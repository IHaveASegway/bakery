//! `Dispatch`, one per sandbox and bakery day, named `dispatch:<sandbox>:<YYYY-MM-DD>`
//! (docs/domain.md, "Object naming"; ADR 0012). It hosts the domain's `Dispatch` aggregate: the
//! state is the fold of its own `events` from `DispatchState::new(date)`, the date read from the
//! object's name. Every command writes its events, their outbox rows, its key and the id of the
//! event it consumed in one transaction, then relays. It keeps no timers of its own: only the
//! outbox's and the backstop every child has.
//!
//! The travel-time matrix is the Salt Lake City fixture (`crates/seed/data/salt-lake-city/
//! matrix.json`, compiled in as `bakery_seed::CITY_MATRIX_JSON`), read by
//! `TravelMatrix::from_json` once per isolate ([`matrix`]) and handed to the aggregate in the
//! commands that plan; it is never stored.
//!
//! Born on first touch through the Sandbox's registry, like a Schedule day: the router (a read
//! of the day, a staff command), the consumer (a delivery's stop) and the seed register the name
//! first, then hand the birth here.
//!
//! Paths (the Worker builds them; nothing outside reaches them):
//!
//! - `POST /_open {birth}` → 200 `DispatchResponse`: the day, created empty if it was not yet.
//! - `POST /_seed {birth, cmds}` → 201 `DispatchResponse`; 200 when already seeded. The seed's
//!   commands (`add_stop`, `confirm_stop`, `propose`) decided in order through the aggregate and
//!   written in one transaction; one the rules refuse is logged by its rule and skipped.
//! - `POST /_command {key, body_hash, birth?, cmd, cause?}` → 200 [`Answer`]; 200 with
//!   `Idempotent-Replayed: true` for a key seen with the same body; 422 `{error: "key-reused"}`
//!   for one seen with another; 422 `{error: "dispatch", rule}` for a rule the command breaks,
//!   which writes nothing (the router picks the problem's status by route). With `birth` the
//!   day is created if needed. `cmd` is one of `{cmd: "propose", vans, capacity}`, `{cmd:
//!   "submit_plan", routes: [{van, stops, start?, end?}]}`, `{cmd: "publish", plan}`, `{cmd:
//!   "complete_stop", stop}`, and the consumer's and the seed's `add_stop`, `confirm_stop`,
//!   `remove_stop`. Before a `publish` over a published plan the object asks each of its Orders
//!   (`GET /_order`) whether it has left (out for delivery, delivered or closed), and the
//!   aggregate refuses `published` if one has. Before a `complete_stop` it asks the stop's
//!   Order whether it is ready (ready, out for delivery, delivered or closed), and the
//!   aggregate refuses `not-ready` if it is not.
//! - `POST /_event {envelope, birth?, place?}` → 200 `{outcome}` (`applied`, `unchanged`,
//!   `duplicate`, `ignored`, `refused`), from the consumer: `OrderPlaced` for a delivery is
//!   `AddStop` (the customer's place, the matrix index, in `place`), `OrderPaid` is
//!   `ConfirmStop`, `OrderExpired` and `OrderCancelled` are `RemoveStop`, and since 2026-11-08
//!   `OrderReady` is `ReadyStop`, which sends a stop of the published plan out (`StopReady`, for
//!   its Order) when its order was made after the plan, and since the UI audit of 2026-11-08
//!   `OrderOutForDelivery` is `DepartStop`, which marks the stop out for delivery
//!   (`StopDeparted`), each for the order the stream names. The
//!   event's id goes into `seen` and is the decision's id, so a redelivery is `duplicate`. 410 when the
//!   day was never born and no `birth` came with it; the consumer registers the day and sends
//!   again.
//! - `GET /_state` → 200 `DispatchResponse` (`bakery_app::dispatch_view`).
//! - `POST /_wipe`, `POST /_clock`: the child protocol (child.rs). No timer here moves with
//!   business time, so the clock only updates `meta`.

use std::cell::{Cell, OnceCell};
use std::sync::Arc;

use bakery_app::Clock;
use bakery_app::dispatch_view::dispatch_response;
use bakery_contracts::{DispatchResponse, OrderResponse, OrderStatus};
use bakery_domain::dispatch::{
    AddStop, Dispatch as Aggregate, DispatchCommand, DispatchEvent, DispatchState, PlaceIndex,
    PlanChoice, RemoveReason, SubmittedRoute, TravelMatrix,
};
use bakery_domain::order::OrderEvent;
use bakery_domain::outbox::{CommandCheck, Stamp, StreamHead, check_command, envelopes};
use bakery_domain::{
    BakeryDate, BusinessTime, DecideContext, DomainEvent, Envelope, Ulid, WallTime, execute,
    replay_from,
};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::child::{self, Birth, ClockUpdate};
use super::order;
use super::sql::{self, exec, gone, json, refuse, replayed, rows, transaction_sync};
use super::stream::{self, BACKSTOP, OUTBOX};
use crate::clock::{SystemClock, business_at};
use crate::random;

pub const BINDING: &str = "DISPATCH";
pub const CLASS: &str = "Dispatch";

pub fn name(sandbox: Ulid, date: BakeryDate) -> String {
    format!("dispatch:{sandbox}:{date}")
}

/// The day a Dispatch's name ends with.
pub fn date_of(name: &str) -> Option<BakeryDate> {
    let mut parts = name.split(':');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("dispatch"), Some(_), Some(date), None) => date.parse().ok(),
        _ => None,
    }
}

thread_local! {
    static MATRIX: OnceCell<Arc<TravelMatrix>> = const { OnceCell::new() };
}

/// The city's travel-time matrix, read from the compiled-in fixture the first time an isolate
/// asks, and kept for the isolate's life.
pub fn matrix() -> Result<Arc<TravelMatrix>> {
    MATRIX.with(|cell| {
        if let Some(m) = cell.get() {
            return Ok(m.clone());
        }
        let m = Arc::new(
            TravelMatrix::from_json(bakery_seed::CITY_MATRIX_JSON)
                .map_err(|e| Error::RustError(format!("the city matrix: {e}")))?,
        );
        let _ = cell.set(m.clone());
        Ok(m)
    })
}

const SCHEMA: &[&str] = &[
    child::META,
    // The consumed events' ids (docs/architecture.md, "Idempotent consumers").
    "CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at TEXT NOT NULL)",
];

/// A Dispatch command as the Worker sends it. The matrix is the object's own, added when the
/// command is decided.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Cmd {
    AddStop {
        order: Ulid,
        customer: Ulid,
        place: PlaceIndex,
        window: BusinessTime,
        zone: String,
        units: u32,
    },
    ConfirmStop {
        order: Ulid,
    },
    RemoveStop {
        order: Ulid,
        reason: RemoveReason,
    },
    Propose {
        vans: u8,
        capacity: u32,
    },
    SubmitPlan {
        routes: Vec<SubmittedRoute>,
    },
    Publish {
        plan: PlanChoice,
    },
    CompleteStop {
        stop: u16,
    },
}

impl Cmd {
    /// The seed's command in the wire form; `None` for one the seed never sends.
    pub fn of(cmd: &DispatchCommand) -> Option<Cmd> {
        Some(match cmd {
            DispatchCommand::AddStop(a) => Cmd::AddStop {
                order: a.order,
                customer: a.customer,
                place: a.place,
                window: a.window,
                zone: a.zone.clone(),
                units: a.units,
            },
            DispatchCommand::ConfirmStop { order } => Cmd::ConfirmStop { order: *order },
            DispatchCommand::RemoveStop { order, reason } => Cmd::RemoveStop {
                order: *order,
                reason: *reason,
            },
            DispatchCommand::Propose { vans, capacity, .. } => Cmd::Propose {
                vans: *vans,
                capacity: *capacity,
            },
            DispatchCommand::CompleteStop { stop, .. } => Cmd::CompleteStop { stop: *stop },
            DispatchCommand::SubmitPlan { .. }
            | DispatchCommand::Publish { .. }
            | DispatchCommand::ReadyStop { .. }
            | DispatchCommand::DepartStop { .. } => return None,
        })
    }

    /// The aggregate's command, with the matrix, the facts the object read from the Orders: for
    /// a publish whether a van has left, for a completion whether the stop's order is ready.
    pub fn domain(&self, matrix: &Arc<TravelMatrix>, facts: Facts) -> DispatchCommand {
        match self {
            Cmd::AddStop {
                order,
                customer,
                place,
                window,
                zone,
                units,
            } => DispatchCommand::AddStop(AddStop {
                order: *order,
                customer: *customer,
                place: *place,
                window: *window,
                zone: zone.clone(),
                units: *units,
            }),
            Cmd::ConfirmStop { order } => DispatchCommand::ConfirmStop { order: *order },
            Cmd::RemoveStop { order, reason } => DispatchCommand::RemoveStop {
                order: *order,
                reason: *reason,
            },
            Cmd::Propose { vans, capacity } => DispatchCommand::Propose {
                vans: *vans,
                capacity: *capacity,
                matrix: matrix.clone(),
            },
            Cmd::SubmitPlan { routes } => DispatchCommand::SubmitPlan {
                routes: routes.clone(),
                matrix: matrix.clone(),
            },
            Cmd::Publish { plan } => DispatchCommand::Publish {
                plan: *plan,
                departed: facts.departed,
                matrix: matrix.clone(),
            },
            Cmd::CompleteStop { stop } => DispatchCommand::CompleteStop {
                stop: *stop,
                ready: facts.ready,
            },
        }
    }
}

/// What the object reads from the Orders before deciding a command.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Facts {
    /// An order of the published plan is out for delivery, delivered or closed.
    pub departed: bool,
    /// The completed stop's order is ready, out for delivery, delivered or closed.
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandIn {
    pub key: String,
    #[serde(default)]
    pub body_hash: String,
    /// Creates the day on its first write.
    #[serde(default)]
    pub birth: Option<Birth>,
    pub cmd: Cmd,
    #[serde(default)]
    pub cause: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Open {
    pub birth: Birth,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedDispatch {
    pub birth: Birth,
    pub cmds: Vec<Cmd>,
}

/// One delivery from the consumer: the envelope, the day's birth when it was never touched,
/// and for `OrderPlaced` the customer's place in the matrix.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventIn {
    pub envelope: Envelope,
    #[serde(default)]
    pub birth: Option<Birth>,
    #[serde(default)]
    pub place: Option<PlaceIndex>,
}

/// `/_command`'s answer, stored as the key's result: the event types it appended and the day.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Answer {
    pub events: Vec<String>,
    pub dispatch: DispatchResponse,
}

/// A refusal's body.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Refusal {
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub rule: Option<String>,
}

#[durable_object]
pub struct Dispatch {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
}

impl DurableObject for Dispatch {
    fn new(state: State, env: Env) -> Self {
        Dispatch {
            state,
            env,
            schema_ready: Cell::new(false),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/_open") => {
                let body: Open = sql::body(&mut req).await?;
                self.open(body.birth, now).await
            }
            (Method::Post, "/_seed") => {
                let body: SeedDispatch = sql::body(&mut req).await?;
                self.seed(body, now).await
            }
            (Method::Post, "/_command") => {
                let body: CommandIn = sql::body(&mut req).await?;
                self.command(body, now).await
            }
            (Method::Post, "/_event") => {
                let text = req.text().await?;
                self.event(&text, now).await
            }
            (Method::Post, "/_wipe") => json(&child::wipe(&self.state).await?, 200),
            (method, path) => {
                let sql = self.sql();
                let Some(meta) = child::meta(&sql)? else {
                    return gone();
                };
                match (method, path) {
                    (Method::Get, "/_state") => {
                        let (state, _) = self.load(&meta)?;
                        json(&dispatch_response(&state, &*matrix()?), 200)
                    }
                    (Method::Post, "/_clock") => {
                        let body: ClockUpdate = sql::body(&mut req).await?;
                        child::clock(&sql, &body)?;
                        stream::arm(&self.state.storage(), now).await?;
                        json(&serde_json::json!({ "clock_v": body.clock_v }), 200)
                    }
                    _ => refuse(404, "not-found"),
                }
            }
        }
    }

    async fn alarm(&self) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let storage = self.state.storage();
        if child::meta(&storage.sql())?.is_none() {
            storage.delete_all().await?;
            return Response::empty();
        }
        for timer in stream::due(&storage.sql(), now)? {
            match timer.purpose.as_str() {
                OUTBOX => stream::outbox_timer(&storage, &self.env, now, CLASS).await?,
                BACKSTOP => {
                    console_log!("{{\"event\":\"backstop\",\"object\":\"{CLASS}\"}}");
                    child::wipe(&self.state).await?;
                    return Response::empty();
                }
                _ => stream::delete_timer(&storage.sql(), &timer.id)?,
            }
        }
        stream::rearm(&storage, now, CLASS).await?;
        Response::empty()
    }
}

/// What a decided command writes.
struct Write {
    birth: Birth,
    first_write: bool,
    last_seq: u64,
    events: Vec<DispatchEvent>,
    at: BusinessTime,
    cause: Option<String>,
    /// The command's key, body hash and stored answer.
    key: Option<(String, String, String)>,
    /// A consumed event's id.
    seen: Option<String>,
}

impl Dispatch {
    fn sql(&self) -> SqlStorage {
        self.state.storage().sql()
    }

    fn ensure_schema(&self) -> Result<()> {
        if !self.schema_ready.get() {
            stream::create_schema(&self.sql(), SCHEMA)?;
            self.schema_ready.set(true);
        }
        Ok(())
    }

    fn date(name: &str) -> Result<BakeryDate> {
        date_of(name).ok_or_else(|| Error::RustError("a dispatch name with no date".into()))
    }

    fn birth_of(meta: &child::Meta) -> Result<Birth> {
        Ok(Birth {
            sandbox: meta.sandbox_id()?,
            name: meta.name.clone(),
            clock_offset_s: meta.clock_offset_s,
            clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
        })
    }

    /// The day's state, folded from its stream, and the stream's last `seq`.
    fn load(&self, meta: &child::Meta) -> Result<(DispatchState, u64)> {
        let date = Self::date(&meta.name)?;
        if !sql::has_table(&self.sql(), "events")? {
            return Ok((DispatchState::new(date), 0));
        }
        let envelopes = stream::events(&self.sql(), meta.sandbox_id()?, &meta.name)?;
        let decoded: Vec<DispatchEvent> = envelopes
            .iter()
            .map(DispatchEvent::from_envelope)
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| Error::RustError(e.to_string()))?;
        let last = envelopes.last().map_or(0, |e| e.seq);
        Ok((
            replay_from::<Aggregate>(DispatchState::new(date), &decoded),
            last,
        ))
    }

    /// The day as it stands, created empty if it was not yet.
    async fn open(&self, birth: Birth, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        if let Some(meta) = child::meta(&sql)? {
            let (state, _) = self.load(&meta)?;
            return json(&dispatch_response(&state, &*matrix()?), 200);
        }
        let date = Self::date(&birth.name)?;
        self.ensure_schema()?;
        transaction_sync(&self.state.storage(), move || {
            child::born(&sql, &birth, now)
        })?;
        stream::arm(&self.state.storage(), now).await?;
        json(
            &dispatch_response(&DispatchState::new(date), &*matrix()?),
            200,
        )
    }

    /// The seed's commands for this day, decided one by one against the state so far and
    /// written together.
    async fn seed(&self, s: SeedDispatch, now: WallTime) -> Result<Response> {
        let m = matrix()?;
        if let Some(meta) = child::meta(&self.sql())? {
            let (state, _) = self.load(&meta)?;
            return json(&dispatch_response(&state, &m), 200);
        }
        let date = Self::date(&s.birth.name)?;
        let ctx = DecideContext {
            now: business_at(now, s.birth.clock_offset_s),
            id: random::ulid(now)?,
        };
        let mut state = DispatchState::new(date);
        let mut events = Vec::new();
        for cmd in &s.cmds {
            match execute::<Aggregate>(state.clone(), &cmd.domain(&m, Facts::default()), &ctx) {
                Ok((next, mut more)) => {
                    state = next;
                    events.append(&mut more);
                }
                Err(e) => console_log!(
                    "{{\"event\":\"seed_dispatch_refused\",\"object\":\"{CLASS}\",\"rule\":\"{}\"}}",
                    e.rule()
                ),
            }
        }
        self.ensure_schema()?;
        let answer = dispatch_response(&state, &m);
        self.write(
            Write {
                birth: s.birth,
                first_write: true,
                last_seq: 0,
                events,
                at: ctx.now,
                cause: None,
                key: None,
                seen: None,
            },
            now,
        )
        .await?;
        json(&answer, 201)
    }

    async fn command(&self, c: CommandIn, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        let meta = child::meta(&sql)?;
        let (birth, first_write) = match (&meta, &c.birth) {
            (Some(m), Some(b)) if m.name != b.name || m.sandbox != b.sandbox.to_string() => {
                return refuse(409, "identity");
            }
            (Some(m), _) => (Self::birth_of(m)?, false),
            (None, Some(b)) => (b.clone(), true),
            (None, None) => return gone(),
        };
        if !first_write {
            let seen = stream::seen(&sql, &c.key)?;
            match check_command(seen.as_ref(), &c.body_hash) {
                Ok(CommandCheck::Replay(result)) => return replayed(result),
                Ok(CommandCheck::Fresh) => {}
                Err(_) => return refuse(422, "key-reused"),
            }
        }
        let (state, last_seq) = match &meta {
            Some(m) => self.load(m)?,
            None => (DispatchState::new(Self::date(&birth.name)?), 0),
        };
        let facts = match (&c.cmd, state.published()) {
            (Cmd::Publish { .. }, Some(_)) => Facts {
                departed: self.departed(birth.sandbox, &state).await?,
                ready: false,
            },
            (Cmd::CompleteStop { stop }, Some(p)) => match p.stop_at(*stop) {
                Some(order) => Facts {
                    departed: false,
                    ready: self.ready(birth.sandbox, order).await?,
                },
                None => Facts::default(),
            },
            _ => Facts::default(),
        };
        let id: Ulid = c
            .key
            .rsplit(':')
            .next()
            .and_then(|k| k.parse().ok())
            .map_or_else(|| random::ulid(now), Ok)?;
        let ctx = DecideContext {
            now: business_at(now, birth.clock_offset_s),
            id,
        };
        let m = matrix()?;
        let (state, events) = match execute::<Aggregate>(state, &c.cmd.domain(&m, facts), &ctx) {
            Ok(done) => done,
            Err(e) => {
                return json(
                    &Refusal {
                        error: "dispatch".into(),
                        rule: Some(e.rule().to_owned()),
                    },
                    422,
                );
            }
        };
        let answer = Answer {
            events: events.iter().map(|e| e.name().to_owned()).collect(),
            dispatch: dispatch_response(&state, &m),
        };
        let stored = serde_json::to_string(&answer)?;
        if first_write {
            self.ensure_schema()?;
        }
        self.write(
            Write {
                birth,
                first_write,
                last_seq,
                events,
                at: ctx.now,
                cause: Some(c.cause.clone().unwrap_or_else(|| c.key.clone())),
                key: Some((c.key.clone(), c.body_hash.clone(), stored.clone())),
                seen: None,
            },
            now,
        )
        .await?;
        let mut out = Response::ok(stored)?;
        out.headers_mut().set("Content-Type", "application/json")?;
        Ok(out)
    }

    /// Whether a van has left on the published plan: any of its Orders out for delivery,
    /// delivered or closed. Asked in plan order, and stops at the first that has; a wiped Order
    /// (410) has not left.
    async fn departed(&self, sandbox: Ulid, state: &DispatchState) -> Result<bool> {
        let Some(published) = state.published() else {
            return Ok(false);
        };
        for &o in published.routes.iter().flat_map(|r| &r.stops) {
            if matches!(
                self.order_status(sandbox, o).await?,
                Some(OrderStatus::OutForDelivery | OrderStatus::Delivered | OrderStatus::Closed)
            ) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Whether the Order is ready for its stop to be completed: ready (published before it
    /// was), out for delivery, or already delivered or closed. A wiped Order (410) is not.
    async fn ready(&self, sandbox: Ulid, order: Ulid) -> Result<bool> {
        Ok(matches!(
            self.order_status(sandbox, order).await?,
            Some(
                OrderStatus::Ready
                    | OrderStatus::OutForDelivery
                    | OrderStatus::Delivered
                    | OrderStatus::Closed
            )
        ))
    }

    /// The Order's status; `None` when it does not exist or was wiped.
    async fn order_status(&self, sandbox: Ulid, o: Ulid) -> Result<Option<OrderStatus>> {
        let mut res = sql::call_empty(
            &self.env,
            order::BINDING,
            &order::name(sandbox, o),
            Method::Get,
            "/_order",
        )
        .await?;
        match res.status_code() {
            200 => {
                let r: OrderResponse = serde_json::from_str(&res.text().await?)?;
                Ok(Some(r.status))
            }
            404 | 410 => Ok(None),
            other => Err(Error::RustError(format!(
                "order answered {other} for its status"
            ))),
        }
    }

    /// One delivery from the consumer.
    async fn event(&self, text: &str, now: WallTime) -> Result<Response> {
        let Ok(input) = serde_json::from_str::<EventIn>(text) else {
            return refuse(422, "envelope");
        };
        let envelope = &input.envelope;
        let sql = self.sql();
        let meta = child::meta(&sql)?;
        let (birth, first_write) = match (&meta, &input.birth) {
            (Some(m), _) => (Self::birth_of(m)?, false),
            (None, Some(b)) => (b.clone(), true),
            (None, None) => return gone(),
        };
        if envelope.sandbox != birth.sandbox {
            return refuse(422, "envelope");
        }
        if !first_write {
            #[derive(Deserialize)]
            struct IdRow {
                #[allow(dead_code)]
                id: String,
            }
            let seen: Vec<IdRow> = rows(
                &sql,
                "SELECT id FROM seen WHERE id = ?",
                vec![envelope.id.to_string().into()],
            )?;
            if !seen.is_empty() {
                return json(&serde_json::json!({ "outcome": "duplicate" }), 200);
            }
        }
        let cmd = match command_of(envelope, input.place) {
            Ok(Some(cmd)) => cmd,
            Ok(None) => return json(&serde_json::json!({ "outcome": "ignored" }), 200),
            Err(why) => return refuse(422, why),
        };
        let (state, last_seq) = match &meta {
            Some(m) => self.load(m)?,
            None => (DispatchState::new(Self::date(&birth.name)?), 0),
        };
        let ctx = DecideContext {
            now: business_at(now, birth.clock_offset_s),
            id: envelope.id,
        };
        let (_, events) = match execute::<Aggregate>(state, &cmd, &ctx) {
            Ok(done) => done,
            Err(e) => {
                // A window on another day, for one: a retry cannot change that.
                console_log!(
                    "{{\"event\":\"dispatch_event_refused\",\"id\":\"{}\",\"type\":{:?},\"rule\":\"{}\"}}",
                    envelope.id,
                    envelope.event_type,
                    e.rule()
                );
                return json(
                    &serde_json::json!({ "outcome": "refused", "rule": e.rule() }),
                    200,
                );
            }
        };
        let outcome = if events.is_empty() {
            "unchanged"
        } else {
            "applied"
        };
        if first_write {
            self.ensure_schema()?;
        }
        self.write(
            Write {
                birth,
                first_write,
                last_seq,
                events,
                at: ctx.now,
                cause: Some(envelope.id.to_string()),
                key: None,
                seen: Some(envelope.id.to_string()),
            },
            now,
        )
        .await?;
        json(&serde_json::json!({ "outcome": outcome }), 200)
    }

    /// The transaction, then the relay, or the alarm when nothing was appended.
    async fn write(&self, w: Write, now: WallTime) -> Result<()> {
        let any = !w.events.is_empty();
        self.commit(w, now)?;
        if any {
            stream::relay_soon(&self.state, &self.env, now, CLASS).await
        } else {
            stream::arm(&self.state.storage(), now).await
        }
    }

    /// One transaction: `meta` on the first write, the events and their outbox rows, the
    /// command's key with its answer, and the consumed event's id.
    fn commit(&self, w: Write, now: WallTime) -> Result<()> {
        let sql = self.sql();
        let head = StreamHead {
            sandbox: w.birth.sandbox,
            stream: w.birth.name.clone(),
            last_seq: w.last_seq,
        };
        let stamp = Stamp {
            at: w.at,
            recorded_at: now,
            cause: w.cause.clone(),
        };
        let mut ids = Vec::new();
        for _ in &w.events {
            ids.push(random::ulid(now)?);
        }
        let mut ids = ids.into_iter();
        let built = envelopes(&head, &stamp, &w.events, || {
            ids.next().unwrap_or(Ulid::from_parts(0, 0))
        })
        .map_err(|e| Error::RustError(e.to_string()))?;
        transaction_sync(&self.state.storage(), move || {
            if w.first_write {
                child::born(&sql, &w.birth, now)?;
            }
            stream::append(&sql, &built)?;
            if let Some((key, hash, answer)) = &w.key {
                stream::remember(&sql, key, hash, answer, now)?;
            }
            if let Some(id) = &w.seen {
                exec(
                    &sql,
                    "INSERT OR IGNORE INTO seen (id, at) VALUES (?, ?)",
                    vec![id.as_str().into(), now.to_string().into()],
                )?;
            }
            Ok(())
        })
    }
}

/// The command an order event from the consumer is, for the order its stream names: `None` for
/// one that asks nothing (a pickup's `OrderPlaced`, a type this object does not hear), and the
/// refusal's slug for one it cannot read.
fn command_of(
    envelope: &Envelope,
    place: Option<PlaceIndex>,
) -> std::result::Result<Option<DispatchCommand>, &'static str> {
    let order = order_of(envelope);
    let named = || order.ok_or("envelope");
    Ok(Some(match envelope.event_type.as_str() {
        "OrderPlaced" => {
            let placed = OrderEvent::from_envelope(envelope).map_err(|_| "envelope")?;
            let place = place.ok_or("place")?;
            match AddStop::from_order_placed(&placed, place) {
                Some(add) if Some(add.order) == order => DispatchCommand::AddStop(add),
                Some(_) => return Err("envelope"),
                // A pickup has no stop.
                None => return Ok(None),
            }
        }
        "OrderPaid" => DispatchCommand::ConfirmStop { order: named()? },
        // Made after its stop was published: it goes out now (docs/domain.md, "Dispatch").
        "OrderReady" => DispatchCommand::ReadyStop { order: named()? },
        // Gone out on its van: the stop says so (docs/domain.md, "Dispatch").
        "OrderOutForDelivery" => {
            match OrderEvent::from_envelope(envelope).map_err(|_| "envelope")? {
                OrderEvent::OrderOutForDelivery { route, stop } => DispatchCommand::DepartStop {
                    order: named()?,
                    route,
                    stop,
                },
                _ => return Err("envelope"),
            }
        }
        "OrderExpired" => DispatchCommand::RemoveStop {
            order: named()?,
            reason: RemoveReason::Expired,
        },
        "OrderCancelled" => DispatchCommand::RemoveStop {
            order: named()?,
            reason: RemoveReason::Cancelled,
        },
        _ => return Ok(None),
    }))
}

/// The order an Order stream names, `order:<sandbox>:<ulid>`, in the envelope's own sandbox.
fn order_of(envelope: &Envelope) -> Option<Ulid> {
    let mut parts = envelope.stream.split(':');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("order"), Some(sandbox), Some(id), None)
            if sandbox == envelope.sandbox.to_string() =>
        {
            id.parse().ok()
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakery_domain::dispatch::{DispatchError, PlanSource};

    #[test]
    fn a_dispatch_name_carries_its_day() {
        let sandbox = Ulid::from_parts(1, 1);
        let date = BakeryDate::new(2026, 11, 7).unwrap();
        let n = name(sandbox, date);
        assert_eq!(n, format!("dispatch:{sandbox}:2026-11-07"));
        assert_eq!(date_of(&n), Some(date));
        assert_eq!(date_of(&format!("schedule:{sandbox}:2026-11-07")), None);
        assert_eq!(date_of(&format!("{n}:extra")), None);
        assert_eq!(date_of("dispatch:x"), None);
    }

    #[test]
    fn the_city_matrix_loads_once_and_reads_the_seeds_place_names() {
        let a = matrix().unwrap();
        let b = matrix().unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!((a.len(), a.depot()), (64, 0));
        assert_eq!(a.place_index("p1"), Some(0));
        assert_eq!(a.label(0), Some("The bakery"));
    }

    #[test]
    fn commands_read_and_write_as_the_worker_sends_them() {
        let order = Ulid::from_parts(1_793_000_000_000, 2);
        let plan: Cmd = serde_json::from_value(serde_json::json!({
            "cmd": "submit_plan",
            "routes": [{ "van": 1, "stops": [order.to_string()], "start": 0, "end": 0 }]
        }))
        .unwrap();
        let m = matrix().unwrap();
        let DispatchCommand::SubmitPlan { routes, .. } = plan.domain(&m, Facts::default()) else {
            panic!()
        };
        assert_eq!(routes[0].stops, vec![order]);
        let publish: Cmd =
            serde_json::from_value(serde_json::json!({ "cmd": "publish", "plan": "submitted" }))
                .unwrap();
        let left = Facts {
            departed: true,
            ready: false,
        };
        assert_eq!(
            publish.domain(&m, left),
            DispatchCommand::Publish {
                plan: PlanChoice::Submitted,
                departed: true,
                matrix: m.clone(),
            }
        );
        let complete: Cmd =
            serde_json::from_value(serde_json::json!({ "cmd": "complete_stop", "stop": 2 }))
                .unwrap();
        let ready = Facts {
            departed: false,
            ready: true,
        };
        assert_eq!(
            complete.domain(&m, ready),
            DispatchCommand::CompleteStop {
                stop: 2,
                ready: true
            }
        );
        assert_eq!(
            complete.domain(&m, Facts::default()),
            DispatchCommand::CompleteStop {
                stop: 2,
                ready: false
            }
        );
        let remove = Cmd::RemoveStop {
            order,
            reason: RemoveReason::Expired,
        };
        let text = serde_json::to_string(&remove).unwrap();
        assert!(text.contains(r#""cmd":"remove_stop""#) && text.contains(r#""reason":"expired""#));
        assert_eq!(serde_json::from_str::<Cmd>(&text).unwrap(), remove);
    }

    #[test]
    fn the_seeds_commands_cross_the_wire_and_decide_as_the_seed_did() {
        let g = bakery_seed::Generator::new(
            bakery_seed::Seed(42),
            bakery_seed::BirthDate::parse("2026-11-07").unwrap(),
        )
        .generate();
        let day = bakery_seed::seed_dispatch(&g);
        let cmds: Vec<Cmd> = day
            .commands
            .iter()
            .map(|(_, c)| Cmd::of(c).unwrap())
            .collect();
        let back: Vec<Cmd> = serde_json::from_str(&serde_json::to_string(&cmds).unwrap()).unwrap();
        let m = matrix().unwrap();
        let ctx = DecideContext {
            now: "2026-11-07T08:00:00-07:00".parse().unwrap(),
            id: Ulid::from_parts(1, 1),
        };
        let mut state = DispatchState::new(day.date);
        for c in &back {
            state = execute::<Aggregate>(state, &c.domain(&m, Facts::default()), &ctx)
                .unwrap()
                .0;
        }
        assert_eq!(state, day.state);
        assert_eq!(state.proposed().unwrap().source, PlanSource::Server);
        assert_eq!(
            Cmd::of(&DispatchCommand::Publish {
                plan: PlanChoice::Proposed,
                departed: false,
                matrix: m.clone(),
            }),
            None
        );
        assert_eq!(DispatchError::Published.rule(), "published");
    }

    #[test]
    fn an_order_made_ready_is_a_ready_stop_for_its_order() {
        let sandbox = Ulid::from_parts(1, 1);
        let order = Ulid::from_parts(1, 2);
        let mut e = Envelope {
            v: 1,
            id: Ulid::from_parts(1, 9),
            sandbox,
            stream: format!("order:{sandbox}:{order}"),
            seq: 4,
            event_type: "OrderReady".into(),
            at: "2026-11-07T10:00:00-07:00".parse().unwrap(),
            recorded_at: WallTime::from_unix_ms(1_793_000_000_000).unwrap(),
            data: serde_json::json!({}),
            cause: None,
        };
        assert_eq!(
            command_of(&e, None),
            Ok(Some(DispatchCommand::ReadyStop { order }))
        );
        e.event_type = "OrderPaid".into();
        assert_eq!(
            command_of(&e, None),
            Ok(Some(DispatchCommand::ConfirmStop { order }))
        );
        e.event_type = "OrderCancelled".into();
        assert_eq!(
            command_of(&e, None),
            Ok(Some(DispatchCommand::RemoveStop {
                order,
                reason: RemoveReason::Cancelled
            }))
        );
        // Gone out on its van: the stop departs, with the route and number the Order names.
        e.event_type = "OrderOutForDelivery".into();
        e.data = serde_json::json!({ "route": "van-2", "stop": 3 });
        assert_eq!(
            command_of(&e, None),
            Ok(Some(DispatchCommand::DepartStop {
                order,
                route: "van-2".into(),
                stop: 3
            }))
        );
        e.data = serde_json::json!({});
        assert_eq!(command_of(&e, None), Err("envelope"));
        // A type the day does not hear is ignored, and a stream that names no order refused.
        e.event_type = "OrderProductionStarted".into();
        assert_eq!(command_of(&e, None), Ok(None));
        e.event_type = "OrderReady".into();
        e.stream = format!("catering:{sandbox}:{order}");
        assert_eq!(command_of(&e, None), Err("envelope"));
    }

    #[test]
    fn an_order_stream_names_its_order_only_in_its_own_sandbox() {
        let sandbox = Ulid::from_parts(1, 1);
        let order = Ulid::from_parts(1, 2);
        let mut e: Envelope = serde_json::from_value(serde_json::json!({
            "v": 1, "id": Ulid::from_parts(1, 9).to_string(), "sandbox": sandbox.to_string(),
            "stream": format!("order:{sandbox}:{order}"), "seq": 2, "type": "OrderPaid",
            "at": "2026-11-07T09:00:00-07:00", "recorded_at": "2026-11-07T16:00:00.000Z",
            "data": {}, "cause": null
        }))
        .unwrap();
        assert_eq!(order_of(&e), Some(order));
        e.stream = format!("order:{order}:{order}");
        assert_eq!(order_of(&e), None);
        e.stream = format!("catering:{sandbox}:{order}");
        assert_eq!(order_of(&e), None);
    }
}
