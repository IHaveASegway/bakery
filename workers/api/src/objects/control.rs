//! `Control`, one per account, named `control`: the demo's flags, the daily ledger, the day's
//! sandboxes and the wipe's fan-out (docs/architecture.md, "Durable Object topology"; "The
//! nightly wipe"). SQLite-backed. Nothing here is billed per sandbox, so the router asks it
//! only after the free checks.
//!
//! One alarm serves two timers: the ledger prune at 00:00 UTC, and the wipe's fan-out, which
//! wipes up to 50 sandboxes a run and re-arms while rows remain (docs/security.md, "The wipe").
//! The traffic ledger holds each sandbox's minutes of simulated traffic for the UTC day: the
//! `Simulator` reserves what is left when it starts and settles what it did not use when it stops
//! (docs/architecture.md, "Simulated traffic"; docs/cost.md, "Guardrails": 30 minutes).
//! The daily IP salt lives in memory only and is never stored, so yesterday's IP hashes cannot
//! be recomputed (docs/security.md, "Privacy and data inventory").
//!
//! The status page's counters (PR 13): the 15-minute cron runs the kept Analytics Engine
//! queries in the Worker and hands the answer here by command (`POST /status-snapshot`, or
//! `POST /status-failed` when a query failed); `GET /status` serves the one stored snapshot with
//! its time and state. Nothing here reads Analytics Engine or arms a timer for it. `admit`
//! writes the `sandbox_created` point and the wipe's last fan-out run writes `wipe`.
//!
//! The count of sandboxes past their wipe (2026-11-10): each 15-minute sweep counts the rows not
//! wiped more than 2 hours after the first 10:00 UTC after their birth
//! (`bakery_app::wipe::count_past_wipe`) and stores the number with its time in `past_wipe`, one
//! row beside the status snapshot. `GET /status` reads that row and serves the count while it is
//! at most 20 minutes old, so the public route reads one row and never scans `sandboxes`. The
//! sweep runs whether or not the analytics secrets are set, which is why the count is not inside
//! the analytics snapshot.
//!
//! The 15-minute cron breaker (PR 17) keeps its state here: the cron reads the window's usage in
//! the Worker and hands it over by command (`POST /breaker`); this object decides with
//! `bakery_app::breaker::decide` against the stored state, stores the run, and on a trip raises
//! the flag in the same transaction. `POST /breaker-rule` records that the WAF kill rule was
//! enabled. The state only rises (`unconfigured`, `armed`, `read-only`, `off`); a person resets
//! it in Data Studio: `UPDATE breaker_state SET state = 'armed', since = NULL WHERE id = 1`, the
//! flag back to `live` (`UPDATE flags SET mode = 'live' WHERE demo = 'bakery'`), and the WAF rule
//! disabled by hand. Nothing here reads analytics or arms a timer for the breaker.

use std::cell::{Cell, RefCell};

use bakery_app::Clock;
use bakery_app::admission::{self, Caps, Counts, Refusal};
use bakery_app::analytics::{Event, Point, counters_state};
use bakery_app::auth::hex;
use bakery_app::breaker::{Reads, decide, raised_flag};
use bakery_app::names::{CONTROL, sandbox_object_name};
use bakery_app::wipe::{count_past_wipe, served_past_wipe};
use bakery_contracts::{
    BreakerState, BreakerStatus, Flag, SandboxKind, StatusCounters, StatusResponse,
};
use bakery_domain::{Ulid, WallTime};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::sandbox::{self, WipeRequest};
use super::sql::{self, exec, first, rows, transaction_sync};
use crate::clock::{SystemClock, alarm_time};
use crate::config::{caps_from_env, traffic_minutes_cap};
use crate::{breaker, metrics, random};

pub const BINDING: &str = "CONTROL";
/// Ledger rows and creation keys older than this many days are pruned.
const LEDGER_DAYS: i64 = 35;
/// Sandboxes one alarm run wipes (docs/security.md, "The wipe"): one subrequest each, far
/// inside the 1,000 a Free invocation and the 10,000 a Paid one may make (Workers limits,
/// https://developers.cloudflare.com/workers/platform/limits/, as of 2026-11-05).
const WIPES_PER_RUN: usize = 50;
/// An alarm-driven re-arm a day past this many stops and logs `alarm_guard` (docs/architecture.md,
/// "The rules, restated for Rust", rule 4). 300 sandboxes at 50 a run need 6.
const REARM_GUARD: u32 = 100;
/// The pause between fan-out runs, so a run's own subrequests have finished.
const FANOUT_GAP_MS: i64 = 1_000;

const SANDBOXES: &str = "sandboxes";
const GUEST_SANDBOXES: &str = "guest_sandboxes";
const DEMO_ACCOUNTS: &str = "demo_accounts";
const ALARM_REARMS: &str = "alarm_rearms";

const PRUNE: &str = "prune";
const FANOUT: &str = "fanout";

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS flags (
       demo TEXT PRIMARY KEY,
       mode TEXT NOT NULL CHECK (mode IN ('live','read-only','off')),
       changed_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS ledger (
       day TEXT NOT NULL,
       meter TEXT NOT NULL,
       value INTEGER NOT NULL,
       PRIMARY KEY (day, meter))",
    // One row per sandbox admitted, until the ledger's retention. `wipe_attempted_at` is
    // the fan-out's cursor: a row is tried once per `wipe_due`, so a sandbox that fails to
    // wipe waits for the sweep instead of looping the alarm.
    "CREATE TABLE IF NOT EXISTS sandboxes (
       id TEXT PRIMARY KEY,
       kind TEXT NOT NULL CHECK (kind IN ('guest','account')),
       created_at TEXT NOT NULL,
       wipe_due TEXT,
       wiped_at TEXT,
       wipe_requested_at TEXT,
       wipe_attempted_at TEXT,
       objects INTEGER,
       rows_deleted INTEGER)",
    // The Idempotency-Key of every admitted creation, with its answer, so a retry gets the
    // first answer and does not take a second place (docs/domain.md, "Idempotency").
    "CREATE TABLE IF NOT EXISTS creations_seen (
       key TEXT PRIMARY KEY,
       day TEXT NOT NULL,
       result TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS timers (
       id TEXT PRIMARY KEY,
       purpose TEXT NOT NULL,
       due_wall TEXT NOT NULL)",
    // Minutes of simulated traffic charged to a sandbox on a UTC day: reserved at a start,
    // given back at a stop. Pruned with the ledger.
    "CREATE TABLE IF NOT EXISTS traffic (
       day TEXT NOT NULL,
       sandbox TEXT NOT NULL,
       minutes INTEGER NOT NULL,
       PRIMARY KEY (day, sandbox))",
    // The status page's counters: one row, the last good refresh's answer as JSON with its
    // time, and the time of a refresh that failed after it (PR 13). Replaced, never appended.
    "CREATE TABLE IF NOT EXISTS status_snapshot (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       as_of TEXT,
       json TEXT,
       failed_at TEXT)",
    // The sweep's count of sandboxes past their wipe, with the sweep's time (2026-11-10): one
    // row, replaced at each sweep. Its own table, so the existing snapshot row needs no new
    // column.
    "CREATE TABLE IF NOT EXISTS past_wipe (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       count INTEGER NOT NULL,
       counted_at TEXT NOT NULL)",
    // One row per nightly wipe, opened by the 10:00 UTC cron and closed by its last fan-out
    // run, which writes the `wipe` point from it. Pruned with the ledger.
    "CREATE TABLE IF NOT EXISTS wipe_runs (
       started_at TEXT PRIMARY KEY,
       finished_at TEXT)",
    // The 15-minute cron breaker (PR 17): one row, created `unconfigured` on first use. `since`
    // is when the state last changed; `last_run`, `last_usd`, `meters` (JSON, each meter's
    // read in its unit or null) and `unread` (a JSON array of names) are the last run's;
    // `rule_enabled_at` is when the WAF kill rule was enabled, cleared on a trip to `off` so the
    // rule is wanted afresh.
    "CREATE TABLE IF NOT EXISTS breaker_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       state TEXT NOT NULL,
       since TEXT,
       last_run TEXT,
       last_usd TEXT,
       meters TEXT,
       unread TEXT,
       rule_enabled_at TEXT)",
];

/// `POST /admit`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdmitRequest {
    pub key: String,
    pub kind: SandboxKind,
    pub sandbox_id: Ulid,
}

/// `/admit`'s answer. On a replay, `sandbox_id` is the first request's, not this one's.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdmitAnswer {
    pub admitted: bool,
    pub sandbox_id: Option<Ulid>,
    pub replayed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `POST /admit-demo`. The username is stored with the key so a replay names the same account;
/// it never reaches a log line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdmitDemoRequest {
    pub key: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdmitDemoAnswer {
    pub admitted: bool,
    pub username: Option<String>,
    pub replayed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `GET /salt`: the day's salt, hex. The router caches it for 30 s.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Salt {
    pub day: String,
    pub salt: String,
}

/// `POST /wiped`, from a Sandbox as it finishes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Wiped {
    pub id: Ulid,
    pub objects: u32,
    pub rows_deleted: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pruned {
    pub before: String,
    pub deleted: u32,
}

/// `GET /flag`: the demo's flag alone, for the Queue consumer, which caches it for 60 s.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FlagAnswer {
    pub flag: Flag,
}

/// `POST /reserve-traffic`: a `Simulator` starting. `key` is the start's own key, so a retried
/// reservation is charged once.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReserveTraffic {
    pub key: String,
    pub sandbox: Ulid,
    /// Minutes asked for; the grant is at most what is left of today's cap.
    pub minutes: u16,
}

/// `POST /settle-traffic`: a `Simulator` stopping, giving back what it reserved and did not use.
/// `day` is the reservation's, so a run that crosses 00:00 UTC credits the day it was charged to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettleTraffic {
    pub key: String,
    pub sandbox: Ulid,
    pub day: String,
    pub unused: u16,
}

/// The answer to both: what was granted (0 when the cap is spent), the minutes charged to the
/// sandbox on `day` after this call, and the cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrafficGrant {
    pub granted: u16,
    pub used: u16,
    pub cap: u16,
}

/// `POST /status-snapshot`, from the 15-minute cron: the kept queries' answer and when it was
/// read, an RFC 3339 UTC time from the cron's clock.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusSnapshot {
    pub as_of: String,
    pub counters: StatusCounters,
}

/// `POST /status-failed`, from the 15-minute cron: a refresh failed at `at`, so the stored
/// snapshot is stale. The reason is in the cron's log line only.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotFailed {
    pub at: String,
}

/// `POST /breaker`, from the 15-minute cron: the window's reads, each meter in its unit or
/// `null` when unread, its price in dollars with four decimals and the unread meters' names, at
/// `at`, an RFC 3339 UTC time from the cron's clock.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreakerRun {
    pub at: String,
    pub usd: String,
    pub meters: serde_json::Map<String, serde_json::Value>,
    pub unread: Vec<String>,
}

/// `/breaker`'s answer: the state after the run and before it, and whether the cron should
/// enable the WAF kill rule (`off`, and not yet enabled since the trip).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BreakerAnswer {
    pub state: BreakerState,
    pub previous: BreakerState,
    pub rule_wanted: bool,
}

/// `POST /breaker-rule`, from the 15-minute cron: the kill rule was enabled at `at`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreakerRuleEnabled {
    pub at: String,
}

/// `POST /wipe` and `POST /sweep`: how many rows were stamped for the fan-out.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stamped {
    pub stamped: u32,
}

#[durable_object]
pub struct Control {
    state: State,
    env: Env,
    /// Set once this instance has created its tables and checked its alarm.
    ready: Cell<bool>,
    /// The day's IP salt, in memory only: replaced when the UTC day changes, lost (and
    /// redrawn) when the object is evicted.
    salt: RefCell<Option<(String, [u8; 32])>>,
}

impl DurableObject for Control {
    fn new(state: State, env: Env) -> Self {
        Control {
            state,
            env,
            ready: Cell::new(false),
            salt: RefCell::new(None),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        self.ensure_ready().await?;
        let now = SystemClock::new().now_wall();
        match (req.method(), req.path().as_str()) {
            (Method::Get, "/status") => Response::from_json(&self.status(now)?),
            (Method::Post, "/admit") => {
                let body: AdmitRequest = sql::body(&mut req).await?;
                Response::from_json(&self.admit(body, now)?)
            }
            (Method::Post, "/admit-demo") => {
                let body: AdmitDemoRequest = sql::body(&mut req).await?;
                Response::from_json(&self.admit_demo(body, now)?)
            }
            (Method::Get, "/salt") => Response::from_json(&self.salt(now)?),
            (Method::Get, "/flag") => Response::from_json(&FlagAnswer {
                flag: read_flag(&self.sql())?,
            }),
            (Method::Post, "/wiped") => {
                let body: Wiped = sql::body(&mut req).await?;
                self.wiped(&body, now)?;
                Response::from_json(&serde_json::json!({ "ok": true }))
            }
            (Method::Post, "/reserve-traffic") => {
                let body: ReserveTraffic = sql::body(&mut req).await?;
                Response::from_json(&self.reserve_traffic(body, now)?)
            }
            (Method::Post, "/settle-traffic") => {
                let body: SettleTraffic = sql::body(&mut req).await?;
                Response::from_json(&self.settle_traffic(body)?)
            }
            (Method::Post, "/wipe") => Response::from_json(&self.stamp_wipe(now).await?),
            (Method::Post, "/sweep") => Response::from_json(&self.sweep(now).await?),
            (Method::Post, "/prune") => Response::from_json(&self.prune(now)?),
            (Method::Post, "/status-snapshot") => {
                let body: StatusSnapshot = sql::body(&mut req).await?;
                self.store_snapshot(&body)?;
                Response::from_json(&serde_json::json!({ "ok": true }))
            }
            (Method::Post, "/status-failed") => {
                let body: SnapshotFailed = sql::body(&mut req).await?;
                self.snapshot_failed(&body)?;
                Response::from_json(&serde_json::json!({ "ok": true }))
            }
            (Method::Post, "/breaker") => {
                let body: BreakerRun = sql::body(&mut req).await?;
                Response::from_json(&self.breaker(body)?)
            }
            (Method::Post, "/breaker-rule") => {
                let body: BreakerRuleEnabled = sql::body(&mut req).await?;
                self.breaker_rule(&body)?;
                Response::from_json(&serde_json::json!({ "ok": true }))
            }
            _ => Response::error("Not Found", 404),
        }
    }

    async fn alarm(&self) -> Result<Response> {
        self.ensure_ready().await?;
        let now = SystemClock::new().now_wall();
        let due: Vec<TimerRow> = rows(
            &self.sql(),
            "SELECT id, purpose, due_wall FROM timers WHERE due_wall <= ?",
            vec![now.to_string().into()],
        )?;
        for timer in due {
            match timer.purpose.as_str() {
                PRUNE => {
                    let pruned = self.prune(now)?;
                    // The next midnight is always later than now, so this timer cannot loop.
                    self.set_timer(PRUNE, now.next_utc_midnight())?;
                    console_log!(
                        "{{\"event\":\"control_alarm\",\"pruned\":{},\"before\":{:?}}}",
                        pruned.deleted,
                        pruned.before
                    );
                }
                FANOUT => {
                    exec(
                        &self.sql(),
                        "DELETE FROM timers WHERE id = ?",
                        vec![FANOUT.into()],
                    )?;
                    self.fan_out(now).await?;
                }
                other => {
                    console_log!("{{\"event\":\"timer_unknown\",\"purpose\":{other:?}}}");
                    exec(
                        &self.sql(),
                        "DELETE FROM timers WHERE id = ?",
                        vec![timer.id.into()],
                    )?;
                }
            }
        }
        self.arm_earliest(now).await?;
        Response::empty()
    }
}

#[derive(Deserialize)]
struct TimerRow {
    id: String,
    purpose: String,
    #[allow(dead_code)]
    due_wall: String,
}

#[derive(Deserialize)]
struct IdRow {
    id: String,
}

#[derive(Deserialize)]
struct ResultRow {
    result: String,
}

impl Control {
    fn sql(&self) -> SqlStorage {
        self.state.storage().sql()
    }

    fn caps(&self) -> Caps {
        caps_from_env(&self.env)
    }

    /// Creates the tables and the flag row on first use, and the prune timer on first start.
    async fn ensure_ready(&self) -> Result<()> {
        if self.ready.get() {
            return Ok(());
        }
        let sql = self.sql();
        for statement in SCHEMA {
            sql.exec(statement, None)?;
        }
        let now = SystemClock::new().now_wall();
        exec(
            &sql,
            "INSERT OR IGNORE INTO flags (demo, mode, changed_at) VALUES ('bakery', 'live', ?)",
            vec![now.to_string().into()],
        )?;
        exec(
            &sql,
            "INSERT OR IGNORE INTO timers (id, purpose, due_wall) VALUES (?, ?, ?)",
            vec![
                PRUNE.into(),
                PRUNE.into(),
                now.next_utc_midnight().to_string().into(),
            ],
        )?;
        if self.state.storage().get_alarm().await?.is_none() {
            self.arm_earliest(now).await?;
        }
        self.ready.set(true);
        Ok(())
    }

    fn set_timer(&self, id: &str, at: WallTime) -> Result<()> {
        exec(
            &self.sql(),
            "INSERT INTO timers (id, purpose, due_wall) VALUES (?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET due_wall = excluded.due_wall",
            vec![id.into(), id.into(), at.to_string().into()],
        )?;
        Ok(())
    }

    /// One alarm, for the earliest timer. A due timer arms for now, which fires at once.
    async fn arm_earliest(&self, now: WallTime) -> Result<()> {
        #[derive(Deserialize)]
        struct Due {
            due_wall: Option<String>,
        }
        let due: Option<Due> = first(
            &self.sql(),
            "SELECT min(due_wall) AS due_wall FROM timers",
            vec![],
        )?;
        match due
            .and_then(|d| d.due_wall)
            .and_then(|t| t.parse::<WallTime>().ok())
        {
            Some(at) => {
                let at = if at < now { now } else { at };
                self.state.storage().set_alarm(alarm_time(at)).await
            }
            None => self.state.storage().delete_alarm().await,
        }
    }

    fn status(&self, now: WallTime) -> Result<StatusResponse> {
        let sql = self.sql();
        let day = now.utc_day();
        let caps = self.caps();
        let snapshot = read_snapshot(&sql)?;
        let as_of = snapshot
            .as_ref()
            .and_then(|s| s.as_of.parse::<WallTime>().ok());
        let failed_at = snapshot
            .as_ref()
            .and_then(|s| s.failed_at.as_deref())
            .and_then(|f| f.parse::<WallTime>().ok());
        // A snapshot is served only whole: counters that read and the time they were read.
        let (counters, counters_as_of, as_of) = match (snapshot, as_of) {
            (
                Some(Snapshot {
                    counters: Some(c),
                    as_of: text,
                    ..
                }),
                Some(at),
            ) => (Some(c), Some(text), Some(at)),
            _ => (None, None, None),
        };
        Ok(StatusResponse {
            counters,
            counters_as_of,
            counters_state: counters_state(as_of, failed_at, now),
            breaker: read_breaker(&sql)?.status(),
            sandboxes_past_wipe: served_past_wipe(read_past_wipe(&sql)?, now),
            sandboxes_today: read_meter(&sql, &day, SANDBOXES)?,
            sandbox_cap: caps.sandboxes,
            guests_today: read_meter(&sql, &day, GUEST_SANDBOXES)?,
            guest_cap: caps.guests,
            demo_accounts_today: read_meter(&sql, &day, DEMO_ACCOUNTS)?,
            demo_account_cap: caps.demo_accounts,
            flag: read_flag(&sql)?,
            day,
        })
    }

    /// The cron's good refresh: the snapshot replaces the last one, and an earlier failure no
    /// longer makes it stale.
    fn store_snapshot(&self, s: &StatusSnapshot) -> Result<()> {
        exec(
            &self.sql(),
            "INSERT INTO status_snapshot (id, as_of, json, failed_at) VALUES (1, ?, ?, NULL)
             ON CONFLICT (id) DO UPDATE SET as_of = excluded.as_of, json = excluded.json,
               failed_at = NULL",
            vec![
                s.as_of.as_str().into(),
                serde_json::to_string(&s.counters)?.into(),
            ],
        )?;
        Ok(())
    }

    /// The cron's failed refresh: the snapshot stays, marked stale from `at`.
    fn snapshot_failed(&self, f: &SnapshotFailed) -> Result<()> {
        exec(
            &self.sql(),
            "INSERT INTO status_snapshot (id, failed_at) VALUES (1, ?)
             ON CONFLICT (id) DO UPDATE SET failed_at = excluded.failed_at",
            vec![f.at.as_str().into()],
        )?;
        Ok(())
    }

    /// The cron's breaker run: the verdict against the stored state, the run stored, and on a
    /// trip the state, its time and the flag raised, all in one transaction. A rise to `off`
    /// clears `rule_enabled_at`, so the answer asks for the rule until `/breaker-rule` says it
    /// is enabled. The lines come from this Worker's vars, as the cron checked them.
    fn breaker(&self, run: BreakerRun) -> Result<BreakerAnswer> {
        let lines = breaker::lines_from_env(&self.env)
            .map_err(|u| Error::RustError(format!("breaker lines: {u:?}")))?;
        let sql = self.sql();
        let (answer, raised) = transaction_sync(&self.state.storage(), move || {
            let stored = read_breaker(&sql)?;
            let previous = stored.state;
            let verdict = decide(previous, &Reads::from_wire(&run.meters), &lines);
            let unread: Vec<&str> = verdict.unread.iter().map(|m| m.name()).collect();
            let since = if verdict.state != previous {
                Some(run.at.clone())
            } else {
                stored.since
            };
            let rule_enabled_at =
                if verdict.state == BreakerState::Off && previous != BreakerState::Off {
                    None
                } else {
                    stored.rule_enabled_at
                };
            exec(
                &sql,
                "INSERT INTO breaker_state
                   (id, state, since, last_run, last_usd, meters, unread, rule_enabled_at)
                 VALUES (1, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET state = excluded.state, since = excluded.since,
                   last_run = excluded.last_run, last_usd = excluded.last_usd,
                   meters = excluded.meters, unread = excluded.unread,
                   rule_enabled_at = excluded.rule_enabled_at",
                vec![
                    verdict.state.as_str().into(),
                    since.into(),
                    run.at.as_str().into(),
                    bakery_app::breaker::usd_text(verdict.usd_micros).into(),
                    serde_json::to_string(&run.meters)?.into(),
                    serde_json::to_string(&unread)?.into(),
                    rule_enabled_at.clone().into(),
                ],
            )?;
            let mut raised = None;
            if verdict.tripped() {
                let current = read_flag(&sql)?;
                if let Some(to) = raised_flag(current, verdict.state) {
                    exec(
                        &sql,
                        "UPDATE flags SET mode = ?, changed_at = ? WHERE demo = 'bakery'",
                        vec![to.as_str().into(), run.at.as_str().into()],
                    )?;
                    raised = Some((current, to));
                }
            }
            let answer = BreakerAnswer {
                state: verdict.state,
                previous,
                rule_wanted: verdict.state == BreakerState::Off && rule_enabled_at.is_none(),
            };
            Ok((answer, raised))
        })?;
        if let Some((from, to)) = raised {
            console_log!(
                "{{\"event\":\"flag_raised\",\"by\":\"breaker\",\"from\":\"{}\",\"to\":\"{}\"}}",
                from.as_str(),
                to.as_str()
            );
        }
        Ok(answer)
    }

    /// The cron enabled the WAF kill rule: the next run's answer no longer asks for it.
    fn breaker_rule(&self, r: &BreakerRuleEnabled) -> Result<()> {
        exec(
            &self.sql(),
            "UPDATE breaker_state SET rule_enabled_at = ? WHERE id = 1",
            vec![r.at.as_str().into()],
        )?;
        Ok(())
    }

    /// Admits one sandbox if the flag and the caps allow it: the replay check, the read, the
    /// decision and the writes are one SQL transaction, so two requests can never both take
    /// the last place and a retried key never takes a second. A first admission writes the
    /// `sandbox_created` point after the commit; a replay or a refusal writes none.
    fn admit(&self, req: AdmitRequest, now: WallTime) -> Result<AdmitAnswer> {
        let answer = self.admit_once(req, now)?;
        if answer.admitted && !answer.replayed {
            metrics::write(&self.env, &Point::one(Event::SandboxCreated));
        }
        Ok(answer)
    }

    fn admit_once(&self, req: AdmitRequest, now: WallTime) -> Result<AdmitAnswer> {
        let sql = self.sql();
        let day = now.utc_day();
        let caps = self.caps();
        let key = format!("sandbox:{}", req.key);
        transaction_sync(&self.state.storage(), move || {
            if let Some(seen) = seen(&sql, &key)? {
                let mut answer: AdmitAnswer = serde_json::from_str(&seen)?;
                answer.replayed = true;
                return Ok(answer);
            }
            let counts = counts(&sql, &day)?;
            if let Err(refusal) = admission::admit_sandbox(req.kind, counts, read_flag(&sql)?, caps)
            {
                return Ok(refused(refusal));
            }
            bump(&sql, &day, SANDBOXES)?;
            if req.kind == SandboxKind::Guest {
                bump(&sql, &day, GUEST_SANDBOXES)?;
            }
            let kind = match req.kind {
                SandboxKind::Guest => "guest",
                SandboxKind::Account => "account",
            };
            exec(
                &sql,
                "INSERT INTO sandboxes (id, kind, created_at) VALUES (?, ?, ?)",
                vec![
                    req.sandbox_id.to_string().into(),
                    kind.into(),
                    now.to_string().into(),
                ],
            )?;
            let answer = AdmitAnswer {
                admitted: true,
                sandbox_id: Some(req.sandbox_id),
                replayed: false,
                reason: None,
            };
            remember(&sql, &key, &day, &serde_json::to_string(&answer)?)?;
            Ok(answer)
        })
    }

    /// Counts one more demo account for today if the flag and the cap allow it, in one
    /// transaction with the replay check, as `admit` does.
    fn admit_demo(&self, req: AdmitDemoRequest, now: WallTime) -> Result<AdmitDemoAnswer> {
        let sql = self.sql();
        let day = now.utc_day();
        let caps = self.caps();
        let key = format!("demo:{}", req.key);
        transaction_sync(&self.state.storage(), move || {
            if let Some(seen) = seen(&sql, &key)? {
                let mut answer: AdmitDemoAnswer = serde_json::from_str(&seen)?;
                answer.replayed = true;
                return Ok(answer);
            }
            let counts = counts(&sql, &day)?;
            if let Err(refusal) = admission::admit_demo_account(counts, read_flag(&sql)?, caps) {
                return Ok(AdmitDemoAnswer {
                    admitted: false,
                    username: None,
                    replayed: false,
                    reason: Some(refusal.slug().to_owned()),
                });
            }
            bump(&sql, &day, DEMO_ACCOUNTS)?;
            let answer = AdmitDemoAnswer {
                admitted: true,
                username: Some(req.username),
                replayed: false,
                reason: None,
            };
            remember(&sql, &key, &day, &serde_json::to_string(&answer)?)?;
            Ok(answer)
        })
    }

    /// Grants a starting `Simulator` what is left of the sandbox's minutes today, at most what it
    /// asked for, and charges the grant at once: the replay check, the read and the write are one
    /// transaction, so two starts cannot both take the last minutes.
    fn reserve_traffic(&self, req: ReserveTraffic, now: WallTime) -> Result<TrafficGrant> {
        let sql = self.sql();
        let day = now.utc_day();
        let cap = traffic_minutes_cap(&self.env);
        let key = format!("traffic:{}", req.key);
        transaction_sync(&self.state.storage(), move || {
            if let Some(seen) = seen(&sql, &key)? {
                return Ok(serde_json::from_str(&seen)?);
            }
            let sandbox = req.sandbox.to_string();
            let used = traffic_used(&sql, &day, &sandbox)?;
            let granted = req.minutes.min(cap.saturating_sub(used));
            if granted > 0 {
                exec(
                    &sql,
                    "INSERT INTO traffic (day, sandbox, minutes) VALUES (?, ?, ?)
                     ON CONFLICT (day, sandbox) DO UPDATE SET minutes = minutes + excluded.minutes",
                    vec![
                        day.as_str().into(),
                        sandbox.as_str().into(),
                        i64::from(granted).into(),
                    ],
                )?;
            }
            let answer = TrafficGrant {
                granted,
                used: used + granted,
                cap,
            };
            remember(&sql, &key, &day, &serde_json::to_string(&answer)?)?;
            Ok(answer)
        })
    }

    /// Gives back the minutes a stopped run did not use, once per key, never below zero.
    fn settle_traffic(&self, req: SettleTraffic) -> Result<TrafficGrant> {
        let sql = self.sql();
        let cap = traffic_minutes_cap(&self.env);
        let key = format!("settle:{}", req.key);
        transaction_sync(&self.state.storage(), move || {
            if let Some(seen) = seen(&sql, &key)? {
                return Ok(serde_json::from_str(&seen)?);
            }
            let sandbox = req.sandbox.to_string();
            exec(
                &sql,
                "UPDATE traffic SET minutes = max(0, minutes - ?) WHERE day = ? AND sandbox = ?",
                vec![
                    i64::from(req.unused).into(),
                    req.day.as_str().into(),
                    sandbox.as_str().into(),
                ],
            )?;
            let answer = TrafficGrant {
                granted: 0,
                used: traffic_used(&sql, &req.day, &sandbox)?,
                cap,
            };
            remember(&sql, &key, &req.day, &serde_json::to_string(&answer)?)?;
            Ok(answer)
        })
    }

    /// The day's salt, drawn on the first request of a UTC day and never written down.
    fn salt(&self, now: WallTime) -> Result<Salt> {
        let day = now.utc_day();
        let mut slot = self.salt.borrow_mut();
        let fresh = !matches!(&*slot, Some((d, _)) if *d == day);
        if fresh {
            *slot = Some((day.clone(), random::bytes::<32>()?));
        }
        let (_, salt) = slot.as_ref().expect("filled above");
        Ok(Salt {
            day,
            salt: hex(salt),
        })
    }

    /// A Sandbox reports its own wipe. A row already marked keeps its first time.
    fn wiped(&self, w: &Wiped, now: WallTime) -> Result<()> {
        exec(
            &self.sql(),
            "UPDATE sandboxes SET wiped_at = coalesce(wiped_at, ?), objects = ?, rows_deleted = ?
             WHERE id = ?",
            vec![
                now.to_string().into(),
                i64::from(w.objects).into(),
                i64::try_from(w.rows_deleted).unwrap_or(i64::MAX).into(),
                w.id.to_string().into(),
            ],
        )?;
        console_log!(
            "{{\"event\":\"sandbox_wiped\",\"objects\":{},\"rows_deleted\":{}}}",
            w.objects,
            w.rows_deleted
        );
        Ok(())
    }

    /// The 10:00 UTC cron: every sandbox not yet wiped is due now, and the fan-out starts.
    /// The cron returns at once; the alarm does the work.
    async fn stamp_wipe(&self, now: WallTime) -> Result<Stamped> {
        let stamped = exec(
            &self.sql(),
            "UPDATE sandboxes SET wipe_due = ? WHERE wiped_at IS NULL",
            vec![now.to_string().into()],
        )?;
        exec(
            &self.sql(),
            "INSERT OR IGNORE INTO wipe_runs (started_at) VALUES (?)",
            vec![now.to_string().into()],
        )?;
        self.start_fan_out(now).await?;
        console_log!("{{\"event\":\"wipe_stamped\",\"rows\":{stamped}}}");
        Ok(Stamped {
            stamped: u32::try_from(stamped).unwrap_or(u32::MAX),
        })
    }

    /// The 15-minute cron: rows whose wipe came due and did not finish, and rows an operator
    /// asked to wipe, are due again. With nothing outstanding it writes nothing.
    async fn sweep(&self, now: WallTime) -> Result<Stamped> {
        let stamped = exec(
            &self.sql(),
            "UPDATE sandboxes SET wipe_due = ?
             WHERE wiped_at IS NULL
               AND ((wipe_due IS NOT NULL AND wipe_due <= ?) OR wipe_requested_at IS NOT NULL)",
            vec![now.to_string().into(), now.to_string().into()],
        )?;
        if stamped > 0 {
            self.start_fan_out(now).await?;
        }
        let past_wipe = self.store_past_wipe(now)?;
        console_log!("{{\"event\":\"sweep\",\"rows\":{stamped},\"past_wipe\":{past_wipe}}}");
        Ok(Stamped {
            stamped: u32::try_from(stamped).unwrap_or(u32::MAX),
        })
    }

    /// The sweep's count of sandboxes past their wipe at `now`, stored with `now` for
    /// `GET /status`. Only unwiped rows are read: at most the day's sandboxes when the wipe works.
    /// A row whose `created_at` cannot be read is counted, since nothing shows it is not late.
    fn store_past_wipe(&self, now: WallTime) -> Result<u32> {
        #[derive(Deserialize)]
        struct Unwiped {
            created_at: String,
        }
        let sql = self.sql();
        let unwiped: Vec<Unwiped> = rows(
            &sql,
            "SELECT created_at FROM sandboxes WHERE wiped_at IS NULL",
            vec![],
        )?;
        let mut unreadable = 0u32;
        let born: Vec<(WallTime, bool)> = unwiped
            .iter()
            .filter_map(|r| match r.created_at.parse::<WallTime>() {
                Ok(at) => Some((at, false)),
                Err(_) => {
                    unreadable += 1;
                    None
                }
            })
            .collect();
        let count = count_past_wipe(born, now).saturating_add(unreadable);
        exec(
            &sql,
            "INSERT INTO past_wipe (id, count, counted_at) VALUES (1, ?, ?)
             ON CONFLICT (id) DO UPDATE SET count = excluded.count,
               counted_at = excluded.counted_at",
            vec![i64::from(count).into(), now.to_string().into()],
        )?;
        Ok(count)
    }

    async fn start_fan_out(&self, now: WallTime) -> Result<()> {
        self.set_timer(FANOUT, now)?;
        self.arm_earliest(now).await
    }

    /// One run: up to 50 due sandboxes, one `Sandbox /_wipe` each. Each row is tried once per
    /// `wipe_due`; a failure waits for the sweep. The run re-arms only while a full batch
    /// suggests more remain, and never past the daily guard.
    async fn fan_out(&self, now: WallTime) -> Result<()> {
        let sql = self.sql();
        let due: Vec<IdRow> = rows(
            &sql,
            "SELECT id FROM sandboxes
             WHERE wiped_at IS NULL AND wipe_due IS NOT NULL AND wipe_due <= ?
               AND (wipe_attempted_at IS NULL OR wipe_attempted_at < wipe_due)
             ORDER BY created_at LIMIT ?",
            vec![now.to_string().into(), (WIPES_PER_RUN as i64).into()],
        )?;
        let mut wiped = 0u32;
        let mut failed = 0u32;
        for row in &due {
            exec(
                &sql,
                "UPDATE sandboxes SET wipe_attempted_at = ? WHERE id = ?",
                vec![now.to_string().into(), row.id.as_str().into()],
            )?;
            match self.wipe_one(&row.id).await {
                Ok(()) => {
                    exec(
                        &sql,
                        "UPDATE sandboxes SET wiped_at = coalesce(wiped_at, ?) WHERE id = ?",
                        vec![now.to_string().into(), row.id.as_str().into()],
                    )?;
                    wiped += 1;
                }
                Err(e) => {
                    failed += 1;
                    console_log!("{{\"event\":\"wipe_error\",\"error\":{:?}}}", e.to_string());
                }
            }
        }
        console_log!(
            "{{\"type\":\"wipe\",\"event\":\"wipe_summary\",\"wiped\":{wiped},\"failed\":{failed}}}"
        );
        if due.len() == WIPES_PER_RUN {
            let day = now.utc_day();
            if read_meter(&sql, &day, ALARM_REARMS)? >= REARM_GUARD {
                console_log!("{{\"event\":\"alarm_guard\",\"object\":\"control\"}}");
                self.finish_wipe_run()?;
                return Ok(());
            }
            bump(&sql, &day, ALARM_REARMS)?;
            let next = WallTime::from_unix_ms(now.unix_ms() + FANOUT_GAP_MS)
                .map_err(|e| Error::RustError(e.to_string()))?;
            self.set_timer(FANOUT, next)?;
        } else {
            self.finish_wipe_run()?;
        }
        Ok(())
    }

    /// The nightly wipe's end: its last fan-out run closes the open `wipe_runs` row and writes
    /// the `wipe` point with the sandboxes it ended, their objects and the milliseconds since
    /// the 10:00 UTC cron. A sweep's retry with no open run writes nothing. The end time is the
    /// Clock port's, read after the run's subrequests.
    fn finish_wipe_run(&self) -> Result<()> {
        #[derive(Deserialize)]
        struct Run {
            started_at: String,
        }
        #[derive(Deserialize)]
        struct Totals {
            sandboxes: i64,
            objects: Option<i64>,
        }
        let sql = self.sql();
        let Some(run): Option<Run> = first(
            &sql,
            "SELECT started_at FROM wipe_runs WHERE finished_at IS NULL
             ORDER BY started_at DESC LIMIT 1",
            vec![],
        )?
        else {
            return Ok(());
        };
        let end = SystemClock::new().now_wall();
        let totals: Option<Totals> = first(
            &sql,
            "SELECT count(*) AS sandboxes, sum(objects) AS objects FROM sandboxes
             WHERE wiped_at IS NOT NULL AND wipe_due IS NOT NULL AND wipe_due >= ?",
            vec![run.started_at.as_str().into()],
        )?;
        exec(
            &sql,
            "UPDATE wipe_runs SET finished_at = ? WHERE finished_at IS NULL",
            vec![end.to_string().into()],
        )?;
        let (sandboxes, objects) = totals.map_or((0, 0), |t| (t.sandboxes, t.objects.unwrap_or(0)));
        let ms = run
            .started_at
            .parse::<WallTime>()
            .map_or(0, |s| end.unix_ms() - s.unix_ms());
        let sandboxes = u32::try_from(sandboxes).unwrap_or(u32::MAX);
        let objects = u32::try_from(objects).unwrap_or(u32::MAX);
        let ms = u64::try_from(ms).unwrap_or(0);
        metrics::write(&self.env, &Point::wipe(sandboxes, objects, ms));
        console_log!(
            "{{\"event\":\"wipe_point\",\"sandboxes\":{sandboxes},\"objects\":{objects},\"ms\":{ms}}}"
        );
        Ok(())
    }

    async fn wipe_one(&self, id: &str) -> Result<()> {
        let id: Ulid = id
            .parse()
            .map_err(|_| Error::RustError("bad sandbox id".into()))?;
        let res = sql::call(
            &self.env,
            sandbox::BINDING,
            &sandbox_object_name(id),
            Method::Post,
            "/_wipe",
            Some(&WipeRequest {
                cause: "nightly".into(),
            }),
        )
        .await?;
        match res.status_code() {
            200 => Ok(()),
            code => Err(Error::RustError(format!("sandbox /_wipe answered {code}"))),
        }
    }

    fn prune(&self, now: WallTime) -> Result<Pruned> {
        let before = now
            .plus_days(-LEDGER_DAYS)
            .map_err(|e| Error::RustError(e.to_string()))?
            .utc_day();
        let sql = self.sql();
        let deleted = exec(
            &sql,
            "DELETE FROM ledger WHERE day < ?",
            vec![before.as_str().into()],
        )? + exec(
            &sql,
            "DELETE FROM creations_seen WHERE day < ?",
            vec![before.as_str().into()],
        )? + exec(
            &sql,
            "DELETE FROM traffic WHERE day < ?",
            vec![before.as_str().into()],
        )? + exec(
            &sql,
            "DELETE FROM sandboxes WHERE created_at < ? AND wiped_at IS NOT NULL",
            vec![before.as_str().into()],
        )? + exec(
            &sql,
            "DELETE FROM wipe_runs WHERE started_at < ? AND finished_at IS NOT NULL",
            vec![before.as_str().into()],
        )?;
        Ok(Pruned {
            before,
            deleted: u32::try_from(deleted).unwrap_or(u32::MAX),
        })
    }
}

fn refused(refusal: Refusal) -> AdmitAnswer {
    AdmitAnswer {
        admitted: false,
        sandbox_id: None,
        replayed: false,
        reason: Some(refusal.slug().to_owned()),
    }
}

fn seen(sql: &SqlStorage, key: &str) -> Result<Option<String>> {
    let row: Option<ResultRow> = first(
        sql,
        "SELECT result FROM creations_seen WHERE key = ?",
        vec![key.into()],
    )?;
    Ok(row.map(|r| r.result))
}

fn remember(sql: &SqlStorage, key: &str, day: &str, result: &str) -> Result<()> {
    exec(
        sql,
        "INSERT INTO creations_seen (key, day, result) VALUES (?, ?, ?)",
        vec![key.into(), day.into(), result.into()],
    )?;
    Ok(())
}

fn counts(sql: &SqlStorage, day: &str) -> Result<Counts> {
    Ok(Counts {
        sandboxes_today: read_meter(sql, day, SANDBOXES)?,
        guests_today: read_meter(sql, day, GUEST_SANDBOXES)?,
        demo_accounts_today: read_meter(sql, day, DEMO_ACCOUNTS)?,
    })
}

fn bump(sql: &SqlStorage, day: &str, meter: &str) -> Result<()> {
    exec(
        sql,
        "INSERT INTO ledger (day, meter, value) VALUES (?, ?, 1)
         ON CONFLICT (day, meter) DO UPDATE SET value = value + 1",
        vec![day.into(), meter.into()],
    )?;
    Ok(())
}

#[derive(Deserialize)]
struct ValueRow {
    value: i64,
}

#[derive(Deserialize)]
struct ModeRow {
    mode: String,
}

/// A sandbox's minutes of traffic charged on `day`; none is 0.
fn traffic_used(sql: &SqlStorage, day: &str, sandbox: &str) -> Result<u16> {
    #[derive(Deserialize)]
    struct Minutes {
        minutes: i64,
    }
    let row: Option<Minutes> = first(
        sql,
        "SELECT minutes FROM traffic WHERE day = ? AND sandbox = ?",
        vec![day.into(), sandbox.into()],
    )?;
    Ok(u16::try_from(row.map_or(0, |r| r.minutes)).unwrap_or(u16::MAX))
}

#[derive(Deserialize)]
struct SnapshotRow {
    as_of: Option<String>,
    json: Option<String>,
    failed_at: Option<String>,
}

/// The stored snapshot: its counters (unreadable JSON reads as none), their time and the last
/// failure's.
struct Snapshot {
    counters: Option<StatusCounters>,
    as_of: String,
    failed_at: Option<String>,
}

fn read_snapshot(sql: &SqlStorage) -> Result<Option<Snapshot>> {
    let row: Option<SnapshotRow> = first(
        sql,
        "SELECT as_of, json, failed_at FROM status_snapshot WHERE id = 1",
        vec![],
    )?;
    Ok(row.map(|r| Snapshot {
        counters: r.json.as_deref().and_then(|j| serde_json::from_str(j).ok()),
        as_of: r.as_of.unwrap_or_default(),
        failed_at: r.failed_at,
    }))
}

/// The sweep's stored count and its time; `None` before the first sweep, or when the time does
/// not read.
fn read_past_wipe(sql: &SqlStorage) -> Result<Option<(u32, WallTime)>> {
    #[derive(Deserialize)]
    struct Row {
        count: i64,
        counted_at: String,
    }
    let row: Option<Row> = first(
        sql,
        "SELECT count, counted_at FROM past_wipe WHERE id = 1",
        vec![],
    )?;
    Ok(row.and_then(|r| {
        let at = r.counted_at.parse::<WallTime>().ok()?;
        Some((u32::try_from(r.count).unwrap_or(u32::MAX), at))
    }))
}

#[derive(Deserialize)]
struct BreakerRow {
    state: String,
    since: Option<String>,
    last_run: Option<String>,
    last_usd: Option<String>,
    unread: Option<String>,
    rule_enabled_at: Option<String>,
}

/// The stored breaker: `unconfigured` with nothing else before its first run.
struct StoredBreaker {
    state: BreakerState,
    since: Option<String>,
    last_run: Option<String>,
    last_usd: Option<String>,
    unread: Vec<String>,
    rule_enabled_at: Option<String>,
}

impl StoredBreaker {
    fn status(self) -> BreakerStatus {
        BreakerStatus {
            state: self.state,
            since: self.since,
            last_run: self.last_run,
            last_usd: self.last_usd,
            unread: self.unread,
        }
    }
}

/// The breaker's row; an unreadable state reads as `off`, as the flag fails closed, so a run
/// cannot lower it.
fn read_breaker(sql: &SqlStorage) -> Result<StoredBreaker> {
    let row: Option<BreakerRow> = first(
        sql,
        "SELECT state, since, last_run, last_usd, unread, rule_enabled_at
         FROM breaker_state WHERE id = 1",
        vec![],
    )?;
    Ok(match row {
        None => StoredBreaker {
            state: BreakerState::Unconfigured,
            since: None,
            last_run: None,
            last_usd: None,
            unread: Vec::new(),
            rule_enabled_at: None,
        },
        Some(r) => StoredBreaker {
            state: BreakerState::parse(&r.state).unwrap_or(BreakerState::Off),
            since: r.since,
            last_run: r.last_run,
            last_usd: r.last_usd,
            unread: r
                .unread
                .as_deref()
                .and_then(|u| serde_json::from_str(u).ok())
                .unwrap_or_default(),
            rule_enabled_at: r.rule_enabled_at,
        },
    })
}

/// A missing row counts as 0.
fn read_meter(sql: &SqlStorage, day: &str, meter: &str) -> Result<u32> {
    let row: Option<ValueRow> = first(
        sql,
        "SELECT value FROM ledger WHERE day = ? AND meter = ?",
        vec![day.into(), meter.into()],
    )?;
    Ok(u32::try_from(row.map_or(0, |r| r.value)).unwrap_or(u32::MAX))
}

/// A missing or unreadable flag reads as `off`: fail closed.
fn read_flag(sql: &SqlStorage) -> Result<Flag> {
    let row: Option<ModeRow> = first(sql, "SELECT mode FROM flags WHERE demo = 'bakery'", vec![])?;
    Ok(row.and_then(|r| Flag::parse(&r.mode)).unwrap_or(Flag::Off))
}

// The router's and the cron's handles on the one `Control` object.

async fn ask<B: Serialize, T: serde::de::DeserializeOwned>(
    env: &Env,
    method: Method,
    path: &str,
    body: Option<&B>,
) -> Result<T> {
    let mut res = sql::call(env, BINDING, CONTROL, method, path, body).await?;
    let status = res.status_code();
    // Read to its end whatever the status: the Queue's consumer asks the flag here, and an
    // answer's body left unread can hold its invocation open (queue.rs, `call`).
    let text = res.text().await?;
    if status != 200 {
        return Err(Error::RustError(format!(
            "control {path} answered {status}"
        )));
    }
    Ok(serde_json::from_str(&text)?)
}

pub async fn status(env: &Env) -> Result<StatusResponse> {
    ask::<(), _>(env, Method::Get, "/status", None).await
}

pub async fn flag(env: &Env) -> Result<Flag> {
    ask::<(), FlagAnswer>(env, Method::Get, "/flag", None)
        .await
        .map(|a| a.flag)
}

pub async fn salt(env: &Env) -> Result<Salt> {
    ask::<(), _>(env, Method::Get, "/salt", None).await
}

pub async fn admit(env: &Env, req: &AdmitRequest) -> Result<AdmitAnswer> {
    ask(env, Method::Post, "/admit", Some(req)).await
}

pub async fn admit_demo(env: &Env, req: &AdmitDemoRequest) -> Result<AdmitDemoAnswer> {
    ask(env, Method::Post, "/admit-demo", Some(req)).await
}

pub async fn wiped(env: &Env, w: &Wiped) -> Result<()> {
    ask::<_, serde_json::Value>(env, Method::Post, "/wiped", Some(w))
        .await
        .map(|_| ())
}

pub async fn reserve_traffic(env: &Env, req: &ReserveTraffic) -> Result<TrafficGrant> {
    ask(env, Method::Post, "/reserve-traffic", Some(req)).await
}

pub async fn settle_traffic(env: &Env, req: &SettleTraffic) -> Result<TrafficGrant> {
    ask(env, Method::Post, "/settle-traffic", Some(req)).await
}

pub async fn wipe(env: &Env) -> Result<Stamped> {
    ask::<(), _>(env, Method::Post, "/wipe", None).await
}

pub async fn sweep(env: &Env) -> Result<Stamped> {
    ask::<(), _>(env, Method::Post, "/sweep", None).await
}

pub async fn store_snapshot(env: &Env, s: &StatusSnapshot) -> Result<()> {
    ask::<_, serde_json::Value>(env, Method::Post, "/status-snapshot", Some(s))
        .await
        .map(|_| ())
}

pub async fn breaker(env: &Env, run: &BreakerRun) -> Result<BreakerAnswer> {
    ask(env, Method::Post, "/breaker", Some(run)).await
}

pub async fn breaker_rule(env: &Env, r: &BreakerRuleEnabled) -> Result<()> {
    ask::<_, serde_json::Value>(env, Method::Post, "/breaker-rule", Some(r))
        .await
        .map(|_| ())
}

pub async fn snapshot_failed(env: &Env, f: &SnapshotFailed) -> Result<()> {
    ask::<_, serde_json::Value>(env, Method::Post, "/status-failed", Some(f))
        .await
        .map(|_| ())
}
