//! `CateringEvent`, one per catering inquiry, named `catering:<sandbox>:<ULID>` (docs/domain.md,
//! "CateringEvent"; docs/architecture.md, "The catering saga"). It hosts the domain's `Catering`
//! aggregate and runs the saga by alarm: every step is one transaction of this object, started
//! by a person (a route), an event (the consumer's delivery) or a timer row, and the timers it
//! keeps are `bakery_domain::catering::timers` of its state, recomputed in the transaction of
//! every change and on `/_clock`. The state is the fold of its own `events`.
//!
//! Paths (the Worker builds them; the router registers the event with the Sandbox first):
//!
//! - `POST /_command {key, body_hash, birth?, cmd, day?, cause?}` → 200 `CateringResponse` (201
//!   for the inquiry, the create path, which needs `birth`); 200 with `Idempotent-Replayed:
//!   true` for a key seen with the same body; 422 `{error: "key-reused"}` for one seen with
//!   another; 422 `{error: "catering", rule, message?}` for a refused inquiry (and `quote-total`)
//!   and 409 for a refused step, `message` only for `catering-lead` (it names the earliest date,
//!   never a value the visitor sent); a refused command writes nothing. `cmd` is [`Cmd`]. With
//!   `cmd: accept`, `day` is the event day's `Schedule` birth: the place is held there first
//!   (`hold:<key>`, `kind: catering`, until the deposit hold lapses), and a day whose two places
//!   are taken answers 409 `{error: "schedule", rule: "slot-full"}` with nothing recorded.
//! - `GET /_state` → 200 `CateringResponse`; 404 before the inquiry.
//! - `GET /_events` → 200 `[Envelope]`: the log, in `seq` order, as the Sandbox reads a seeded
//!   event's history to hand it to Crm and the Inbox (PR 8), since no outbox relays it.
//! - `POST /_event` with an envelope, from the consumer → 200 `{outcome}`: `PaymentSucceeded`
//!   with purpose `deposit` is `RecordDeposit`, with purpose `balance` `RecordBalance`;
//!   `InvoiceIssued` is `RecordInvoice`; each under the key `evt:<event id>`, so a redelivery is
//!   `duplicate`. A deposit the event refuses as `out-of-order` (it landed after the quote
//!   expired, or it is a second one) is refunded in full: Billing's `/_refund` under the
//!   delivery's id, reason `goodwill`, logged `deposit_late`; 503 while Billing cannot be
//!   reached, so the delivery is retried. Any other refusal is logged by its rule and
//!   acknowledged. `PaymentFailed`, `RefundIssued` and anything else are `ignored`.
//! - `POST /_seed {birth, steps}` → 201; 200 when already seeded. The seed's commands
//!   (`bakery_seed::seed_commands`), each decided at its own business time under the key
//!   `seed:<n>`, written in one transaction. The seed's events are history: they are kept in the
//!   log with no outbox row, so a seeded delivery raises no Stripe invoice at birth and a seeded
//!   deposit reserves no day twice (the Sandbox seeds the days' places itself). A reminder
//!   already due at birth fires on the first alarm, as a new event.
//! - `POST /_wipe`, `POST /_clock`: the child protocol (child.rs).
//!
//! Timers: one row per `catering::timers` entry, purpose `catering`, id its
//! `TimerKind::row_name()` (`reminder:follow_up`, `reminder:event_soon`, `reminder:invoice_due`,
//! `quote-expiry`, `deposit-lapse`), in business time. The alarm runs the due one's command
//! (`FireReminder { kind }`, `ExpireQuote`, `LapseDeposit`) under the key `timer:<row>:<at>`. A
//! change that leaves none (a cancellation, a decline, an expiry, the closure) deletes every
//! row and logs `timers_cleared`. `outbox` and `backstop` as every child.
//!
//! Log lines carry reason codes and ids, never the brief.

use std::cell::Cell;
use std::collections::BTreeMap;

use bakery_app::Clock;
use bakery_contracts::{CateringReminder, CateringResponse};
use bakery_domain::catering::{
    CancelReason, Catering as Aggregate, CateringCommand, CateringError, CateringEvent as Event,
    CateringState, DeclineReason, ReminderKind, SubmitInquiry, hold_request, reminders, timers,
};
use bakery_domain::order::{CancelledBy, RefundReason};
use bakery_domain::outbox::{CommandCheck, Stamp, StreamHead, check_command, envelopes};
use bakery_domain::{
    BakeryDate, BusinessTime, Cents, DecideContext, DomainEvent, Envelope, Ulid, WallTime, execute,
    replay,
};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::billing::{self, RefundIn};
use super::child::{self, Birth, ClockUpdate};
use super::schedule::{self, HoldAnswer};
use super::sql::{self, exec, gone, has_table, json, refuse, replayed, transaction_sync};
use super::stream::{self, BACKSTOP, OUTBOX};
use crate::clock::{SystemClock, wall_at};
use crate::random;

pub const BINDING: &str = "CATERING";
pub const CLASS: &str = "CateringEvent";
/// Every saga timer's purpose; its id is the timer kind's row name.
const TIMER: &str = "catering";

pub fn name(sandbox: Ulid, catering: Ulid) -> String {
    format!("catering:{sandbox}:{catering}")
}

/// The catering id a `catering:<sandbox>:<ulid>` stream names, in that sandbox only.
pub fn id_of(stream: &str, sandbox: Ulid) -> Option<Ulid> {
    stream
        .strip_prefix(&format!("catering:{sandbox}:"))?
        .parse()
        .ok()
}

const SCHEMA: &[&str] = &[child::META];

/// A catering command as the Worker sends it: the domain's `CateringCommand` with serde names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Cmd {
    Submit {
        catering: Ulid,
        customer: Ulid,
        date: BakeryDate,
        headcount: u16,
        package: String,
        venue: String,
        #[serde(default)]
        brief: Option<String>,
    },
    Quote {
        #[serde(default)]
        total: Option<Cents>,
    },
    Decline {
        reason: DeclineReason,
    },
    Accept,
    LapseDeposit,
    RecordDeposit {
        payment: Ulid,
        amount: Cents,
    },
    FireReminder {
        kind: ReminderKind,
    },
    ExpireQuote,
    StartProduction,
    MarkDelivered,
    RecordInvoice {
        invoice: Ulid,
        amount: Cents,
        due: BakeryDate,
    },
    RecordBalance {
        payment: Ulid,
        amount: Cents,
    },
    Cancel {
        by: CancelledBy,
        reason: CancelReason,
    },
}

impl Cmd {
    pub fn domain(&self) -> CateringCommand {
        match self.clone() {
            Cmd::Submit {
                catering,
                customer,
                date,
                headcount,
                package,
                venue,
                brief,
            } => CateringCommand::SubmitInquiry(Box::new(SubmitInquiry {
                catering,
                customer,
                date,
                headcount,
                package,
                venue,
                brief,
            })),
            Cmd::Quote { total } => CateringCommand::SendQuote { total },
            Cmd::Decline { reason } => CateringCommand::Decline { reason },
            Cmd::Accept => CateringCommand::AcceptQuote,
            Cmd::LapseDeposit => CateringCommand::LapseDeposit,
            Cmd::RecordDeposit { payment, amount } => {
                CateringCommand::RecordDeposit { payment, amount }
            }
            Cmd::FireReminder { kind } => CateringCommand::FireReminder { kind },
            Cmd::ExpireQuote => CateringCommand::ExpireQuote,
            Cmd::StartProduction => CateringCommand::StartProduction,
            Cmd::MarkDelivered => CateringCommand::MarkDelivered,
            Cmd::RecordInvoice {
                invoice,
                amount,
                due,
            } => CateringCommand::RecordInvoice {
                invoice,
                amount,
                due,
            },
            Cmd::RecordBalance { payment, amount } => {
                CateringCommand::RecordBalance { payment, amount }
            }
            Cmd::Cancel { by, reason } => CateringCommand::Cancel { by, reason },
        }
    }

    /// The wire form of a domain command: how the Sandbox sends the seed's commands.
    pub fn of(cmd: &CateringCommand) -> Cmd {
        match cmd.clone() {
            CateringCommand::SubmitInquiry(s) => Cmd::Submit {
                catering: s.catering,
                customer: s.customer,
                date: s.date,
                headcount: s.headcount,
                package: s.package,
                venue: s.venue,
                brief: s.brief,
            },
            CateringCommand::SendQuote { total } => Cmd::Quote { total },
            CateringCommand::Decline { reason } => Cmd::Decline { reason },
            CateringCommand::AcceptQuote => Cmd::Accept,
            CateringCommand::LapseDeposit => Cmd::LapseDeposit,
            CateringCommand::RecordDeposit { payment, amount } => {
                Cmd::RecordDeposit { payment, amount }
            }
            CateringCommand::FireReminder { kind } => Cmd::FireReminder { kind },
            CateringCommand::ExpireQuote => Cmd::ExpireQuote,
            CateringCommand::StartProduction => Cmd::StartProduction,
            CateringCommand::MarkDelivered => Cmd::MarkDelivered,
            CateringCommand::RecordInvoice {
                invoice,
                amount,
                due,
            } => Cmd::RecordInvoice {
                invoice,
                amount,
                due,
            },
            CateringCommand::RecordBalance { payment, amount } => {
                Cmd::RecordBalance { payment, amount }
            }
            CateringCommand::Cancel { by, reason } => Cmd::Cancel { by, reason },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandIn {
    pub key: String,
    #[serde(default)]
    pub body_hash: String,
    /// The event's birth: required on the inquiry, its first write.
    #[serde(default)]
    pub birth: Option<Birth>,
    pub cmd: Cmd,
    /// For `accept`: the event day's `Schedule`, registered by the router.
    #[serde(default)]
    pub day: Option<Birth>,
    #[serde(default)]
    pub cause: Option<String>,
}

/// One seed command and the business time it is decided at.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedStep {
    pub at: BusinessTime,
    pub cmd: Cmd,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedCatering {
    pub birth: Birth,
    pub steps: Vec<SeedStep>,
}

/// An object refusal's body, as the router reads it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Refusal {
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub rule: Option<String>,
    /// `catering-lead`'s sentence, naming the earliest date.
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub next_free: Option<String>,
}

/// The refusal a domain error is: 422 for a refused inquiry, 409 for a refused step.
pub fn refusal_of(e: &CateringError) -> (u16, Refusal) {
    let status = if e.is_inquiry_rule() { 422 } else { 409 };
    let message = match e {
        CateringError::Lead { .. } => Some(e.to_string()),
        _ => None,
    };
    (
        status,
        Refusal {
            error: "catering".into(),
            rule: Some(e.rule().to_owned()),
            message,
            next_free: None,
        },
    )
}

#[durable_object]
pub struct CateringEvent {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
}

impl DurableObject for CateringEvent {
    fn new(state: State, env: Env) -> Self {
        CateringEvent {
            state,
            env,
            schema_ready: Cell::new(false),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/_command") => {
                let body: CommandIn = sql::body(&mut req).await?;
                self.command(body, now).await
            }
            (Method::Post, "/_seed") => {
                let body: SeedCatering = sql::body(&mut req).await?;
                self.seed(body, now).await
            }
            (Method::Post, "/_wipe") => json(&child::wipe(&self.state).await?, 200),
            (method, path) => {
                let sql = self.sql();
                let Some(meta) = child::meta(&sql)? else {
                    return gone();
                };
                match (method, path) {
                    (Method::Get, "/_events") => {
                        let (_, events) = self.load(&meta)?;
                        json(&events, 200)
                    }
                    (Method::Get, "/_state") => {
                        let (state, events) = self.load(&meta)?;
                        match response_of(&state, &events) {
                            Some(r) => json(&r, 200),
                            None => refuse(404, "not-found"),
                        }
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
                TIMER => self.fire(&meta, &timer, now)?,
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

/// One decided command's events, stamped with the business time it was decided at.
struct Batch {
    at: BusinessTime,
    cause: Option<String>,
    events: Vec<Event>,
}

/// What a decided change writes in its one transaction.
struct Write {
    birth: Birth,
    first_write: bool,
    existing: Vec<Envelope>,
    batches: Vec<Batch>,
    state: CateringState,
    /// Command keys with their body hash and stored answer: one for a command, one per step
    /// for the seed.
    keys: Vec<(String, String, String)>,
    /// Whether the events go to the Queue: every change but the seed's history.
    relay: bool,
}

/// What a commit wrote: the answer stored for the command's key.
struct Written {
    answer: Option<CateringResponse>,
}

impl CateringEvent {
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

    fn birth_of(meta: &child::Meta) -> Result<Birth> {
        Ok(Birth {
            sandbox: meta.sandbox_id()?,
            name: meta.name.clone(),
            clock_offset_s: meta.clock_offset_s,
            clock_v: u32::try_from(meta.clock_v).unwrap_or(0),
        })
    }

    /// The state, folded from the stream, and the stream.
    fn load(&self, meta: &child::Meta) -> Result<(CateringState, Vec<Envelope>)> {
        if !has_table(&self.sql(), "events")? {
            return Ok((CateringState::default(), Vec::new()));
        }
        let envelopes = stream::events(&self.sql(), meta.sandbox_id()?, &meta.name)?;
        let decoded: Vec<Event> = envelopes
            .iter()
            .map(Event::from_envelope)
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| Error::RustError(e.to_string()))?;
        Ok((replay::<Aggregate>(&decoded), envelopes))
    }

    /// A command from a route. Decided before anything is written: a refused one leaves the
    /// object as it found it, and a refused inquiry leaves it empty.
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
        let id: Ulid = c
            .key
            .rsplit(':')
            .next()
            .and_then(|k| k.parse().ok())
            .map_or_else(|| random::ulid(now), Ok)?;
        let ctx = DecideContext {
            now: crate::clock::business_at(now, birth.clock_offset_s),
            id,
        };
        let cmd = c.cmd.domain();
        let (state, existing) = match &meta {
            Some(m) => self.load(m)?,
            None => (CateringState::default(), Vec::new()),
        };
        let (mut decided, mut events) = match execute::<Aggregate>(state, &cmd, &ctx) {
            Ok(done) => done,
            Err(e) => {
                let (status, body) = refusal_of(&e);
                return json(&body, status);
            }
        };
        let mut existing = existing;
        if c.cmd == Cmd::Accept && !events.is_empty() {
            // The day's place first: a full day records no acceptance.
            let (Some(day), Some(request)) = (c.day.clone(), hold_request(&decided)) else {
                return Err(Error::RustError("an acceptance with no day to hold".into()));
            };
            let cause = c.cause.clone().unwrap_or_else(|| c.key.clone());
            match schedule::hold(&self.env, &day, &c.key, &c.body_hash, request, Some(cause))
                .await?
            {
                HoldAnswer::Held(_) => {}
                HoldAnswer::Refused(r) => {
                    console_log!(
                        "{{\"event\":\"catering_hold_refused\",\"object\":\"{CLASS}\",\"rule\":{:?}}}",
                        r.rule.as_deref().unwrap_or("")
                    );
                    return json(
                        &Refusal {
                            error: "schedule".into(),
                            rule: r.rule,
                            message: None,
                            next_free: r.next_free,
                        },
                        409,
                    );
                }
                HoldAnswer::KeyReused => return refuse(422, "key-reused"),
                HoldAnswer::Gone => return gone(),
            }
            // Another request may have written while the day answered: decide again on what
            // is stored now, at the same time, so the lapse is the hold's `expires_at`.
            let (state, again) = self.load(&Self::meta_or(&meta)?)?;
            match execute::<Aggregate>(state, &cmd, &ctx) {
                Ok((s, e)) => {
                    decided = s;
                    events = e;
                    existing = again;
                }
                Err(e) => {
                    let (status, body) = refusal_of(&e);
                    return json(&body, status);
                }
            }
        }
        if first_write {
            self.ensure_schema()?;
        }
        let cause = c.cause.clone().unwrap_or_else(|| c.key.clone());
        let written = self
            .write(
                Write {
                    birth,
                    first_write,
                    existing,
                    batches: vec![Batch {
                        at: ctx.now,
                        cause: Some(cause),
                        events,
                    }],
                    state: decided,
                    keys: vec![(c.key.clone(), c.body_hash.clone(), String::new())],
                    relay: true,
                },
                now,
            )
            .await?;
        let answer = written
            .answer
            .ok_or_else(|| Error::RustError("no catering event after a command".into()))?;
        let status = if first_write { 201 } else { 200 };
        json(&answer, status)
    }

    fn meta_or(meta: &Option<child::Meta>) -> Result<child::Meta> {
        match meta {
            Some(m) => Ok(m.clone()),
            None => Err(Error::RustError("an acceptance before the inquiry".into())),
        }
    }

    /// One delivery from the consumer: Billing's outcome for this event.
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
            purpose: String,
            #[serde(rename = "ref")]
            reference: Ulid,
            amount_cents: Cents,
        }
        #[derive(Deserialize)]
        struct Issued {
            invoice: Ulid,
            #[serde(rename = "ref")]
            reference: Ulid,
            amount_cents: Cents,
            due: BakeryDate,
        }
        let data = envelope.data.clone();
        let (cmd, reference) = match envelope.event_type.as_str() {
            "PaymentSucceeded" => match serde_json::from_value::<Paid>(data) {
                Ok(d) if d.purpose == "deposit" => (
                    CateringCommand::RecordDeposit {
                        payment: d.payment,
                        amount: d.amount_cents,
                    },
                    d.reference,
                ),
                Ok(d) if d.purpose == "balance" => (
                    CateringCommand::RecordBalance {
                        payment: d.payment,
                        amount: d.amount_cents,
                    },
                    d.reference,
                ),
                _ => return refuse(422, "envelope"),
            },
            "InvoiceIssued" => match serde_json::from_value::<Issued>(data) {
                Ok(d) => (
                    CateringCommand::RecordInvoice {
                        invoice: d.invoice,
                        amount: d.amount_cents,
                        due: d.due,
                    },
                    d.reference,
                ),
                Err(_) => return refuse(422, "envelope"),
            },
            _ => return json(&serde_json::json!({ "outcome": "ignored" }), 200),
        };
        if meta.name != name(envelope.sandbox, reference) {
            return refuse(422, "envelope");
        }
        let key = format!("evt:{}", envelope.id);
        if stream::seen(&self.sql(), &key)?.is_some() {
            return json(&serde_json::json!({ "outcome": "duplicate" }), 200);
        }
        let (state, existing) = self.load(meta)?;
        let ctx = DecideContext {
            now: meta.business(now),
            id: envelope.id,
        };
        let (state, events) = match execute::<Aggregate>(state.clone(), &cmd, &ctx) {
            Ok(done) => done,
            Err(e) => {
                console_log!(
                    "{{\"event\":\"catering_event_refused\",\"id\":\"{}\",\"type\":{:?},\"rule\":\"{}\"}}",
                    envelope.id,
                    envelope.event_type,
                    e.rule()
                );
                if let (CateringCommand::RecordDeposit { payment, .. }, "out-of-order") =
                    (&cmd, e.rule())
                {
                    if !self
                        .refund_late_deposit(meta, envelope.id, *payment)
                        .await?
                    {
                        return refuse(503, "billing");
                    }
                    // The refund is asked for; the key keeps a redelivery from asking twice.
                    self.write(
                        Write {
                            birth: Self::birth_of(meta)?,
                            first_write: false,
                            existing,
                            batches: Vec::new(),
                            state,
                            keys: vec![(key, String::new(), String::new())],
                            relay: false,
                        },
                        now,
                    )
                    .await?;
                    return json(&serde_json::json!({ "outcome": "refunded" }), 200);
                }
                return json(
                    &serde_json::json!({ "outcome": "refused", "rule": e.rule() }),
                    200,
                );
            }
        };
        self.write(
            Write {
                birth: Self::birth_of(meta)?,
                first_write: false,
                existing,
                batches: vec![Batch {
                    at: ctx.now,
                    cause: Some(envelope.id.to_string()),
                    events,
                }],
                state,
                keys: vec![(key, String::new(), String::new())],
                relay: true,
            },
            now,
        )
        .await?;
        json(&serde_json::json!({ "outcome": "applied" }), 200)
    }

    /// A deposit the event cannot take, refunded in full by Billing under the delivery's id, as
    /// an order's late payment is (docs/domain.md, "Order"). Answers whether Billing took it.
    async fn refund_late_deposit(
        &self,
        meta: &child::Meta,
        delivery: Ulid,
        payment: Ulid,
    ) -> Result<bool> {
        let res = sql::call(
            &self.env,
            billing::BINDING,
            &billing::name(meta.sandbox_id()?),
            Method::Post,
            "/_refund",
            Some(&RefundIn {
                refund: delivery,
                payment,
                amount: None,
                reason: RefundReason::Goodwill,
            }),
        )
        .await?;
        let status = res.status_code();
        console_log!(
            "{{\"event\":\"deposit_late\",\"object\":\"{CLASS}\",\"payment\":\"{payment}\",\"refund\":\"{delivery}\",\"status\":{status}}}"
        );
        Ok(status == 200)
    }

    /// A saga timer is due: its command, under the timer's own key, so a second run of the same
    /// row finds the key and appends nothing. A row the state no longer asks for goes; one whose
    /// business time has not come (a stale wall time) is set again from its business time.
    fn fire(&self, meta: &child::Meta, timer: &stream::Timer, now: WallTime) -> Result<()> {
        let sql = self.sql();
        let (state, existing) = self.load(meta)?;
        let Some(due) = timers(&state)
            .into_iter()
            .find(|t| t.kind.row_name() == timer.id)
        else {
            stream::delete_timer(&sql, &timer.id)?;
            return Ok(());
        };
        let key = format!("timer:{}:{}", timer.id, due.at);
        if stream::seen(&sql, &key)?.is_some() {
            return sync_timers(&sql, &state, meta.clock_offset_s, true).map(|_| ());
        }
        let ctx = DecideContext {
            now: meta.business(now),
            id: random::ulid(now)?,
        };
        let (next, events) = match execute::<Aggregate>(state.clone(), &due.kind.command(), &ctx) {
            Ok(done) => done,
            Err(e) => {
                console_log!(
                    "{{\"event\":\"catering_timer_refused\",\"timer\":{:?},\"rule\":\"{}\"}}",
                    timer.id,
                    e.rule()
                );
                stream::delete_timer(&sql, &timer.id)?;
                return Ok(());
            }
        };
        if events.is_empty() {
            return sync_timers(&sql, &state, meta.clock_offset_s, true).map(|_| ());
        }
        console_log!(
            "{{\"event\":\"catering_timer\",\"object\":\"{CLASS}\",\"timer\":{:?},\"catering\":{:?}}}",
            timer.id,
            meta.name
        );
        let any = !events.is_empty();
        self.commit(
            Write {
                birth: Self::birth_of(meta)?,
                first_write: false,
                existing,
                batches: vec![Batch {
                    at: ctx.now,
                    cause: Some(key.clone()),
                    events,
                }],
                state: next,
                keys: vec![(key, String::new(), String::new())],
                relay: true,
            },
            now,
        )?;
        if any {
            stream::relay_after(&self.state, &self.env, now, CLASS)?;
        }
        Ok(())
    }

    /// The seed's commands for this event, each at its own time, written together as history.
    async fn seed(&self, s: SeedCatering, now: WallTime) -> Result<Response> {
        if child::meta(&self.sql())?.is_some() {
            return json(&serde_json::json!({ "seeded": true }), 200);
        }
        let mut state = CateringState::default();
        let mut batches = Vec::new();
        let mut keys = Vec::new();
        for (n, step) in s.steps.iter().enumerate() {
            let ctx = DecideContext {
                now: step.at,
                id: random::ulid(now)?,
            };
            let key = format!("seed:{n}");
            match execute::<Aggregate>(state.clone(), &step.cmd.domain(), &ctx) {
                Ok((next, events)) => {
                    state = next;
                    batches.push(Batch {
                        at: step.at,
                        cause: Some(key.clone()),
                        events,
                    });
                    keys.push((key, String::new(), String::new()));
                }
                Err(e) => console_log!(
                    "{{\"event\":\"seed_catering_refused\",\"object\":\"{CLASS}\",\"step\":{n},\"rule\":\"{}\"}}",
                    e.rule()
                ),
            }
        }
        self.ensure_schema()?;
        self.write(
            Write {
                birth: s.birth,
                first_write: true,
                existing: Vec::new(),
                batches,
                state,
                keys,
                relay: false,
            },
            now,
        )
        .await?;
        json(&serde_json::json!({ "seeded": true }), 201)
    }

    /// The transaction, then the relay and the alarm. The alarm's own path commits through
    /// [`CateringEvent::commit`] and relays without arming, so its run's re-arm is the one the
    /// guard counts.
    async fn write(&self, w: Write, now: WallTime) -> Result<Written> {
        let relay = w.relay && w.batches.iter().any(|b| !b.events.is_empty());
        let written = self.commit(w, now)?;
        if relay {
            stream::relay_soon(&self.state, &self.env, now, CLASS).await?;
        } else {
            stream::arm(&self.state.storage(), now).await?;
        }
        Ok(written)
    }

    /// One transaction: `meta` on the first write, the events and (unless it is the seed's
    /// history) their outbox rows, the keys with the answer, and the saga's timers brought in
    /// line with the state.
    fn commit(&self, w: Write, now: WallTime) -> Result<Written> {
        let sql = self.sql();
        let mut last_seq = w.existing.last().map_or(0, |e| e.seq);
        let mut built: Vec<Envelope> = Vec::new();
        for b in &w.batches {
            if b.events.is_empty() {
                continue;
            }
            let head = StreamHead {
                sandbox: w.birth.sandbox,
                stream: w.birth.name.clone(),
                last_seq,
            };
            let stamp = Stamp {
                at: b.at,
                recorded_at: now,
                cause: b.cause.clone(),
            };
            let mut ids = Vec::new();
            for _ in &b.events {
                ids.push(random::ulid(now)?);
            }
            let mut ids = ids.into_iter();
            let more = envelopes(&head, &stamp, &b.events, || {
                ids.next().unwrap_or(Ulid::from_parts(0, 0))
            })
            .map_err(|e| Error::RustError(e.to_string()))?;
            last_seq = more.last().map_or(last_seq, |e| e.seq);
            built.extend(more);
        }
        let mut all = w.existing.clone();
        all.extend(built.iter().cloned());
        let answer = response_of(&w.state, &all);
        let stored = match &answer {
            Some(a) => serde_json::to_string(a)?,
            None => "{}".to_owned(),
        };
        let keys: Vec<(String, String, String)> = w
            .keys
            .into_iter()
            .map(|(k, h, r)| {
                let r = if r.is_empty() { stored.clone() } else { r };
                (k, h, r)
            })
            .collect();
        let (birth, first_write, relay, state) =
            (w.birth.clone(), w.first_write, w.relay, w.state.clone());
        let tx_built = built.clone();
        let catering = state.record().map(|r| r.id);
        let cleared = transaction_sync(&self.state.storage(), move || {
            if first_write {
                child::born(&sql, &birth, now)?;
            }
            stream::append(&sql, &tx_built)?;
            if !relay {
                // The seed's history: its own rows only, never one an earlier commit left.
                for e in &tx_built {
                    let seq = i64::try_from(e.seq).map_err(|_| Error::RustError("seq".into()))?;
                    exec(&sql, "DELETE FROM outbox WHERE seq = ?", vec![seq.into()])?;
                }
            }
            for (key, hash, result) in &keys {
                stream::remember(&sql, key, hash, result, now)?;
            }
            // A first write knows no clock but its birth's; a later one the meta row's, which
            // `/_clock` keeps current.
            let offset = match child::meta(&sql)? {
                Some(m) => m.clock_offset_s,
                None => birth.clock_offset_s,
            };
            sync_timers(&sql, &state, offset, false)
        })?;
        if cleared {
            let status = w
                .state
                .status()
                .and_then(|s| serde_json::to_value(s).ok())
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            console_log!(
                "{{\"event\":\"timers_cleared\",\"object\":\"{CLASS}\",\"catering\":\"{}\",\"state\":{status:?}}}",
                catering.map(|c| c.to_string()).unwrap_or_default()
            );
        }
        Ok(Written { answer })
    }
}

/// The saga's timer rows as the state needs them: one per `catering::timers` entry, at its
/// business time, the rest deleted. A row whose business time is unchanged is left alone (no
/// row written) unless `recompute` asks for its wall time again. Answers whether rows were
/// there and none is left: the cleared timers a cancellation, decline, expiry or closure
/// leaves.
fn sync_timers(
    sql: &SqlStorage,
    state: &CateringState,
    offset_s: i64,
    recompute: bool,
) -> Result<bool> {
    let have: BTreeMap<String, Option<String>> = stream::timers(sql)?
        .into_iter()
        .filter(|t| t.purpose == TIMER)
        .map(|t| (t.id, t.due_business))
        .collect();
    let want: BTreeMap<String, BusinessTime> = timers(state)
        .into_iter()
        .map(|t| (t.kind.row_name(), t.at))
        .collect();
    for id in have.keys().filter(|id| !want.contains_key(*id)) {
        stream::delete_timer(sql, id)?;
    }
    for (id, at) in &want {
        let due = at.to_string();
        if !recompute
            && have
                .get(id)
                .is_some_and(|d| d.as_deref() == Some(due.as_str()))
        {
            continue;
        }
        stream::set_timer(sql, id, TIMER, wall_at(*at, offset_s), Some(&due))?;
    }
    Ok(!have.is_empty() && want.is_empty())
}

/// Domain values to wire values through their shared serde names.
fn via_json<T: Serialize, U: serde::de::DeserializeOwned>(value: T) -> Option<U> {
    serde_json::from_value(serde_json::to_value(value).ok()?).ok()
}

/// The event as the API shows it (`CateringResponse`): the record, the reminders still to come,
/// and the first and last envelopes' business times.
pub fn response_of(state: &CateringState, events: &[Envelope]) -> Option<CateringResponse> {
    let r = state.record()?;
    let quote = r.quote;
    Some(CateringResponse {
        catering: r.id.to_string(),
        state: via_json(r.status)?,
        date: r.date.to_string(),
        headcount: r.headcount,
        package: r.package.clone(),
        venue: r.venue.clone(),
        brief: r.brief.clone(),
        total_cents: quote.map(|q| q.total.0),
        deposit_cents: quote.map(|q| q.deposit.0),
        balance_cents: quote.map(|q| q.balance.0),
        valid_until: quote.map(|q| q.valid_until.to_string()),
        deposit_payment: r.deposit.map(|d| d.payment.to_string()),
        invoice: r.invoice.map(|i| i.invoice.to_string()),
        invoice_due: r.invoice.map(|i| i.due.to_string()),
        reminders: reminders(state)
            .into_iter()
            .filter_map(|x| {
                Some(CateringReminder {
                    kind: via_json(x.kind)?,
                    at: x.at.to_string(),
                })
            })
            .collect(),
        refund_deposit: r.refund_deposit,
        created_at: events.first().map(|e| e.at.to_string()).unwrap_or_default(),
        updated_at: events.last().map(|e| e.at.to_string()).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakery_domain::catering::{EXPIRY_REASON, TimerKind};

    fn at(text: &str) -> BusinessTime {
        text.parse().unwrap()
    }

    fn ctx(now: &str, n: u128) -> DecideContext {
        DecideContext {
            now: at(now),
            id: Ulid::from_parts(1_793_819_530_318, n),
        }
    }

    fn submit() -> Cmd {
        Cmd::Submit {
            catering: Ulid::from_parts(1_793_819_530_318, 2),
            customer: Ulid::from_parts(1_793_819_530_318, 3),
            date: "2026-11-21".parse().unwrap(),
            headcount: 40,
            package: "breakfast-spread".into(),
            venue: "v2".into(),
            brief: Some("Gluten-free options, please".into()),
        }
    }

    #[test]
    fn every_command_reads_and_writes_as_the_worker_sends_it() {
        let payment = Ulid::from_parts(1_793_819_530_318, 9);
        for cmd in [
            submit(),
            Cmd::Quote { total: None },
            Cmd::Quote {
                total: Some(Cents(120_000)),
            },
            Cmd::Decline {
                reason: DeclineReason::TooSoon,
            },
            Cmd::Accept,
            Cmd::LapseDeposit,
            Cmd::RecordDeposit {
                payment,
                amount: Cents(14_500),
            },
            Cmd::FireReminder {
                kind: ReminderKind::FollowUp,
            },
            Cmd::ExpireQuote,
            Cmd::StartProduction,
            Cmd::MarkDelivered,
            Cmd::RecordInvoice {
                invoice: payment,
                amount: Cents(43_500),
                due: "2026-11-28".parse().unwrap(),
            },
            Cmd::RecordBalance {
                payment,
                amount: Cents(43_500),
            },
            Cmd::Cancel {
                by: CancelledBy::Staff,
                reason: CancelReason::VenueLost,
            },
        ] {
            let text = serde_json::to_string(&cmd).unwrap();
            let back: Cmd = serde_json::from_str(&text).unwrap();
            assert_eq!(back, cmd, "{text}");
            assert_eq!(Cmd::of(&cmd.domain()), cmd, "{text}");
        }
        let accept: Cmd = serde_json::from_str(r#"{"cmd":"accept"}"#).unwrap();
        assert_eq!(accept.domain(), CateringCommand::AcceptQuote);
    }

    #[test]
    fn a_stream_names_its_event_in_its_own_sandbox_only() {
        let s = Ulid::from_parts(1, 1);
        let c = Ulid::from_parts(1, 2);
        assert_eq!(id_of(&name(s, c), s), Some(c));
        assert_eq!(id_of(&name(c, s), s), None);
        assert_eq!(id_of(&format!("order:{s}:{c}"), s), None);
    }

    #[test]
    fn a_refused_inquiry_is_422_a_refused_step_409_and_only_the_lead_has_a_sentence() {
        let (status, r) = refusal_of(&CateringError::Headcount);
        assert_eq!((status, r.rule.as_deref()), (422, Some("headcount")));
        assert!(r.message.is_none());
        let lead = CateringError::Lead {
            earliest: "2026-11-17".parse().unwrap(),
        };
        let (status, r) = refusal_of(&lead);
        assert_eq!(status, 422);
        assert!(r.message.unwrap().contains("2026-11-17"));
        let (status, r) = refusal_of(&CateringError::OutOfOrder {
            command: "AcceptQuote",
            status: Some(bakery_domain::catering::CateringStatus::Inquiry),
        });
        assert_eq!((status, r.rule.as_deref()), (409, Some("out-of-order")));
        // A package that is not one carries the text it was sent in the domain's message;
        // the refusal carries only the rule.
        let (_, r) = refusal_of(&CateringError::UnknownPackage("anything".into()));
        assert!(r.message.is_none());
        assert!(!serde_json::to_string(&r).unwrap().contains("anything"));
    }

    /// The saga's timers, as the object arms them: the follow-up and the expiry while quoted, the
    /// lapse while accepted, and none once it is cancelled.
    #[test]
    fn the_timer_rows_follow_the_state_and_a_cancellation_leaves_none() {
        let mut state = CateringState::default();
        let mut events: Vec<Event> = Vec::new();
        let mut run = |state: &mut CateringState, cmd: Cmd, now: &str, n| {
            let (next, mut more) = execute::<Aggregate>(state.clone(), &cmd.domain(), &ctx(now, n))
                .unwrap_or_else(|e| panic!("{}", e.rule()));
            *state = next;
            events.append(&mut more);
        };
        run(&mut state, submit(), "2026-11-07T10:00:00-07:00", 1);
        assert!(timers(&state).is_empty());
        run(
            &mut state,
            Cmd::Quote { total: None },
            "2026-11-07T11:00:00-07:00",
            2,
        );
        let rows: Vec<String> = timers(&state).iter().map(|t| t.kind.row_name()).collect();
        assert_eq!(rows, ["reminder:follow_up", "quote-expiry"]);
        run(&mut state, Cmd::Accept, "2026-11-07T12:00:00-07:00", 3);
        let t = timers(&state);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].kind, TimerKind::DepositLapse);
        assert_eq!(t[0].at, at("2026-11-07T12:15:00-07:00"));
        let lapse = hold_request(&state).unwrap();
        assert_eq!(
            lapse.expires_at, t[0].at,
            "the day's hold lapses with the deposit hold"
        );
        let deposit = state.record().unwrap().quote.unwrap().deposit;
        run(
            &mut state,
            Cmd::RecordDeposit {
                payment: Ulid::from_parts(1_793_819_530_318, 7),
                amount: deposit,
            },
            "2026-11-07T12:05:00-07:00",
            4,
        );
        let rows: Vec<String> = timers(&state).iter().map(|t| t.kind.row_name()).collect();
        assert_eq!(rows, ["reminder:event_soon"]);
        run(
            &mut state,
            Cmd::Cancel {
                by: CancelledBy::Customer,
                reason: CancelReason::CustomerChange,
            },
            "2026-11-08T09:00:00-07:00",
            5,
        );
        assert!(timers(&state).is_empty());
        let r = response_of(&state, &[]).unwrap();
        assert!(r.reminders.is_empty());
        assert_eq!(r.refund_deposit, Some(true), "13 days ahead");
        assert_eq!(r.state, bakery_contracts::CateringState::Cancelled);
        assert_eq!(EXPIRY_REASON, "14 business days");
    }

    #[test]
    fn a_response_shows_the_quote_the_brief_and_the_reminders() {
        let mut state = CateringState::default();
        for (cmd, now, n) in [
            (submit(), "2026-11-07T10:00:00-07:00", 1),
            (Cmd::Quote { total: None }, "2026-11-07T11:00:00-07:00", 2),
        ] {
            state = execute::<Aggregate>(state, &cmd.domain(), &ctx(now, n))
                .unwrap()
                .0;
        }
        let r = response_of(&state, &[]).unwrap();
        assert_eq!(r.state, bakery_contracts::CateringState::Quoted);
        assert_eq!(r.total_cents, Some(58_000), "40 × $14.50");
        assert_eq!(r.deposit_cents, Some(14_500));
        assert_eq!(
            r.deposit_cents.unwrap() + r.balance_cents.unwrap(),
            r.total_cents.unwrap()
        );
        assert_eq!(r.brief.as_deref(), Some("Gluten-free options, please"));
        assert_eq!(r.reminders.len(), 1);
        assert_eq!(
            r.reminders[0].kind,
            bakery_contracts::ReminderKind::FollowUp
        );
        assert!(r.valid_until.is_some());
    }
}
