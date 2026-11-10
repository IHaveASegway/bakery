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
//! - `POST /_register-order {key, date?}` → `{order, persona, clock_offset_s, clock_v, replayed,
//!   schedule?}`: the client's `Idempotency-Key` mapped to one order ULID, registered with class
//!   `Order`, and the slot's `Schedule` day registered beside it when `date` is one a day may be
//!   created for; `schedule` is its name, absent when the date is out of range.
//! - `POST /_register-catering {key}` → `{catering, persona, clock_offset_s, clock_v,
//!   replayed}`: the inquiry's `Idempotency-Key` mapped to one catering ULID (kept beside the
//!   orders' keys, as `catering:<key>`), registered with class `CateringEvent`.
//! - `POST /_register-customer {customer}` → `CustomerBirth {name, clock_offset_s, clock_v,
//!   register}`: a persona's `Customer`, registered on its first touch, with the seed's
//!   synthetic profile, consent and opening points from the `personas` table (written at
//!   creation, so no touch regenerates the seed). Answered while seeding too, since a seeded
//!   paid order's `OrderPaid` reaches its customer then; 404 `{error: "unknown-persona"}`.
//! - `POST /_register-day {date, catering?}` → `{name, clock_offset_s, clock_v}`: a `Schedule`
//!   day, born on first touch, for a date from the birth day to 30 days after business today, or
//!   any later one with `catering: true` (an accepted quote's event day, which the domain bounds
//!   at 365 days after business today, `MAX_DAYS_AHEAD`, since 2026-11-10); 404 `{error: "no-such-day"}` for any other.
//! - `POST /_register-dispatch {date}` → `{name, clock_offset_s, clock_v}`: the day's
//!   `Dispatch`, born on first touch, for the same dates as a `Schedule` day (PR 9); 404
//!   `{error: "no-such-day"}` for any other, 409 `{error: "seeding"}` before seeding is done.
//! - `GET /_place/<customer>` → `{place}`: a persona's delivery place, the seed's `p<n>`, from
//!   the `personas` table (PR 9: the consumer's `AddStop`); 404 `{error: "unknown-persona"}`.
//! - `GET /_children/<class>` → `[name]`: the registered children of a class, by name.
//! - `GET /_days` → `[name]`: the registered `Schedule` days from business today on.
//! - `GET /_child/<name>` → 200 `{class}` for a registered child, else 404.
//! - `POST /_faults {key, fault, on}` → `FaultsResponse`, and the Kitchen told of `kitchen`.
//! - `POST /_clock {key, step}` → `ClockResponse` with the step applied; 422 `{error: "clock",
//!   rule}` with the domain's `not-positive` or `offset-cap`.
//! - `POST /_delivery-error {id, error}`: the consumer's last error for an event, kept until
//!   the event is dead-lettered or the sandbox wiped.
//! - `POST /_dead-letter {envelope, error?}`: from the DLQ consumer, or from the main consumer
//!   for a poisoned message. Idempotent by event id.
//! - `GET /_dead-letters` → `[DeadLetter]`, oldest first.
//! - `POST /_redrive {key, id}` → `DeadLetter`: the stored envelope sent to the Queue again with
//!   its own id, and the row removed; 404 `{error: "unknown-dead-letter"}`.
//! - `POST /_wipe {cause}` → `WipeAnswer`.
//! - `GET /_token` → `TokenState`: the lifecycle state and the token version the router checks a
//!   bearer token against, with the last issued token's times and masked form for the console.
//! - `POST /_token/issue {key, rotate, tid, iat, exp}` → `TokenIssued`: the claims the Worker
//!   signs, at the current token version, or with `rotate` (`RotateApiToken`) at the version plus
//!   one and `ApiTokenRotated` appended in the same transaction. The token itself never reaches
//!   this object; a repeated key replays the claims, so the Worker signs the same token again.
//! - `POST /_token/masked {token_v, tid, masked}`: the issued token's masked form, for `GET`.

use std::cell::Cell;

use bakery_app::Clock;
use bakery_app::wipe::{backstop_at, next_wipe_at};
use bakery_contracts::{
    ClockResponse, DeadLetter, FaultName, Faults, FaultsResponse, PersonaAddress, SandboxKind,
    SandboxResponse, SandboxState,
};
use bakery_domain::catalog::{Category, Item, Variant};
use bakery_domain::clock::{ClockStep, advance};
use bakery_domain::order::{Line, OrderEvent, OrderKind};
use bakery_domain::schedule::{
    DEFAULT_CATERING_CAPACITY, DEFAULT_SLOT_CAPACITY, DEFAULT_ZONE_CAPACITY, HoldRequest,
    HoldStatus, Target,
};
use bakery_domain::{BakeryDate, BusinessTime, Envelope, Ulid, WallTime};
use bakery_seed::{BirthDate, Generated, Generator, OpenState, Seed};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::child::{Birth, ClockUpdate, WipeReport};
use super::control::{self, Wiped};
use super::schedule::{self, Cmd, SeedSchedule};
use super::sql::{
    self, exec, first, gone, has_table, json, refuse, replayed, rows, transaction_sync, user_rows,
};
use super::stream::{self, OUTBOX};
use super::{
    billing, catalog, catering, crm, customer, dispatch, inbox, kitchen, order, recorder, simulator,
};
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
    (schedule::CLASS, schedule::BINDING),
    (catering::CLASS, catering::BINDING),
    (customer::CLASS, customer::BINDING),
    (crm::CLASS, crm::BINDING),
    (inbox::CLASS, inbox::BINDING),
    (dispatch::CLASS, dispatch::BINDING),
    (recorder::CLASS, recorder::BINDING),
];

const WIPE: &str = "wipe";
const BACKSTOP: &str = "backstop";
const SEED: &str = "seed";
const CLOCK: &str = "clock";

/// Children seeded per alarm run: the Catalog, the Kitchen, Billing, Crm, the Inbox, the
/// Recorder, the 7 Schedule days, today's Dispatch, the 12 open orders, the 8 catering events and
/// their 3 days, 37 in all (PR 9 added the Dispatch, 2026-11-09 the Recorder), take six runs,
/// each far inside the 1,000 subrequests a Free invocation may make (Workers limits,
/// https://developers.cloudflare.com/workers/platform/limits/, as of 2026-11-05): a run's
/// largest, the one with the catering events, makes at most 7 seeds, 7 log reads and 14
/// hand-overs.
const SEED_BATCH: usize = 7;
/// The pause between seeding runs, so a run's subrequests have finished.
const SEED_GAP_MS: i64 = 100;
/// A `Schedule` day may be created up to this many days after business today (and from the
/// sandbox's birth day on).
const DAYS_AHEAD: i64 = 30;
/// A seeded order still waiting for payment is held this long after the sandbox is born, as a
/// new order would be (docs/domain.md, "Order": 15 minutes).
const SEED_HOLD_MINUTES: i64 = bakery_domain::order::EXPIRY_MINUTES;

/// The last token issued at the current version (PR 10): its id and times, and its masked form
/// once the Worker has signed it. Never the token, and never its MAC beyond the masked form's
/// last 4 characters. Created on first use too, for a sandbox born before the table existed.
const API_TOKEN_TABLE: &str = "CREATE TABLE IF NOT EXISTS api_token (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       token_v INTEGER NOT NULL,
       tid TEXT NOT NULL,
       iat INTEGER NOT NULL,
       exp INTEGER NOT NULL,
       masked TEXT)";

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
    // Each persona's first-touch payload for its `Customer`: the seed's profile, consent and
    // opening points (PR 8), so registering a customer reads a row and never the whole seed.
    "CREATE TABLE IF NOT EXISTS personas (id TEXT PRIMARY KEY, register TEXT NOT NULL)",
    API_TOKEN_TABLE,
    "CREATE TABLE IF NOT EXISTS delivery_errors (id TEXT PRIMARY KEY, error TEXT NOT NULL, at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS dead_letters (
       id TEXT PRIMARY KEY,
       type TEXT NOT NULL,
       stream TEXT NOT NULL,
       seq INTEGER NOT NULL,
       error TEXT NOT NULL,
       at TEXT NOT NULL,
       envelope TEXT NOT NULL)",
    // The dead letters made while the bakery was `off` (roadmap R67, 2026-11-10), by id: a table
    // of its own, so a sandbox born before it needs no new column in `dead_letters`.
    "CREATE TABLE IF NOT EXISTS dead_letters_while_off (id TEXT PRIMARY KEY)",
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
    /// The slot's bakery day: its `Schedule` is registered in the same call.
    #[serde(default)]
    pub date: Option<BakeryDate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterDay {
    pub date: BakeryDate,
    /// A catering event's day: no upper bound.
    #[serde(default)]
    pub catering: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterCustomer {
    pub customer: Ulid,
}

/// `/_register-customer`'s answer: what the persona's `Customer` is born with.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerBirth {
    pub name: String,
    pub clock_offset_s: i64,
    pub clock_v: u32,
    pub register: customer::RegisterIn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterCatering {
    pub key: String,
}

/// `/_register-catering`'s answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CateringSlot {
    pub catering: Ulid,
    pub persona: Ulid,
    pub clock_offset_s: i64,
    pub clock_v: u32,
    pub replayed: bool,
}

/// `/_register-day`'s answer: what the day is born with.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayBirth {
    pub name: String,
    pub clock_offset_s: i64,
    pub clock_v: u32,
}

/// `/_register-order`'s answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderSlot {
    pub order: Ulid,
    pub persona: Ulid,
    pub clock_offset_s: i64,
    pub clock_v: u32,
    pub replayed: bool,
    /// The slot day's `Schedule`, registered; `None` when no date was asked or it is out of
    /// range.
    #[serde(default)]
    pub schedule: Option<String>,
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
    /// `15m`, `1h`, `1d`, `next-opening`, or `<n>m` for the older `minutes` form.
    pub step: ClockStep,
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
    /// Made while the bakery was `off`, as the dead-letter queue's consumer judged it
    /// (`bakery_app::dead_letters`); the main consumer's poison is never.
    #[serde(default)]
    pub while_off: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Redrive {
    pub key: String,
    pub id: String,
}

/// `/_token`'s answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenState {
    /// `seeding`, `live` or `wiping`.
    pub state: String,
    pub token_v: u32,
    #[serde(default)]
    pub issued_at: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub masked: Option<String>,
}

/// `IssueApiToken`, or `RotateApiToken` with `rotate`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenCommand {
    /// The command's `Idempotency-Key`.
    pub key: String,
    pub rotate: bool,
    /// The new token's id, 32 hex characters: the rate limit's key, never a secret.
    pub tid: String,
    /// Unix seconds.
    pub iat: i64,
    pub exp: i64,
}

/// `/_token/issue`'s answer: the claims the Worker signs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenIssued {
    pub tid: String,
    pub iat: i64,
    pub exp: i64,
    pub token_v: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenMasked {
    pub token_v: u32,
    pub tid: String,
    pub masked: String,
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

    fn born(&self) -> Result<WallTime> {
        self.born
            .parse()
            .map_err(|_| Error::RustError("meta born".into()))
    }

    /// Business time at the sandbox's birth, at the offset it was born with: the base of the
    /// seeded holds' 15 minutes, the same for every seeding run.
    fn born_business(&self) -> Result<BusinessTime> {
        Ok(business(self.born()?))
    }

    /// Whether a `Schedule` day may exist for `date`: from the birth day to 30 days after
    /// business today.
    fn day_in_range(&self, date: BakeryDate, now: WallTime) -> Result<bool> {
        let birth_day = BakeryDate::of(self.born_business()?);
        let today = BakeryDate::of(business_at(now, self.clock_offset_s));
        Ok(date >= birth_day && date <= today.plus_days(DAYS_AHEAD))
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
    /// 1 when the id is in `dead_letters_while_off`.
    while_off: i64,
}

/// A dead letter's columns, with its mark, for `rows`/`first` (`WHERE` and `ORDER BY` follow).
const DEAD_ROW: &str = "SELECT d.id, d.type, d.stream, d.seq, d.error, d.at, d.envelope,
       (o.id IS NOT NULL) AS while_off
     FROM dead_letters d LEFT JOIN dead_letters_while_off o ON o.id = d.id";

impl DeadRow {
    fn view(&self) -> DeadLetter {
        DeadLetter {
            id: self.id.clone(),
            event_type: self.event_type.clone(),
            stream: self.stream.clone(),
            seq: u64::try_from(self.seq).unwrap_or(0),
            error: self.error.clone(),
            at: self.at.clone(),
            made_while_off: self.while_off != 0,
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
                    (Method::Post, "/_register-day") => {
                        let body: RegisterDay = sql::body(&mut req).await?;
                        self.register_day(&meta, body.date, body.catering, now)
                    }
                    (Method::Post, "/_register-dispatch") => {
                        let body: RegisterDay = sql::body(&mut req).await?;
                        self.register_dispatch(&meta, body.date, now)
                    }
                    (Method::Get, p) if p.starts_with("/_place/") => {
                        self.place_of(&meta, &p["/_place/".len()..])
                    }
                    (Method::Post, "/_register-catering") => {
                        let body: RegisterCatering = sql::body(&mut req).await?;
                        self.register_catering(&meta, body, now)
                    }
                    (Method::Post, "/_register-customer") => {
                        let body: RegisterCustomer = sql::body(&mut req).await?;
                        self.register_customer(&meta, body.customer, now)
                    }
                    (Method::Get, p) if p.starts_with("/_children/") => {
                        self.children_of(&p["/_children/".len()..])
                    }
                    (Method::Get, "/_days") => self.days(&meta, now),
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
                            &format!("{DEAD_ROW} ORDER BY d.at, d.id"),
                            vec![],
                        )?;
                        json(&found.iter().map(DeadRow::view).collect::<Vec<_>>(), 200)
                    }
                    (Method::Post, "/_redrive") => {
                        let body: Redrive = sql::body(&mut req).await?;
                        self.redrive(body, now).await
                    }
                    (Method::Get, "/_token") => json(&self.token_state(&meta)?, 200),
                    (Method::Post, "/_token/issue") => {
                        let body: TokenCommand = sql::body(&mut req).await?;
                        self.issue_token(&meta, body, now).await
                    }
                    (Method::Post, "/_token/masked") => {
                        let body: TokenMasked = sql::body(&mut req).await?;
                        self.token_masked(&body)
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
            stream::rearm(&storage, now, CLASS).await?;
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
    /// stored, only read for the rows a child needs. The generator knows the birth date; the
    /// minute of the birth moves the open orders' placements and payments before it and pays an
    /// order whose slot is too near to stay pending (`Generated::born_at`).
    fn generated(seed: u64, born: WallTime) -> Result<Generated> {
        let now = business(born);
        let birth_date = now.to_string();
        let date = BirthDate::parse(&birth_date[..10])
            .map_err(|e| Error::RustError(format!("birth date: {e}")))?;
        Ok(Generator::new(Seed(seed), date).generate().born_at(now))
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
        let personas = generated
            .customers
            .iter()
            .map(|c| Ok((c.id.to_string(), serde_json::to_string(&register_in(c)?)?)))
            .collect::<Result<Vec<(String, String)>>>()?;
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
            for (id, register) in &personas {
                exec(
                    &sql,
                    "INSERT INTO personas (id, register) VALUES (?, ?)",
                    vec![id.as_str().into(), register.as_str().into()],
                )?;
            }
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
            let body = child.body(&g, &meta)?;
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
            if child.catering.is_some() {
                self.hand_over_catering(sandbox, &child.name).await?;
            }
            exec(
                &sql,
                "UPDATE seeding SET step = ?",
                vec![i64::try_from(i + 1).unwrap_or(i64::MAX).into()],
            )?;
        }
        if start + SEED_BATCH < plan.len() {
            // The alarm's re-arm counts this against the guard.
            stream::set_timer(&sql, SEED, SEED, stream::after(now, SEED_GAP_MS)?, None)?;
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
            // `born` is the birth's business date, as the catalog writes it (`born: date`), so
            // Crm can mark where the history starts.
            data: serde_json::json!({
                "seed": meta.seed,
                "born": BakeryDate::of(meta.born_business()?).to_string(),
                "rows": g.rows,
            }),
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
        let schedule = match body.date {
            Some(date) if meta.day_in_range(date, now)? => {
                Some(self.register_schedule(meta, date, now)?)
            }
            _ => None,
        };
        json(
            &OrderSlot {
                order,
                persona,
                clock_offset_s: meta.clock_offset_s,
                clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
                replayed,
                schedule,
            },
            200,
        )
    }

    /// The inquiry's creation step, as `register_order` is the order's: the client's key maps to
    /// one catering ULID, registered with its name in the same transaction, so a retried
    /// inquiry finds the same event and the wipe knows it. The keys share the orders' table,
    /// prefixed, so a sandbox born before PR 7 needs no new table.
    fn register_catering(
        &self,
        meta: &MetaRow,
        body: RegisterCatering,
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
        let key = format!("catering:{}", body.key);
        let known: Option<KeyRow> = first(
            &sql,
            "SELECT order_id FROM order_keys WHERE key = ?",
            vec![key.as_str().into()],
        )?;
        let (id, replayed) = match known {
            Some(k) => (
                k.order_id
                    .parse()
                    .map_err(|_| Error::RustError("stored catering id".into()))?,
                true,
            ),
            None => {
                let id = random::ulid(now)?;
                let name = catering::name(meta.sandbox()?, id);
                let clock_v = meta.clock_v;
                transaction_sync(&self.state.storage(), move || {
                    exec(
                        &sql,
                        "INSERT INTO order_keys (key, order_id) VALUES (?, ?)",
                        vec![key.into(), id.to_string().into()],
                    )?;
                    exec(
                        &sql,
                        "INSERT INTO registry (name, class, registered_at, clock_v) VALUES (?, ?, ?, ?)",
                        vec![
                            name.into(),
                            catering::CLASS.into(),
                            now.to_string().into(),
                            clock_v.into(),
                        ],
                    )?;
                    Ok(())
                })?;
                (id, false)
            }
        };
        json(
            &CateringSlot {
                catering: id,
                persona,
                clock_offset_s: meta.clock_offset_s,
                clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
                replayed,
            },
            200,
        )
    }

    /// A persona's `Customer`, registered on its first touch, with what it is born with.
    fn register_customer(
        &self,
        meta: &MetaRow,
        customer_id: Ulid,
        now: WallTime,
    ) -> Result<Response> {
        if !matches!(meta.state.as_str(), "live" | "seeding") {
            return gone();
        }
        #[derive(Deserialize)]
        struct PersonaRow {
            register: String,
        }
        let sql = self.sql();
        let found: Option<PersonaRow> = if has_table(&sql, "personas")? {
            first(
                &sql,
                "SELECT register FROM personas WHERE id = ?",
                vec![customer_id.to_string().into()],
            )?
        } else {
            None
        };
        let register: customer::RegisterIn = match found {
            Some(r) => serde_json::from_str(&r.register)?,
            None => {
                // A sandbox created before the table: the seed, once.
                let g = Self::generated(u64::try_from(meta.seed).unwrap_or(0), meta.born()?)?;
                match g.customers.iter().find(|c| c.id == customer_id) {
                    Some(c) => register_in(c)?,
                    None => return refuse(404, "unknown-persona"),
                }
            }
        };
        let name = customer::name(meta.sandbox()?, customer_id);
        exec(
            &sql,
            "INSERT OR IGNORE INTO registry (name, class, registered_at, clock_v) VALUES (?, ?, ?, ?)",
            vec![
                name.as_str().into(),
                customer::CLASS.into(),
                now.to_string().into(),
                meta.clock_v.into(),
            ],
        )?;
        json(
            &CustomerBirth {
                name,
                clock_offset_s: meta.clock_offset_s,
                clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
                register,
            },
            200,
        )
    }

    /// A seeded catering event's own events, which it keeps out of its outbox (PR 7), read from
    /// its log and handed to Crm, the brief stripped, and to the Inbox for their facts, so no
    /// later event of the inquiry meets an unknown one. Both were seeded before it.
    async fn hand_over_catering(&self, sandbox: Ulid, name: &str) -> Result<()> {
        let mut res =
            sql::call_empty(&self.env, catering::BINDING, name, Method::Get, "/_events").await?;
        if res.status_code() != 200 {
            return Err(Error::RustError(format!(
                "a seeded catering event's log answered {}",
                res.status_code()
            )));
        }
        let events: Vec<Envelope> = serde_json::from_str(&res.text().await?)?;
        let stripped: Vec<Envelope> = events
            .iter()
            .map(|e| bakery_app::routing::strip_for(e, bakery_app::routing::Subscriber::Crm))
            .collect();
        for (binding, target, path) in [
            (crm::BINDING, crm::name(sandbox), "/_ingest"),
            (inbox::BINDING, inbox::name(sandbox), "/_learn"),
        ] {
            let res = sql::call(
                &self.env,
                binding,
                &target,
                Method::Post,
                path,
                Some(&crm::IngestIn {
                    envelopes: stripped.clone(),
                }),
            )
            .await?;
            if res.status_code() != 200 {
                return Err(Error::RustError(format!(
                    "handing a catering event's log over answered {}",
                    res.status_code()
                )));
            }
        }
        Ok(())
    }

    /// The registered children of one class, by name: the catering list's source.
    fn children_of(&self, class: &str) -> Result<Response> {
        #[derive(Deserialize)]
        struct NameRow {
            name: String,
        }
        let found: Vec<NameRow> = rows(
            &self.sql(),
            "SELECT name FROM registry WHERE class = ? AND wiped_at IS NULL ORDER BY name",
            vec![class.into()],
        )?;
        json(&found.into_iter().map(|r| r.name).collect::<Vec<_>>(), 200)
    }

    /// A `Schedule` day's name in the registry, before its first write.
    fn register_schedule(&self, meta: &MetaRow, date: BakeryDate, now: WallTime) -> Result<String> {
        let name = schedule::name(meta.sandbox()?, date);
        exec(
            &self.sql(),
            "INSERT OR IGNORE INTO registry (name, class, registered_at, clock_v) VALUES (?, ?, ?, ?)",
            vec![
                name.as_str().into(),
                schedule::CLASS.into(),
                now.to_string().into(),
                meta.clock_v.into(),
            ],
        )?;
        Ok(name)
    }

    /// A `Schedule` day for the router's read, a capacity change or a catering hold, born on
    /// first touch.
    fn register_day(
        &self,
        meta: &MetaRow,
        date: BakeryDate,
        catering: bool,
        now: WallTime,
    ) -> Result<Response> {
        match meta.state.as_str() {
            "live" => {}
            "seeding" => return refuse(409, "seeding"),
            _ => return gone(),
        }
        let in_range = if catering {
            date >= BakeryDate::of(meta.born_business()?)
        } else {
            meta.day_in_range(date, now)?
        };
        if !in_range {
            return refuse(404, "no-such-day");
        }
        let name = self.register_schedule(meta, date, now)?;
        json(
            &DayBirth {
                name,
                clock_offset_s: meta.clock_offset_s,
                clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
            },
            200,
        )
    }

    /// A day's `Dispatch` for the router's read or a staff command, or the consumer's stop,
    /// born on first touch. The same days as a `Schedule`'s: from the birth day to 30 days after
    /// business today.
    fn register_dispatch(
        &self,
        meta: &MetaRow,
        date: BakeryDate,
        now: WallTime,
    ) -> Result<Response> {
        match meta.state.as_str() {
            "live" => {}
            "seeding" => return refuse(409, "seeding"),
            _ => return gone(),
        }
        if !meta.day_in_range(date, now)? {
            return refuse(404, "no-such-day");
        }
        let name = dispatch::name(meta.sandbox()?, date);
        exec(
            &self.sql(),
            "INSERT OR IGNORE INTO registry (name, class, registered_at, clock_v) VALUES (?, ?, ?, ?)",
            vec![
                name.as_str().into(),
                dispatch::CLASS.into(),
                now.to_string().into(),
                meta.clock_v.into(),
            ],
        )?;
        json(
            &DayBirth {
                name,
                clock_offset_s: meta.clock_offset_s,
                clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
            },
            200,
        )
    }

    /// A persona's delivery place, the seed's `p<n>`, from its first-touch payload: where its
    /// delivery orders' stops are. Answered while seeding too, as `/_register-customer` is.
    fn place_of(&self, meta: &MetaRow, customer_id: &str) -> Result<Response> {
        if !matches!(meta.state.as_str(), "live" | "seeding") {
            return gone();
        }
        let Ok(customer_id) = customer_id.parse::<Ulid>() else {
            return refuse(404, "unknown-persona");
        };
        #[derive(Deserialize)]
        struct PersonaRow {
            register: String,
        }
        let sql = self.sql();
        let found: Option<PersonaRow> = if has_table(&sql, "personas")? {
            first(
                &sql,
                "SELECT register FROM personas WHERE id = ?",
                vec![customer_id.to_string().into()],
            )?
        } else {
            None
        };
        let place = match found {
            Some(r) => {
                serde_json::from_str::<customer::RegisterIn>(&r.register)?
                    .profile
                    .place
            }
            None => {
                let g = Self::generated(u64::try_from(meta.seed).unwrap_or(0), meta.born()?)?;
                match g.customers.iter().find(|c| c.id == customer_id) {
                    Some(c) => c.place.clone(),
                    None => return refuse(404, "unknown-persona"),
                }
            }
        };
        json(&serde_json::json!({ "place": place }), 200)
    }

    /// The registered `Schedule` days from business today on: where `MenuPublished`'s new
    /// caps go.
    fn days(&self, meta: &MetaRow, now: WallTime) -> Result<Response> {
        #[derive(Deserialize)]
        struct NameRow {
            name: String,
        }
        let today = BakeryDate::of(business_at(now, meta.clock_offset_s));
        let found: Vec<NameRow> = rows(
            &self.sql(),
            "SELECT name FROM registry WHERE class = ? AND wiped_at IS NULL ORDER BY name",
            vec![schedule::CLASS.into()],
        )?;
        let names: Vec<String> = found
            .into_iter()
            .map(|r| r.name)
            .filter(|n| schedule::date_of(n).is_some_and(|d| d >= today))
            .collect();
        json(&names, 200)
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
        // The Kitchen and the Inbox keep their own copy of their switch, so each refuses a
        // delivery without asking.
        let (binding, target) = match cmd.fault {
            FaultName::Kitchen => (kitchen::BINDING, kitchen::name(sandbox)),
            FaultName::Inbox => (inbox::BINDING, inbox::name(sandbox)),
        };
        if self.is_registered(&target)? {
            let res = sql::call(
                &self.env,
                binding,
                &target,
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

    /// What the router checks a bearer token against: the state and the token version, read
    /// from `meta` with no other query but the last token's row.
    fn token_state(&self, meta: &MetaRow) -> Result<TokenState> {
        #[derive(Deserialize)]
        struct TokenRow {
            iat: i64,
            exp: i64,
            masked: Option<String>,
        }
        let token_v = u32::try_from(meta.token_v).unwrap_or(0);
        let row: Option<TokenRow> = if has_table(&self.sql(), "api_token")? {
            first(
                &self.sql(),
                "SELECT iat, exp, masked FROM api_token WHERE token_v = ?",
                vec![meta.token_v.into()],
            )?
        } else {
            None
        };
        let wall = |s: i64| {
            WallTime::from_unix_ms(s.saturating_mul(1_000))
                .map(|t| t.to_string())
                .ok()
        };
        Ok(TokenState {
            state: meta.state.clone(),
            token_v,
            issued_at: row.as_ref().and_then(|r| wall(r.iat)),
            expires_at: row.as_ref().and_then(|r| wall(r.exp)),
            masked: row.and_then(|r| r.masked),
        })
    }

    /// `IssueApiToken` and `RotateApiToken` (docs/domain.md, "Sandbox"): the token row and the
    /// command's key in one transaction, and for a rotation the version plus one and
    /// `ApiTokenRotated { token_v }` with them, so a token naming the old version is refused from
    /// the next request on. The version only grows. A key seen with the other command is 422.
    async fn issue_token(
        &self,
        meta: &MetaRow,
        cmd: TokenCommand,
        now: WallTime,
    ) -> Result<Response> {
        if meta.state == "wiping" {
            return gone();
        }
        let sql = self.sql();
        exec(&sql, API_TOKEN_TABLE, vec![])?;
        let kind = if cmd.rotate { "rotate" } else { "issue" };
        let seen = stream::seen(&sql, &cmd.key)?;
        match bakery_domain::outbox::check_command(seen.as_ref(), kind) {
            Ok(bakery_domain::outbox::CommandCheck::Replay(result)) => return replayed(result),
            Ok(bakery_domain::outbox::CommandCheck::Fresh) => {}
            Err(_) => return refuse(422, "key-reused"),
        }
        let token_v = meta.token_v + i64::from(cmd.rotate);
        let issued = TokenIssued {
            tid: cmd.tid.clone(),
            iat: cmd.iat,
            exp: cmd.exp,
            token_v: u32::try_from(token_v).map_err(|_| Error::RustError("token_v".into()))?,
        };
        let answer = serde_json::to_string(&issued)?;
        let event = if cmd.rotate {
            let sandbox = meta.sandbox()?;
            Some(Envelope {
                v: bakery_domain::ENVELOPE_VERSION,
                id: random::ulid(now)?,
                sandbox,
                stream: bakery_app::names::sandbox_object_name(sandbox),
                seq: stream::head(&sql, sandbox, "")?.last_seq + 1,
                event_type: "ApiTokenRotated".into(),
                at: business_at(now, meta.clock_offset_s),
                recorded_at: now,
                data: serde_json::json!({ "token_v": token_v }),
                cause: Some(cmd.key.clone()),
            })
        } else {
            None
        };
        let stored = answer.clone();
        let tx_sql = self.sql();
        transaction_sync(&self.state.storage(), move || {
            if let Some(event) = &event {
                exec(&tx_sql, "UPDATE meta SET token_v = ?", vec![token_v.into()])?;
                stream::append(&tx_sql, std::slice::from_ref(event))?;
            }
            exec(
                &tx_sql,
                "INSERT OR REPLACE INTO api_token (id, token_v, tid, iat, exp, masked)
                 VALUES (1, ?, ?, ?, ?, NULL)",
                vec![
                    token_v.into(),
                    cmd.tid.as_str().into(),
                    cmd.iat.into(),
                    cmd.exp.into(),
                ],
            )?;
            stream::remember(&tx_sql, &cmd.key, kind, &stored, now)?;
            Ok(())
        })?;
        if cmd.rotate {
            stream::relay_soon(&self.state, &self.env, now, CLASS).await?;
        }
        let mut res = Response::ok(answer)?;
        res.headers_mut().set("Content-Type", "application/json")?;
        Ok(res)
    }

    /// The signed token's masked form, kept for `GET` while that token is the last issued.
    fn token_masked(&self, body: &TokenMasked) -> Result<Response> {
        if has_table(&self.sql(), "api_token")? {
            exec(
                &self.sql(),
                "UPDATE api_token SET masked = ? WHERE token_v = ? AND tid = ?",
                vec![
                    body.masked.as_str().into(),
                    i64::from(body.token_v).into(),
                    body.tid.as_str().into(),
                ],
            )?;
        }
        json(&serde_json::json!({ "ok": true }), 200)
    }

    /// `AdvanceClock` (docs/domain.md, "Sandbox"): the step from the domain's rules (`15m`,
    /// `1h`, `1d`, `next-opening`, or `<n>m`), so the offset only grows, at most 14 days in total;
    /// `ClockAdvanced` is appended with the key; then every child is told the new offset, the
    /// Kitchen with the event too, for the console's feed, and one that cannot be reached is
    /// retried by the `clock` timer (docs/architecture.md, "Time travel").
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
        let from = business_at(now, meta.clock_offset_s);
        let offset = match advance(meta.clock_offset_s, cmd.step, from) {
            Ok(o) => o,
            Err(e) => {
                return json(
                    &serde_json::json!({ "error": "clock", "rule": e.rule() }),
                    422,
                );
            }
        };
        let clock_v = meta.clock_v + 1;
        let sandbox = meta.sandbox()?;
        let to = business_at(now, offset);
        let step = cmd.step.to_string();
        let answer = serde_json::to_string(&ClockResponse {
            clock_offset_s: offset,
            clock_v: u32::try_from(clock_v).unwrap_or(0),
            business_now: to.to_string(),
            step: Some(step.clone()),
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
                "step": step,
            }),
            cause: Some(cmd.key.clone()),
        };
        let (key, stored) = (cmd.key.clone(), answer.clone());
        let tx_sql = self.sql();
        let tx_event = event.clone();
        transaction_sync(&self.state.storage(), move || {
            exec(
                &tx_sql,
                "UPDATE meta SET clock_offset_s = ?, clock_v = ?",
                vec![offset.into(), clock_v.into()],
            )?;
            stream::append(&tx_sql, std::slice::from_ref(&tx_event))?;
            stream::remember(&tx_sql, &key, "", &stored, now)?;
            Ok(())
        })?;
        let missed = self
            .tell_children_of_clock(offset, clock_v, Some(&event))
            .await?;
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
    /// The Kitchen also gets `event`, the `ClockAdvanced` it shows on the console's feed.
    async fn tell_children_of_clock(
        &self,
        offset: i64,
        clock_v: i64,
        event: Option<&Envelope>,
    ) -> Result<usize> {
        let sql = self.sql();
        let behind: Vec<ChildRow> = rows(
            &sql,
            "SELECT name, class FROM registry WHERE wiped_at IS NULL AND clock_v < ?",
            vec![clock_v.into()],
        )?;
        let mut missed = 0;
        for child in &behind {
            let binding = Self::binding_of(&child.class)?;
            let update = ClockUpdate {
                clock_offset_s: offset,
                clock_v: u32::try_from(clock_v).unwrap_or(0),
                event: event.filter(|_| child.class == kitchen::CLASS).cloned(),
            };
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
            .tell_children_of_clock(meta.clock_offset_s, meta.clock_v, None)
            .await?;
        if missed > 0 {
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
        let while_off = body.while_off;
        let id_for_tx = id.clone();
        transaction_sync(&self.state.storage(), move || {
            let inserted = exec(
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
            // The mark goes with the row it describes: a second copy of a kept letter changes
            // neither.
            if inserted > 0 && while_off {
                exec(
                    &sql,
                    "INSERT OR IGNORE INTO dead_letters_while_off (id) VALUES (?)",
                    vec![id_for_tx.as_str().into()],
                )?;
            }
            exec(
                &sql,
                "DELETE FROM delivery_errors WHERE id = ?",
                vec![id_for_tx.into()],
            )?;
            Ok(())
        })?;
        console_log!("{{\"event\":\"dead_letter\",\"id\":\"{id}\",\"while_off\":{while_off}}}");
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
            &format!("{DEAD_ROW} WHERE d.id = ?"),
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
                vec![id.as_str().into()],
            )?;
            exec(
                &sql,
                "DELETE FROM dead_letters_while_off WHERE id = ?",
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
    /// Index into the seed's schedule days, for a `Schedule`.
    day: Option<usize>,
    /// Index into the seed's catering events, for a `CateringEvent`.
    catering: Option<usize>,
    /// Index into the seed's catering events, for the `Schedule` day that holds its place.
    catering_day: Option<usize>,
}

/// The Catalog, the Kitchen, Billing, Crm, the Inbox, the Recorder, the seed's 7 Schedule days,
/// today's Dispatch, its 12 open orders, its 8 catering events and the 3 days that hold the
/// accepted and confirmed events' places: 37 children. The Recorder goes before every child that
/// writes events, so the flight recorder holds the seeded orders' hops too. The days and the Dispatch go before the orders, so an
/// order's events find its day and its stop already there; Crm
/// and the Inbox go before the orders too, so the seeded orders' events, which their outboxes
/// relay, find both born (and a seeded paid order's points find Crm), and before the catering
/// events, whose own events the Sandbox hands them as each is seeded.
fn seed_plan(g: &Generated, sandbox: Ulid) -> Vec<SeedChild> {
    let plain = |class, binding, name| SeedChild {
        class,
        binding,
        name,
        open: None,
        day: None,
        catering: None,
        catering_day: None,
    };
    let mut plan = vec![
        SeedChild {
            class: catalog::CLASS,
            binding: catalog::BINDING,
            name: catalog::name(sandbox),
            open: None,
            day: None,
            catering: None,
            catering_day: None,
        },
        SeedChild {
            class: kitchen::CLASS,
            binding: kitchen::BINDING,
            name: kitchen::name(sandbox),
            open: None,
            day: None,
            catering: None,
            catering_day: None,
        },
        SeedChild {
            class: billing::CLASS,
            binding: billing::BINDING,
            name: billing::name(sandbox),
            open: None,
            day: None,
            catering: None,
            catering_day: None,
        },
        plain(crm::CLASS, crm::BINDING, crm::name(sandbox)),
        plain(inbox::CLASS, inbox::BINDING, inbox::name(sandbox)),
        plain(recorder::CLASS, recorder::BINDING, recorder::name(sandbox)),
    ];
    plan.extend(g.schedule.iter().enumerate().map(|(i, d)| SeedChild {
        class: schedule::CLASS,
        binding: schedule::BINDING,
        name: schedule::name(sandbox, d.date),
        open: None,
        day: Some(i),
        catering: None,
        catering_day: None,
    }));
    plan.push(plain(
        dispatch::CLASS,
        dispatch::BINDING,
        dispatch::name(sandbox, bakery_seed::seed_dispatch(g).date),
    ));
    plan.extend(g.open_orders.iter().enumerate().map(|(i, o)| SeedChild {
        class: order::CLASS,
        binding: order::BINDING,
        name: order::name(sandbox, o.id),
        open: Some(i),
        day: None,
        catering: None,
        catering_day: None,
    }));
    plan.extend(g.catering.iter().enumerate().map(|(i, e)| SeedChild {
        class: catering::CLASS,
        binding: catering::BINDING,
        name: catering::name(sandbox, e.id),
        open: None,
        day: None,
        catering: Some(i),
        catering_day: None,
    }));
    plan.extend(
        g.catering
            .iter()
            .enumerate()
            .filter(|(_, e)| holds_a_place(e))
            .filter_map(|(i, e)| {
                let date: BakeryDate = e.date.parse().ok()?;
                Some(SeedChild {
                    class: schedule::CLASS,
                    binding: schedule::BINDING,
                    name: schedule::name(sandbox, date),
                    open: None,
                    day: None,
                    catering: None,
                    catering_day: Some(i),
                })
            }),
    );
    plan
}

/// Whether a seeded catering event holds its day's place at birth: an accepted one (held while
/// its deposit hold runs) and a confirmed one (reserved). The invoiced and closed ones are in the
/// past, before the sandbox's first day, and the rest hold nothing.
fn holds_a_place(e: &bakery_seed::CateringEvent) -> bool {
    matches!(
        e.state,
        bakery_seed::CateringState::Accepted | bakery_seed::CateringState::Confirmed
    )
}

/// The seeded event as the Sandbox replays it (decision 1 of PR 7): an `accepted` event is
/// accepted at the sandbox's birth, so it is born with a live deposit hold that lapses 15
/// business minutes later, as a seeded open order's hold does. Every other event is the seed's.
fn rebased(e: &bakery_seed::CateringEvent, born: BusinessTime) -> bakery_seed::CateringEvent {
    let mut e = e.clone();
    if e.state == bakery_seed::CateringState::Accepted {
        e.accepted_at = Some(born);
    }
    e
}

/// The seeded event's commands, as `bakery_seed::seed_commands` gives them for the re-based
/// event, in the wire form the CateringEvent's `/_seed` reads.
fn catering_seed_steps(
    e: &bakery_seed::CateringEvent,
    born: BusinessTime,
) -> Vec<catering::SeedStep> {
    bakery_seed::seed_commands(&rebased(e, born))
        .iter()
        .map(|(at, cmd)| catering::SeedStep {
            at: *at,
            cmd: catering::Cmd::of(cmd),
        })
        .collect()
}

/// The `Schedule` day of a seeded accepted or confirmed event: its place held until the deposit
/// hold lapses (15 business minutes after birth for the re-based accepted event), and reserved
/// for a confirmed one. Built as `catering::hold_request` builds an acceptance's.
fn catering_day_cmds(e: &bakery_seed::CateringEvent, born: BusinessTime) -> Result<Vec<Cmd>> {
    let date: BakeryDate = e
        .date
        .parse()
        .map_err(|_| Error::RustError("a seeded catering date".into()))?;
    let accepted = rebased(e, born).accepted_at.unwrap_or(born);
    let expires_at = bakery_domain::calendar::plus_elapsed_minutes(
        accepted,
        bakery_domain::catering::DEPOSIT_HOLD_MINUTES,
    )
    .map_err(|e| Error::RustError(e.to_string()))?;
    let mut cmds = vec![Cmd::Hold(HoldRequest {
        reference: e.id,
        kind: bakery_domain::schedule::HoldKind::Catering,
        start: date.opening(),
        zone: None,
        lines: vec![bakery_domain::schedule::ItemQty {
            item: e.package.to_owned(),
            qty: e.headcount,
        }],
        expires_at,
    })];
    if e.state == bakery_seed::CateringState::Confirmed {
        cmds.push(Cmd::Confirm { reference: e.id });
    }
    Ok(cmds)
}

/// The seed's records cross into the domain's types as JSON, as the alignment test in
/// bakery-app reads them.
fn via_json<T: Serialize, U: serde::de::DeserializeOwned>(value: T) -> Result<U> {
    Ok(serde_json::from_value(serde_json::to_value(value)?)?)
}

impl SeedChild {
    fn body(&self, g: &Generated, meta: &MetaRow) -> Result<serde_json::Value> {
        let birth = meta.birth(self.name.clone())?;
        let born = meta.born_business()?;
        if let Some(i) = self.day {
            return Ok(serde_json::to_value(SeedSchedule {
                birth,
                cmds: schedule_seed_cmds(g, i, born)?,
            })?);
        }
        if let Some(i) = self.catering {
            return Ok(serde_json::to_value(catering::SeedCatering {
                birth,
                steps: catering_seed_steps(&g.catering[i], born),
            })?);
        }
        if let Some(i) = self.catering_day {
            return Ok(serde_json::to_value(SeedSchedule {
                birth,
                cmds: catering_day_cmds(&g.catering[i], born)?,
            })?);
        }
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
            None if self.class == dispatch::CLASS => {
                serde_json::to_value(dispatch::SeedDispatch {
                    birth,
                    cmds: bakery_seed::seed_dispatch(g)
                        .commands
                        .iter()
                        .filter_map(|(_, c)| dispatch::Cmd::of(c))
                        .collect(),
                })?
            }
            None if self.class == billing::CLASS => serde_json::to_value(billing::SeedBilling {
                birth,
                days: billing::daily_totals(&g.history),
                payments: billing::seed_payments(&g.open_orders)?,
            })?,
            None if self.class == crm::CLASS => serde_json::to_value(crm::SeedCrm {
                birth,
                directory: bakery_seed::directory(g),
                profiles: g
                    .customers
                    .iter()
                    .map(|c| {
                        (
                            c.id,
                            crm::PersonaProfile {
                                preferences: c.preferences.iter().map(|&p| p.to_owned()).collect(),
                                place: c.place.clone(),
                            },
                        )
                    })
                    .collect(),
                envelopes: bakery_seed::history_envelopes(g, meta.sandbox()?),
            })?,
            None if self.class == recorder::CLASS => {
                serde_json::to_value(recorder::SeedRecorder { birth })?
            }
            None if self.class == inbox::CLASS => serde_json::to_value(inbox::SeedInbox {
                birth,
                seed: g.seed.0,
                messages: bakery_seed::seed_messages(g),
            })?,
            None => serde_json::to_value(kitchen::SeedKitchen {
                birth,
                fault: false,
            })?,
            Some(i) => {
                let o = &g.open_orders[i];
                serde_json::to_value(order::SeedOrder {
                    birth,
                    events: open_order_events(g, o, born)?,
                    at: o.placed_at,
                })?
            }
        };
        Ok(value)
    }
}

/// A persona's `Customer` payload at its first touch: the seed's `Register`, as the object
/// takes it.
fn register_in(c: &bakery_seed::Customer) -> Result<customer::RegisterIn> {
    match bakery_seed::register(c) {
        bakery_domain::customer::CustomerCommand::Register {
            profile,
            marketing,
            opening_points,
            ..
        } => Ok(customer::RegisterIn {
            profile,
            marketing,
            opening_points,
        }),
        _ => Err(Error::RustError(
            "the seed's register is not a Register".into(),
        )),
    }
}

/// When a seeded order's hold ends: 15 minutes of business time after its placement or the
/// sandbox's birth, whichever is later, so it is on the board when the visitor arrives. The
/// Order's `held_until` and the Schedule's `expires_at` are this one instant.
fn seed_held_until(placed_at: BusinessTime, born: BusinessTime) -> Result<BusinessTime> {
    let base = if placed_at > born { placed_at } else { born };
    base.plus_minutes(SEED_HOLD_MINUTES)
        .map_err(|e| Error::RustError(e.to_string()))
}

/// One seeded `Schedule` day's commands: the menu's caps, any capacity the seed sets apart from
/// the defaults, then each open order's place held until its Order's `held_until`, and confirmed
/// when the order is past `placed`.
fn schedule_seed_cmds(g: &Generated, i: usize, born: BusinessTime) -> Result<Vec<Cmd>> {
    let day = &g.schedule[i];
    let mut cmds = vec![Cmd::RefreshCaps {
        menu_version: 1,
        caps: day.item_caps.clone(),
    }];
    if day.slot_capacity != DEFAULT_SLOT_CAPACITY {
        cmds.extend(day.date.slot_starts().into_iter().map(|s| {
            let m = bakery_domain::calendar::local_minutes(s);
            Cmd::SetCapacity {
                target: Target::Slot(m),
                capacity: day.slot_capacity,
            }
        }));
    }
    if day.zone_capacity != DEFAULT_ZONE_CAPACITY {
        cmds.extend(
            bakery_domain::schedule::ZONES
                .iter()
                .map(|z| Cmd::SetCapacity {
                    target: Target::Zone((*z).to_owned()),
                    capacity: day.zone_capacity,
                }),
        );
    }
    if day.catering_capacity != DEFAULT_CATERING_CAPACITY {
        cmds.push(Cmd::SetCapacity {
            target: Target::Catering,
            capacity: day.catering_capacity,
        });
    }
    for place in &day.places {
        let placed_at = g
            .open_orders
            .iter()
            .find(|o| o.id == place.reference)
            .map(|o| o.placed_at)
            .ok_or_else(|| Error::RustError("a seeded place names no open order".into()))?;
        cmds.push(Cmd::Hold(HoldRequest {
            reference: place.reference,
            kind: place.kind,
            start: place.start,
            zone: place.zone.map(str::to_owned),
            lines: place.lines.clone(),
            expires_at: seed_held_until(placed_at, born)?,
        }));
        if place.status == HoldStatus::Reserved {
            cmds.push(Cmd::Confirm {
                reference: place.reference,
            });
        }
    }
    Ok(cmds)
}

/// The events that bring an order to its seeded state. One still waiting for payment is held
/// until [`seed_held_until`].
fn open_order_events(
    g: &Generated,
    o: &bakery_seed::OpenOrder,
    now: BusinessTime,
) -> Result<Vec<OrderEvent>> {
    let held_until = seed_held_until(o.placed_at, now)?;
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
    fn the_plan_is_thirty_seven_children_catalog_kitchen_billing_crm_inbox_recorder_the_days_and_dispatch_first()
     {
        let g = generated();
        let sandbox = Ulid::from_parts(1, 1);
        let plan = seed_plan(&g, sandbox);
        assert_eq!(plan.len(), 37);
        assert_eq!(plan[0].name, format!("catalog:{sandbox}"));
        assert_eq!(plan[1].name, format!("kitchen:{sandbox}"));
        assert_eq!(plan[2].name, format!("billing:{sandbox}"));
        assert_eq!(
            (plan[3].class, plan[3].name.clone()),
            ("Crm", format!("crm:{sandbox}"))
        );
        assert_eq!(
            (plan[4].class, plan[4].name.clone()),
            ("Inbox", format!("inbox:{sandbox}"))
        );
        // The flight recorder, before every child whose events the consumer delivers.
        assert_eq!(
            (plan[5].class, plan[5].name.clone()),
            ("Recorder", format!("recorder:{sandbox}"))
        );
        assert!(plan[6..13].iter().all(|c| c.class == "Schedule"
            && c.name.starts_with(&format!("schedule:{sandbox}:"))
            && schedule::date_of(&c.name).is_some()));
        // Today's Dispatch, before the orders whose stops it holds.
        assert_eq!(
            (plan[13].class, plan[13].name.clone()),
            ("Dispatch", format!("dispatch:{sandbox}:2026-11-07"))
        );
        assert!(
            plan[14..26]
                .iter()
                .all(|c| c.class == "Order" && c.name.starts_with(&format!("order:{sandbox}:")))
        );
        assert!(
            plan[26..34].iter().all(|c| c.class == "CateringEvent"
                && c.name.starts_with(&format!("catering:{sandbox}:")))
        );
        // The accepted and the two confirmed events' days, none of them a seeded week day.
        assert!(plan[34..].iter().all(|c| c.class == "Schedule"));
        let names: std::collections::BTreeSet<&str> =
            plan.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names.len(), plan.len(), "no child twice");
        assert_eq!(plan.len().div_ceil(SEED_BATCH), 6, "six seeding runs");
        // Every class but the Simulator, born on the first "Start traffic", and the Customer,
        // born on a persona's first touch.
        for (class, _) in DISPATCH
            .iter()
            .filter(|(c, _)| ![simulator::CLASS, customer::CLASS].contains(c))
        {
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
    fn seeded_days_decide_cleanly_and_hold_each_unpaid_order_until_its_held_until() {
        use bakery_domain::schedule::{Schedule as ScheduleAggregate, ScheduleState};
        use bakery_domain::{DecideContext, execute};
        let g = generated();
        let born: BusinessTime = "2026-11-07T08:00:00-07:00".parse().unwrap();
        let ctx = DecideContext {
            now: born,
            id: Ulid::from_parts(1, 1),
        };
        let mut places = 0;
        for (i, day) in g.schedule.iter().enumerate() {
            let mut state = ScheduleState::new(day.date);
            for cmd in schedule_seed_cmds(&g, i, born).unwrap() {
                if let Cmd::Hold(h) = &cmd {
                    let o = g.open_orders.iter().find(|o| o.id == h.reference).unwrap();
                    let events = open_order_events(&g, o, born).unwrap();
                    let order = replay::<OrderAggregate>(&events);
                    assert_eq!(order.record().unwrap().held_until, h.expires_at);
                    places += 1;
                }
                let (next, _) = execute::<ScheduleAggregate>(state, &cmd.domain(), &ctx)
                    .unwrap_or_else(|e| panic!("{} refused {cmd:?}: {}", day.date, e.rule()));
                state = next;
            }
            for place in &day.places {
                assert_eq!(
                    state.hold(place.reference).map(|h| h.status),
                    Some(place.status)
                );
            }
        }
        assert_eq!(
            places,
            g.open_orders.len(),
            "every open order has its place"
        );
    }

    #[test]
    fn seeded_catering_events_replay_to_their_states_and_an_accepted_one_holds_from_birth() {
        use bakery_domain::catering::{Catering, CateringState as Saga, CateringStatus, timers};
        use bakery_domain::schedule::{Schedule as ScheduleAggregate, ScheduleState};
        use bakery_domain::{DecideContext, execute};
        let g = generated();
        let born: BusinessTime = "2026-11-07T08:00:00-07:00".parse().unwrap();
        let mut held = 0;
        for e in &g.catering {
            let mut state = Saga::default();
            for step in catering_seed_steps(e, born) {
                // Through the wire form, as the object reads it.
                let cmd: catering::Cmd =
                    serde_json::from_str(&serde_json::to_string(&step.cmd).unwrap()).unwrap();
                let ctx = DecideContext {
                    now: step.at,
                    id: Ulid::from_parts(1, 1),
                };
                state = execute::<Catering>(state, &cmd.domain(), &ctx)
                    .unwrap_or_else(|err| panic!("{}: {}", e.id, err.rule()))
                    .0;
            }
            assert_eq!(state.status(), Some(e.state.status()), "{}", e.id);
            if e.state == bakery_seed::CateringState::Accepted {
                let r = state.record().unwrap();
                let lapse = r.lapses_at.unwrap();
                assert_eq!(
                    lapse,
                    bakery_domain::calendar::plus_elapsed_minutes(born, 15).unwrap()
                );
                assert!(timers(&state).iter().any(|t| t.at == lapse));
            }
            if holds_a_place(e) {
                let date: BakeryDate = e.date.parse().unwrap();
                let mut day = ScheduleState::new(date);
                for cmd in catering_day_cmds(e, born).unwrap() {
                    let ctx = DecideContext {
                        now: born,
                        id: Ulid::from_parts(1, 2),
                    };
                    day = execute::<ScheduleAggregate>(day, &cmd.domain(), &ctx)
                        .unwrap_or_else(|err| panic!("{date}: {}", err.rule()))
                        .0;
                }
                let want = if state.status() == Some(CateringStatus::Accepted) {
                    HoldStatus::Held
                } else {
                    HoldStatus::Reserved
                };
                assert_eq!(day.hold(e.id).map(|h| h.status), Some(want));
                assert_eq!(day.catering_taken(), 1);
                held += 1;
            }
        }
        assert_eq!(
            held, 3,
            "one accepted and two confirmed events hold a place"
        );
    }

    #[test]
    fn a_day_exists_from_the_birth_day_to_thirty_days_after_today() {
        let meta = MetaRow {
            id: Ulid::from_parts(1, 1).to_string(),
            owner: "guest:x".into(),
            kind: "guest".into(),
            seed: 42,
            // 08:00 MST on 2026-11-07.
            born: "2026-11-07T15:00:00.000Z".into(),
            wipe_at: "2026-11-08T10:00:00.000Z".into(),
            state: "live".into(),
            persona: Ulid::from_parts(1, 2).to_string(),
            clock_offset_s: 86_400,
            clock_v: 1,
            token_v: 0,
        };
        let now: WallTime = "2026-11-07T16:00:00.000Z".parse().unwrap();
        let d = |s: &str| s.parse::<BakeryDate>().unwrap();
        assert!(!meta.day_in_range(d("2026-11-06"), now).unwrap());
        assert!(meta.day_in_range(d("2026-11-07"), now).unwrap());
        // Business today is the 8th, a day ahead.
        assert!(meta.day_in_range(d("2026-12-08"), now).unwrap());
        assert!(!meta.day_in_range(d("2026-12-09"), now).unwrap());
    }

    #[test]
    fn the_clock_bound_is_fourteen_days() {
        assert_eq!(bakery_domain::clock::MAX_OFFSET_S, 1_209_600);
    }
}
