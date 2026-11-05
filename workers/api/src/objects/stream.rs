//! What every aggregate object shares besides `sql.rs`: its event stream and outbox, its
//! `commands_seen`, its `timers` with the one platform alarm, the relay to the Queue and the
//! loop guard (docs/architecture.md, "Events and the outbox" and "The rules, restated for
//! Rust", rules 3 and 4).
//!
//! The write is one `transaction_sync`: the events, their outbox rows, the new state and the
//! command's key. After the commit the object hands its outbox to [`relay_soon`], which sends
//! the rows under `wait_until` and deletes each one the Queue accepted, and leaves an `outbox`
//! timer 30 s out that sends whatever is still there. A row may go twice; once committed it is
//! never lost, and every subscriber's `seen` table makes the second delivery a no-op.

use bakery_domain::outbox::{OutboxRow, StreamHead, outbox_rows};
use bakery_domain::{Envelope, Ulid, WallTime};
use serde::Deserialize;
use worker::{Env, Error, Result, SqlStorage, SqlStorageValue, State, Storage, console_log};

use super::sql::{exec, first, rows};
use crate::clock::alarm_time;

/// The Queue producer binding (wrangler.jsonc).
pub const EVENTS: &str = "EVENTS";

/// How long the outbox waits before the alarm resends what the first send left (ADR 0004,
/// decision 5).
pub const OUTBOX_RETRY_MS: i64 = 30_000;

/// Alarm-driven re-arms an object may make in a UTC day before it stops and logs `alarm_guard`
/// (docs/architecture.md, "The rules, restated for Rust", rule 4; ADR 0004, decision 7).
pub const REARM_GUARD: u32 = 100;

/// The outbox timer's id and purpose.
pub const OUTBOX: &str = "outbox";
/// Every child's 36 h backstop (docs/architecture.md, rule 6).
pub const BACKSTOP: &str = "backstop";

/// The tables every aggregate object keeps. `timers.due_business` is set for timers that move
/// with the business clock, such as an order's expiry; their `due_wall` is recomputed from it
/// whenever the clock moves.
pub const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS events (
       seq INTEGER PRIMARY KEY,
       id TEXT NOT NULL UNIQUE,
       type TEXT NOT NULL,
       at TEXT NOT NULL,
       recorded_at TEXT NOT NULL,
       data TEXT NOT NULL,
       cause TEXT)",
    "CREATE TABLE IF NOT EXISTS outbox (
       seq INTEGER PRIMARY KEY,
       envelope TEXT NOT NULL,
       attempts INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS commands_seen (
       key TEXT PRIMARY KEY,
       body_hash TEXT NOT NULL DEFAULT '',
       result TEXT NOT NULL,
       at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS timers (
       id TEXT PRIMARY KEY,
       purpose TEXT NOT NULL,
       due_wall TEXT NOT NULL,
       due_business TEXT)",
    "CREATE TABLE IF NOT EXISTS rearms (day TEXT PRIMARY KEY, n INTEGER NOT NULL, last_at INTEGER)",
];

pub fn create_schema(sql: &SqlStorage, own: &[&str]) -> Result<()> {
    for statement in own.iter().chain(SCHEMA) {
        sql.exec(statement, None)?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct SeqRow {
    seq: Option<i64>,
}

/// The stream as it stands: the last `seq` written, 0 for none.
pub fn head(sql: &SqlStorage, sandbox: Ulid, stream: &str) -> Result<StreamHead> {
    let last: Option<SeqRow> = first(sql, "SELECT max(seq) AS seq FROM events", vec![])?;
    Ok(StreamHead {
        sandbox,
        stream: stream.to_owned(),
        last_seq: last
            .and_then(|r| r.seq)
            .and_then(|s| u64::try_from(s).ok())
            .unwrap_or(0),
    })
}

/// The events and their outbox rows, inside the caller's transaction.
pub fn append(sql: &SqlStorage, envelopes: &[Envelope]) -> Result<()> {
    let outbox = outbox_rows(envelopes).map_err(|e| Error::RustError(e.to_string()))?;
    for (e, row) in envelopes.iter().zip(outbox) {
        let seq = i64::try_from(e.seq).map_err(|_| Error::RustError("seq".into()))?;
        exec(
            sql,
            "INSERT INTO events (seq, id, type, at, recorded_at, data, cause)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            vec![
                seq.into(),
                e.id.to_string().into(),
                e.event_type.as_str().into(),
                e.at.to_string().into(),
                e.recorded_at.to_string().into(),
                serde_json::to_string(&e.data)?.into(),
                match &e.cause {
                    Some(c) => c.as_str().into(),
                    None => SqlStorageValue::Null,
                },
            ],
        )?;
        exec(
            sql,
            "INSERT INTO outbox (seq, envelope) VALUES (?, ?)",
            vec![seq.into(), row.envelope.into()],
        )?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct EventRow {
    seq: i64,
    id: String,
    #[serde(rename = "type")]
    event_type: String,
    at: String,
    recorded_at: String,
    data: String,
    cause: Option<String>,
}

/// Every event in the stream, in `seq` order, as envelopes.
pub fn events(sql: &SqlStorage, sandbox: Ulid, stream: &str) -> Result<Vec<Envelope>> {
    let found: Vec<EventRow> = rows(
        sql,
        "SELECT seq, id, type, at, recorded_at, data, cause FROM events ORDER BY seq",
        vec![],
    )?;
    found
        .into_iter()
        .map(|r| {
            let bad = |what: &str| Error::RustError(format!("stored event {what}"));
            Ok(Envelope {
                v: bakery_domain::ENVELOPE_VERSION,
                id: r.id.parse().map_err(|_| bad("id"))?,
                sandbox,
                stream: stream.to_owned(),
                seq: u64::try_from(r.seq).map_err(|_| bad("seq"))?,
                event_type: r.event_type,
                at: r.at.parse().map_err(|_| bad("at"))?,
                recorded_at: r.recorded_at.parse().map_err(|_| bad("recorded_at"))?,
                data: serde_json::from_str(&r.data)?,
                cause: r.cause,
            })
        })
        .collect()
}

#[derive(Deserialize)]
struct SeenRow {
    body_hash: String,
    result: String,
}

/// The `commands_seen` row for `key`, as the domain's rule reads it.
pub fn seen(sql: &SqlStorage, key: &str) -> Result<Option<bakery_domain::outbox::SeenCommand>> {
    let row: Option<SeenRow> = first(
        sql,
        "SELECT body_hash, result FROM commands_seen WHERE key = ?",
        vec![key.into()],
    )?;
    Ok(row.map(|r| bakery_domain::outbox::SeenCommand {
        body_hash: r.body_hash,
        result: r.result,
    }))
}

/// Records a command's key and answer, inside the caller's transaction.
pub fn remember(
    sql: &SqlStorage,
    key: &str,
    body_hash: &str,
    result: &str,
    now: WallTime,
) -> Result<()> {
    exec(
        sql,
        "INSERT INTO commands_seen (key, body_hash, result, at) VALUES (?, ?, ?, ?)",
        vec![
            key.into(),
            body_hash.into(),
            result.into(),
            now.to_string().into(),
        ],
    )?;
    Ok(())
}

// ---------- timers and the one alarm ----------

#[derive(Debug, Clone, Deserialize)]
pub struct Timer {
    pub id: String,
    pub purpose: String,
    pub due_wall: String,
    pub due_business: Option<String>,
}

impl Timer {
    pub fn due_wall(&self) -> Option<WallTime> {
        self.due_wall.parse().ok()
    }
}

/// Sets a timer, replacing one with the same id.
pub fn set_timer(
    sql: &SqlStorage,
    id: &str,
    purpose: &str,
    due_wall: WallTime,
    due_business: Option<&str>,
) -> Result<()> {
    exec(
        sql,
        "INSERT INTO timers (id, purpose, due_wall, due_business) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET purpose = excluded.purpose, due_wall = excluded.due_wall,
           due_business = excluded.due_business",
        vec![
            id.into(),
            purpose.into(),
            due_wall.to_string().into(),
            match due_business {
                Some(b) => b.into(),
                None => SqlStorageValue::Null,
            },
        ],
    )?;
    Ok(())
}

pub fn delete_timer(sql: &SqlStorage, id: &str) -> Result<()> {
    exec(sql, "DELETE FROM timers WHERE id = ?", vec![id.into()])?;
    Ok(())
}

pub fn timers(sql: &SqlStorage) -> Result<Vec<Timer>> {
    rows(
        sql,
        "SELECT id, purpose, due_wall, due_business FROM timers ORDER BY due_wall",
        vec![],
    )
}

/// Timers due at `now`, earliest first.
pub fn due(sql: &SqlStorage, now: WallTime) -> Result<Vec<Timer>> {
    Ok(timers(sql)?
        .into_iter()
        .filter(|t| t.due_wall().is_some_and(|at| at <= now))
        .collect())
}

/// What arming the one alarm comes to, decided by [`plan_arm`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arming {
    /// The alarm already holds the time wanted, or holds none and nothing is due: nothing is
    /// written and nothing is counted.
    Unchanged,
    /// `setAlarm` for this wall time, in ms.
    Set(i64),
    /// No timer is left: `deleteAlarm`.
    Delete,
    /// An alarm-driven re-arm past the guard: nothing is armed, `alarm_guard` is logged.
    Refused,
}

/// The day's count of alarm-driven re-arms, and the wall time the last one armed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Rearms {
    /// The UTC day, `YYYY-MM-DD`.
    pub day: String,
    pub n: u32,
    pub last_at: Option<i64>,
}

/// The loop guard and the timer wheel's idempotence, as a pure function (docs/architecture.md,
/// "The rules, restated for Rust", rule 4; ADR 0004, decision 7). `current` is the alarm the
/// platform holds, `next_due` the earliest timer's wall time, both in ms. A time already past
/// arms for now. Arming the time already armed is [`Arming::Unchanged`] and is not counted.
/// Only a re-arm from the alarm handler (`from_alarm`) is counted, once per distinct wall time,
/// against [`REARM_GUARD`] a UTC day; the 101st is refused. A command may arm freely. Answers
/// the ledger to store when the re-arm was counted.
pub fn plan_arm(
    current: Option<i64>,
    next_due: Option<i64>,
    now_ms: i64,
    from_alarm: bool,
    today: &str,
    ledger: &Rearms,
) -> (Arming, Option<Rearms>) {
    let Some(due) = next_due else {
        return match current {
            Some(_) => (Arming::Delete, None),
            None => (Arming::Unchanged, None),
        };
    };
    let at = due.max(now_ms);
    if current == Some(at) {
        return (Arming::Unchanged, None);
    }
    if !from_alarm {
        return (Arming::Set(at), None);
    }
    let mut day = if ledger.day == today {
        ledger.clone()
    } else {
        Rearms {
            day: today.to_owned(),
            n: 0,
            last_at: None,
        }
    };
    if day.last_at == Some(at) {
        // The same re-arm again, such as an alarm run retried by the platform: counted once.
        return (Arming::Set(at), None);
    }
    if day.n >= REARM_GUARD {
        return (Arming::Refused, None);
    }
    day.n += 1;
    day.last_at = Some(at);
    (Arming::Set(at), Some(day))
}

fn earliest(sql: &SqlStorage) -> Result<Option<i64>> {
    Ok(timers(sql)?
        .iter()
        .filter_map(Timer::due_wall)
        .map(|t| t.unix_ms())
        .min())
}

fn ledger(sql: &SqlStorage, today: &str) -> Result<Rearms> {
    #[derive(Deserialize)]
    struct Row {
        n: i64,
        last_at: Option<i64>,
    }
    let row: Option<Row> = first(
        sql,
        "SELECT n, last_at FROM rearms WHERE day = ?",
        vec![today.into()],
    )?;
    Ok(row.map_or_else(Rearms::default, |r| Rearms {
        day: today.to_owned(),
        n: u32::try_from(r.n).unwrap_or(u32::MAX),
        last_at: r.last_at,
    }))
}

/// Whether the guard still allows an alarm-driven re-arm today, without counting one: the
/// Simulator stops its traffic cleanly rather than be refused mid-run.
pub fn guard_allows(sql: &SqlStorage, now: WallTime) -> Result<bool> {
    Ok(ledger(sql, &now.utc_day())?.n < REARM_GUARD)
}

async fn arm_with(storage: &Storage, now: WallTime, from_alarm: bool, object: &str) -> Result<()> {
    let sql = storage.sql();
    let today = now.utc_day();
    let current = storage.get_alarm().await?;
    let book = if from_alarm {
        ledger(&sql, &today)?
    } else {
        Rearms::default()
    };
    let (arming, counted) = plan_arm(
        current,
        earliest(&sql)?,
        now.unix_ms(),
        from_alarm,
        &today,
        &book,
    );
    if let Some(day) = counted {
        exec(
            &sql,
            "INSERT INTO rearms (day, n, last_at) VALUES (?, ?, ?)
             ON CONFLICT (day) DO UPDATE SET n = excluded.n, last_at = excluded.last_at",
            vec![
                day.day.into(),
                i64::from(day.n).into(),
                day.last_at
                    .map_or(SqlStorageValue::Null, SqlStorageValue::from),
            ],
        )?;
    }
    match arming {
        Arming::Unchanged => Ok(()),
        Arming::Set(ms) => {
            let at = WallTime::from_unix_ms(ms).map_err(|e| Error::RustError(e.to_string()))?;
            storage.set_alarm(alarm_time(at)).await
        }
        Arming::Delete => storage.delete_alarm().await,
        Arming::Refused => {
            // Control has no per-sandbox read-only switch (its flag is the whole demo's), so
            // the object stops arming and waits for the nightly wipe (ADR 0004, decision 7).
            console_log!(
                "{{\"event\":\"alarm_guard\",\"reason\":\"rearm-cap\",\"object\":\"{object}\"}}"
            );
            Ok(())
        }
    }
}

/// Arms the one alarm for the earliest timer from a command or a delivery, or deletes it when
/// there is none. Not counted by the guard: a command may arm an earlier wall time
/// (docs/architecture.md, "Time travel"). Arming the time already armed writes nothing.
pub async fn arm(storage: &Storage, now: WallTime) -> Result<()> {
    arm_with(storage, now, false, "").await
}

/// The end of every alarm run: the next alarm armed for the earliest timer left, counted by the
/// loop guard. The handler deletes or moves every timer it ran, so a timer still due arms for
/// now, and a loop of those is what the guard stops at 100 a day.
pub async fn rearm(storage: &Storage, now: WallTime, object: &str) -> Result<()> {
    arm_with(storage, now, true, object).await
}

/// A wall time `ms` after `now`.
pub fn after(now: WallTime, ms: i64) -> Result<WallTime> {
    WallTime::from_unix_ms(now.unix_ms() + ms).map_err(|e| Error::RustError(e.to_string()))
}

// ---------- the relay ----------

#[derive(Deserialize)]
struct OutboxRead {
    seq: i64,
    envelope: String,
}

fn pending(sql: &SqlStorage) -> Result<Vec<OutboxRow>> {
    let found: Vec<OutboxRead> = rows(
        sql,
        "SELECT seq, envelope FROM outbox ORDER BY seq LIMIT 100",
        vec![],
    )?;
    Ok(found
        .into_iter()
        .map(|r| OutboxRow {
            seq: u64::try_from(r.seq).unwrap_or(0),
            envelope: r.envelope,
        })
        .collect())
}

/// Sends the outbox to `bakery-events` in one batch, each envelope as a JSON string (spike S6:
/// a `serde_json::Value` arrives as `{}`), and deletes the rows the Queue accepted. A batch
/// holds up to 100 messages (Queues limits, as of 2026-11-04,
/// https://developers.cloudflare.com/queues/platform/limits/). Answers how many rows are left.
pub async fn relay(storage: &Storage, env: &Env, object: &str) -> Result<usize> {
    let sql = storage.sql();
    let rows = pending(&sql)?;
    if rows.is_empty() {
        return Ok(0);
    }
    let bodies: Vec<String> = rows.iter().map(|r| r.envelope.clone()).collect();
    let sent = env.queue(EVENTS)?.send_batch(bodies).await;
    match sent {
        Ok(()) => {
            let last = rows.last().map_or(0, |r| r.seq);
            exec(
                &sql,
                "DELETE FROM outbox WHERE seq <= ?",
                vec![i64::try_from(last).unwrap_or(0).into()],
            )?;
            console_log!(
                "{{\"event\":\"relay\",\"object\":\"{object}\",\"sent\":{}}}",
                rows.len()
            );
        }
        Err(e) => {
            exec(&sql, "UPDATE outbox SET attempts = attempts + 1", vec![])?;
            console_log!(
                "{{\"event\":\"relay_error\",\"object\":\"{object}\",\"error\":{:?}}}",
                e.to_string()
            );
        }
    }
    #[derive(Deserialize)]
    struct N {
        n: i64,
    }
    let left: Option<N> = first(&sql, "SELECT count(*) AS n FROM outbox", vec![])?;
    Ok(usize::try_from(left.map_or(0, |r| r.n)).unwrap_or(0))
}

/// After a commit: the outbox timer 30 s out and the alarm armed for it (or for anything
/// earlier), then the send under `wait_until`, so the answer does not wait for the Queue.
pub async fn relay_soon(
    state: &State,
    env: &Env,
    now: WallTime,
    object: &'static str,
) -> Result<()> {
    relay_after(state, env, now, object)?;
    arm(&state.storage(), now).await
}

/// [`relay_soon`] from inside an alarm run: the outbox timer and the send, with the alarm left
/// to the run's own [`rearm`], so the guard sees the re-arm.
pub fn relay_after(state: &State, env: &Env, now: WallTime, object: &'static str) -> Result<()> {
    let storage = state.storage();
    set_timer(
        &storage.sql(),
        OUTBOX,
        OUTBOX,
        after(now, OUTBOX_RETRY_MS)?,
        None,
    )?;
    let env = env.clone();
    state.wait_until(async move {
        if let Err(e) = relay(&storage, &env, object).await {
            console_log!(
                "{{\"event\":\"relay_error\",\"object\":\"{object}\",\"error\":{:?}}}",
                e.to_string()
            );
        }
    });
    Ok(())
}

/// The outbox timer fired: send what is left, and come back in 30 s only while rows remain. The
/// alarm's [`rearm`] counts that against the guard.
pub async fn outbox_timer(storage: &Storage, env: &Env, now: WallTime, object: &str) -> Result<()> {
    let left = relay(storage, env, object).await?;
    let sql = storage.sql();
    if left > 0 {
        set_timer(&sql, OUTBOX, OUTBOX, after(now, OUTBOX_RETRY_MS)?, None)?;
    } else {
        delete_timer(&sql, OUTBOX)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_794_069_730_000;
    const DAY: &str = "2026-11-07";

    /// Runs `n` alarm-driven re-arms, each to a new wall time, keeping the ledger as the
    /// object would.
    fn rearm_n(ledger: &mut Rearms, n: u32, from: i64) -> Vec<Arming> {
        (0..n)
            .map(|i| {
                let at = from + i64::from(i + 1) * 30_000;
                let (arming, counted) = plan_arm(None, Some(at), NOW, true, DAY, ledger);
                if let Some(l) = counted {
                    *ledger = l;
                }
                arming
            })
            .collect()
    }

    #[test]
    fn the_hundred_and_first_alarm_driven_rearm_in_a_day_is_refused() {
        let mut ledger = Rearms::default();
        let armed = rearm_n(&mut ledger, REARM_GUARD, NOW);
        assert!(armed.iter().all(|a| matches!(a, Arming::Set(_))));
        assert_eq!(ledger.n, 100);
        let (arming, counted) = plan_arm(None, Some(NOW + 999_000), NOW, true, DAY, &ledger);
        assert_eq!((arming, counted), (Arming::Refused, None));
        // A command still arms: the guard counts the alarm's own re-arms only.
        let (arming, counted) = plan_arm(None, Some(NOW + 999_000), NOW, false, DAY, &ledger);
        assert_eq!((arming, counted), (Arming::Set(NOW + 999_000), None));
    }

    #[test]
    fn the_same_wall_time_twice_is_counted_once() {
        let mut ledger = Rearms::default();
        let at = NOW + 60_000;
        let (first, counted) = plan_arm(None, Some(at), NOW, true, DAY, &ledger);
        ledger = counted.unwrap();
        assert_eq!((first, ledger.n), (Arming::Set(at), 1));
        // The platform already holds it: nothing written, nothing counted.
        assert_eq!(
            plan_arm(Some(at), Some(at), NOW, true, DAY, &ledger),
            (Arming::Unchanged, None)
        );
        assert_eq!(
            plan_arm(Some(at), Some(at), NOW, false, DAY, &ledger),
            (Arming::Unchanged, None)
        );
        // The alarm consumed, then the same time asked again (a retried run): set, not counted.
        assert_eq!(
            plan_arm(None, Some(at), NOW, true, DAY, &ledger),
            (Arming::Set(at), None)
        );
        assert_eq!(ledger.n, 1);
    }

    #[test]
    fn a_new_day_resets_the_count() {
        let mut ledger = Rearms::default();
        rearm_n(&mut ledger, REARM_GUARD, NOW);
        assert_eq!(
            plan_arm(None, Some(NOW + 999_000), NOW, true, DAY, &ledger).0,
            Arming::Refused
        );
        let (arming, counted) =
            plan_arm(None, Some(NOW + 999_000), NOW, true, "2026-11-08", &ledger);
        assert_eq!(arming, Arming::Set(NOW + 999_000));
        assert_eq!(
            counted.map(|l| (l.day, l.n)),
            Some(("2026-11-08".into(), 1))
        );
    }

    #[test]
    fn a_past_timer_arms_for_now_and_no_timer_deletes() {
        let ledger = Rearms::default();
        assert_eq!(
            plan_arm(None, Some(NOW - 5_000), NOW, false, DAY, &ledger).0,
            Arming::Set(NOW)
        );
        assert_eq!(
            plan_arm(Some(NOW), None, NOW, true, DAY, &ledger),
            (Arming::Delete, None)
        );
        assert_eq!(
            plan_arm(None, None, NOW, true, DAY, &ledger),
            (Arming::Unchanged, None)
        );
    }
}
