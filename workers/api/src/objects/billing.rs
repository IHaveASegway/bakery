//! `Billing`, one per sandbox, named `billing:<sandbox>` (docs/architecture.md, "Durable Object
//! topology"; ADR 0007, decisions 3, 5, 7 and 9). It hosts the domain's `Billing` aggregate: the
//! state is the fold of its own `events`, and every change is one transaction of events, outbox
//! rows and, for a webhook, the Stripe event id inside the event itself, so a replay finds it in
//! the fold and changes nothing.
//!
//! The order of a call that reaches Stripe is always: decide and commit, then call Stripe with
//! the idempotency key the committed state names, then record Stripe's answer as a second
//! command. A retry after a lost answer makes the same call with the same key and gets the
//! first answer back. The client secret Stripe returns goes to the caller and is never stored,
//! logged or put in an event.
//!
//! Paths (the Worker builds them; nothing outside reaches them):
//!
//! - `POST /_seed {birth, days}` → 201; 200 when already seeded. The seed's history as daily
//!   totals (`history`): what the bakery took before the sandbox was born. These are not Stripe
//!   payments and are not in the ledger, whose every line has a Stripe id.
//! - `POST /_intent {purpose, reference, amount}` → 200 `IntentOut`: the payment created (or the
//!   open one reused), the intent created at Stripe, `RecordIntent`. 409 `{error: "paid"}`
//!   when the reference is paid; 409 `{error: "canceled"}` when its expiry canceled the payment
//!   while Stripe answered; 503 `{error: "stripe-key" | "config"}`; 502 `{error: "stripe",
//!   reason}` or 503 for a retryable one.
//! - `POST /_confirm-test {purpose, reference, card}` → 200 `ConfirmOut`: the open payment's
//!   intent confirmed server-side with a test payment method. Records nothing: the webhook does.
//! - `POST /_webhook {event_id, kind}` → 200 `{outcome: applied | replayed | no-effect}`; 409
//!   `{error: "billing", rule}` for an event Billing cannot apply yet (an unknown intent, a
//!   refund before its payment), so Stripe delivers it again.
//! - `POST /_refund {refund, payment, amount?, reason}` → 200 `RefundOut`: `RequestRefund` under
//!   the refund's id, Stripe's refund, `RecordRefund`. 200 with `issued: false, rule:
//!   "unknown-payment"` for a payment Billing never took (a seeded order's).
//! - `POST /_cancel {reference}` → 200 `{canceled}`: `CancelForExpiry`, then each intent canceled
//!   at Stripe, best effort.
//! - `POST /_event` with an envelope, from the consumer: `OrderRefundRequested` is `/_refund`
//!   with the event's id as the refund's, `OrderExpired` is `/_cancel`; anything else is 200.
//! - `GET /_payment/<ref>` → 200 `PaidOut` for the reference's succeeded order payment, else 404.
//! - `GET /_ledger` → 200 `LedgerResponse`.
//! - `POST /_wipe`: every open intent canceled at Stripe, best effort, then the child protocol's
//!   wipe. `POST /_clock`: the child protocol (child.rs); Billing's timers are wall time.
//!
//! Timers: `outbox`, `backstop`.

use std::cell::Cell;

use bakery_app::Clock;
use bakery_app::ports::{
    CancelRequest, ConfirmRequest, IntentRequest, PaymentGateway, PortError, RefundIntentRequest,
    TestCard,
};
use bakery_app::stripe::{Call, idempotency_key};
use bakery_contracts::{
    LedgerEntry as WireEntry, LedgerKind as WireKind, LedgerResponse, PaymentPurpose,
};
use bakery_domain::billing::{
    Billing as BillingAggregate, BillingCommand, BillingError, BillingEvent, BillingState,
    LedgerKind, PaymentStatus, Purpose, WebhookKind, WebhookOutcome,
};
use bakery_domain::order::RefundReason;
use bakery_domain::outbox::{Stamp, StreamHead, envelopes};
use bakery_domain::{Cents, DecideContext, DomainEvent, Envelope, Ulid, WallTime, execute, replay};
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Error, Method, Request, Response, Result, SqlStorage, State, console_log,
    durable_object,
};

use super::child::{self, Birth, ClockUpdate};
use super::sql::{self, exec, gone, has_table, json, refuse, transaction_sync};
use super::stream::{self, BACKSTOP, OUTBOX};
use crate::clock::SystemClock;
use crate::random;
use crate::stripe::{self, Stripe, Unavailable};

pub const BINDING: &str = "BILLING";
pub const CLASS: &str = "Billing";

pub fn name(sandbox: Ulid) -> String {
    format!("billing:{sandbox}")
}

/// Billing's two events beyond the catalog have no subscriber: they are kept in the stream and
/// never sent to the Queue (docs/domain.md, "The event catalog").
const QUIET: &[&str] = &["PaymentIntentRecorded", "RefundRequested"];

const SCHEMA: &[&str] = &[
    child::META,
    // The seed's history, a row a business day: what the bakery took before this sandbox.
    "CREATE TABLE IF NOT EXISTS history (
       day TEXT PRIMARY KEY,
       orders INTEGER NOT NULL,
       cents INTEGER NOT NULL)",
];

/// One business day of the seed's history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DayTotal {
    /// `YYYY-MM-DD`, business time.
    pub day: String,
    pub orders: u32,
    pub cents: Cents,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedBilling {
    pub birth: Birth,
    pub days: Vec<DayTotal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentIn {
    pub purpose: Purpose,
    pub reference: Ulid,
    pub amount: Cents,
}

/// `/_intent`'s answer. Holds the client secret, so it has no `Debug` and is never logged.
#[derive(Clone, Serialize, Deserialize)]
pub struct IntentOut {
    pub payment: Ulid,
    pub client_secret: String,
    pub amount_cents: Cents,
    pub status: PaymentStatus,
}

/// Which of Stripe's test payment methods a server-side confirm uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Card {
    Visa,
    ChargeDeclined,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmIn {
    pub purpose: Purpose,
    pub reference: Ulid,
    pub card: Card,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmOut {
    pub payment: Ulid,
    /// `awaiting_payment` after a decline, `succeeded`, `processing` or `canceled`.
    pub status: String,
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookIn {
    pub event_id: String,
    pub kind: WebhookKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefundIn {
    /// The refund's id: the `OrderRefundRequested` event's id.
    pub refund: Ulid,
    pub payment: Ulid,
    #[serde(default)]
    pub amount: Option<Cents>,
    pub reason: RefundReason,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefundOut {
    pub refund: Ulid,
    pub issued: bool,
    pub amount_cents: Cents,
    #[serde(default)]
    pub stripe_refund: Option<String>,
    #[serde(default)]
    pub rule: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelIn {
    pub reference: Ulid,
}

/// `/_payment/<ref>`: the reference's succeeded order payment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaidOut {
    pub payment: Ulid,
    pub amount_cents: Cents,
    pub refunded_cents: Cents,
}

#[durable_object]
pub struct Billing {
    state: State,
    env: Env,
    schema_ready: Cell<bool>,
}

impl DurableObject for Billing {
    fn new(state: State, env: Env) -> Self {
        Billing {
            state,
            env,
            schema_ready: Cell::new(false),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let now = SystemClock::new().now_wall();
        let path = req.path();
        match (req.method(), path.as_str()) {
            (Method::Post, "/_seed") => {
                let body: SeedBilling = sql::body(&mut req).await?;
                self.seed(body, now).await
            }
            (Method::Post, "/_wipe") => {
                self.cancel_open_intents().await;
                json(&child::wipe(&self.state).await?, 200)
            }
            (method, path) => {
                let sql = self.sql();
                let Some(meta) = child::meta(&sql)? else {
                    return gone();
                };
                match (method, path) {
                    (Method::Post, "/_intent") => {
                        let body: IntentIn = sql::body(&mut req).await?;
                        self.intent(&meta, body, now).await
                    }
                    (Method::Post, "/_confirm-test") => {
                        let body: ConfirmIn = sql::body(&mut req).await?;
                        self.confirm_test(&meta, body).await
                    }
                    (Method::Post, "/_webhook") => {
                        let body: WebhookIn = sql::body(&mut req).await?;
                        self.webhook(&meta, body, now).await
                    }
                    (Method::Post, "/_refund") => {
                        let body: RefundIn = sql::body(&mut req).await?;
                        self.refund(&meta, body, now).await
                    }
                    (Method::Post, "/_cancel") => {
                        let body: CancelIn = sql::body(&mut req).await?;
                        self.cancel(&meta, body.reference, now).await
                    }
                    (Method::Post, "/_event") => {
                        let text = req.text().await?;
                        self.event(&meta, &text, now).await
                    }
                    (Method::Get, "/_ledger") => json(&self.ledger(&meta)?, 200),
                    (Method::Get, p) if p.starts_with("/_payment/") => {
                        self.paid(&meta, &p["/_payment/".len()..])
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

/// An object refusal for a gateway that cannot be used.
fn unavailable(u: Unavailable) -> Result<Response> {
    match u {
        Unavailable::Config(e) => json(
            &serde_json::json!({ "error": "config", "name": e.name() }),
            503,
        ),
        Unavailable::Key => refuse(503, "stripe-key"),
    }
}

/// Stripe refused or could not be reached: 503 when a retry may help, else 502. The reason is a
/// code from Stripe's error body, never its message.
fn stripe_refusal(op: &str, e: &PortError) -> Result<Response> {
    let reason = stripe::reason(e);
    console_log!("{{\"event\":\"stripe_error\",\"op\":\"{op}\",\"reason\":{reason:?}}}");
    let status = match e {
        PortError::Unavailable(_) => 503,
        _ => 502,
    };
    json(
        &serde_json::json!({ "error": "stripe", "reason": reason }),
        status,
    )
}

fn billing_refusal(status: u16, e: &BillingError) -> Result<Response> {
    json(
        &serde_json::json!({ "error": "billing", "rule": e.rule() }),
        status,
    )
}

fn status_text(s: bakery_app::ports::IntentStatus) -> &'static str {
    use bakery_app::ports::IntentStatus as S;
    match s {
        S::AwaitingPayment => "awaiting_payment",
        S::Processing => "processing",
        S::Succeeded => "succeeded",
        S::Canceled => "canceled",
    }
}

impl Billing {
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

    /// The stream and the state it folds to.
    fn load(&self, meta: &child::Meta) -> Result<(BillingState, Vec<Envelope>)> {
        if !has_table(&self.sql(), "events")? {
            return Ok((BillingState::default(), Vec::new()));
        }
        let events = stream::events(&self.sql(), meta.sandbox_id()?, &meta.name)?;
        let decoded = decode(&events)?;
        Ok((replay::<BillingAggregate>(&decoded), events))
    }

    fn ctx(meta: &child::Meta, now: WallTime, id: Ulid) -> DecideContext {
        DecideContext {
            now: meta.business(now),
            id,
        }
    }

    /// The events, their outbox rows (but the quiet ones'), in one transaction; then the relay.
    async fn commit(
        &self,
        meta: &child::Meta,
        existing: &[Envelope],
        events: &[BillingEvent],
        now: WallTime,
        cause: &str,
    ) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let head = StreamHead {
            sandbox: meta.sandbox_id()?,
            stream: meta.name.clone(),
            last_seq: existing.last().map_or(0, |e| e.seq),
        };
        let stamp = Stamp {
            at: meta.business(now),
            recorded_at: now,
            cause: Some(cause.to_owned()),
        };
        let mut ids = Vec::new();
        for _ in events {
            ids.push(random::ulid(now)?);
        }
        let mut ids = ids.into_iter();
        let built = envelopes(&head, &stamp, events, || {
            ids.next().unwrap_or(Ulid::from_parts(0, 0))
        })
        .map_err(|e| Error::RustError(e.to_string()))?;
        let quiet: Vec<i64> = built
            .iter()
            .filter(|e| QUIET.contains(&e.event_type.as_str()))
            .filter_map(|e| i64::try_from(e.seq).ok())
            .collect();
        let loud = built.len() > quiet.len();
        let sql = self.sql();
        transaction_sync(&self.state.storage(), move || {
            stream::append(&sql, &built)?;
            for seq in quiet {
                exec(&sql, "DELETE FROM outbox WHERE seq = ?", vec![seq.into()])?;
            }
            Ok(())
        })?;
        if loud {
            stream::relay_soon(&self.state, &self.env, now, CLASS).await?;
        }
        Ok(())
    }

    async fn seed(&self, s: SeedBilling, now: WallTime) -> Result<Response> {
        let sql = self.sql();
        if child::meta(&sql)?.is_some() {
            return json(&serde_json::json!({ "seeded": true }), 200);
        }
        self.ensure_schema()?;
        let birth = s.birth.clone();
        transaction_sync(&self.state.storage(), move || {
            child::born(&sql, &birth, now)?;
            for d in &s.days {
                exec(
                    &sql,
                    "INSERT OR REPLACE INTO history (day, orders, cents) VALUES (?, ?, ?)",
                    vec![
                        d.day.as_str().into(),
                        i64::from(d.orders).into(),
                        d.cents.0.into(),
                    ],
                )?;
            }
            Ok(())
        })?;
        // No events yet; the alarm is armed for the backstop.
        stream::arm(&self.state.storage(), now).await?;
        json(&serde_json::json!({ "seeded": true }), 201)
    }

    /// Pay: the payment, the intent at Stripe, and Stripe's id recorded.
    async fn intent(&self, meta: &child::Meta, body: IntentIn, now: WallTime) -> Result<Response> {
        let gateway = match Stripe::from_env(&self.env) {
            Ok(g) => g,
            Err(u) => return unavailable(u),
        };
        self.ensure_schema()?;
        let (state, existing) = self.load(meta)?;
        let fresh = random::ulid(now)?;
        let cmd = BillingCommand::CreateIntent {
            payment: fresh,
            purpose: body.purpose,
            reference: body.reference,
            amount: body.amount,
        };
        let (state, payment) =
            match execute::<BillingAggregate>(state.clone(), &cmd, &Self::ctx(meta, now, fresh)) {
                Ok((next, events)) => {
                    self.commit(meta, &existing, &events, now, &fresh.to_string())
                        .await?;
                    (next, fresh)
                }
                // A second "pay" for the same order: the same payment, and the same intent below.
                Err(BillingError::PaymentOpen { payment }) => (state, payment),
                Err(BillingError::AlreadyPaid { .. }) => return refuse(409, "paid"),
                Err(e) => return billing_refusal(422, &e),
            };
        let Some(p) = state.payment(payment).cloned() else {
            return Err(Error::RustError("the payment is not in the state".into()));
        };
        if p.amount != body.amount {
            console_log!("{{\"event\":\"billing_amount_mismatch\",\"payment\":\"{payment}\"}}");
            return refuse(409, "amount");
        }
        // The same key and body as the first time, so a retry, or a remount of the payment step,
        // gets the same intent and client secret back from Stripe.
        let created = gateway
            .create_intent(IntentRequest {
                sandbox: meta.sandbox_id()?,
                payment,
                purpose: p.purpose,
                reference: p.reference,
                amount: p.amount,
                idempotency_key: idempotency_key(Call::Create, p.reference, p.purpose, p.attempt),
            })
            .await;
        let created = match created {
            Ok(c) => c,
            Err(e) => return stripe_refusal("create", &e),
        };
        // The expiry, or a webhook, may have written while Stripe answered.
        let (state, existing) = self.load(meta)?;
        let id = random::ulid(now)?;
        let cmd = BillingCommand::RecordIntent {
            payment,
            stripe_id: created.provider_id.clone(),
            client_secret_seen: !created.client_secret.is_empty(),
        };
        let state = match execute::<BillingAggregate>(state, &cmd, &Self::ctx(meta, now, id)) {
            Ok((next, events)) => {
                self.commit(meta, &existing, &events, now, &id.to_string())
                    .await?;
                next
            }
            Err(e) => {
                console_log!(
                    "{{\"event\":\"billing_refused\",\"command\":\"RecordIntent\",\"rule\":\"{}\"}}",
                    e.rule()
                );
                return billing_refusal(502, &e);
            }
        };
        let Some(p) = state.payment(payment).cloned() else {
            return Err(Error::RustError("the payment is not in the state".into()));
        };
        if p.status == PaymentStatus::Canceled {
            // The order expired while Stripe answered: the intent is canceled there too.
            self.cancel_at_stripe(
                &gateway,
                &p.reference,
                p.purpose,
                p.attempt,
                &created.provider_id,
            )
            .await;
            return refuse(409, "canceled");
        }
        console_log!(
            "{{\"event\":\"intent_created\",\"payment\":\"{payment}\",\"intent\":{:?}}}",
            created.provider_id
        );
        json(
            &IntentOut {
                payment,
                client_secret: created.client_secret,
                amount_cents: p.amount,
                status: p.status,
            },
            200,
        )
    }

    /// The server-side path's confirm, with a test payment method. The outcome reaches Billing
    /// as Stripe's webhook, like the browser's.
    async fn confirm_test(&self, meta: &child::Meta, body: ConfirmIn) -> Result<Response> {
        let gateway = match Stripe::from_env(&self.env) {
            Ok(g) => g,
            Err(u) => return unavailable(u),
        };
        let (state, _) = self.load(meta)?;
        let Some((payment, p)) = state.open_payment(body.purpose, body.reference) else {
            return refuse(409, "no-open-payment");
        };
        let Some(intent) = p.intent.clone() else {
            return refuse(409, "no-intent");
        };
        let card = match body.card {
            Card::Visa => TestCard::Visa,
            Card::ChargeDeclined => TestCard::ChargeDeclined,
        };
        let snapshot = gateway
            .confirm_intent(ConfirmRequest {
                intent,
                card,
                idempotency_key: idempotency_key(Call::Confirm, p.reference, p.purpose, p.attempt),
            })
            .await;
        match snapshot {
            Ok(s) => json(
                &ConfirmOut {
                    payment,
                    status: status_text(s.status).to_owned(),
                    failure_code: s.failure_code,
                },
                200,
            ),
            Err(e) => stripe_refusal("confirm", &e),
        }
    }

    /// A verified Stripe event. A refund whose webhook names no request (Stripe's own refunds
    /// carry the bakery's `metadata[refund]`; the local fake's carry the intent's) is matched to
    /// the one unissued request of its payment and amount, so a webhook that overtakes the
    /// gateway's answer still issues that request, not a second refund.
    async fn webhook(
        &self,
        meta: &child::Meta,
        body: WebhookIn,
        now: WallTime,
    ) -> Result<Response> {
        self.ensure_schema()?;
        let (state, existing) = self.load(meta)?;
        let kind = match body.kind {
            WebhookKind::Refunded {
                intent,
                refund,
                amount,
                request: None,
            } => {
                let request = state.payment_for_intent(&intent).and_then(|(payment, _)| {
                    let mut pending = state.refunds().filter(|(_, r)| {
                        r.payment == payment && !r.is_issued() && r.amount == amount
                    });
                    match (pending.next(), pending.next()) {
                        (Some((id, _)), None) => Some(id),
                        _ => None,
                    }
                });
                WebhookKind::Refunded {
                    intent,
                    refund,
                    amount,
                    request,
                }
            }
            other => other,
        };
        let id = random::ulid(now)?;
        let outcome = BillingAggregate::apply_webhook(
            &state,
            &body.event_id,
            &kind,
            &Self::ctx(meta, now, id),
        );
        let label = match outcome {
            Ok(WebhookOutcome::Applied(events)) => {
                self.commit(
                    meta,
                    &existing,
                    &events,
                    now,
                    &format!("stripe:{}", body.event_id),
                )
                .await?;
                "applied"
            }
            Ok(WebhookOutcome::Replayed) => "replayed",
            Ok(WebhookOutcome::NoEffect) => "no-effect",
            Err(e) => {
                console_log!(
                    "{{\"event\":\"webhook_refused\",\"stripe_event\":{:?},\"rule\":\"{}\"}}",
                    body.event_id,
                    e.rule()
                );
                return billing_refusal(409, &e);
            }
        };
        console_log!(
            "{{\"event\":\"webhook_applied\",\"stripe_event\":{:?},\"outcome\":\"{label}\"}}",
            body.event_id
        );
        json(&serde_json::json!({ "outcome": label }), 200)
    }

    /// A refund: requested under its id, made at Stripe, recorded. Every step can run again: the
    /// request is a no-op once recorded, Stripe answers the same key with the same refund, and
    /// `RecordRefund` is a no-op once issued.
    async fn refund(&self, meta: &child::Meta, body: RefundIn, now: WallTime) -> Result<Response> {
        let gateway = match Stripe::from_env(&self.env) {
            Ok(g) => g,
            Err(u) => return unavailable(u),
        };
        self.ensure_schema()?;
        let (state, existing) = self.load(meta)?;
        let cmd = BillingCommand::RequestRefund {
            payment: body.payment,
            amount: body.amount,
            reason: body.reason,
        };
        let state = match execute::<BillingAggregate>(
            state,
            &cmd,
            &Self::ctx(meta, now, body.refund),
        ) {
            Ok((next, events)) => {
                self.commit(meta, &existing, &events, now, &body.refund.to_string())
                    .await?;
                next
            }
            Err(BillingError::UnknownPayment) => {
                // A seeded order's payment never went through Stripe: nothing to refund there.
                console_log!(
                    "{{\"event\":\"refund_skipped\",\"refund\":\"{}\",\"rule\":\"unknown-payment\"}}",
                    body.refund
                );
                return json(
                    &RefundOut {
                        refund: body.refund,
                        issued: false,
                        amount_cents: body.amount.unwrap_or(Cents::ZERO),
                        stripe_refund: None,
                        rule: Some("unknown-payment".into()),
                    },
                    200,
                );
            }
            Err(e) => {
                console_log!(
                    "{{\"event\":\"billing_refused\",\"command\":\"RequestRefund\",\"rule\":\"{}\"}}",
                    e.rule()
                );
                return billing_refusal(422, &e);
            }
        };
        let (Some(r), Some(p)) = (
            state.refund(body.refund).cloned(),
            state.payment(body.payment).cloned(),
        ) else {
            return Err(Error::RustError("the refund is not in the state".into()));
        };
        if let Some(stripe_refund) = r.stripe_refund.clone() {
            return json(
                &RefundOut {
                    refund: body.refund,
                    issued: true,
                    amount_cents: r.amount,
                    stripe_refund: Some(stripe_refund),
                    rule: None,
                },
                200,
            );
        }
        let Some(intent) = p.intent.clone() else {
            return Err(Error::RustError("a paid payment has no intent".into()));
        };
        let created = gateway
            .refund(RefundIntentRequest {
                sandbox: meta.sandbox_id()?,
                payment: body.payment,
                refund: body.refund,
                purpose: p.purpose,
                reference: p.reference,
                intent,
                amount: r.amount,
                reason: r.reason.unwrap_or(body.reason),
                idempotency_key: idempotency_key(Call::Refund, p.reference, p.purpose, r.ordinal),
            })
            .await;
        let created = match created {
            Ok(c) => c,
            Err(e) => return stripe_refusal("refund", &e),
        };
        let (state, existing) = self.load(meta)?;
        let id = random::ulid(now)?;
        let cmd = BillingCommand::RecordRefund {
            payment: body.payment,
            refund: body.refund,
            stripe_refund: created.provider_id.clone(),
            amount: created.amount,
        };
        match execute::<BillingAggregate>(state, &cmd, &Self::ctx(meta, now, id)) {
            Ok((_, events)) => {
                self.commit(meta, &existing, &events, now, &body.refund.to_string())
                    .await?;
            }
            Err(e) => {
                console_log!(
                    "{{\"event\":\"billing_refused\",\"command\":\"RecordRefund\",\"rule\":\"{}\"}}",
                    e.rule()
                );
                return billing_refusal(502, &e);
            }
        }
        console_log!(
            "{{\"event\":\"refund_issued\",\"refund\":\"{}\",\"stripe_refund\":{:?}}}",
            body.refund,
            created.provider_id
        );
        json(
            &RefundOut {
                refund: body.refund,
                issued: true,
                amount_cents: created.amount,
                stripe_refund: Some(created.provider_id),
                rule: None,
            },
            200,
        )
    }

    /// `CancelForExpiry`, then each canceled intent canceled at Stripe, best effort: an intent
    /// left open there expires with the sandbox's test data.
    async fn cancel(&self, meta: &child::Meta, reference: Ulid, now: WallTime) -> Result<Response> {
        self.ensure_schema()?;
        let (state, existing) = self.load(meta)?;
        let id = random::ulid(now)?;
        let cmd = BillingCommand::CancelForExpiry { reference };
        let events =
            match execute::<BillingAggregate>(state.clone(), &cmd, &Self::ctx(meta, now, id)) {
                Ok((_, events)) => events,
                Err(e) => return billing_refusal(422, &e),
            };
        self.commit(meta, &existing, &events, now, &id.to_string())
            .await?;
        let canceled: Vec<(Ulid, String, Purpose, u32)> = events
            .iter()
            .filter_map(|e| match e {
                BillingEvent::PaymentCanceled { payment, .. } => {
                    let p = state.payment(*payment)?;
                    Some((*payment, p.intent.clone()?, p.purpose, p.attempt))
                }
                _ => None,
            })
            .collect();
        if !canceled.is_empty() {
            match Stripe::from_env(&self.env) {
                Ok(gateway) => {
                    for (_, intent, purpose, attempt) in &canceled {
                        self.cancel_at_stripe(&gateway, &reference, *purpose, *attempt, intent)
                            .await;
                    }
                }
                Err(u) => console_log!(
                    "{{\"event\":\"stripe_cancel_skipped\",\"reason\":\"{}\"}}",
                    u.code()
                ),
            }
        }
        json(&serde_json::json!({ "canceled": events.len() }), 200)
    }

    async fn cancel_at_stripe(
        &self,
        gateway: &Stripe,
        reference: &Ulid,
        purpose: Purpose,
        attempt: u32,
        intent: &str,
    ) {
        let done = gateway
            .cancel_intent(CancelRequest {
                intent: intent.to_owned(),
                idempotency_key: idempotency_key(Call::Cancel, *reference, purpose, attempt),
            })
            .await;
        match done {
            Ok(_) => console_log!("{{\"event\":\"intent_canceled\",\"intent\":{intent:?}}}"),
            Err(e) => console_log!(
                "{{\"event\":\"stripe_error\",\"op\":\"cancel\",\"reason\":{:?}}}",
                stripe::reason(&e)
            ),
        }
    }

    /// The wipe's Stripe cleanup (ADR 0007, decision 9): every intent still open is canceled,
    /// best effort, before `delete_all`.
    async fn cancel_open_intents(&self) {
        let Ok(Some(meta)) = child::meta(&self.sql()) else {
            return;
        };
        let Ok((state, _)) = self.load(&meta) else {
            return;
        };
        let open: Vec<(Ulid, String, Purpose, u32)> = state
            .payments()
            .filter(|(_, p)| p.status.is_open())
            .filter_map(|(_, p)| Some((p.reference, p.intent.clone()?, p.purpose, p.attempt)))
            .collect();
        if open.is_empty() {
            return;
        }
        let Ok(gateway) = Stripe::from_env(&self.env) else {
            console_log!("{{\"event\":\"stripe_cancel_skipped\",\"reason\":\"wipe\"}}");
            return;
        };
        for (reference, intent, purpose, attempt) in &open {
            self.cancel_at_stripe(&gateway, reference, *purpose, *attempt, intent)
                .await;
        }
    }

    /// One delivery from the consumer.
    async fn event(&self, meta: &child::Meta, text: &str, now: WallTime) -> Result<Response> {
        let Ok(envelope) = serde_json::from_str::<Envelope>(text) else {
            return refuse(422, "envelope");
        };
        if envelope.sandbox.to_string() != meta.sandbox {
            return refuse(422, "envelope");
        }
        match envelope.event_type.as_str() {
            "OrderRefundRequested" => {
                #[derive(Deserialize)]
                struct Data {
                    payment: Ulid,
                    amount_cents: Cents,
                    reason: RefundReason,
                }
                let Ok(d) = serde_json::from_value::<Data>(envelope.data.clone()) else {
                    return refuse(422, "envelope");
                };
                let body = RefundIn {
                    refund: envelope.id,
                    payment: d.payment,
                    amount: Some(d.amount_cents),
                    reason: d.reason,
                };
                self.refund(meta, body, now).await
            }
            "OrderExpired" => {
                let Some(order) = order_of(&envelope.stream, envelope.sandbox) else {
                    return refuse(422, "envelope");
                };
                self.cancel(meta, order, now).await
            }
            _ => json(&serde_json::json!({ "outcome": "ignored" }), 200),
        }
    }

    fn paid(&self, meta: &child::Meta, reference: &str) -> Result<Response> {
        let Ok(reference) = reference.parse::<Ulid>() else {
            return refuse(404, "not-found");
        };
        let (state, _) = self.load(meta)?;
        let found = state.payments().find(|(_, p)| {
            p.purpose == Purpose::Order
                && p.reference == reference
                && p.status == PaymentStatus::Succeeded
        });
        match found {
            Some((payment, p)) => json(
                &PaidOut {
                    payment,
                    amount_cents: p.amount,
                    refunded_cents: p.refunded,
                },
                200,
            ),
            None => refuse(404, "no-payment"),
        }
    }

    fn ledger(&self, meta: &child::Meta) -> Result<LedgerResponse> {
        let (_, events) = self.load(meta)?;
        let decoded = decode(&events)?;
        let ledger = bakery_domain::billing::Ledger::from_events(
            events.iter().map(|e| e.at).zip(decoded.iter()),
        );
        Ok(ledger_response(&ledger))
    }
}

fn decode(events: &[Envelope]) -> Result<Vec<BillingEvent>> {
    events
        .iter()
        .map(BillingEvent::from_envelope)
        .collect::<std::result::Result<_, _>>()
        .map_err(|e| Error::RustError(e.to_string()))
}

/// The order an `order:<sandbox>:<ulid>` stream names.
fn order_of(stream: &str, sandbox: Ulid) -> Option<Ulid> {
    let rest = stream.strip_prefix(&format!("order:{sandbox}:"))?;
    rest.parse().ok()
}

pub fn ledger_response(ledger: &bakery_domain::billing::Ledger) -> LedgerResponse {
    let purpose = |p: Purpose| match p {
        Purpose::Order => PaymentPurpose::Order,
        Purpose::Deposit => PaymentPurpose::Deposit,
        Purpose::Balance => PaymentPurpose::Balance,
    };
    LedgerResponse {
        entries: ledger
            .entries()
            .iter()
            .map(|e| WireEntry {
                at: e.at.to_string(),
                kind: match e.kind {
                    LedgerKind::Payment => WireKind::Payment,
                    LedgerKind::Refund => WireKind::Refund,
                },
                purpose: purpose(e.purpose),
                reference: e.reference.to_string(),
                amount_cents: e.amount.0,
                stripe_id: e.stripe_id.clone(),
            })
            .collect(),
        net_cents: ledger.net_total().0,
        paid_cents: ledger.paid_total().0,
        refunded_cents: ledger.refunded_total().0,
    }
}

/// The seed's history as daily totals, by the business date each order was placed on.
pub fn daily_totals(history: &[bakery_seed::OrderClosed]) -> Vec<DayTotal> {
    let mut days: std::collections::BTreeMap<String, (u32, i64)> =
        std::collections::BTreeMap::new();
    for o in history {
        let day = o.placed_at.to_string()[..10].to_owned();
        let e = days.entry(day).or_insert((0, 0));
        e.0 += 1;
        e.1 += o.total_cents.0;
    }
    days.into_iter()
        .map(|(day, (orders, cents))| DayTotal {
            day,
            orders,
            cents: Cents(cents),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakery_domain::BusinessTime;
    use bakery_domain::billing::Ledger;

    #[test]
    fn an_expiry_names_its_order_by_the_stream() {
        let s = Ulid::from_parts(1, 1);
        let o = Ulid::from_parts(1, 2);
        assert_eq!(order_of(&format!("order:{s}:{o}"), s), Some(o));
        assert_eq!(order_of(&format!("order:{o}:{s}"), s), None);
        assert_eq!(order_of(&format!("kitchen:{s}"), s), None);
    }

    #[test]
    fn the_history_sums_by_day() {
        let g = bakery_seed::Generator::new(
            bakery_seed::Seed(42),
            bakery_seed::BirthDate::parse("2026-11-07").unwrap(),
        )
        .generate();
        let days = daily_totals(&g.history);
        assert!(!days.is_empty());
        assert_eq!(
            days.iter().map(|d| u64::from(d.orders)).sum::<u64>(),
            g.history.len() as u64
        );
        assert_eq!(
            days.iter().map(|d| d.cents.0).sum::<i64>(),
            g.history.iter().map(|o| o.total_cents.0).sum::<i64>()
        );
        assert!(days.windows(2).all(|w| w[0].day < w[1].day));
    }

    #[test]
    fn an_empty_ledger_answers_zeroes() {
        let r = ledger_response(&Ledger::default());
        assert!(r.entries.is_empty());
        assert_eq!((r.net_cents, r.paid_cents, r.refunded_cents), (0, 0, 0));
    }

    #[test]
    fn the_quiet_events_are_billing_events() {
        for name in QUIET {
            assert!(BillingEvent::NAMES.contains(name), "{name}");
        }
    }

    #[test]
    fn a_time_parses_as_business_time() {
        let t: BusinessTime = "2026-11-07T09:00:00-07:00".parse().unwrap();
        assert_eq!(&t.to_string()[..10], "2026-11-07");
    }
}
