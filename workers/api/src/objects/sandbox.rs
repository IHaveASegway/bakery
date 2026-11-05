//! `Sandbox`, one per visitor's sandbox, named `sandbox:<ULID>` (docs/domain.md, "Sandbox").
//! It holds the lifecycle, the seed, the business clock's offset, the fault switches, the
//! registry of children and the dead letters, so the wipe has one place to start.
//!
//! A `Sandbox` with no `meta` row answers 410 to everything but `/_create`, so a request after
//! the wipe, or for a guessed id, summons nothing and writes nothing. Its one alarm serves its
//! timers: `seed` (the first alarm, ADR 0005 decision 2), `outbox`, `clock` (children that
//! missed an advance), the wipe at the first 10:00 UTC after birth and the backstop 36 h after.
//!
//! Paths (the Worker builds them; nothing outside reaches them):
//!
//! - `POST /_create {id, owner, kind, seed, born}` → 201 `SandboxResponse` in state `seeding`.
//! - `GET /_state` → `SandboxResponse`.
//! - `POST /_register {name, class}` → `{seed, clock_offset_s, clock_v}`: a child born on first
//!   use, the Simulator. 409 `{error: "seeding"}` before seeding is done.
//! - `POST /_register-order {key}` → `{order, persona, clock_offset_s, clock_v, replayed}`:
//!   the client's `Idempotency-Key` mapped to one order ULID, registered with class `Order`.
//! - `GET /_child/<name>` → 200 `{class}` for a registered child, else 404.
//! - `POST /_faults {key, fault, on}` → `FaultsResponse`, and the Kitchen told of `kitchen`.
//! - `POST /_clock {key, minutes}` → `ClockResponse`; 422 `{error: "clock", rule}`.
//! - `POST /_delivery-error {id, error}`: the consumer's last error for an event, kept until
//!   the event is dead-lettered or the sandbox wiped.
//! - `POST /_dead-letter {envelope, error?}`: from the DLQ consumer, or from the main consumer
//!   for a poisoned message. Idempotent by event id.
//! - `GET /_dead-letters` → `[DeadLetter]`, oldest first.
//! - `POST /_redrive {key, id}` → `DeadLetter`: the stored envelope sent to the Queue again with
//!   its own id, and the row removed; 404 `{error: "unknown-dead-letter"}`.
//! - `POST /_wipe {cause}` → `WipeAnswer`.

use std::cell::Cell;

use bakery_app::Clock;
use bakery_app::wipe::{backstop_at, next_wipe_at};
use bakery_contracts::{
    ClockResponse, DeadLetter, FaultName, Faults, FaultsResponse, PersonaAddress, SandboxKind,
    SandboxResponse, SandboxState,
};
use bakery_domain::catalog::{Category, Item, Variant};
use bakery_domain::order::{Line, OrderEvent, OrderKind};
use bakery_domain::{BusinessTime, Envelope, Ulid, WallTime};
use bakery_seed::{BirthDate, Generated, Generator, OpenState, Seed};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::child::{Birth, ClockUpdate, WipeReport};
use super::control::{self, Wiped};
use super::sql::{
    self, exec, first, gone, has_table, json, refuse, replayed, rows, transaction_sync, user_rows,
};
use super::stream::{self, OUTBOX};
use super::{billing, catalog, kitchen, order, simulator};
use crate::clock::{SystemClock, alarm_time, business, business_at};
use crate::random;

pub const BINDING: &str = "SANDBOX";
pub const CLASS: &str = "Sandbox";

/// Which binding wipes, and tells of the clock, a registered child, by class. The Simulator is
/// the one class registered through `/_register`, on the first "Start traffic".
const DISPATCH: &[(&str, &str)] = &[
    (catalog::CLASS, catalog::BINDING),
    (kitchen::CLASS, kitchen::BINDING),
    (billing::CLASS, billing::BINDING),
    (order::CLASS, order::BINDING),
    (simulator::CLASS, simulator::BINDING),
];

const WIPE: &str = "wipe";
const BACKSTOP: &str = "backstop";
const SEED: &str = "seed";
const CLOCK: &str = "clock";

/// Children seeded per alarm run: the Catalog, the Kitchen, Billing and the 12 open orders take
/// three runs, each far inside the 1,000 subrequests a Free invocation may make (Workers limits,
/// https://developers.cloudflare.com/workers/platform/limits/, as of 2026-11-05).
const SEED_BATCH: usize = 7;
/// The pause between seeding runs, so a run's subrequests have finished.
const SEED_GAP_MS: i64 = 100;
/// The business clock moves at most 14 days in total (docs/domain.md, "Sandbox"; Q12 · Q-clock).
const MAX_OFFSET_S: i64 = 14 * 24 * 3_600;
/// A seeded order still waiting for payment is held this long after the sandbox is born, as a
/// new order would be (docs/domain.md, "Order": 15 minutes).
const SEED_HOLD_MINUTES: i64 = bakery_domain::order::EXPIRY_MINUTES;

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS meta (
       id TEXT NOT NULL,
       owner TEXT NOT NULL,
       kind TEXT NOT NULL CHECK (kind IN ('guest','account')),
       seed INTEGER NOT NULL,
       born TEXT NOT NULL,
       wipe_at TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN ('seeding','live','wiping')),
       persona TEXT NOT NULL,
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
    // The persona's synthetic display name and address line, from the seed, for the Payment
    // Element's billing details (ADR 0007, decision 6): read on every GET, so kept, not
    // regenerated.
    "CREATE TABLE IF NOT EXISTS persona (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       name TEXT NOT NULL,
       line1 TEXT NOT NULL)",
    // The seeding cursor: the index of the next child to seed (ADR 0005, decision 2).
    "CREATE TABLE IF NOT EXISTS seeding (id INTEGER PRIMARY KEY CHECK (id = 1), step INTEGER NOT NULL)",
    // docs/domain.md, "Idempotency": creating an aggregate maps the client's key to its ULID.
    "CREATE TABLE IF NOT EXISTS order_keys (key TEXT PRIMARY KEY, order_id TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS delivery_errors (id TEXT PRIMARY KEY, error TEXT NOT NULL, at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS dead_letters (
       id TEXT PRIMARY KEY,
       type TEXT NOT NULL,
       stream TEXT NOT NULL,
       seq INTEGER NOT NULL,
       error TEXT NOT NULL,
       at TEXT NOT NULL,
       envelope TEXT NOT NULL)",
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
pub struct RegisterOrder {
    pub key: String,
}

/// `/_register-order`'s answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderSlot {
    pub order: Ulid,
    pub persona: Ulid,
    pub clock_offset_s: i64,
    pub clock_v: u32,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaultCommand {
    /// The command's `Idempotency-Key`.
    pub key: String,
    pub fault: FaultName,
    pub on: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClockCommand {
    pub key: String,
    pub minutes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryError {
    pub id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeadLetterIn {
    /// The message body as the Queue held it: the envelope's JSON text.
    pub envelope: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Redrive {
    pub key: String,
    pub id: String,
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
    persona: String,
    clock_offset_s: i64,
    clock_v: i64,
    token_v: i64,
}

impl MetaRow {
    fn sandbox(&self) -> Result<Ulid> {
        self.id
            .parse()
            .map_err(|_| Error::RustError("meta id".into()))
    }

    fn birth(&self, name: String) -> Result<Birth> {
        Ok(Birth {
            sandbox: self.sandbox()?,
            name,
            clock_offset_s: self.clock_offset_s,
            clock_v: u32::try_from(self.clock_v).unwrap_or(0),
        })
    }
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
struct StepRow {
    step: i64,
}

#[derive(Deserialize)]
struct DeadRow {
    id: String,
    #[serde(rename = "type")]
    event_type: String,
    stream: String,
    seq: i64,
    error: String,
    at: String,
    envelope: String,
}

impl DeadRow {
    fn view(&self) -> DeadLetter {
        DeadLetter {
            id: self.id.clone(),
            event_type: self.event_type.clone(),
            stream: self.stream.clone(),
            seq: u64::try_from(self.seq).unwrap_or(0),
            error: self.error.clone(),
            at: self.at.clone(),
        }
    }
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
                    (Method::Post, "/_register-order") => {
                        let body: RegisterOrder = sql::body(&mut req).await?;
                        self.register_order(&meta, body, now)
                    }
                    (Method::Get, p) if p.starts_with("/_child/") => {
                        self.child(&p["/_child/".len()..])
                    }
                    (Method::Post, "/_faults") => {
                        let body: FaultCommand = sql::body(&mut req).await?;
                        self.set_fault(&meta, body, now).await
                    }
                    (Method::Post, "/_clock") => {
                        let body: ClockCommand = sql::body(&mut req).await?;
                        self.advance_clock(&meta, body, now).await
                    }
                    (Method::Post, "/_delivery-error") => {
                        let body: DeliveryError = sql::body(&mut req).await?;
                        exec(
                            &self.sql(),
                            "INSERT INTO delivery_errors (id, error, at) VALUES (?, ?, ?)
                             ON CONFLICT (id) DO UPDATE SET error = excluded.error, at = excluded.at",
                            vec![body.id.into(), body.error.into(), now.to_string().into()],
                        )?;
                        json(&serde_json::json!({ "ok": true }), 200)
                    }
                    (Method::Post, "/_dead-letter") => {
                        let body: DeadLetterIn = sql::body(&mut req).await?;
                        self.dead_letter(body, now)
                    }
                    (Method::Get, "/_dead-letters") => {
                        let found: Vec<DeadRow> = rows(
                            &self.sql(),
                            "SELECT id, type, stream, seq, error, at, envelope FROM dead_letters
                             ORDER BY at, id",
                            vec![],
                        )?;
                        json(&found.iter().map(DeadRow::view).collect::<Vec<_>>(), 200)
                    }
                    (Method::Post, "/_redrive") => {
                        let body: Redrive = sql::body(&mut req).await?;
                        self.redrive(body, now).await
                    }
                    _ => refuse(404, "not-found"),
                }
            }
        }
    }

    async fn alarm(&self) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let storage = self.state.storage();
        if !has_table(&self.sql(), "timers")? {
            storage.delete_all().await?;
            return Response::empty();
        }
        for timer in stream::due(&self.sql(), now)? {
            match timer.purpose.as_str() {
                WIPE | BACKSTOP => {
                    let cause = if timer.purpose == BACKSTOP {
                        BACKSTOP
                    } else {
                        "timer"
                    };
                    self.wipe(cause).await?;
                    return Response::empty();
                }
                SEED => self.seed_step(now).await?,
                OUTBOX => stream::outbox_timer(&storage, &self.env, now, CLASS).await?,
                CLOCK => self.clock_retry(now).await?,
                other => {
                    console_log!("{{\"event\":\"timer_unknown\",\"purpose\":{other:?}}}");
                    stream::delete_timer(&self.sql(), &timer.id)?;
                }
            }
        }
        if self.meta()?.is_some() {
            stream::arm(&storage, now).await?;
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
            "SELECT id, owner, kind, seed, born, wipe_at, state, persona, clock_offset_s, clock_v,
                    token_v FROM meta",
            vec![],
        )
    }

    /// The seed's whole sandbox, recomputed from the seed: about 580 KB of JSON that is never
    /// stored, only read for the rows a child needs.
    fn generated(seed: u64, born: WallTime) -> Result<Generated> {
        let birth_date = business(born).to_string();
        let date = BirthDate::parse(&birth_date[..10])
            .map_err(|e| Error::RustError(format!("birth date: {e}")))?;
        Ok(Generator::new(Seed(seed), date).generate())
    }

    /// Writes `meta` in state `seeding`, the fault switches, the cursor and the timers in one
    /// transaction, and arms the first alarm for now: seeding happens there, in batches, not in
    /// this request. A repeat with the same id and owner answers the state.
    async fn create(&self, body: CreateRequest, now: WallTime) -> Result<Response> {
        if let Some(meta) = self.meta()? {
            if meta.id == body.id.to_string() && meta.owner == body.owner {
                return json(&self.response(&meta)?, 200);
            }
            return refuse(409, "identity");
        }
        let generated = Self::generated(body.seed, body.born)?;
        let first_customer = generated
            .customers
            .first()
            .ok_or_else(|| Error::RustError("the seed has no customers".into()))?;
        let persona = first_customer.id.to_string();
        let persona_name = first_customer.display_name.clone();
        let persona_line1 = first_customer.address.line1.clone();
        let wipe_at = next_wipe_at(body.born).map_err(|e| Error::RustError(e.to_string()))?;
        let backstop = backstop_at(body.born).map_err(|e| Error::RustError(e.to_string()))?;
        if !self.schema_ready.get() {
            stream::create_schema(&self.sql(), SCHEMA)?;
            self.schema_ready.set(true);
        }
        let sql = self.sql();
        let kind = kind_text(body.kind);
        let seed =
            i64::try_from(body.seed).map_err(|_| Error::RustError("seed over 2^63".into()))?;
        transaction_sync(&self.state.storage(), move || {
            exec(
                &sql,
                "INSERT INTO meta (id, owner, kind, seed, born, wipe_at, state, persona)
                 VALUES (?, ?, ?, ?, ?, ?, 'seeding', ?)",
                vec![
                    body.id.to_string().into(),
                    body.owner.into(),
                    kind.into(),
                    seed.into(),
                    body.born.to_string().into(),
                    wipe_at.to_string().into(),
                    persona.into(),
                ],
            )?;
            for fault in [FaultName::Inbox, FaultName::Kitchen] {
                exec(
                    &sql,
                    "INSERT INTO faults (name, \"on\") VALUES (?, 0)",
                    vec![fault.as_str().into()],
                )?;
            }
            exec(&sql, "INSERT INTO seeding (id, step) VALUES (1, 0)", vec![])?;
            exec(
                &sql,
                "INSERT INTO persona (id, name, line1) VALUES (1, ?, ?)",
                vec![persona_name.into(), persona_line1.into()],
            )?;
            for (purpose, at) in [(WIPE, wipe_at), (BACKSTOP, backstop), (SEED, now)] {
                stream::set_timer(&sql, purpose, purpose, at, None)?;
            }
            Ok(())
        })?;
        self.state.storage().set_alarm(alarm_time(now)).await?;
        let meta = self
            .meta()?
            .ok_or_else(|| Error::RustError("meta not written".into()))?;
        json(&self.response(&meta)?, 201)
    }

    fn faults(&self) -> Result<Faults> {
        let rows: Vec<FaultRow> = rows(&self.sql(), "SELECT name, \"on\" FROM faults", vec![])?;
        let on = |name: &str| rows.iter().any(|r| r.name == name && r.on != 0);
        Ok(Faults {
            inbox: on(FaultName::Inbox.as_str()),
            kitchen: on(FaultName::Kitchen.as_str()),
        })
    }

    fn response(&self, meta: &MetaRow) -> Result<SandboxResponse> {
        #[derive(Deserialize)]
        struct N {
            n: i64,
        }
        let children: Option<N> = first(&self.sql(), "SELECT count(*) AS n FROM registry", vec![])?;
        let (persona_name, line1) = self.persona(meta)?;
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
            persona: meta.persona.clone(),
            persona_name,
            persona_address: PersonaAddress {
                line1,
                city: bakery_seed::ADDRESS_CITY.to_owned(),
                state: bakery_seed::ADDRESS_STATE.to_owned(),
                postal_code: bakery_seed::ADDRESS_POSTAL_CODE.to_owned(),
                country: bakery_seed::ADDRESS_COUNTRY.to_owned(),
            },
            clock_offset_s: meta.clock_offset_s,
            clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
            token_v: u32::try_from(meta.token_v).unwrap_or(0),
            faults: self.faults()?,
            children: u32::try_from(children.map_or(0, |c| c.n)).unwrap_or(0),
        })
    }

    /// The persona's display name and address line: from the `persona` row, or for a sandbox
    /// created before that table existed, from its seed.
    fn persona(&self, meta: &MetaRow) -> Result<(String, String)> {
        #[derive(Deserialize)]
        struct PersonaRow {
            name: String,
            line1: String,
        }
        if has_table(&self.sql(), "persona")?
            && let Some(row) =
                first::<PersonaRow>(&self.sql(), "SELECT name, line1 FROM persona", vec![])?
        {
            return Ok((row.name, row.line1));
        }
        let born: WallTime = meta
            .born
            .parse()
            .map_err(|_| Error::RustError("meta born".into()))?;
        let g = Self::generated(u64::try_from(meta.seed).unwrap_or(0), born)?;
        let c = g
            .customers
            .first()
            .ok_or_else(|| Error::RustError("the seed has no customers".into()))?;
        Ok((c.display_name.clone(), c.address.line1.clone()))
    }

    // ---------- seeding ----------

    /// One run of the seeding alarm: up to [`SEED_BATCH`] children from the cursor, each
    /// registered before its first write, then the next run, or at the end `live` and
    /// `SandboxSeeded`. A run that dies mid-batch resumes at the cursor; a child seeded twice
    /// answers 200 and changes nothing.
    async fn seed_step(&self, now: WallTime) -> Result<()> {
        let sql = self.sql();
        let Some(meta) = self.meta()? else {
            return Ok(());
        };
        if meta.state != "seeding" {
            stream::delete_timer(&sql, SEED)?;
            return Ok(());
        }
        let sandbox = meta.sandbox()?;
        let born: WallTime = meta
            .born
            .parse()
            .map_err(|_| Error::RustError("meta born".into()))?;
        let g = Self::generated(u64::try_from(meta.seed).unwrap_or(0), born)?;
        let plan = seed_plan(&g, sandbox);
        let step: Option<StepRow> = first(&sql, "SELECT step FROM seeding", vec![])?;
        let start = usize::try_from(step.map_or(0, |s| s.step)).unwrap_or(0);
        for (i, child) in plan.iter().enumerate().skip(start).take(SEED_BATCH) {
            exec(
                &sql,
                "INSERT OR IGNORE INTO registry (name, class, registered_at, clock_v)
                 VALUES (?, ?, ?, ?)",
                vec![
                    child.name.as_str().into(),
                    child.class.into(),
                    now.to_string().into(),
                    meta.clock_v.into(),
                ],
            )?;
            let body = child.body(&g, &meta, now)?;
            let res = sql::call(
                &self.env,
                child.binding,
                &child.name,
                Method::Post,
                "/_seed",
                Some(&body),
            )
            .await?;
            if !matches!(res.status_code(), 200 | 201) {
                return Err(Error::RustError(format!(
                    "seeding {} answered {}",
                    child.class,
                    res.status_code()
                )));
            }
            // A wipe that ran while this child was being seeded could not see what it wrote.
            if self.meta()?.is_none_or(|m| m.state != "seeding") {
                self.wipe_child(child.binding, &child.name, "seed-race")
                    .await?;
                return Ok(());
            }
            exec(
                &sql,
                "UPDATE seeding SET step = ?",
                vec![i64::try_from(i + 1).unwrap_or(i64::MAX).into()],
            )?;
        }
        if start + SEED_BATCH < plan.len() {
            if stream::may_rearm(&sql, now, CLASS)? {
                stream::set_timer(&sql, SEED, SEED, stream::after(now, SEED_GAP_MS)?, None)?;
            }
            return Ok(());
        }
        let event = Envelope {
            v: bakery_domain::ENVELOPE_VERSION,
            id: random::ulid(now)?,
            sandbox,
            stream: bakery_app::names::sandbox_object_name(sandbox),
            seq: stream::head(&sql, sandbox, "")?.last_seq + 1,
            event_type: "SandboxSeeded".into(),
            at: business_at(now, meta.clock_offset_s),
            recorded_at: now,
            data: serde_json::json!({ "seed": meta.seed, "born": meta.born, "rows": g.rows }),
            cause: None,
        };
        transaction_sync(&self.state.storage(), move || {
            exec(&sql, "UPDATE meta SET state = 'live'", vec![])?;
            exec(&sql, "DELETE FROM seeding", vec![])?;
            stream::delete_timer(&sql, SEED)?;
            stream::append(&sql, std::slice::from_ref(&event))?;
            Ok(())
        })?;
        console_log!(
            "{{\"event\":\"sandbox_seeded\",\"children\":{}}}",
            plan.len()
        );
        stream::relay_soon(&self.state, &self.env, now, CLASS).await
    }

    // ---------- children ----------

    /// A child is born only through here: once wiping, nothing new is registered.
    fn register(&self, meta: &MetaRow, body: RegisterRequest, now: WallTime) -> Result<Response> {
        match meta.state.as_str() {
            "live" => {}
            "seeding" => return refuse(409, "seeding"),
            _ => return gone(),
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
            &serde_json::json!({
                "seed": meta.seed,
                "clock_offset_s": meta.clock_offset_s,
                "clock_v": meta.clock_v,
            }),
            200,
        )
    }

    /// `PlaceOrder`'s creation step (docs/domain.md, "Idempotency"): the client's key maps to
    /// one ULID, registered with its order name in the same transaction, so a retried "place
    /// order" finds the same order and the wipe knows it.
    fn register_order(
        &self,
        meta: &MetaRow,
        body: RegisterOrder,
        now: WallTime,
    ) -> Result<Response> {
        match meta.state.as_str() {
            "live" => {}
            "seeding" => return refuse(409, "seeding"),
            _ => return gone(),
        }
        #[derive(Deserialize)]
        struct KeyRow {
            order_id: String,
        }
        let sql = self.sql();
        let persona: Ulid = meta
            .persona
            .parse()
            .map_err(|_| Error::RustError("meta persona".into()))?;
        let known: Option<KeyRow> = first(
            &sql,
            "SELECT order_id FROM order_keys WHERE key = ?",
            vec![body.key.as_str().into()],
        )?;
        let (order, replayed) = match known {
            Some(k) => (
                k.order_id
                    .parse()
                    .map_err(|_| Error::RustError("stored order id".into()))?,
                true,
            ),
            None => {
                let order = random::ulid(now)?;
                let name = order::name(meta.sandbox()?, order);
                let clock_v = meta.clock_v;
                let key = body.key.clone();
                transaction_sync(&self.state.storage(), move || {
                    exec(
                        &sql,
                        "INSERT INTO order_keys (key, order_id) VALUES (?, ?)",
                        vec![key.into(), order.to_string().into()],
                    )?;
                    exec(
                        &sql,
                        "INSERT INTO registry (name, class, registered_at, clock_v) VALUES (?, ?, ?, ?)",
                        vec![
                            name.into(),
                            order::CLASS.into(),
                            now.to_string().into(),
                            clock_v.into(),
                        ],
                    )?;
                    Ok(())
                })?;
                (order, false)
            }
        };
        json(
            &OrderSlot {
                order,
                persona,
                clock_offset_s: meta.clock_offset_s,
                clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
                replayed,
            },
            200,
        )
    }

    fn child(&self, name: &str) -> Result<Response> {
        #[derive(Deserialize, Serialize)]
        struct ClassRow {
            class: String,
        }
        let found: Option<ClassRow> = first(
            &self.sql(),
            "SELECT class FROM registry WHERE name = ? AND wiped_at IS NULL",
            vec![name.into()],
        )?;
        match found {
            Some(row) => json(&row, 200),
            None => refuse(404, "not-registered"),
        }
    }

    fn binding_of(class: &str) -> Result<&'static str> {
        DISPATCH
            .iter()
            .find(|(c, _)| *c == class)
            .map(|(_, b)| *b)
            .ok_or_else(|| Error::RustError("a registered class has no binding".into()))
    }

    async fn wipe_child(&self, binding: &str, name: &str, cause: &str) -> Result<u64> {
        let mut res = sql::call(
            &self.env,
            binding,
            name,
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
        Ok(res.json::<WipeReport>().await.map_or(0, |r| r.rows_deleted))
    }

    // ---------- commands ----------

    /// `SetFault`: the switch, its `FaultSet` event and the command's key in one transaction,
    /// so a retry with the same key gets the first answer and appends nothing. The Kitchen keeps
    /// its own copy of `kitchen`, so it can refuse a delivery without asking.
    async fn set_fault(
        &self,
        meta: &MetaRow,
        cmd: FaultCommand,
        now: WallTime,
    ) -> Result<Response> {
        if meta.state == "wiping" {
            return gone();
        }
        let sql = self.sql();
        if let Some(seen) = stream::seen(&sql, &cmd.key)? {
            return replayed(&seen.result);
        }
        let sandbox = meta.sandbox()?;
        let event_id = random::ulid(now)?;
        let mut faults = self.faults()?;
        match cmd.fault {
            FaultName::Inbox => faults.inbox = cmd.on,
            FaultName::Kitchen => faults.kitchen = cmd.on,
        }
        let answer = serde_json::to_string(&FaultsResponse { faults })?;
        let stored = answer.clone();
        let name = cmd.fault.as_str();
        let at = business_at(now, meta.clock_offset_s);
        let key = cmd.key.clone();
        transaction_sync(&self.state.storage(), move || {
            exec(
                &sql,
                "UPDATE faults SET \"on\" = ? WHERE name = ?",
                vec![i64::from(cmd.on).into(), name.into()],
            )?;
            let seq = stream::head(&sql, sandbox, "")?.last_seq + 1;
            stream::append(
                &sql,
                &[Envelope {
                    v: bakery_domain::ENVELOPE_VERSION,
                    id: event_id,
                    sandbox,
                    stream: bakery_app::names::sandbox_object_name(sandbox),
                    seq,
                    event_type: "FaultSet".into(),
                    at,
                    recorded_at: now,
                    data: serde_json::json!({ "fault": name, "on": cmd.on }),
                    cause: Some(key.clone()),
                }],
            )?;
            stream::remember(&sql, &key, "", &stored, now)?;
            Ok(())
        })?;
        if cmd.fault == FaultName::Kitchen {
            let kitchen = kitchen::name(sandbox);
            if self.is_registered(&kitchen)? {
                let res = sql::call(
                    &self.env,
                    kitchen::BINDING,
                    &kitchen,
                    Method::Post,
                    "/_fault",
                    Some(&kitchen::FaultSwitch { on: cmd.on }),
                )
                .await?;
                if res.status_code() != 200 {
                    console_log!(
                        "{{\"event\":\"fault_push_error\",\"status\":{}}}",
                        res.status_code()
                    );
                }
            }
        }
        stream::relay_soon(&self.state, &self.env, now, CLASS).await?;
        let mut res = Response::ok(answer)?;
        res.headers_mut().set("Content-Type", "application/json")?;
        Ok(res)
    }

    fn is_registered(&self, name: &str) -> Result<bool> {
        #[derive(Deserialize)]
        struct N {
            n: i64,
        }
        let n: Option<N> = first(
            &self.sql(),
            "SELECT count(*) AS n FROM registry WHERE name = ? AND wiped_at IS NULL",
            vec![name.into()],
        )?;
        Ok(n.is_some_and(|r| r.n > 0))
    }

    /// `AdvanceClock`, minimal (PR 6 adds the presets and "next opening"): the offset only
    /// grows, at most 14 days in total; `ClockAdvanced` is appended with the key; then every
    /// child is told the new offset, and one that cannot be reached is retried by the `clock`
    /// timer (docs/architecture.md, "Time travel").
    async fn advance_clock(
        &self,
        meta: &MetaRow,
        cmd: ClockCommand,
        now: WallTime,
    ) -> Result<Response> {
        match meta.state.as_str() {
            "live" => {}
            "seeding" => return refuse(409, "seeding"),
            _ => return gone(),
        }
        let sql = self.sql();
        if let Some(seen) = stream::seen(&sql, &cmd.key)? {
            return replayed(&seen.result);
        }
        if cmd.minutes == 0 {
            return json(
                &serde_json::json!({ "error": "clock", "rule": "not-positive" }),
                422,
            );
        }
        let offset = meta.clock_offset_s + i64::from(cmd.minutes) * 60;
        if offset > MAX_OFFSET_S {
            return json(
                &serde_json::json!({ "error": "clock", "rule": "too-far" }),
                422,
            );
        }
        let clock_v = meta.clock_v + 1;
        let sandbox = meta.sandbox()?;
        let from = business_at(now, meta.clock_offset_s);
        let to = business_at(now, offset);
        let answer = serde_json::to_string(&ClockResponse {
            clock_offset_s: offset,
            clock_v: u32::try_from(clock_v).unwrap_or(0),
            business_now: to.to_string(),
        })?;
        let event = Envelope {
            v: bakery_domain::ENVELOPE_VERSION,
            id: random::ulid(now)?,
            sandbox,
            stream: bakery_app::names::sandbox_object_name(sandbox),
            seq: stream::head(&sql, sandbox, "")?.last_seq + 1,
            event_type: "ClockAdvanced".into(),
            at: to,
            recorded_at: now,
            data: serde_json::json!({
                "from": from.to_string(),
                "to": to.to_string(),
                "clock_v": clock_v,
            }),
            cause: Some(cmd.key.clone()),
        };
        let (key, stored) = (cmd.key.clone(), answer.clone());
        let tx_sql = self.sql();
        transaction_sync(&self.state.storage(), move || {
            exec(
                &tx_sql,
                "UPDATE meta SET clock_offset_s = ?, clock_v = ?",
                vec![offset.into(), clock_v.into()],
            )?;
            stream::append(&tx_sql, std::slice::from_ref(&event))?;
            stream::remember(&tx_sql, &key, "", &stored, now)?;
            Ok(())
        })?;
        let missed = self.tell_children_of_clock(offset, clock_v).await?;
        if missed > 0 {
            stream::set_timer(
                &sql,
                CLOCK,
                CLOCK,
                stream::after(now, stream::OUTBOX_RETRY_MS)?,
                None,
            )?;
        }
        stream::relay_soon(&self.state, &self.env, now, CLASS).await?;
        let mut res = Response::ok(answer)?;
        res.headers_mut().set("Content-Type", "application/json")?;
        Ok(res)
    }

    /// `/_clock` to every child whose `clock_v` is behind; answers how many could not be told.
    async fn tell_children_of_clock(&self, offset: i64, clock_v: i64) -> Result<usize> {
        let sql = self.sql();
        let behind: Vec<ChildRow> = rows(
            &sql,
            "SELECT name, class FROM registry WHERE wiped_at IS NULL AND clock_v < ?",
            vec![clock_v.into()],
        )?;
        let update = ClockUpdate {
            clock_offset_s: offset,
            clock_v: u32::try_from(clock_v).unwrap_or(0),
        };
        let mut missed = 0;
        for child in &behind {
            let binding = Self::binding_of(&child.class)?;
            let told = sql::call(
                &self.env,
                binding,
                &child.name,
                Method::Post,
                "/_clock",
                Some(&update),
            )
            .await;
            match told.map(|r| r.status_code()) {
                // 410: an order registered and refused, which holds nothing to move.
                Ok(200 | 410) => {
                    exec(
                        &sql,
                        "UPDATE registry SET clock_v = ? WHERE name = ?",
                        vec![clock_v.into(), child.name.as_str().into()],
                    )?;
                }
                _ => missed += 1,
            }
        }
        if missed > 0 {
            console_log!("{{\"event\":\"clock_children_missed\",\"missed\":{missed}}}");
        }
        Ok(missed)
    }

    async fn clock_retry(&self, now: WallTime) -> Result<()> {
        let sql = self.sql();
        stream::delete_timer(&sql, CLOCK)?;
        let Some(meta) = self.meta()? else {
            return Ok(());
        };
        let missed = self
            .tell_children_of_clock(meta.clock_offset_s, meta.clock_v)
            .await?;
        if missed > 0 && stream::may_rearm(&sql, now, CLASS)? {
            stream::set_timer(
                &sql,
                CLOCK,
                CLOCK,
                stream::after(now, stream::OUTBOX_RETRY_MS)?,
                None,
            )?;
        }
        Ok(())
    }

    // ---------- dead letters ----------

    /// One dead letter, keyed by the event id, with the consumer's last error for it. The body
    /// is read tolerantly: a poisoned message may not be an envelope at all.
    fn dead_letter(&self, body: DeadLetterIn, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        let value: serde_json::Value =
            serde_json::from_str(&body.envelope).unwrap_or(serde_json::Value::Null);
        let text = |k: &str| {
            value
                .get(k)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned()
        };
        let id = match text("id") {
            id if !id.is_empty() => id,
            _ => random::ulid(now)?.to_string(),
        };
        #[derive(Deserialize)]
        struct ErrorRow {
            error: String,
        }
        let last: Option<ErrorRow> = first(
            &sql,
            "SELECT error FROM delivery_errors WHERE id = ?",
            vec![id.as_str().into()],
        )?;
        let error = body
            .error
            .or(last.map(|r| r.error))
            .unwrap_or_else(|| "no answer recorded".into());
        let seq = value.get("seq").and_then(|v| v.as_i64()).unwrap_or(0);
        let (event_type, stream_name) = (text("type"), text("stream"));
        let envelope = body.envelope;
        let id_for_tx = id.clone();
        transaction_sync(&self.state.storage(), move || {
            exec(
                &sql,
                "INSERT OR IGNORE INTO dead_letters (id, type, stream, seq, error, at, envelope)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                vec![
                    id_for_tx.as_str().into(),
                    event_type.into(),
                    stream_name.into(),
                    seq.into(),
                    error.into(),
                    now.to_string().into(),
                    envelope.into(),
                ],
            )?;
            exec(
                &sql,
                "DELETE FROM delivery_errors WHERE id = ?",
                vec![id_for_tx.into()],
            )?;
            Ok(())
        })?;
        console_log!("{{\"event\":\"dead_letter\",\"id\":\"{id}\"}}");
        json(&serde_json::json!({ "id": id }), 200)
    }

    /// `RedriveDeadLetter`: the stored envelope goes back on the Queue with its own id, so the
    /// subscribers' `seen` tables make a second effect impossible, and the row goes.
    async fn redrive(&self, body: Redrive, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        if let Some(seen) = stream::seen(&sql, &body.key)? {
            return replayed(&seen.result);
        }
        let found: Option<DeadRow> = first(
            &sql,
            "SELECT id, type, stream, seq, error, at, envelope FROM dead_letters WHERE id = ?",
            vec![body.id.as_str().into()],
        )?;
        let Some(row) = found else {
            return refuse(404, "unknown-dead-letter");
        };
        self.env
            .queue(stream::EVENTS)?
            .send(row.envelope.clone())
            .await?;
        let answer = serde_json::to_string(&row.view())?;
        let (key, stored, id) = (body.key, answer.clone(), row.id.clone());
        transaction_sync(&self.state.storage(), move || {
            exec(
                &sql,
                "DELETE FROM dead_letters WHERE id = ?",
                vec![id.into()],
            )?;
            stream::remember(&sql, &key, "", &stored, now)?;
            Ok(())
        })?;
        console_log!("{{\"event\":\"redrive\",\"id\":\"{}\"}}", row.id);
        let mut res = Response::ok(answer)?;
        res.headers_mut().set("Content-Type", "application/json")?;
        Ok(res)
    }

    // ---------- the wipe ----------

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
        let mut child_rows = 0u64;
        for child in &children {
            let binding = Self::binding_of(&child.class)?;
            child_rows += self.wipe_child(binding, &child.name, cause).await?;
            exec(
                &sql,
                "UPDATE registry SET wiped_at = ? WHERE name = ?",
                vec![
                    SystemClock::new().now_wall().to_string().into(),
                    child.name.as_str().into(),
                ],
            )?;
        }
        let rows_deleted = user_rows(&sql)? + child_rows;
        let objects = 1 + u32::try_from(children.len()).unwrap_or(u32::MAX);
        let id = meta.sandbox()?;
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

/// One child the seeding alarm creates, in the order it creates them.
struct SeedChild {
    class: &'static str,
    binding: &'static str,
    name: String,
    /// Index into the seed's open orders, for an `Order`.
    open: Option<usize>,
}

/// The Catalog, the Kitchen, Billing, then the seed's 12 open orders: 15 children.
fn seed_plan(g: &Generated, sandbox: Ulid) -> Vec<SeedChild> {
    let mut plan = vec![
        SeedChild {
            class: catalog::CLASS,
            binding: catalog::BINDING,
            name: catalog::name(sandbox),
            open: None,
        },
        SeedChild {
            class: kitchen::CLASS,
            binding: kitchen::BINDING,
            name: kitchen::name(sandbox),
            open: None,
        },
        SeedChild {
            class: billing::CLASS,
            binding: billing::BINDING,
            name: billing::name(sandbox),
            open: None,
        },
    ];
    plan.extend(g.open_orders.iter().enumerate().map(|(i, o)| SeedChild {
        class: order::CLASS,
        binding: order::BINDING,
        name: order::name(sandbox, o.id),
        open: Some(i),
    }));
    plan
}

/// The seed's records cross into the domain's types as JSON, as the alignment test in
/// bakery-app reads them.
fn via_json<T: Serialize, U: serde::de::DeserializeOwned>(value: T) -> Result<U> {
    Ok(serde_json::from_value(serde_json::to_value(value)?)?)
}

impl SeedChild {
    fn body(&self, g: &Generated, meta: &MetaRow, now: WallTime) -> Result<serde_json::Value> {
        let birth = meta.birth(self.name.clone())?;
        let value = match self.open {
            None if self.class == catalog::CLASS => {
                let items: Vec<Item> = g
                    .items
                    .iter()
                    .map(|item| {
                        // The seed's items carry no status: every one is on sale at birth.
                        let mut v = serde_json::to_value(item)?;
                        v["status"] = serde_json::Value::from("available");
                        Ok(serde_json::from_value(v)?)
                    })
                    .collect::<Result<_>>()?;
                serde_json::to_value(catalog::SeedCatalog {
                    birth,
                    categories: via_json::<_, Vec<Category>>(&g.categories)?,
                    items,
                    variants: via_json::<_, Vec<Variant>>(&g.variants)?,
                })?
            }
            None if self.class == billing::CLASS => serde_json::to_value(billing::SeedBilling {
                birth,
                days: billing::daily_totals(&g.history),
            })?,
            None => serde_json::to_value(kitchen::SeedKitchen {
                birth,
                fault: false,
            })?,
            Some(i) => {
                let o = &g.open_orders[i];
                serde_json::to_value(order::SeedOrder {
                    birth,
                    events: open_order_events(g, o, business_at(now, meta.clock_offset_s))?,
                    at: o.placed_at,
                })?
            }
        };
        Ok(value)
    }
}

/// The events that bring an order to its seeded state. One still waiting for payment is held
/// for 15 minutes from now, not from its seeded placement, so it is on the board when the
/// visitor arrives.
fn open_order_events(
    g: &Generated,
    o: &bakery_seed::OpenOrder,
    now: BusinessTime,
) -> Result<Vec<OrderEvent>> {
    let base = if o.placed_at > now { o.placed_at } else { now };
    let held_until = base
        .plus_minutes(SEED_HOLD_MINUTES)
        .map_err(|e| Error::RustError(e.to_string()))?;
    let lines = o
        .lines
        .iter()
        .map(|l| {
            let item = g
                .variants
                .iter()
                .find(|v| v.slug == l.variant)
                .map(|v| v.item.to_owned())
                .ok_or_else(|| Error::RustError("a seeded line names no variant".into()))?;
            Ok(Line {
                item,
                variant: l.variant.clone(),
                qty: u16::try_from(l.qty).unwrap_or(u16::MAX),
                unit_cents: l.unit_cents,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut events = vec![OrderEvent::OrderPlaced {
        order: o.id,
        customer: o.customer,
        kind: via_json::<_, OrderKind>(o.kind)?,
        slot: o.slot_start,
        zone: o.zone.map(str::to_owned),
        lines,
        subtotal_cents: o.subtotal_cents,
        tax_cents: o.tax_cents,
        total_cents: o.total_cents,
        note: None,
        menu_version: 1,
        held_until,
    }];
    let steps = match o.state {
        OpenState::Placed => 0,
        OpenState::Confirmed => 1,
        OpenState::InProduction => 2,
        OpenState::Ready => 3,
    };
    if steps >= 1 {
        let payment = o
            .payment_id
            .ok_or_else(|| Error::RustError("a paid seed order has no payment".into()))?;
        events.push(OrderEvent::OrderPaid {
            payment,
            amount_cents: o.total_cents,
        });
    }
    if steps >= 2 {
        events.push(OrderEvent::OrderProductionStarted {});
    }
    if steps >= 3 {
        events.push(OrderEvent::OrderReady {});
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakery_domain::kitchen::Board;
    use bakery_domain::order::{Order as OrderAggregate, OrderStatus};
    use bakery_domain::outbox::{Stamp, StreamHead, envelopes};
    use bakery_domain::{DomainEvent, replay};

    fn generated() -> Generated {
        Generator::new(Seed(42), BirthDate::parse("2026-11-07").unwrap()).generate()
    }

    #[test]
    fn the_plan_is_fifteen_children_catalog_kitchen_and_billing_first() {
        let g = generated();
        let sandbox = Ulid::from_parts(1, 1);
        let plan = seed_plan(&g, sandbox);
        assert_eq!(plan.len(), 15);
        assert_eq!(plan[0].name, format!("catalog:{sandbox}"));
        assert_eq!(plan[1].name, format!("kitchen:{sandbox}"));
        assert_eq!(plan[2].name, format!("billing:{sandbox}"));
        assert!(
            plan[3..]
                .iter()
                .all(|c| c.class == "Order" && c.name.starts_with(&format!("order:{sandbox}:")))
        );
        assert_eq!(plan.len().div_ceil(SEED_BATCH), 3, "three seeding runs");
        // Every class but the Simulator, which is born on the first "Start traffic".
        for (class, _) in DISPATCH.iter().filter(|(c, _)| *c != simulator::CLASS) {
            assert!(plan.iter().any(|c| c.class == *class), "{class}");
        }
    }

    #[test]
    fn seeded_orders_reach_their_seeded_states_and_draw_the_board() {
        let g = generated();
        let sandbox = Ulid::from_parts(1, 1);
        let now: BusinessTime = "2026-11-07T08:00:00-07:00".parse().unwrap();
        let mut board = Board::default();
        let mut id = 0u128;
        for o in &g.open_orders {
            let events = open_order_events(&g, o, now).unwrap();
            let state = replay::<OrderAggregate>(&events);
            let want: OrderStatus = via_json(o.state).unwrap();
            assert_eq!(state.status(), Some(want), "{}", o.id);
            let record = state.record().unwrap();
            assert!(record.held_until > now);
            assert_eq!(record.total_cents, o.total_cents);
            let head = StreamHead {
                sandbox,
                stream: order::name(sandbox, o.id),
                last_seq: 0,
            };
            let stamp = Stamp {
                at: o.placed_at,
                recorded_at: "2026-11-07T15:00:00.000Z".parse().unwrap(),
                cause: None,
            };
            let built = envelopes(&head, &stamp, &events, || {
                id += 1;
                Ulid::from_parts(1, id)
            })
            .unwrap();
            for e in &built {
                assert!(OrderEvent::from_envelope(e).is_ok());
                board.apply(e).unwrap();
            }
        }
        assert_eq!(board.snapshot().len(), 12, "every open order is a card");
    }

    #[test]
    fn the_clock_bound_is_fourteen_days() {
        assert_eq!(MAX_OFFSET_S, 1_209_600);
    }
}
