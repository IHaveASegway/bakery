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
    "CREATE TABLE IF NOT EXISTS rearms (day TEXT PRIMARY KEY, n INTEGER NOT NULL)",
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

/// Arms the one alarm for the earliest timer, or deletes it when there is none. A timer already
/// due arms for now, which fires at once; the alarm handler deletes or moves every timer it
/// runs, so this never loops (rule 4).
pub async fn arm(storage: &Storage, now: WallTime) -> Result<()> {
    let next = timers(&storage.sql())?
        .iter()
        .filter_map(Timer::due_wall)
        .min();
    match next {
        Some(at) => {
            let at = if at < now { now } else { at };
            storage.set_alarm(alarm_time(at)).await
        }
        None => storage.delete_alarm().await,
    }
}

/// Counts one alarm-driven re-arm for today. `false` at the guard: the caller stops arming,
/// and the object waits for the wipe or its backstop.
pub fn may_rearm(sql: &SqlStorage, now: WallTime, object: &str) -> Result<bool> {
    #[derive(Deserialize)]
    struct N {
        n: i64,
    }
    let day = now.utc_day();
    let n: Option<N> = first(
        sql,
        "SELECT n FROM rearms WHERE day = ?",
        vec![day.as_str().into()],
    )?;
    let n = n.map_or(0, |r| r.n);
    if n >= i64::from(REARM_GUARD) {
        console_log!("{{\"event\":\"alarm_guard\",\"object\":\"{object}\"}}");
        return Ok(false);
    }
    exec(
        sql,
        "INSERT INTO rearms (day, n) VALUES (?, 1)
         ON CONFLICT (day) DO UPDATE SET n = n + 1",
        vec![day.into()],
    )?;
    Ok(true)
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
    let storage = state.storage();
    set_timer(
        &storage.sql(),
        OUTBOX,
        OUTBOX,
        after(now, OUTBOX_RETRY_MS)?,
        None,
    )?;
    arm(&storage, now).await?;
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

/// The outbox timer fired: send what is left, and come back in 30 s only while rows remain and
/// the guard allows.
pub async fn outbox_timer(storage: &Storage, env: &Env, now: WallTime, object: &str) -> Result<()> {
    let left = relay(storage, env, object).await?;
    let sql = storage.sql();
    if left > 0 && may_rearm(&sql, now, object)? {
        set_timer(&sql, OUTBOX, OUTBOX, after(now, OUTBOX_RETRY_MS)?, None)?;
    } else {
        delete_timer(&sql, OUTBOX)?;
    }
    Ok(())
}
