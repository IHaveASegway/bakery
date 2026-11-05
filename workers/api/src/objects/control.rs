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

use std::cell::{Cell, RefCell};

use bakery_app::Clock;
use bakery_app::admission::{self, Caps, Counts, Refusal};
use bakery_app::auth::hex;
use bakery_app::names::{CONTROL, sandbox_object_name};
use bakery_contracts::{Flag, SandboxKind, StatusResponse};
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
use crate::random;

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
        Ok(StatusResponse {
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

    /// Admits one sandbox if the flag and the caps allow it: the replay check, the read, the
    /// decision and the writes are one SQL transaction, so two requests can never both take
    /// the last place and a retried key never takes a second.
    fn admit(&self, req: AdmitRequest, now: WallTime) -> Result<AdmitAnswer> {
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
        console_log!("{{\"event\":\"sweep\",\"rows\":{stamped}}}");
        Ok(Stamped {
            stamped: u32::try_from(stamped).unwrap_or(u32::MAX),
        })
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
                return Ok(());
            }
            bump(&sql, &day, ALARM_REARMS)?;
            let next = WallTime::from_unix_ms(now.unix_ms() + FANOUT_GAP_MS)
                .map_err(|e| Error::RustError(e.to_string()))?;
            self.set_timer(FANOUT, next)?;
        }
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
    if res.status_code() != 200 {
        return Err(Error::RustError(format!(
            "control {path} answered {}",
            res.status_code()
        )));
    }
    res.json().await
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
