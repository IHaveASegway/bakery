//! `Sandbox`, one per visitor's sandbox, named `sandbox:<ULID>` (docs/domain.md, "Sandbox").
//! It holds the lifecycle, the seed, the business clock's offset, the fault switches and the
//! registry of children, so the wipe has one place to start.
//!
//! A `Sandbox` with no `meta` row answers 410 to everything but `/_create`, so a request after
//! the wipe, or for a guessed id, summons nothing and writes nothing. Its one alarm serves two
//! timers: the wipe at the first 10:00 UTC after birth, and the backstop 36 h after birth.

use std::cell::Cell;

use bakery_app::Clock;
use bakery_app::wipe::{backstop_at, next_wipe_at};
use bakery_contracts::{
    FaultName, Faults, FaultsResponse, SandboxKind, SandboxResponse, SandboxState,
};
use bakery_domain::{ENVELOPE_VERSION, Envelope, Ulid, WallTime};
use bakery_seed::{BirthDate, Generator, Seed};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::control::{self, Wiped};
use super::sql::{
    self, exec, first, gone, has_table, json, refuse, rows, transaction_sync, user_rows,
};
use crate::clock::{SystemClock, alarm_time, business};
use crate::random;

pub const BINDING: &str = "SANDBOX";

/// Which binding wipes a registered child, by class. PR 4 adds the children's classes; until
/// then the table names only `Sandbox`, and the registry is empty.
const DISPATCH: &[(&str, &str)] = &[("Sandbox", BINDING)];

const WIPE: &str = "wipe";
const BACKSTOP: &str = "backstop";

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS meta (
       id TEXT NOT NULL,
       owner TEXT NOT NULL,
       kind TEXT NOT NULL CHECK (kind IN ('guest','account')),
       seed INTEGER NOT NULL,
       born TEXT NOT NULL,
       wipe_at TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN ('seeding','live','wiping')),
       clock_offset_s INTEGER NOT NULL DEFAULT 0,
       clock_v INTEGER NOT NULL DEFAULT 0,
       token_v INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS registry (
       name TEXT PRIMARY KEY,
       class TEXT NOT NULL,
       registered_at TEXT NOT NULL,
       clock_v INTEGER NOT NULL,
       wiped_at TEXT)",
    "CREATE TABLE IF NOT EXISTS faults (name TEXT PRIMARY KEY, \"on\" INTEGER NOT NULL)",
    // docs/architecture.md, "Events and the outbox".
    "CREATE TABLE IF NOT EXISTS events (
       seq INTEGER PRIMARY KEY,
       id TEXT NOT NULL UNIQUE,
       type TEXT NOT NULL,
       at TEXT NOT NULL,
       recorded_at TEXT NOT NULL,
       data TEXT NOT NULL,
       cause TEXT)",
    "CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY, envelope TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS commands_seen (key TEXT PRIMARY KEY, result TEXT NOT NULL, at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS timers (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, due_wall TEXT NOT NULL)",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRequest {
    pub id: Ulid,
    /// `guest:<ULID>` or `account:<hex>` (bakery_app::names).
    pub owner: String,
    pub kind: SandboxKind,
    pub seed: u64,
    pub born: WallTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WipeRequest {
    /// `nightly`, `wipe-now`, `replace`, `timer` or `backstop`: a code, for the log.
    pub cause: String,
}

/// `/_wipe`'s answer. `already` is true when there was nothing left: the wipe is idempotent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WipeAnswer {
    pub already: bool,
    pub objects: u32,
    pub rows_deleted: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub name: String,
    pub class: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaultCommand {
    /// The command's `Idempotency-Key`.
    pub key: String,
    pub fault: FaultName,
    pub on: bool,
}

#[derive(Deserialize)]
struct MetaRow {
    id: String,
    owner: String,
    kind: String,
    seed: i64,
    born: String,
    wipe_at: String,
    state: String,
    clock_offset_s: i64,
    clock_v: i64,
    token_v: i64,
}

#[derive(Deserialize)]
struct FaultRow {
    name: String,
    on: i64,
}

#[derive(Deserialize)]
struct ChildRow {
    name: String,
    class: String,
}

#[derive(Deserialize)]
struct SeqRow {
    seq: Option<i64>,
}

#[derive(Deserialize)]
struct ResultRow {
    result: String,
}

#[derive(Deserialize)]
struct TimerRow {
    purpose: String,
    due_wall: String,
}

#[durable_object]
pub struct Sandbox {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
}

impl DurableObject for Sandbox {
    fn new(state: State, env: Env) -> Self {
        Sandbox {
            state,
            env,
            schema_ready: Cell::new(false),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/_create") => {
                let body: CreateRequest = sql::body(&mut req).await?;
                self.create(body, now).await
            }
            (Method::Post, "/_wipe") => {
                let body: WipeRequest = sql::body(&mut req).await?;
                json(&self.wipe(&body.cause).await?, 200)
            }
            (method, path) => {
                let Some(meta) = self.meta()? else {
                    return gone();
                };
                match (method, path) {
                    (Method::Get, "/_state") => json(&self.response(&meta)?, 200),
                    (Method::Post, "/_register") => {
                        let body: RegisterRequest = sql::body(&mut req).await?;
                        self.register(&meta, body, now)
                    }
                    (Method::Post, "/_faults") => {
                        let body: FaultCommand = sql::body(&mut req).await?;
                        self.set_fault(&meta, body, now)
                    }
                    _ => refuse(404, "not-found"),
                }
            }
        }
    }

    /// The sandbox's own timers. Either one wipes; a wiped sandbox has no timers and no data,
    /// so a late alarm only makes sure of it.
    async fn alarm(&self) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        if !has_table(&self.sql(), "timers")? {
            self.state.storage().delete_all().await?;
            return Response::empty();
        }
        let timers: Vec<TimerRow> =
            rows(&self.sql(), "SELECT purpose, due_wall FROM timers", vec![])?;
        let due = timers
            .iter()
            .find(|t| t.due_wall.parse::<WallTime>().is_ok_and(|at| at <= now));
        if let Some(timer) = due {
            let cause = if timer.purpose == BACKSTOP {
                BACKSTOP
            } else {
                "timer"
            };
            self.wipe(cause).await?;
        } else {
            self.arm_earliest(now).await?;
        }
        Response::empty()
    }
}

impl Sandbox {
    fn sql(&self) -> SqlStorage {
        self.state.storage().sql()
    }

    fn meta(&self) -> Result<Option<MetaRow>> {
        if !has_table(&self.sql(), "meta")? {
            return Ok(None);
        }
        first(
            &self.sql(),
            "SELECT id, owner, kind, seed, born, wipe_at, state, clock_offset_s, clock_v, token_v FROM meta",
            vec![],
        )
    }

    /// Re-arms for the earliest timer later than now, if any. Never for a time already past,
    /// so the alarm cannot loop.
    async fn arm_earliest(&self, now: WallTime) -> Result<()> {
        let timers: Vec<TimerRow> =
            rows(&self.sql(), "SELECT purpose, due_wall FROM timers", vec![])?;
        let next = timers
            .iter()
            .filter_map(|t| t.due_wall.parse::<WallTime>().ok())
            .filter(|at| *at > now)
            .min();
        match next {
            Some(at) => self.state.storage().set_alarm(alarm_time(at)).await,
            None => Ok(()),
        }
    }

    /// Writes `meta` first, then the seed's summary as `SandboxSeeded` in the events and the
    /// outbox, then the two timers, all in one transaction. Only the seed's row counts are
    /// stored: the whole generated sandbox is about 580 KB of JSON and is recomputed from the
    /// seed whenever a child needs it. A repeat with the same id and owner answers the state.
    async fn create(&self, body: CreateRequest, now: WallTime) -> Result<Response> {
        if let Some(meta) = self.meta()? {
            if meta.id == body.id.to_string() && meta.owner == body.owner {
                return json(&self.response(&meta)?, 200);
            }
            return refuse(409, "identity");
        }
        let birth_date = business(body.born).to_string();
        let born = BirthDate::parse(&birth_date[..10])
            .map_err(|e| Error::RustError(format!("birth date: {e}")))?;
        let rows = Generator::new(Seed(body.seed), born).generate().rows;
        let wipe_at = next_wipe_at(body.born).map_err(|e| Error::RustError(e.to_string()))?;
        let backstop = backstop_at(body.born).map_err(|e| Error::RustError(e.to_string()))?;
        let event_id = random::ulid(now)?;
        let envelope = Envelope {
            v: ENVELOPE_VERSION,
            id: event_id,
            sandbox: body.id,
            stream: bakery_app::names::sandbox_object_name(body.id),
            seq: 1,
            event_type: "SandboxSeeded".into(),
            at: business(now),
            recorded_at: now,
            data: serde_json::json!({ "seed": body.seed, "born": body.born, "rows": rows }),
            cause: None,
        };
        if !self.schema_ready.get() {
            for statement in SCHEMA {
                self.sql().exec(statement, None)?;
            }
            self.schema_ready.set(true);
        }
        let sql = self.sql();
        let kind = kind_text(body.kind);
        let seed =
            i64::try_from(body.seed).map_err(|_| Error::RustError("seed over 2^63".into()))?;
        transaction_sync(&self.state.storage(), move || {
            exec(
                &sql,
                "INSERT INTO meta (id, owner, kind, seed, born, wipe_at, state)
                 VALUES (?, ?, ?, ?, ?, ?, 'live')",
                vec![
                    body.id.to_string().into(),
                    body.owner.into(),
                    kind.into(),
                    seed.into(),
                    body.born.to_string().into(),
                    wipe_at.to_string().into(),
                ],
            )?;
            exec(
                &sql,
                "INSERT INTO faults (name, \"on\") VALUES ('inbox', 0)",
                vec![],
            )?;
            append(&sql, &envelope)?;
            for (purpose, at) in [(WIPE, wipe_at), (BACKSTOP, backstop)] {
                exec(
                    &sql,
                    "INSERT INTO timers (id, purpose, due_wall) VALUES (?, ?, ?)",
                    vec![purpose.into(), purpose.into(), at.to_string().into()],
                )?;
            }
            Ok(())
        })?;
        self.state.storage().set_alarm(alarm_time(wipe_at)).await?;
        let meta = self
            .meta()?
            .ok_or_else(|| Error::RustError("meta not written".into()))?;
        json(&self.response(&meta)?, 201)
    }

    fn faults(&self) -> Result<Faults> {
        let rows: Vec<FaultRow> = rows(&self.sql(), "SELECT name, \"on\" FROM faults", vec![])?;
        Ok(Faults {
            inbox: rows.iter().any(|r| r.name == "inbox" && r.on != 0),
        })
    }

    fn response(&self, meta: &MetaRow) -> Result<SandboxResponse> {
        #[derive(Deserialize)]
        struct N {
            n: i64,
        }
        let children: Option<N> = first(&self.sql(), "SELECT count(*) AS n FROM registry", vec![])?;
        Ok(SandboxResponse {
            id: meta.id.clone(),
            kind: if meta.kind == "guest" {
                SandboxKind::Guest
            } else {
                SandboxKind::Account
            },
            state: match meta.state.as_str() {
                "seeding" => SandboxState::Seeding,
                "live" => SandboxState::Live,
                _ => SandboxState::Wiping,
            },
            born: meta.born.clone(),
            wipe_at: meta.wipe_at.clone(),
            seed: u64::try_from(meta.seed).unwrap_or(0),
            clock_offset_s: meta.clock_offset_s,
            clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
            token_v: u32::try_from(meta.token_v).unwrap_or(0),
            faults: self.faults()?,
            children: u32::try_from(children.map_or(0, |c| c.n)).unwrap_or(0),
        })
    }

    /// A child is born only through here: once wiping, nothing new is registered.
    fn register(&self, meta: &MetaRow, body: RegisterRequest, now: WallTime) -> Result<Response> {
        if meta.state != "live" {
            return gone();
        }
        if !DISPATCH.iter().any(|(class, _)| *class == body.class) {
            return refuse(422, "class");
        }
        exec(
            &self.sql(),
            "INSERT OR IGNORE INTO registry (name, class, registered_at, clock_v) VALUES (?, ?, ?, ?)",
            vec![
                body.name.into(),
                body.class.into(),
                now.to_string().into(),
                meta.clock_v.into(),
            ],
        )?;
        json(
            &serde_json::json!({ "seed": meta.seed, "clock_offset_s": meta.clock_offset_s }),
            200,
        )
    }

    /// `SetFault`: the switch, its `FaultSet` event and the command's key in one transaction,
    /// so a retry with the same key gets the first answer and appends nothing.
    fn set_fault(&self, meta: &MetaRow, cmd: FaultCommand, now: WallTime) -> Result<Response> {
        if meta.state != "live" {
            return gone();
        }
        let sql = self.sql();
        if let Some(seen) = first::<ResultRow>(
            &sql,
            "SELECT result FROM commands_seen WHERE key = ?",
            vec![cmd.key.as_str().into()],
        )? {
            let mut res = Response::ok(seen.result)?;
            res.headers_mut().set("Content-Type", "application/json")?;
            res.headers_mut().set("Idempotent-Replayed", "true")?;
            return Ok(res);
        }
        let name = match cmd.fault {
            FaultName::Inbox => "inbox",
        };
        let sandbox: Ulid = meta
            .id
            .parse()
            .map_err(|_| Error::RustError("meta id".into()))?;
        let event_id = random::ulid(now)?;
        let mut faults = self.faults()?;
        match cmd.fault {
            FaultName::Inbox => faults.inbox = cmd.on,
        }
        let answer = serde_json::to_string(&FaultsResponse { faults })?;
        let stored = answer.clone();
        transaction_sync(&self.state.storage(), move || {
            exec(
                &sql,
                "UPDATE faults SET \"on\" = ? WHERE name = ?",
                vec![i64::from(cmd.on).into(), name.into()],
            )?;
            let last: Option<SeqRow> = first(&sql, "SELECT max(seq) AS seq FROM events", vec![])?;
            let seq = last.and_then(|r| r.seq).unwrap_or(0) + 1;
            append(
                &sql,
                &Envelope {
                    v: ENVELOPE_VERSION,
                    id: event_id,
                    sandbox,
                    stream: bakery_app::names::sandbox_object_name(sandbox),
                    seq: u64::try_from(seq).unwrap_or(0),
                    event_type: "FaultSet".into(),
                    at: business(now),
                    recorded_at: now,
                    data: serde_json::json!({ "fault": name, "on": cmd.on }),
                    cause: Some(cmd.key.clone()),
                },
            )?;
            exec(
                &sql,
                "INSERT INTO commands_seen (key, result, at) VALUES (?, ?, ?)",
                vec![cmd.key.into(), stored.into(), now.to_string().into()],
            )?;
            Ok(())
        })?;
        let mut res = Response::ok(answer)?;
        res.headers_mut().set("Content-Type", "application/json")?;
        Ok(res)
    }

    /// `Wipe` and `WipeNow` (docs/security.md, "The wipe", steps 2 and 4): wiping, each
    /// registered child wiped by its class's binding, the count reported to `Control`, then
    /// the alarm deleted and `delete_all`. With nothing left it answers `already` and
    /// changes nothing, so every layer of the wipe can run it again.
    async fn wipe(&self, cause: &str) -> Result<WipeAnswer> {
        let Some(meta) = self.meta()? else {
            // A wiped object holds nothing, and the platform's own alarm row goes with it.
            self.state.storage().delete_all().await?;
            return Ok(WipeAnswer {
                already: true,
                objects: 0,
                rows_deleted: 0,
            });
        };
        let sql = self.sql();
        exec(&sql, "UPDATE meta SET state = 'wiping'", vec![])?;
        let children: Vec<ChildRow> = rows(
            &sql,
            "SELECT name, class FROM registry WHERE wiped_at IS NULL",
            vec![],
        )?;
        for child in &children {
            let Some((_, binding)) = DISPATCH.iter().find(|(class, _)| *class == child.class)
            else {
                return Err(Error::RustError("a registered class has no binding".into()));
            };
            let res = sql::call(
                &self.env,
                binding,
                &child.name,
                Method::Post,
                "/_wipe",
                Some(&WipeRequest {
                    cause: cause.into(),
                }),
            )
            .await?;
            if res.status_code() != 200 {
                return Err(Error::RustError(format!(
                    "child wipe answered {}",
                    res.status_code()
                )));
            }
            exec(
                &sql,
                "UPDATE registry SET wiped_at = ? WHERE name = ?",
                vec![
                    SystemClock::new().now_wall().to_string().into(),
                    child.name.as_str().into(),
                ],
            )?;
        }
        let rows_deleted = user_rows(&sql)?;
        let objects = 1 + u32::try_from(children.len()).unwrap_or(u32::MAX);
        let id: Ulid = meta
            .id
            .parse()
            .map_err(|_| Error::RustError("meta id".into()))?;
        // Control learns of the wipe from here; if it cannot be reached, its own fan-out marks
        // the row when it next asks, and this object is empty either way.
        if let Err(e) = control::wiped(
            &self.env,
            &Wiped {
                id,
                objects,
                rows_deleted,
            },
        )
        .await
        {
            console_log!(
                "{{\"event\":\"wipe_report_error\",\"error\":{:?}}}",
                e.to_string()
            );
        }
        self.state.storage().delete_alarm().await?;
        self.state.storage().delete_all().await?;
        self.schema_ready.set(false);
        console_log!(
            "{{\"type\":\"wipe\",\"event\":\"sandbox_wipe\",\"cause\":{cause:?},\"objects\":{objects},\"rows_deleted\":{rows_deleted}}}"
        );
        Ok(WipeAnswer {
            already: false,
            objects,
            rows_deleted,
        })
    }
}

fn kind_text(kind: SandboxKind) -> &'static str {
    match kind {
        SandboxKind::Guest => "guest",
        SandboxKind::Account => "account",
    }
}

/// One event into `events` and its copy into `outbox`, inside the caller's transaction.
fn append(sql: &SqlStorage, e: &Envelope) -> Result<()> {
    let seq = i64::try_from(e.seq).map_err(|_| Error::RustError("seq".into()))?;
    exec(
        sql,
        "INSERT INTO events (seq, id, type, at, recorded_at, data, cause) VALUES (?, ?, ?, ?, ?, ?, ?)",
        vec![
            seq.into(),
            e.id.to_string().into(),
            e.event_type.as_str().into(),
            e.at.to_string().into(),
            e.recorded_at.to_string().into(),
            serde_json::to_string(&e.data)?.into(),
            match &e.cause {
                Some(c) => c.as_str().into(),
                None => worker::SqlStorageValue::Null,
            },
        ],
    )?;
    exec(
        sql,
        "INSERT INTO outbox (seq, envelope) VALUES (?, ?)",
        vec![seq.into(), serde_json::to_string(e)?.into()],
    )?;
    Ok(())
}
