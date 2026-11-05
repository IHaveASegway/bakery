//! `Order`, one per order, named `order:<sandbox>:<ULID>` (docs/domain.md, "Order"). It hosts
//! the domain's `Order` aggregate: the state is the fold of its own `events`, which are few, so
//! nothing but the stream is stored. Every command writes its events, their outbox rows, its key
//! and any timer change in one transaction, then relays.
//!
//! Paths (the Worker builds them; the router registers the order with the Sandbox first):
//!
//! - `POST /_place {key, body_hash, birth, order, customer, kind, slot, zone, lines, note, menu,
//!   tax_bp, cause?}` → 201 `OrderResponse`; 200 with `Idempotent-Replayed: true` for a key seen
//!   with the same body; 422 `{error: "key-reused"}` for one seen with another; 422 `{error:
//!   "order", rule, class?}` for a broken rule, `class` naming the note's free-text class. The
//!   order's first write, so it is also its create path: a rejection writes nothing at all.
//! - `GET /_order` → 200 `OrderResponse`; 404 before an order is placed.
//! - `POST /_command {key, action, cause?}` with `action` one of `cancel`, `start_production`,
//!   `mark_ready`, `mark_picked_up` → 200 `OrderResponse`; the same 422s; a replay as above.
//!   The Kitchen's socket commands arrive here with the frame's id as the key (W2).
//! - `POST /_refund {key, body_hash, amount?, reason}` → 200 `RefundAnswer`: `RefundOrder` by
//!   staff, `amount` defaulting to all that is left; `refund` is the id of the
//!   `OrderRefundRequested` event, the id Billing keeps the refund under. The same 422s and
//!   replay as `/_command`.
//! - `POST /_event` with an envelope, from the consumer → 200 `{outcome}`: `PaymentSucceeded` is
//!   `RecordPayment`, `RefundIssued` is `RecordRefund`, each under the key `evt:<event id>`, so
//!   a redelivery replays; `PaymentFailed` and anything else is acknowledged and changes
//!   nothing. A rule the event breaks (an amount that is not the total, a refund the order never
//!   asked for) is logged by its rule and acknowledged, since a retry cannot fix it.
//! - `POST /_seed {birth, events, at}` → 201: one of the seed's open orders, its events written
//!   as they are (no `decide`: the seed is checked against the rules by a test in bakery-app).
//! - `POST /_wipe`, `POST /_clock`: the child protocol (child.rs).
//!
//! Timers: `expiry` (business time: 15 minutes after placement; the key of its `Expire` is
//! `timer:expiry`, so a second run is a replay and appends nothing), `outbox`, `backstop`.

use std::cell::Cell;

use bakery_app::Clock;
use bakery_contracts::{OrderLineResponse, OrderResponse};
use bakery_domain::catalog::MenuView;
use bakery_domain::order::{
    CancelledBy, LineInput, Order as OrderAggregate, OrderCommand, OrderError, OrderEvent,
    OrderKind, OrderState, OrderStatus, PlaceOrder, RefundReason,
};
use bakery_domain::outbox::{CommandCheck, Stamp, check_command, envelopes};
use bakery_domain::{
    BusinessTime, Cents, DecideContext, DomainEvent, Envelope, Ulid, WallTime, execute, replay,
};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::child::{self, Birth, ClockUpdate};
use super::sql::{self, gone, json, refuse, replayed, transaction_sync};
use super::stream::{self, BACKSTOP, OUTBOX};
use crate::clock::{SystemClock, business_at, wall_at};
use crate::random;

pub const BINDING: &str = "ORDER";
pub const CLASS: &str = "Order";
const EXPIRY: &str = "expiry";
const EXPIRY_KEY: &str = "timer:expiry";

pub fn name(sandbox: Ulid, order: Ulid) -> String {
    format!("order:{sandbox}:{order}")
}

const SCHEMA: &[&str] = &[child::META];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Place {
    pub key: String,
    pub body_hash: String,
    pub birth: Birth,
    pub order: Ulid,
    pub customer: Ulid,
    pub kind: OrderKind,
    pub slot: BusinessTime,
    #[serde(default)]
    pub zone: Option<String>,
    pub lines: Vec<LineInput>,
    #[serde(default)]
    pub note: Option<String>,
    pub menu: MenuView,
    pub tax_bp: u32,
    /// The events' `cause` when it is not the key: `sim:<ulid>` for the Simulator.
    #[serde(default)]
    pub cause: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Cancel,
    StartProduction,
    MarkReady,
    MarkPickedUp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub key: String,
    pub action: Action,
    #[serde(default)]
    pub body_hash: String,
    #[serde(default)]
    pub cause: Option<String>,
}

/// `POST /_refund`: staff give money back.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Refund {
    pub key: String,
    #[serde(default)]
    pub body_hash: String,
    /// `None` refunds all that is left.
    #[serde(default)]
    pub amount: Option<Cents>,
    pub reason: RefundReason,
}

/// `/_refund`'s answer, stored as the key's result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefundAnswer {
    pub refund: Ulid,
    pub amount_cents: Cents,
    pub order: OrderResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedOrder {
    pub birth: Birth,
    pub events: Vec<OrderEvent>,
    /// Business time of the seeded events.
    pub at: BusinessTime,
}

#[durable_object]
pub struct Order {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
}

impl DurableObject for Order {
    fn new(state: State, env: Env) -> Self {
        Order {
            state,
            env,
            schema_ready: Cell::new(false),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/_place") => {
                let body: Place = sql::body(&mut req).await?;
                self.place(body, now).await
            }
            (Method::Post, "/_seed") => {
                let body: SeedOrder = sql::body(&mut req).await?;
                self.seed(body, now).await
            }
            (Method::Post, "/_wipe") => json(&child::wipe(&self.state).await?, 200),
            (method, path) => {
                let sql = self.sql();
                let Some(meta) = child::meta(&sql)? else {
                    return gone();
                };
                match (method, path) {
                    (Method::Get, "/_order") => match self.response(&meta)? {
                        Some(r) => json(&r, 200),
                        None => refuse(404, "not-found"),
                    },
                    (Method::Post, "/_command") => {
                        let body: Command = sql::body(&mut req).await?;
                        self.command(&meta, body, now).await
                    }
                    (Method::Post, "/_refund") => {
                        let body: Refund = sql::body(&mut req).await?;
                        self.refund(&meta, body, now).await
                    }
                    (Method::Post, "/_event") => {
                        let text = req.text().await?;
                        self.event(&meta, &text, now).await
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
        let Some(meta) = child::meta(&storage.sql())? else {
            storage.delete_all().await?;
            return Response::empty();
        };
        for timer in stream::due(&storage.sql(), now)? {
            match timer.purpose.as_str() {
                EXPIRY => self.expire(&meta, now).await?,
                OUTBOX => stream::outbox_timer(&storage, &self.env, now, CLASS).await?,
                BACKSTOP => {
                    console_log!("{{\"event\":\"backstop\",\"object\":\"{CLASS}\"}}");
                    child::wipe(&self.state).await?;
                    return Response::empty();
                }
                _ => stream::delete_timer(&storage.sql(), &timer.id)?,
            }
        }
        stream::arm(&storage, now).await?;
        Response::empty()
    }
}

/// What a command's stored answer is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnswerKind {
    /// The `OrderResponse`.
    Order,
    /// A `RefundAnswer`.
    Refund,
}

/// What a command decided, ready to commit.
struct Decided {
    state: OrderState,
    events: Vec<OrderEvent>,
}

impl Order {
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

    fn stream(&self, meta: &child::Meta) -> Result<Vec<Envelope>> {
        stream::events(&self.sql(), meta.sandbox_id()?, &meta.name)
    }

    fn state_of(events: &[Envelope]) -> Result<OrderState> {
        let decoded: Vec<OrderEvent> = events
            .iter()
            .map(OrderEvent::from_envelope)
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| Error::RustError(e.to_string()))?;
        Ok(replay::<OrderAggregate>(&decoded))
    }

    fn response(&self, meta: &child::Meta) -> Result<Option<OrderResponse>> {
        if !sql::has_table(&self.sql(), "events")? {
            return Ok(None);
        }
        let events = self.stream(meta)?;
        let state = Self::state_of(&events)?;
        Ok(response_of(&state, &events))
    }

    /// `PlaceOrder`. Decided before anything is written: a refused order leaves the object as
    /// empty as it found it.
    async fn place(&self, p: Place, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        let meta = child::meta(&sql)?;
        if let Some(m) = &meta
            && (m.name != p.birth.name || m.sandbox != p.birth.sandbox.to_string())
        {
            return refuse(409, "identity");
        }
        if meta.is_some() {
            let seen = stream::seen(&sql, &p.key)?;
            match check_command(seen.as_ref(), &p.body_hash) {
                Ok(CommandCheck::Replay(result)) => return replayed(result),
                Ok(CommandCheck::Fresh) => {}
                Err(_) => return refuse(422, "key-reused"),
            }
        }
        let offset = meta
            .as_ref()
            .map_or(p.birth.clock_offset_s, |m| m.clock_offset_s);
        let id: Ulid = p
            .key
            .parse()
            .or_else(|_| random::ulid(now))
            .map_err(|_| Error::RustError("command id".into()))?;
        let ctx = DecideContext {
            now: business_at(now, offset),
            id,
        };
        let existing = match &meta {
            Some(m) => self.stream(m)?,
            None => Vec::new(),
        };
        let state = Self::state_of(&existing)?;
        let cmd = OrderCommand::PlaceOrder(Box::new(PlaceOrder {
            order: p.order,
            customer: p.customer,
            kind: p.kind,
            slot: p.slot,
            zone: p.zone.clone(),
            lines: p.lines.clone(),
            note: p.note.clone(),
            menu: p.menu.clone(),
            tax_bp: p.tax_bp,
        }));
        let (state, events) = match execute::<OrderAggregate>(state, &cmd, &ctx) {
            Ok(done) => done,
            Err(e) => return rejection(&e),
        };
        if meta.is_none() {
            self.ensure_schema()?;
        }
        let birth = p.birth.clone();
        let cause = p.cause.clone().unwrap_or_else(|| p.key.clone());
        let held_until = state.record().map(|r| r.held_until);
        let res = self
            .commit(
                &birth,
                meta.is_none(),
                &existing,
                Decided { state, events },
                ctx.now,
                now,
                (&p.key, &p.body_hash, &cause),
                held_until.map(|h| (h, offset)),
                AnswerKind::Order,
            )
            .await?;
        let mut out = Response::ok(res)?.with_status(201);
        out.headers_mut().set("Content-Type", "application/json")?;
        Ok(out)
    }

    async fn command(&self, meta: &child::Meta, c: Command, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        let seen = stream::seen(&sql, &c.key)?;
        match check_command(seen.as_ref(), &c.body_hash) {
            Ok(CommandCheck::Replay(result)) => return replayed(result),
            Ok(CommandCheck::Fresh) => {}
            Err(_) => return refuse(422, "key-reused"),
        }
        let cmd = match c.action {
            Action::Cancel => OrderCommand::CancelOrder {
                by: CancelledBy::Customer,
            },
            Action::StartProduction => OrderCommand::StartProduction,
            Action::MarkReady => OrderCommand::MarkReady,
            Action::MarkPickedUp => OrderCommand::MarkPickedUp,
        };
        let id: Ulid = c
            .key
            .rsplit(':')
            .next()
            .and_then(|k| k.parse().ok())
            .map_or_else(|| random::ulid(now), Ok)?;
        let ctx = DecideContext {
            now: meta.business(now),
            id,
        };
        let existing = self.stream(meta)?;
        let state = Self::state_of(&existing)?;
        let (state, events) = match execute::<OrderAggregate>(state, &cmd, &ctx) {
            Ok(done) => done,
            Err(e) => return rejection(&e),
        };
        let birth = Birth {
            sandbox: meta.sandbox_id()?,
            name: meta.name.clone(),
            clock_offset_s: meta.clock_offset_s,
            clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
        };
        let cause = c.cause.clone().unwrap_or_else(|| c.key.clone());
        let res = self
            .commit(
                &birth,
                false,
                &existing,
                Decided { state, events },
                ctx.now,
                now,
                (&c.key, &c.body_hash, &cause),
                None,
                AnswerKind::Order,
            )
            .await?;
        let mut out = Response::ok(res)?;
        out.headers_mut().set("Content-Type", "application/json")?;
        Ok(out)
    }

    /// `RefundOrder` by staff. The router has checked that Billing holds the order's payment.
    async fn refund(&self, meta: &child::Meta, r: Refund, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        let seen = stream::seen(&sql, &r.key)?;
        match check_command(seen.as_ref(), &r.body_hash) {
            Ok(CommandCheck::Replay(result)) => return replayed(result),
            Ok(CommandCheck::Fresh) => {}
            Err(_) => return refuse(422, "key-reused"),
        }
        let existing = self.stream(meta)?;
        let state = Self::state_of(&existing)?;
        // No amount: all that is left of what was paid.
        let amount = r.amount.unwrap_or_else(|| {
            state
                .record()
                .and_then(|rec| {
                    rec.payment
                        .and_then(|p| p.amount.checked_sub(rec.refund_requested).ok())
                })
                .unwrap_or(Cents::ZERO)
        });
        let id: Ulid = r.key.parse().or_else(|_| random::ulid(now))?;
        let ctx = DecideContext {
            now: meta.business(now),
            id,
        };
        let cmd = OrderCommand::RefundOrder {
            amount,
            reason: r.reason,
        };
        let (state, events) = match execute::<OrderAggregate>(state, &cmd, &ctx) {
            Ok(done) => done,
            Err(e) => return rejection(&e),
        };
        let birth = Self::birth_of(meta)?;
        let res = self
            .commit(
                &birth,
                false,
                &existing,
                Decided { state, events },
                ctx.now,
                now,
                (&r.key, &r.body_hash, &r.key),
                None,
                AnswerKind::Refund,
            )
            .await?;
        let mut out = Response::ok(res)?;
        out.headers_mut().set("Content-Type", "application/json")?;
        Ok(out)
    }

    /// One delivery from the consumer: Billing's outcome for this order.
    async fn event(&self, meta: &child::Meta, text: &str, now: WallTime) -> Result<Response> {
        let Ok(envelope) = serde_json::from_str::<Envelope>(text) else {
            return refuse(422, "envelope");
        };
        if envelope.sandbox.to_string() != meta.sandbox {
            return refuse(422, "envelope");
        }
        #[derive(Deserialize)]
        struct Paid {
            payment: Ulid,
            amount_cents: Cents,
            #[serde(rename = "ref")]
            reference: Ulid,
        }
        #[derive(Deserialize)]
        struct Refunded {
            refund: Ulid,
            amount_cents: Cents,
            #[serde(rename = "ref")]
            reference: Ulid,
        }
        let data = envelope.data.clone();
        let (cmd, reference) = match envelope.event_type.as_str() {
            "PaymentSucceeded" => match serde_json::from_value::<Paid>(data) {
                Ok(d) => (
                    OrderCommand::RecordPayment {
                        payment: d.payment,
                        amount: d.amount_cents,
                    },
                    d.reference,
                ),
                Err(_) => return refuse(422, "envelope"),
            },
            "RefundIssued" => match serde_json::from_value::<Refunded>(data) {
                Ok(d) => (
                    OrderCommand::RecordRefund {
                        refund: d.refund,
                        amount: d.amount_cents,
                    },
                    d.reference,
                ),
                Err(_) => return refuse(422, "envelope"),
            },
            // PaymentFailed: the order keeps waiting, and its expiry still runs.
            _ => return json(&serde_json::json!({ "outcome": "ignored" }), 200),
        };
        if meta.name != name(envelope.sandbox, reference) {
            return refuse(422, "envelope");
        }
        let key = format!("evt:{}", envelope.id);
        let sql = self.sql();
        if stream::seen(&sql, &key)?.is_some() {
            return json(&serde_json::json!({ "outcome": "duplicate" }), 200);
        }
        let existing = self.stream(meta)?;
        let state = Self::state_of(&existing)?;
        let ctx = DecideContext {
            now: meta.business(now),
            id: envelope.id,
        };
        let (state, events) = match execute::<OrderAggregate>(state, &cmd, &ctx) {
            Ok(done) => done,
            Err(e) => {
                console_log!(
                    "{{\"event\":\"order_event_refused\",\"id\":\"{}\",\"type\":{:?},\"rule\":\"{}\"}}",
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
        let birth = Self::birth_of(meta)?;
        let cause = envelope.id.to_string();
        self.commit(
            &birth,
            false,
            &existing,
            Decided { state, events },
            ctx.now,
            now,
            (&key, "", &cause),
            None,
            AnswerKind::Order,
        )
        .await?;
        json(&serde_json::json!({ "outcome": "applied" }), 200)
    }

    fn birth_of(meta: &child::Meta) -> Result<Birth> {
        Ok(Birth {
            sandbox: meta.sandbox_id()?,
            name: meta.name.clone(),
            clock_offset_s: meta.clock_offset_s,
            clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
        })
    }

    /// One transaction: `meta` on the first write, the events and their outbox rows, the key
    /// with its answer, and the expiry timer while the order waits for payment. Answers the
    /// stored result text.
    #[allow(clippy::too_many_arguments)]
    async fn commit(
        &self,
        birth: &Birth,
        first_write: bool,
        existing: &[Envelope],
        decided: Decided,
        at: BusinessTime,
        now: WallTime,
        (key, body_hash, cause): (&str, &str, &str),
        expiry: Option<(BusinessTime, i64)>,
        kind: AnswerKind,
    ) -> Result<String> {
        let sql = self.sql();
        let last_seq = existing.last().map_or(0, |e| e.seq);
        let head = bakery_domain::outbox::StreamHead {
            sandbox: birth.sandbox,
            stream: birth.name.clone(),
            last_seq,
        };
        let stamp = Stamp {
            at,
            recorded_at: now,
            cause: Some(cause.to_owned()),
        };
        let mut ids = Vec::new();
        for _ in &decided.events {
            ids.push(random::ulid(now)?);
        }
        let mut ids = ids.into_iter();
        let built = envelopes(&head, &stamp, &decided.events, || {
            ids.next().unwrap_or(Ulid::from_parts(0, 0))
        })
        .map_err(|e| Error::RustError(e.to_string()))?;
        let mut all: Vec<Envelope> = existing.to_vec();
        all.extend(built.iter().cloned());
        let order = response_of(&decided.state, &all)
            .ok_or_else(|| Error::RustError("no order after a command".into()))?;
        let answer = match kind {
            AnswerKind::Order => serde_json::to_string(&order)?,
            AnswerKind::Refund => {
                let requested = built
                    .iter()
                    .zip(&decided.events)
                    .find_map(|(e, d)| match d {
                        OrderEvent::OrderRefundRequested { amount_cents, .. } => {
                            Some((e.id, *amount_cents))
                        }
                        _ => None,
                    })
                    .ok_or_else(|| Error::RustError("a refund requested nothing".into()))?;
                serde_json::to_string(&RefundAnswer {
                    refund: requested.0,
                    amount_cents: requested.1,
                    order,
                })?
            }
        };
        let placed = decided.state.status() == Some(OrderStatus::Placed);
        let (birth, key, hash, stored) = (
            birth.clone(),
            key.to_owned(),
            body_hash.to_owned(),
            answer.clone(),
        );
        let any = !built.is_empty();
        transaction_sync(&self.state.storage(), move || {
            if first_write {
                child::born(&sql, &birth, now)?;
            }
            stream::append(&sql, &built)?;
            stream::remember(&sql, &key, &hash, &stored, now)?;
            match expiry {
                Some((held_until, offset)) if placed => stream::set_timer(
                    &sql,
                    EXPIRY,
                    EXPIRY,
                    wall_at(held_until, offset),
                    Some(&held_until.to_string()),
                )?,
                _ if !placed => stream::delete_timer(&sql, EXPIRY)?,
                _ => {}
            }
            Ok(())
        })?;
        if any {
            stream::relay_soon(&self.state, &self.env, now, CLASS).await?;
        } else {
            stream::arm(&self.state.storage(), now).await?;
        }
        Ok(answer)
    }

    /// The expiry timer: `Expire` under the timer's own key, so a second run replays. A paid
    /// or cancelled order needs nothing; a timer that fired early (the clock moved back is
    /// impossible, but a stale wall time is not) is set again for its business time.
    async fn expire(&self, meta: &child::Meta, now: WallTime) -> Result<()> {
        let sql = self.sql();
        if stream::seen(&sql, EXPIRY_KEY)?.is_some() {
            stream::delete_timer(&sql, EXPIRY)?;
            return Ok(());
        }
        let existing = self.stream(meta)?;
        let state = Self::state_of(&existing)?;
        let ctx = DecideContext {
            now: meta.business(now),
            id: random::ulid(now)?,
        };
        match execute::<OrderAggregate>(state, &OrderCommand::Expire, &ctx) {
            Ok((state, events)) => {
                let birth = Birth {
                    sandbox: meta.sandbox_id()?,
                    name: meta.name.clone(),
                    clock_offset_s: meta.clock_offset_s,
                    clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
                };
                self.commit(
                    &birth,
                    false,
                    &existing,
                    Decided { state, events },
                    ctx.now,
                    now,
                    (EXPIRY_KEY, "", EXPIRY_KEY),
                    None,
                    AnswerKind::Order,
                )
                .await?;
                console_log!("{{\"event\":\"order_expired\",\"object\":\"{CLASS}\"}}");
            }
            Err(OrderError::NotDue) => {
                if let Some(r) = state_record_held(&existing)? {
                    stream::set_timer(
                        &sql,
                        EXPIRY,
                        EXPIRY,
                        wall_at(r, meta.clock_offset_s),
                        Some(&r.to_string()),
                    )?;
                }
            }
            Err(e) => {
                // Paid or further along: nothing to expire.
                console_log!(
                    "{{\"event\":\"expiry_skipped\",\"object\":\"{CLASS}\",\"rule\":\"{}\"}}",
                    e.rule()
                );
                stream::delete_timer(&sql, EXPIRY)?;
            }
        }
        Ok(())
    }

    /// One of the seed's open orders, written as the seed describes it.
    async fn seed(&self, s: SeedOrder, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        if child::meta(&sql)?.is_some() {
            return json(&serde_json::json!({ "seeded": true }), 200);
        }
        self.ensure_schema()?;
        let state = replay::<OrderAggregate>(&s.events);
        let held_until = state.record().map(|r| r.held_until);
        let offset = s.birth.clock_offset_s;
        let built = {
            let head = bakery_domain::outbox::StreamHead {
                sandbox: s.birth.sandbox,
                stream: s.birth.name.clone(),
                last_seq: 0,
            };
            let stamp = Stamp {
                at: s.at,
                recorded_at: now,
                cause: None,
            };
            let mut ids = Vec::new();
            for _ in &s.events {
                ids.push(random::ulid(now)?);
            }
            let mut ids = ids.into_iter();
            envelopes(&head, &stamp, &s.events, || {
                ids.next().unwrap_or(Ulid::from_parts(0, 0))
            })
            .map_err(|e| Error::RustError(e.to_string()))?
        };
        let placed = state.status() == Some(OrderStatus::Placed);
        let birth = s.birth.clone();
        transaction_sync(&self.state.storage(), move || {
            child::born(&sql, &birth, now)?;
            stream::append(&sql, &built)?;
            if let (true, Some(h)) = (placed, held_until) {
                stream::set_timer(
                    &sql,
                    EXPIRY,
                    EXPIRY,
                    wall_at(h, offset),
                    Some(&h.to_string()),
                )?;
            }
            Ok(())
        })?;
        stream::relay_soon(&self.state, &self.env, now, CLASS).await?;
        json(&serde_json::json!({ "seeded": true }), 201)
    }
}

fn state_record_held(events: &[Envelope]) -> Result<Option<BusinessTime>> {
    Ok(Order::state_of(events)?.record().map(|r| r.held_until))
}

/// The 422 the router turns into problem `order`: the rule, and for the note its free-text
/// class, never the text.
fn rejection(e: &OrderError) -> Result<Response> {
    let class = match e {
        OrderError::Note(f) => Some(f.slug()),
        _ => None,
    };
    json(
        &serde_json::json!({ "error": "order", "rule": e.rule(), "class": class }),
        422,
    )
}

/// Domain values to wire values through their shared serde names.
fn via_json<T: Serialize, U: serde::de::DeserializeOwned>(value: T) -> Option<U> {
    serde_json::from_value(serde_json::to_value(value).ok()?).ok()
}

pub fn response_of(state: &OrderState, events: &[Envelope]) -> Option<OrderResponse> {
    let r = state.record()?;
    Some(OrderResponse {
        id: r.id.to_string(),
        status: via_json(r.status)?,
        kind: via_json(r.kind)?,
        slot: r.slot.to_string(),
        zone: r.zone.clone(),
        lines: r
            .lines
            .iter()
            .map(|l| OrderLineResponse {
                item: l.item.clone(),
                variant: l.variant.clone(),
                qty: l.qty,
                unit_cents: l.unit_cents.0,
            })
            .collect(),
        subtotal_cents: r.subtotal_cents.0,
        tax_cents: r.tax_cents.0,
        total_cents: r.total_cents.0,
        placed_at: events
            .iter()
            .find(|e| e.event_type == "OrderPlaced")
            .map_or_else(|| r.slot.to_string(), |e| e.at.to_string()),
        held_until: r.held_until.to_string(),
        note: r.note.clone(),
        menu_version: r.menu_version,
        events_seq: events.last().map_or(0, |e| e.seq),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakery_domain::Cents;
    use bakery_domain::order::Line;

    #[test]
    fn every_order_status_and_kind_has_a_wire_name() {
        use bakery_contracts as c;
        for s in [
            OrderStatus::Placed,
            OrderStatus::Confirmed,
            OrderStatus::Expired,
            OrderStatus::Cancelled,
            OrderStatus::RefundPending,
            OrderStatus::InProduction,
            OrderStatus::Ready,
            OrderStatus::PickedUp,
            OrderStatus::OutForDelivery,
            OrderStatus::Delivered,
            OrderStatus::Closed,
        ] {
            assert!(via_json::<_, c::OrderStatus>(s).is_some(), "{s:?}");
        }
        for k in [OrderKind::Pickup, OrderKind::Delivery] {
            assert!(via_json::<_, c::OrderKind>(k).is_some(), "{k:?}");
        }
    }

    #[test]
    fn a_response_reads_the_record_and_the_stream() {
        let t: BusinessTime = "2026-11-07T09:00:00-07:00".parse().unwrap();
        let order = Ulid::from_parts(1, 2);
        let event = OrderEvent::OrderPlaced {
            order,
            customer: Ulid::from_parts(1, 3),
            kind: OrderKind::Pickup,
            slot: t.plus_minutes(120).unwrap(),
            zone: None,
            lines: vec![Line {
                item: "fern-loaf".into(),
                variant: "fern-loaf/whole".into(),
                qty: 2,
                unit_cents: Cents(950),
            }],
            subtotal_cents: Cents(1_900),
            tax_cents: Cents(190),
            total_cents: Cents(2_090),
            note: None,
            menu_version: 1,
            held_until: t.plus_minutes(15).unwrap(),
        };
        let state = replay::<OrderAggregate>(std::slice::from_ref(&event));
        let envelope = Envelope {
            v: 1,
            id: Ulid::from_parts(1, 9),
            sandbox: Ulid::from_parts(1, 1),
            stream: name(Ulid::from_parts(1, 1), order),
            seq: 1,
            event_type: "OrderPlaced".into(),
            at: t,
            recorded_at: "2026-11-07T16:00:00.000Z".parse().unwrap(),
            data: event.to_data(),
            cause: None,
        };
        let r = response_of(&state, &[envelope]).unwrap();
        assert_eq!(r.status, bakery_contracts::OrderStatus::Placed);
        assert_eq!(r.placed_at, "2026-11-07T09:00:00-07:00");
        assert_eq!(r.held_until, "2026-11-07T09:15:00-07:00");
        assert_eq!(r.events_seq, 1);
        assert_eq!(r.lines[0].unit_cents, 950);
        assert_eq!(r.total_cents, 2_090);
    }

    #[test]
    fn a_rejected_note_names_its_class_and_never_its_text() {
        let e = OrderError::Note(bakery_domain::FreeTextError::Class(
            bakery_domain::FreeTextClass::Email,
        ));
        assert_eq!(e.rule(), "note");
        let class = match e {
            OrderError::Note(f) => f.slug(),
            _ => "",
        };
        assert_eq!(class, "email");
    }
}
