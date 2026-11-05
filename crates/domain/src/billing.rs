//! The Billing aggregate, hosted by `Billing`, one object per sandbox (`billing:<sandbox>`). It
//! owns the ledger: the payments it asked Stripe for, the Stripe event ids it has seen and the
//! refunds it has requested and recorded (docs/domain.md, "The event catalog", the Billing rows;
//! ADR 0007, decisions 3, 5 and 7).
//!
//! Stripe is reached through the `PaymentGateway` port in `bakery-app`; nothing here knows its
//! wire format. The object decides, commits the events, then calls the gateway, and the
//! gateway's answer (or Stripe's webhook) comes back as a command:
//!
//! - **Paying.** `CreateIntent` records the payment and emits `PaymentIntentCreated`; the object
//!   creates the intent at Stripe with the key `<ref>:<purpose>:<attempt>`, then `RecordIntent`
//!   stores Stripe's id. The client secret goes to the browser and never into an event.
//! - **Webhooks.** `ApplyEvent` turns a verified Stripe event into `PaymentSucceeded`,
//!   `PaymentFailed`, `PaymentCanceled` or `RefundIssued`. An event id seen before is a replay:
//!   no events and no error, so the webhook still answers 200. Amounts come from Billing's own
//!   records; an event whose amount disagrees is refused, never believed.
//! - **Refunds.** `RequestRefund` checks the amount against what is left and records the request
//!   (`RefundRequested`) under the command's id, which becomes the refund's id; Stripe's answer
//!   arrives as `RecordRefund`, or first as the `refund.created` webhook, and either emits
//!   `RefundIssued` once, keyed by Stripe's refund id.
//! - **Expiry.** `CancelForExpiry` cancels the order's open payments (`PaymentCanceled` with no
//!   Stripe event); the object then cancels each intent at Stripe, best effort. A payment that
//!   succeeds at Stripe anyway is still recorded: the money moved, and the Order refunds it as a
//!   late payment.
//!
//! Two events go beyond the catalog's Billing rows, because the state is the fold of the log and
//! these two facts change it: `PaymentIntentRecorded` (Stripe's id for the intent) and
//! `RefundRequested` (a refund asked for and not yet issued). Neither has a subscriber.
//! Beyond the catalog's data, `PaymentSucceeded` carries `intent`, the four outcome events carry
//! `purpose` and `ref` (so the consumer routes them without asking Billing) and the webhook-made
//! ones `stripe_event`, the id `webhooks_seen` keeps.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::aggregate::{Aggregate, DecideContext, DomainEvent};
use crate::order::RefundReason;
use crate::{BusinessTime, Cents, DomainError, Ulid};

/// What a payment is for (docs/domain.md, "The event catalog": `PaymentIntentCreated`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Purpose {
    /// A one-off order; `ref` is the order's id.
    Order,
    /// A catering deposit; `ref` is the catering job's id.
    Deposit,
    /// A catering balance; `ref` is the catering job's id.
    Balance,
}

impl Purpose {
    pub const ALL: [Purpose; 3] = [Purpose::Order, Purpose::Deposit, Purpose::Balance];

    /// The name on the wire, in Stripe's metadata and in idempotency keys.
    pub fn as_str(self) -> &'static str {
        match self {
            Purpose::Order => "order",
            Purpose::Deposit => "deposit",
            Purpose::Balance => "balance",
        }
    }

    pub fn parse(text: &str) -> Option<Purpose> {
        Purpose::ALL.into_iter().find(|p| p.as_str() == text)
    }
}

/// Where a payment stands, as Billing knows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaymentStatus {
    /// Asked for; the browser has not paid yet.
    Created,
    Succeeded,
    /// The last attempt was declined. Stripe keeps the intent open, so it can still succeed.
    Failed,
    Canceled,
}

impl PaymentStatus {
    /// Created or failed: an intent the visitor can still pay.
    pub fn is_open(self) -> bool {
        matches!(self, PaymentStatus::Created | PaymentStatus::Failed)
    }
}

/// One payment Billing asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaymentRecord {
    pub purpose: Purpose,
    pub reference: Ulid,
    /// What Billing computed and asked Stripe for. Every later amount is checked against it.
    pub amount: Cents,
    /// Stripe's `pi_...` id, once `RecordIntent` stored it.
    pub intent: Option<String>,
    pub status: PaymentStatus,
    /// The last decline code, while the payment is failed.
    pub failure: Option<String>,
    /// Refunds requested, issued or not; never more than `amount`.
    pub refund_requested: Cents,
    /// Refunds issued; never more than `refund_requested`.
    pub refunded: Cents,
    /// This payment's place among the payments for its purpose and reference, from 1: the
    /// `<attempt>` of its Stripe idempotency key.
    pub attempt: u32,
}

/// One refund, requested by the bakery or reported by Stripe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefundRecord {
    pub payment: Ulid,
    pub amount: Cents,
    /// `None` for a refund Stripe reported that the bakery never asked for.
    pub reason: Option<RefundReason>,
    /// This refund's place among the refunds for its payment's purpose and reference, from 1:
    /// the `<attempt>` of its Stripe idempotency key.
    pub ordinal: u32,
    /// Stripe's `re_...` id, once issued.
    pub stripe_refund: Option<String>,
}

impl RefundRecord {
    pub fn is_issued(&self) -> bool {
        self.stripe_refund.is_some()
    }
}

/// Billing's state: the fold of its events.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BillingState {
    payments: BTreeMap<Ulid, PaymentRecord>,
    /// Every Stripe event id that changed the state.
    webhooks_seen: BTreeSet<String>,
    refunds: BTreeMap<Ulid, RefundRecord>,
}

impl BillingState {
    pub fn payment(&self, id: Ulid) -> Option<&PaymentRecord> {
        self.payments.get(&id)
    }

    pub fn payments(&self) -> impl Iterator<Item = (Ulid, &PaymentRecord)> {
        self.payments.iter().map(|(id, p)| (*id, p))
    }

    pub fn refund(&self, id: Ulid) -> Option<&RefundRecord> {
        self.refunds.get(&id)
    }

    pub fn refunds(&self) -> impl Iterator<Item = (Ulid, &RefundRecord)> {
        self.refunds.iter().map(|(id, r)| (*id, r))
    }

    /// Whether a Stripe event id was applied before.
    pub fn has_seen(&self, stripe_event: &str) -> bool {
        self.webhooks_seen.contains(stripe_event)
    }

    /// The payment Stripe's intent id belongs to.
    pub fn payment_for_intent(&self, intent: &str) -> Option<(Ulid, &PaymentRecord)> {
        self.payments()
            .find(|(_, p)| p.intent.as_deref() == Some(intent))
    }

    /// The open payment (created or failed) for a purpose and reference, if there is one: what
    /// a second "pay" for the same order should reuse.
    pub fn open_payment(
        &self,
        purpose: Purpose,
        reference: Ulid,
    ) -> Option<(Ulid, &PaymentRecord)> {
        self.payments()
            .find(|(_, p)| p.purpose == purpose && p.reference == reference && p.status.is_open())
    }

    /// The refund Stripe's refund id was recorded under.
    pub fn refund_for_stripe(&self, stripe_refund: &str) -> Option<(Ulid, &RefundRecord)> {
        self.refunds()
            .find(|(_, r)| r.stripe_refund.as_deref() == Some(stripe_refund))
    }
}

/// A verified Stripe event, reduced to what Billing reads. `bakery-app`'s Stripe module builds
/// these from `payment_intent.succeeded`, `payment_intent.payment_failed`,
/// `payment_intent.canceled` and `refund.created` or `refund.updated`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WebhookKind {
    Succeeded {
        intent: String,
        amount: Cents,
    },
    Failed {
        intent: String,
        code: String,
    },
    Canceled {
        intent: String,
    },
    Refunded {
        intent: String,
        /// Stripe's `re_...` id.
        refund: String,
        amount: Cents,
        /// The refund's id in Billing, from the refund's `metadata[refund]`; `None` for a refund
        /// made outside the bakery, such as in Stripe's dashboard.
        request: Option<Ulid>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BillingCommand {
    /// Records a payment Billing will ask Stripe for. `payment` is a fresh id from the router.
    CreateIntent {
        payment: Ulid,
        purpose: Purpose,
        reference: Ulid,
        amount: Cents,
    },
    /// The gateway's answer to creating the intent. The client secret itself is never passed:
    /// only whether Stripe returned one.
    RecordIntent {
        payment: Ulid,
        stripe_id: String,
        client_secret_seen: bool,
    },
    /// A verified Stripe event.
    ApplyEvent { event_id: String, kind: WebhookKind },
    /// From `OrderRefundRequested` (or a catering refund). `None` refunds all that is left. The
    /// refund's id is the command's id.
    RequestRefund {
        payment: Ulid,
        amount: Option<Cents>,
        reason: RefundReason,
    },
    /// The gateway's answer to a refund request.
    RecordRefund {
        payment: Ulid,
        refund: Ulid,
        stripe_refund: String,
        amount: Cents,
    },
    /// From `OrderExpired`: the order's open payments are canceled.
    CancelForExpiry { reference: Ulid },
}

/// Billing's events. The catalog's rows, plus the two this module adds (see the module doc).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum BillingEvent {
    PaymentIntentCreated {
        payment: Ulid,
        purpose: Purpose,
        #[serde(rename = "ref")]
        reference: Ulid,
        amount_cents: Cents,
    },
    /// Stripe's id for the intent. Not in the catalog; no subscriber.
    PaymentIntentRecorded { payment: Ulid, intent: String },
    PaymentSucceeded {
        payment: Ulid,
        purpose: Purpose,
        #[serde(rename = "ref")]
        reference: Ulid,
        amount_cents: Cents,
        stripe_event: String,
        intent: String,
    },
    PaymentFailed {
        payment: Ulid,
        purpose: Purpose,
        #[serde(rename = "ref")]
        reference: Ulid,
        code: String,
        stripe_event: String,
    },
    PaymentCanceled {
        payment: Ulid,
        purpose: Purpose,
        #[serde(rename = "ref")]
        reference: Ulid,
        /// `None` when the bakery canceled it on expiry.
        #[serde(default)]
        stripe_event: Option<String>,
    },
    /// A refund asked for and not yet issued. Not in the catalog; no subscriber.
    RefundRequested {
        refund: Ulid,
        payment: Ulid,
        purpose: Purpose,
        #[serde(rename = "ref")]
        reference: Ulid,
        amount_cents: Cents,
        reason: RefundReason,
    },
    RefundIssued {
        refund: Ulid,
        payment: Ulid,
        purpose: Purpose,
        #[serde(rename = "ref")]
        reference: Ulid,
        amount_cents: Cents,
        stripe_refund: String,
        /// `None` when the gateway's answer recorded it before Stripe's webhook did.
        #[serde(default)]
        stripe_event: Option<String>,
    },
}

impl DomainEvent for BillingEvent {
    const NAMES: &'static [&'static str] = &[
        "PaymentIntentCreated",
        "PaymentIntentRecorded",
        "PaymentSucceeded",
        "PaymentFailed",
        "PaymentCanceled",
        "RefundRequested",
        "RefundIssued",
    ];

    fn name(&self) -> &'static str {
        match self {
            BillingEvent::PaymentIntentCreated { .. } => "PaymentIntentCreated",
            BillingEvent::PaymentIntentRecorded { .. } => "PaymentIntentRecorded",
            BillingEvent::PaymentSucceeded { .. } => "PaymentSucceeded",
            BillingEvent::PaymentFailed { .. } => "PaymentFailed",
            BillingEvent::PaymentCanceled { .. } => "PaymentCanceled",
            BillingEvent::RefundRequested { .. } => "RefundRequested",
            BillingEvent::RefundIssued { .. } => "RefundIssued",
        }
    }
}

impl BillingEvent {
    /// The Stripe event id this event records in `webhooks_seen`, if a webhook made it.
    pub fn stripe_event(&self) -> Option<&str> {
        match self {
            BillingEvent::PaymentSucceeded { stripe_event, .. }
            | BillingEvent::PaymentFailed { stripe_event, .. } => Some(stripe_event),
            BillingEvent::PaymentCanceled { stripe_event, .. }
            | BillingEvent::RefundIssued { stripe_event, .. } => stripe_event.as_deref(),
            _ => None,
        }
    }
}

/// The rule a Billing command broke. [`BillingError::rule`] names it for a log line or a
/// problem document.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum BillingError {
    #[error("a payment is positive cents")]
    AmountNotPositive,
    #[error("the payment id was used for another payment")]
    PaymentExists,
    #[error("payment {payment} is still open for this reference")]
    PaymentOpen { payment: Ulid },
    #[error("this reference is already paid by payment {payment}")]
    AlreadyPaid { payment: Ulid },
    #[error("no such payment")]
    UnknownPayment,
    #[error("the gateway returned no client secret")]
    NoClientSecret,
    #[error("not a payment intent id")]
    BadIntentId,
    #[error("the payment already has another intent")]
    IntentMismatch,
    #[error("no payment has that intent")]
    UnknownIntent,
    #[error("the event's amount differs from the payment's {expected:?}")]
    AmountMismatch { expected: Cents },
    #[error("the payment has not succeeded")]
    NotPaid,
    #[error("a refund is positive cents")]
    RefundNotPositive,
    #[error("at most {available:?} cents can still be refunded")]
    RefundExceedsPaid { available: Cents },
    #[error("no such refund request")]
    UnknownRefund,
    #[error("the refund disagrees with its request")]
    RefundMismatch,
    #[error("amount out of range")]
    Overflow,
}

impl BillingError {
    pub fn rule(&self) -> &'static str {
        match self {
            BillingError::AmountNotPositive => "amount-not-positive",
            BillingError::PaymentExists => "payment-exists",
            BillingError::PaymentOpen { .. } => "payment-open",
            BillingError::AlreadyPaid { .. } => "already-paid",
            BillingError::UnknownPayment => "unknown-payment",
            BillingError::NoClientSecret => "no-client-secret",
            BillingError::BadIntentId => "intent-id",
            BillingError::IntentMismatch => "intent-mismatch",
            BillingError::UnknownIntent => "unknown-intent",
            BillingError::AmountMismatch { .. } => "amount-mismatch",
            BillingError::NotPaid => "not-paid",
            BillingError::RefundNotPositive => "refund-not-positive",
            BillingError::RefundExceedsPaid { .. } => "refund-exceeds-paid",
            BillingError::UnknownRefund => "unknown-refund",
            BillingError::RefundMismatch => "refund-mismatch",
            BillingError::Overflow => "overflow",
        }
    }
}

impl From<DomainError> for BillingError {
    fn from(_: DomainError) -> BillingError {
        BillingError::Overflow
    }
}

/// What a webhook did. Only `Applied` has events; the other two answer 200 all the same.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebhookOutcome {
    Applied(Vec<BillingEvent>),
    /// The event id was applied before.
    Replayed,
    /// A new event id whose effect already holds: a second report of a refund, a decline for a
    /// payment that has since succeeded.
    NoEffect,
}

/// The aggregate hosted by `Billing`.
pub struct Billing;

impl Billing {
    /// `ApplyEvent`, with the replay told apart from the no-op. `ctx.id` names a refund Stripe
    /// reports that the bakery never requested.
    pub fn apply_webhook(
        state: &BillingState,
        event_id: &str,
        kind: &WebhookKind,
        ctx: &DecideContext,
    ) -> Result<WebhookOutcome, BillingError> {
        if state.has_seen(event_id) {
            return Ok(WebhookOutcome::Replayed);
        }
        let intent = match kind {
            WebhookKind::Succeeded { intent, .. }
            | WebhookKind::Failed { intent, .. }
            | WebhookKind::Canceled { intent }
            | WebhookKind::Refunded { intent, .. } => intent,
        };
        let (payment, p) = state
            .payment_for_intent(intent)
            .ok_or(BillingError::UnknownIntent)?;
        let stripe_event = event_id.to_owned();
        let applied = |e: BillingEvent| Ok(WebhookOutcome::Applied(vec![e]));
        use PaymentStatus as S;
        match kind {
            WebhookKind::Succeeded { amount, .. } => {
                if *amount != p.amount {
                    return Err(BillingError::AmountMismatch { expected: p.amount });
                }
                match p.status {
                    S::Succeeded => Ok(WebhookOutcome::NoEffect),
                    // A canceled payment that succeeded anyway lost a race with the expiry: the
                    // money moved, so it is recorded and the Order refunds it as late.
                    S::Created | S::Failed | S::Canceled => {
                        applied(BillingEvent::PaymentSucceeded {
                            payment,
                            purpose: p.purpose,
                            reference: p.reference,
                            amount_cents: p.amount,
                            stripe_event,
                            intent: intent.clone(),
                        })
                    }
                }
            }
            WebhookKind::Failed { code, .. } => match p.status {
                S::Created | S::Failed => applied(BillingEvent::PaymentFailed {
                    payment,
                    purpose: p.purpose,
                    reference: p.reference,
                    code: code.clone(),
                    stripe_event,
                }),
                S::Succeeded | S::Canceled => Ok(WebhookOutcome::NoEffect),
            },
            WebhookKind::Canceled { .. } => match p.status {
                S::Created | S::Failed => applied(BillingEvent::PaymentCanceled {
                    payment,
                    purpose: p.purpose,
                    reference: p.reference,
                    stripe_event: Some(stripe_event),
                }),
                S::Succeeded | S::Canceled => Ok(WebhookOutcome::NoEffect),
            },
            WebhookKind::Refunded {
                refund,
                amount,
                request,
                ..
            } => {
                if state.refund_for_stripe(refund).is_some() {
                    return Ok(WebhookOutcome::NoEffect);
                }
                if p.status != S::Succeeded {
                    // Stripe does not promise order: the success may still be on its way, and a
                    // refusal makes Stripe deliver this again later.
                    return Err(BillingError::NotPaid);
                }
                if *amount <= Cents::ZERO {
                    return Err(BillingError::RefundNotPositive);
                }
                let requested = request.and_then(|id| state.refund(id).map(|r| (id, r)));
                let id = match requested {
                    Some((id, r)) => {
                        if r.payment != payment || r.amount != *amount || r.is_issued() {
                            return Err(BillingError::RefundMismatch);
                        }
                        id
                    }
                    None => {
                        let available = p.amount.checked_sub(p.refund_requested)?;
                        if *amount > available {
                            return Err(BillingError::RefundExceedsPaid { available });
                        }
                        if state.refund(ctx.id).is_some() {
                            // The command id must be fresh to name a refund.
                            return Err(BillingError::RefundMismatch);
                        }
                        ctx.id
                    }
                };
                applied(BillingEvent::RefundIssued {
                    refund: id,
                    payment,
                    purpose: p.purpose,
                    reference: p.reference,
                    amount_cents: *amount,
                    stripe_refund: refund.clone(),
                    stripe_event: Some(stripe_event),
                })
            }
        }
    }
}

/// Whether a text is shaped like a Stripe object id with the given prefix: the prefix, then
/// one or more ASCII letters, digits or underscores. Ids go into URL paths, so nothing else
/// passes.
pub fn is_stripe_id(text: &str, prefix: &str) -> bool {
    text.strip_prefix(prefix).is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= 255
            && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    })
}

impl Aggregate for Billing {
    type State = BillingState;
    type Command = BillingCommand;
    type Event = BillingEvent;
    type Error = BillingError;

    fn decide(
        state: &BillingState,
        cmd: &BillingCommand,
        ctx: &DecideContext,
    ) -> Result<Vec<BillingEvent>, BillingError> {
        match cmd {
            BillingCommand::CreateIntent {
                payment,
                purpose,
                reference,
                amount,
            } => {
                if *amount <= Cents::ZERO {
                    return Err(BillingError::AmountNotPositive);
                }
                if let Some(p) = state.payment(*payment) {
                    let same =
                        p.purpose == *purpose && p.reference == *reference && p.amount == *amount;
                    return if same {
                        Ok(Vec::new())
                    } else {
                        Err(BillingError::PaymentExists)
                    };
                }
                for (id, p) in state.payments() {
                    if p.purpose != *purpose || p.reference != *reference {
                        continue;
                    }
                    if p.status == PaymentStatus::Succeeded {
                        return Err(BillingError::AlreadyPaid { payment: id });
                    }
                    if p.status.is_open() {
                        return Err(BillingError::PaymentOpen { payment: id });
                    }
                }
                Ok(vec![BillingEvent::PaymentIntentCreated {
                    payment: *payment,
                    purpose: *purpose,
                    reference: *reference,
                    amount_cents: *amount,
                }])
            }
            BillingCommand::RecordIntent {
                payment,
                stripe_id,
                client_secret_seen,
            } => {
                let p = state
                    .payment(*payment)
                    .ok_or(BillingError::UnknownPayment)?;
                if !is_stripe_id(stripe_id, "pi_") {
                    return Err(BillingError::BadIntentId);
                }
                match &p.intent {
                    Some(known) if known == stripe_id => return Ok(Vec::new()),
                    Some(_) => return Err(BillingError::IntentMismatch),
                    None => {}
                }
                if !client_secret_seen {
                    return Err(BillingError::NoClientSecret);
                }
                if state.payment_for_intent(stripe_id).is_some() {
                    return Err(BillingError::IntentMismatch);
                }
                Ok(vec![BillingEvent::PaymentIntentRecorded {
                    payment: *payment,
                    intent: stripe_id.clone(),
                }])
            }
            BillingCommand::ApplyEvent { event_id, kind } => {
                match Billing::apply_webhook(state, event_id, kind, ctx)? {
                    WebhookOutcome::Applied(events) => Ok(events),
                    WebhookOutcome::Replayed | WebhookOutcome::NoEffect => Ok(Vec::new()),
                }
            }
            BillingCommand::RequestRefund {
                payment,
                amount,
                reason,
            } => {
                if state.refund(ctx.id).is_some() {
                    // The same command again.
                    return Ok(Vec::new());
                }
                let p = state
                    .payment(*payment)
                    .ok_or(BillingError::UnknownPayment)?;
                if p.status != PaymentStatus::Succeeded {
                    return Err(BillingError::NotPaid);
                }
                let available = p.amount.checked_sub(p.refund_requested)?;
                let amount = match amount {
                    Some(a) if *a <= Cents::ZERO => return Err(BillingError::RefundNotPositive),
                    Some(a) => *a,
                    None => available,
                };
                if amount > available || amount <= Cents::ZERO {
                    return Err(BillingError::RefundExceedsPaid { available });
                }
                Ok(vec![BillingEvent::RefundRequested {
                    refund: ctx.id,
                    payment: *payment,
                    purpose: p.purpose,
                    reference: p.reference,
                    amount_cents: amount,
                    reason: *reason,
                }])
            }
            BillingCommand::RecordRefund {
                payment,
                refund,
                stripe_refund,
                amount,
            } => {
                if state.refund_for_stripe(stripe_refund).is_some() {
                    return Ok(Vec::new());
                }
                let r = state.refund(*refund).ok_or(BillingError::UnknownRefund)?;
                if r.payment != *payment {
                    return Err(BillingError::UnknownRefund);
                }
                if r.is_issued() || r.amount != *amount || !is_stripe_id(stripe_refund, "re_") {
                    return Err(BillingError::RefundMismatch);
                }
                let p = state
                    .payment(*payment)
                    .ok_or(BillingError::UnknownPayment)?;
                Ok(vec![BillingEvent::RefundIssued {
                    refund: *refund,
                    payment: *payment,
                    purpose: p.purpose,
                    reference: p.reference,
                    amount_cents: *amount,
                    stripe_refund: stripe_refund.clone(),
                    stripe_event: None,
                }])
            }
            BillingCommand::CancelForExpiry { reference } => Ok(state
                .payments()
                .filter(|(_, p)| {
                    p.purpose == Purpose::Order && p.reference == *reference && p.status.is_open()
                })
                .map(|(payment, p)| BillingEvent::PaymentCanceled {
                    payment,
                    purpose: p.purpose,
                    reference: p.reference,
                    stripe_event: None,
                })
                .collect()),
        }
    }

    fn evolve(mut state: BillingState, event: &BillingEvent) -> BillingState {
        if let Some(id) = event.stripe_event() {
            state.webhooks_seen.insert(id.to_owned());
        }
        match event {
            BillingEvent::PaymentIntentCreated {
                payment,
                purpose,
                reference,
                amount_cents,
            } => {
                if state.payments.contains_key(payment) {
                    return state;
                }
                let earlier = state
                    .payments
                    .values()
                    .filter(|p| p.purpose == *purpose && p.reference == *reference)
                    .count();
                state.payments.insert(
                    *payment,
                    PaymentRecord {
                        purpose: *purpose,
                        reference: *reference,
                        amount: *amount_cents,
                        intent: None,
                        status: PaymentStatus::Created,
                        failure: None,
                        refund_requested: Cents::ZERO,
                        refunded: Cents::ZERO,
                        attempt: u32::try_from(earlier + 1).unwrap_or(u32::MAX),
                    },
                );
            }
            BillingEvent::PaymentIntentRecorded { payment, intent } => {
                if let Some(p) = state.payments.get_mut(payment) {
                    p.intent = Some(intent.clone());
                }
            }
            BillingEvent::PaymentSucceeded { payment, .. } => {
                if let Some(p) = state.payments.get_mut(payment) {
                    p.status = PaymentStatus::Succeeded;
                    p.failure = None;
                }
            }
            BillingEvent::PaymentFailed { payment, code, .. } => {
                if let Some(p) = state.payments.get_mut(payment) {
                    p.status = PaymentStatus::Failed;
                    p.failure = Some(code.clone());
                }
            }
            BillingEvent::PaymentCanceled { payment, .. } => {
                if let Some(p) = state.payments.get_mut(payment) {
                    p.status = PaymentStatus::Canceled;
                }
            }
            BillingEvent::RefundRequested {
                refund,
                payment,
                amount_cents,
                reason,
                ..
            } => {
                if state.refunds.contains_key(refund) {
                    return state;
                }
                let ordinal = next_refund_ordinal(&state, *payment);
                if let Some(p) = state.payments.get_mut(payment) {
                    p.refund_requested = p
                        .refund_requested
                        .checked_add(*amount_cents)
                        .unwrap_or(p.refund_requested);
                }
                state.refunds.insert(
                    *refund,
                    RefundRecord {
                        payment: *payment,
                        amount: *amount_cents,
                        reason: Some(*reason),
                        ordinal,
                        stripe_refund: None,
                    },
                );
            }
            BillingEvent::RefundIssued {
                refund,
                payment,
                amount_cents,
                stripe_refund,
                ..
            } => {
                let requested = state.refunds.contains_key(refund);
                if !requested {
                    // Stripe reported a refund the bakery never asked for: it counts as asked.
                    let ordinal = next_refund_ordinal(&state, *payment);
                    state.refunds.insert(
                        *refund,
                        RefundRecord {
                            payment: *payment,
                            amount: *amount_cents,
                            reason: None,
                            ordinal,
                            stripe_refund: None,
                        },
                    );
                }
                if let Some(r) = state.refunds.get_mut(refund) {
                    r.stripe_refund = Some(stripe_refund.clone());
                }
                if let Some(p) = state.payments.get_mut(payment) {
                    if !requested {
                        p.refund_requested = p
                            .refund_requested
                            .checked_add(*amount_cents)
                            .unwrap_or(p.refund_requested);
                    }
                    p.refunded = p.refunded.checked_add(*amount_cents).unwrap_or(p.refunded);
                }
            }
        }
        state
    }
}

/// One more than the refunds already recorded for the payment's purpose and reference.
fn next_refund_ordinal(state: &BillingState, payment: Ulid) -> u32 {
    let Some(p) = state.payments.get(&payment) else {
        return 1;
    };
    let earlier = state
        .refunds
        .values()
        .filter(|r| {
            state
                .payments
                .get(&r.payment)
                .is_some_and(|q| q.purpose == p.purpose && q.reference == p.reference)
        })
        .count();
    u32::try_from(earlier + 1).unwrap_or(u32::MAX)
}

/// A ledger line's kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LedgerKind {
    Payment,
    Refund,
}

/// One line of the ledger: money in on a payment's success, money out on each refund issued.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerEntry {
    /// The business time of the event that made it.
    pub at: BusinessTime,
    pub kind: LedgerKind,
    pub purpose: Purpose,
    pub reference: Ulid,
    pub payment: Ulid,
    /// Signed: positive for a payment, negative for a refund.
    pub amount: Cents,
    /// Stripe's id: the intent for a payment, the refund for a refund.
    pub stripe_id: String,
}

/// The ledger view: a fold of `PaymentSucceeded` and `RefundIssued`, in log order. Every other
/// event leaves it as it was.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ledger {
    entries: Vec<LedgerEntry>,
}

impl Ledger {
    /// The ledger of a log of `(business time, event)` pairs, the envelopes' `at` and events.
    pub fn from_events<'a>(
        events: impl IntoIterator<Item = (BusinessTime, &'a BillingEvent)>,
    ) -> Ledger {
        let mut ledger = Ledger::default();
        for (at, event) in events {
            ledger.apply(at, event);
        }
        ledger
    }

    /// Folds one event in.
    pub fn apply(&mut self, at: BusinessTime, event: &BillingEvent) {
        match event {
            BillingEvent::PaymentSucceeded {
                payment,
                purpose,
                reference,
                amount_cents,
                intent,
                ..
            } => self.entries.push(LedgerEntry {
                at,
                kind: LedgerKind::Payment,
                purpose: *purpose,
                reference: *reference,
                payment: *payment,
                amount: *amount_cents,
                stripe_id: intent.clone(),
            }),
            BillingEvent::RefundIssued {
                payment,
                purpose,
                reference,
                amount_cents,
                stripe_refund,
                ..
            } => self.entries.push(LedgerEntry {
                at,
                kind: LedgerKind::Refund,
                purpose: *purpose,
                reference: *reference,
                payment: *payment,
                amount: Cents(-amount_cents.0),
                stripe_id: stripe_refund.clone(),
            }),
            _ => {}
        }
    }

    pub fn entries(&self) -> &[LedgerEntry] {
        &self.entries
    }

    fn sum(&self, keep: impl Fn(&LedgerEntry) -> bool) -> Cents {
        Cents(
            self.entries
                .iter()
                .filter(|e| keep(e))
                .map(|e| e.amount.0)
                .sum(),
        )
    }

    /// Paid minus refunded for one order or catering job.
    pub fn net(&self, reference: Ulid) -> Cents {
        self.sum(|e| e.reference == reference)
    }

    /// Money in for one reference.
    pub fn paid(&self, reference: Ulid) -> Cents {
        self.sum(|e| e.reference == reference && e.kind == LedgerKind::Payment)
    }

    /// Money out for one reference, as a positive amount.
    pub fn refunded(&self, reference: Ulid) -> Cents {
        Cents(
            -self
                .sum(|e| e.reference == reference && e.kind == LedgerKind::Refund)
                .0,
        )
    }

    /// Every entry's amount summed: the sandbox's takings after refunds.
    pub fn net_total(&self) -> Cents {
        self.sum(|_| true)
    }

    pub fn paid_total(&self) -> Cents {
        self.sum(|e| e.kind == LedgerKind::Payment)
    }

    /// As a positive amount.
    pub fn refunded_total(&self) -> Cents {
        Cents(-self.sum(|e| e.kind == LedgerKind::Refund).0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aggregate::{execute, replay};
    use proptest::prelude::*;

    fn id(n: u128) -> Ulid {
        Ulid::from_parts(1_793_000_000_000, n)
    }

    fn at(text: &str) -> BusinessTime {
        text.parse().unwrap()
    }

    const NOW: &str = "2026-11-07T09:00:00-07:00";

    fn ctx(n: u128) -> DecideContext {
        DecideContext {
            now: at(NOW),
            id: id(n),
        }
    }

    const ORDER: u128 = 1;
    const PAYMENT: u128 = 10;
    const INTENT: &str = "pi_fake000000000000000001";

    fn run(state: BillingState, cmd: BillingCommand, n: u128) -> (BillingState, Vec<BillingEvent>) {
        execute::<Billing>(state, &cmd, &ctx(n)).unwrap()
    }

    fn webhook(event: &str, kind: WebhookKind) -> BillingCommand {
        BillingCommand::ApplyEvent {
            event_id: event.to_owned(),
            kind,
        }
    }

    /// A payment of $20.90 for order 1, with its intent recorded, and the log that made it.
    fn created() -> (BillingState, Vec<BillingEvent>) {
        let (s, mut log) = run(
            BillingState::default(),
            BillingCommand::CreateIntent {
                payment: id(PAYMENT),
                purpose: Purpose::Order,
                reference: id(ORDER),
                amount: Cents(2_090),
            },
            90,
        );
        let (s, more) = run(
            s,
            BillingCommand::RecordIntent {
                payment: id(PAYMENT),
                stripe_id: INTENT.into(),
                client_secret_seen: true,
            },
            91,
        );
        log.extend(more);
        (s, log)
    }

    fn paid() -> (BillingState, Vec<BillingEvent>) {
        let (s, mut log) = created();
        let (s, more) = run(
            s,
            webhook(
                "evt_fake_succeeded_1",
                WebhookKind::Succeeded {
                    intent: INTENT.into(),
                    amount: Cents(2_090),
                },
            ),
            92,
        );
        log.extend(more);
        (s, log)
    }

    fn ledger_of(log: &[BillingEvent]) -> Ledger {
        Ledger::from_events(log.iter().map(|e| (at(NOW), e)))
    }

    #[test]
    fn a_payment_is_created_recorded_and_succeeds() {
        let (state, log) = paid();
        let names: Vec<&str> = log.iter().map(DomainEvent::name).collect();
        assert_eq!(
            names,
            [
                "PaymentIntentCreated",
                "PaymentIntentRecorded",
                "PaymentSucceeded"
            ]
        );
        assert_eq!(
            log[2],
            BillingEvent::PaymentSucceeded {
                payment: id(PAYMENT),
                purpose: Purpose::Order,
                reference: id(ORDER),
                amount_cents: Cents(2_090),
                stripe_event: "evt_fake_succeeded_1".into(),
                intent: INTENT.into(),
            }
        );
        let p = state.payment(id(PAYMENT)).unwrap();
        assert_eq!(p.status, PaymentStatus::Succeeded);
        assert_eq!(p.attempt, 1);
        assert!(state.has_seen("evt_fake_succeeded_1"));
        assert_eq!(
            serde_json::to_value(&log[0]).unwrap()["data"],
            serde_json::json!({
                "payment": id(PAYMENT).to_string(),
                "purpose": "order",
                "ref": id(ORDER).to_string(),
                "amount_cents": 2090,
            })
        );
    }

    #[test]
    fn creating_refuses_a_second_open_payment_and_a_paid_reference() {
        let (state, _) = created();
        let again = |payment: u128, amount: i64| BillingCommand::CreateIntent {
            payment: id(payment),
            purpose: Purpose::Order,
            reference: id(ORDER),
            amount: Cents(amount),
        };
        // The same command again is a no-op; the same id for something else is refused.
        assert_eq!(
            Billing::decide(&state, &again(PAYMENT, 2_090), &ctx(1)),
            Ok(vec![])
        );
        assert_eq!(
            Billing::decide(&state, &again(PAYMENT, 2_091), &ctx(1)),
            Err(BillingError::PaymentExists)
        );
        assert_eq!(
            Billing::decide(&state, &again(11, 2_090), &ctx(1)),
            Err(BillingError::PaymentOpen {
                payment: id(PAYMENT)
            })
        );
        assert_eq!(
            Billing::decide(&state, &again(11, 0), &ctx(1)),
            Err(BillingError::AmountNotPositive)
        );
        let (paid, _) = paid();
        assert_eq!(
            Billing::decide(&paid, &again(11, 2_090), &ctx(1)),
            Err(BillingError::AlreadyPaid {
                payment: id(PAYMENT)
            })
        );
        // A deposit for the same reference is another purpose.
        let deposit = BillingCommand::CreateIntent {
            payment: id(11),
            purpose: Purpose::Deposit,
            reference: id(ORDER),
            amount: Cents(500),
        };
        assert_eq!(Billing::decide(&paid, &deposit, &ctx(1)).unwrap().len(), 1);
    }

    #[test]
    fn recording_an_intent_checks_the_gateway_answer() {
        let (state, _) = run(
            BillingState::default(),
            BillingCommand::CreateIntent {
                payment: id(PAYMENT),
                purpose: Purpose::Order,
                reference: id(ORDER),
                amount: Cents(2_090),
            },
            90,
        );
        let record = |stripe_id: &str, seen: bool| BillingCommand::RecordIntent {
            payment: id(PAYMENT),
            stripe_id: stripe_id.into(),
            client_secret_seen: seen,
        };
        assert_eq!(
            Billing::decide(&state, &record(INTENT, false), &ctx(1)),
            Err(BillingError::NoClientSecret)
        );
        for bad in ["re_fake1", "pi_", "pi_fake/../x", "pi_fake 1"] {
            assert_eq!(
                Billing::decide(&state, &record(bad, true), &ctx(1)),
                Err(BillingError::BadIntentId),
                "{bad}"
            );
        }
        let (state, _) = run(state, record(INTENT, true), 1);
        assert_eq!(
            Billing::decide(&state, &record(INTENT, true), &ctx(1)),
            Ok(vec![])
        );
        assert_eq!(
            Billing::decide(&state, &record("pi_fake_other", true), &ctx(1)),
            Err(BillingError::IntentMismatch)
        );
        assert_eq!(
            Billing::decide(
                &state,
                &BillingCommand::RecordIntent {
                    payment: id(11),
                    stripe_id: INTENT.into(),
                    client_secret_seen: true
                },
                &ctx(1)
            ),
            Err(BillingError::UnknownPayment)
        );
    }

    #[test]
    fn a_replayed_event_changes_nothing_and_is_told_apart() {
        let (state, _) = paid();
        let succeeded = WebhookKind::Succeeded {
            intent: INTENT.into(),
            amount: Cents(2_090),
        };
        assert_eq!(
            Billing::apply_webhook(&state, "evt_fake_succeeded_1", &succeeded, &ctx(1)),
            Ok(WebhookOutcome::Replayed)
        );
        // Another event id for the same success has no effect either.
        assert_eq!(
            Billing::apply_webhook(&state, "evt_fake_succeeded_2", &succeeded, &ctx(1)),
            Ok(WebhookOutcome::NoEffect)
        );
        for _ in 0..5 {
            let (again, events) = run(
                state.clone(),
                webhook("evt_fake_succeeded_1", succeeded.clone()),
                1,
            );
            assert!(events.is_empty());
            assert_eq!(again, state);
        }
    }

    #[test]
    fn webhooks_for_unknown_intents_or_wrong_amounts_are_refused() {
        let (state, _) = created();
        assert_eq!(
            Billing::decide(
                &state,
                &webhook(
                    "evt_fake_1",
                    WebhookKind::Succeeded {
                        intent: "pi_fake_unknown".into(),
                        amount: Cents(2_090)
                    }
                ),
                &ctx(1)
            ),
            Err(BillingError::UnknownIntent)
        );
        assert_eq!(
            Billing::decide(
                &state,
                &webhook(
                    "evt_fake_1",
                    WebhookKind::Succeeded {
                        intent: INTENT.into(),
                        amount: Cents(1)
                    }
                ),
                &ctx(1)
            ),
            Err(BillingError::AmountMismatch {
                expected: Cents(2_090)
            })
        );
        // A refused event is not seen, so Stripe's retry is decided afresh.
        assert!(!state.has_seen("evt_fake_1"));
    }

    #[test]
    fn a_decline_keeps_the_payment_open_until_it_succeeds() {
        let (state, _) = created();
        let (state, events) = run(
            state,
            webhook(
                "evt_fake_failed_1",
                WebhookKind::Failed {
                    intent: INTENT.into(),
                    code: "card_declined".into(),
                },
            ),
            1,
        );
        assert_eq!(
            events,
            [BillingEvent::PaymentFailed {
                payment: id(PAYMENT),
                purpose: Purpose::Order,
                reference: id(ORDER),
                code: "card_declined".into(),
                stripe_event: "evt_fake_failed_1".into(),
            }]
        );
        let p = state.payment(id(PAYMENT)).unwrap();
        assert_eq!(p.status, PaymentStatus::Failed);
        assert_eq!(p.failure.as_deref(), Some("card_declined"));
        assert_eq!(
            state
                .open_payment(Purpose::Order, id(ORDER))
                .map(|(i, _)| i),
            Some(id(PAYMENT))
        );
        let (state, events) = run(
            state,
            webhook(
                "evt_fake_succeeded_1",
                WebhookKind::Succeeded {
                    intent: INTENT.into(),
                    amount: Cents(2_090),
                },
            ),
            2,
        );
        assert_eq!(events.len(), 1);
        assert_eq!(
            state.payment(id(PAYMENT)).unwrap().status,
            PaymentStatus::Succeeded
        );
        // A late decline for a paid intent has no effect.
        assert_eq!(
            Billing::apply_webhook(
                &state,
                "evt_fake_failed_2",
                &WebhookKind::Failed {
                    intent: INTENT.into(),
                    code: "card_declined".into()
                },
                &ctx(3)
            ),
            Ok(WebhookOutcome::NoEffect)
        );
    }

    #[test]
    fn expiry_cancels_the_open_payment_and_a_late_success_still_counts() {
        let (state, _) = created();
        let (state, events) = run(
            state,
            BillingCommand::CancelForExpiry {
                reference: id(ORDER),
            },
            1,
        );
        assert_eq!(
            events,
            [BillingEvent::PaymentCanceled {
                payment: id(PAYMENT),
                purpose: Purpose::Order,
                reference: id(ORDER),
                stripe_event: None,
            }]
        );
        // Again: nothing open is left.
        assert_eq!(
            Billing::decide(
                &state,
                &BillingCommand::CancelForExpiry {
                    reference: id(ORDER)
                },
                &ctx(2)
            ),
            Ok(vec![])
        );
        // Stripe's own cancel event has no effect now.
        assert_eq!(
            Billing::apply_webhook(
                &state,
                "evt_fake_canceled_1",
                &WebhookKind::Canceled {
                    intent: INTENT.into()
                },
                &ctx(3)
            ),
            Ok(WebhookOutcome::NoEffect)
        );
        // The visitor paid in the moment before the cancel reached Stripe.
        let (state, events) = run(
            state,
            webhook(
                "evt_fake_succeeded_1",
                WebhookKind::Succeeded {
                    intent: INTENT.into(),
                    amount: Cents(2_090),
                },
            ),
            4,
        );
        assert_eq!(events.len(), 1);
        assert_eq!(
            state.payment(id(PAYMENT)).unwrap().status,
            PaymentStatus::Succeeded
        );
        // A new payment for a canceled reference is its second attempt.
        let (state, _) = run(
            created().0,
            BillingCommand::CancelForExpiry {
                reference: id(ORDER),
            },
            5,
        );
        let (state, _) = run(
            state,
            BillingCommand::CreateIntent {
                payment: id(11),
                purpose: Purpose::Order,
                reference: id(ORDER),
                amount: Cents(2_090),
            },
            6,
        );
        assert_eq!(state.payment(id(11)).unwrap().attempt, 2);
    }

    #[test]
    fn a_partial_then_full_refund_nets_the_ledger_to_zero() {
        let (state, mut log) = paid();
        let (state, events) = run(
            state,
            BillingCommand::RequestRefund {
                payment: id(PAYMENT),
                amount: Some(Cents(500)),
                reason: RefundReason::MissingItem,
            },
            30,
        );
        assert_eq!(
            events,
            [BillingEvent::RefundRequested {
                refund: id(30),
                payment: id(PAYMENT),
                purpose: Purpose::Order,
                reference: id(ORDER),
                amount_cents: Cents(500),
                reason: RefundReason::MissingItem,
            }]
        );
        log.extend(events);
        assert_eq!(state.refund(id(30)).unwrap().ordinal, 1);
        // More than is left is refused, before Stripe is asked.
        assert_eq!(
            Billing::decide(
                &state,
                &BillingCommand::RequestRefund {
                    payment: id(PAYMENT),
                    amount: Some(Cents(1_591)),
                    reason: RefundReason::Goodwill
                },
                &ctx(31)
            ),
            Err(BillingError::RefundExceedsPaid {
                available: Cents(1_590)
            })
        );
        // The gateway's answer records the refund once.
        let record = BillingCommand::RecordRefund {
            payment: id(PAYMENT),
            refund: id(30),
            stripe_refund: "re_fake_1".into(),
            amount: Cents(500),
        };
        let (state, events) = run(state, record.clone(), 32);
        assert_eq!(events.len(), 1);
        log.extend(events);
        assert_eq!(Billing::decide(&state, &record, &ctx(33)), Ok(vec![]));
        // Stripe's webhook for the same refund then has no effect.
        assert_eq!(
            Billing::apply_webhook(
                &state,
                "evt_fake_refund_1",
                &WebhookKind::Refunded {
                    intent: INTENT.into(),
                    refund: "re_fake_1".into(),
                    amount: Cents(500),
                    request: Some(id(30)),
                },
                &ctx(34)
            ),
            Ok(WebhookOutcome::NoEffect)
        );
        // The rest, with no amount named; this time the webhook lands first.
        let (state, events) = run(
            state,
            BillingCommand::RequestRefund {
                payment: id(PAYMENT),
                amount: None,
                reason: RefundReason::Cancelled,
            },
            40,
        );
        log.extend(events);
        assert_eq!(state.refund(id(40)).unwrap().amount, Cents(1_590));
        assert_eq!(state.refund(id(40)).unwrap().ordinal, 2);
        let (state, events) = run(
            state,
            webhook(
                "evt_fake_refund_2",
                WebhookKind::Refunded {
                    intent: INTENT.into(),
                    refund: "re_fake_2".into(),
                    amount: Cents(1_590),
                    request: Some(id(40)),
                },
            ),
            41,
        );
        assert!(matches!(
            events.as_slice(),
            [BillingEvent::RefundIssued { refund, .. }] if *refund == id(40)
        ));
        log.extend(events);
        let (state, events) = run(
            state,
            BillingCommand::RecordRefund {
                payment: id(PAYMENT),
                refund: id(40),
                stripe_refund: "re_fake_2".into(),
                amount: Cents(1_590),
            },
            42,
        );
        assert!(events.is_empty());
        let p = state.payment(id(PAYMENT)).unwrap();
        assert_eq!(
            (p.refund_requested, p.refunded),
            (Cents(2_090), Cents(2_090))
        );
        assert_eq!(
            Billing::decide(
                &state,
                &BillingCommand::RequestRefund {
                    payment: id(PAYMENT),
                    amount: None,
                    reason: RefundReason::Goodwill
                },
                &ctx(43)
            ),
            Err(BillingError::RefundExceedsPaid {
                available: Cents::ZERO
            })
        );
        // A refunded order's ledger nets to zero.
        let ledger = ledger_of(&log);
        assert_eq!(ledger.paid(id(ORDER)), Cents(2_090));
        assert_eq!(ledger.refunded(id(ORDER)), Cents(2_090));
        assert_eq!(ledger.net(id(ORDER)), Cents::ZERO);
        assert_eq!(ledger.net_total(), Cents::ZERO);
        let ids: Vec<&str> = ledger
            .entries()
            .iter()
            .map(|e| e.stripe_id.as_str())
            .collect();
        assert_eq!(ids, [INTENT, "re_fake_1", "re_fake_2"]);
        assert_eq!(replay::<Billing>(&log), state);
    }

    #[test]
    fn refund_rules() {
        let (created, _) = created();
        let request = |amount: Option<i64>| BillingCommand::RequestRefund {
            payment: id(PAYMENT),
            amount: amount.map(Cents),
            reason: RefundReason::Goodwill,
        };
        assert_eq!(
            Billing::decide(&created, &request(None), &ctx(30)),
            Err(BillingError::NotPaid)
        );
        let (state, _) = paid();
        assert_eq!(
            Billing::decide(&state, &request(Some(0)), &ctx(30)),
            Err(BillingError::RefundNotPositive)
        );
        let (state, _) = run(state, request(Some(100)), 30);
        // The same command id again is a no-op, not a second refund.
        assert_eq!(
            Billing::decide(&state, &request(Some(100)), &ctx(30)),
            Ok(vec![])
        );
        let record = |refund: u128, stripe: &str, amount: i64| BillingCommand::RecordRefund {
            payment: id(PAYMENT),
            refund: id(refund),
            stripe_refund: stripe.into(),
            amount: Cents(amount),
        };
        assert_eq!(
            Billing::decide(&state, &record(31, "re_fake_1", 100), &ctx(1)),
            Err(BillingError::UnknownRefund)
        );
        assert_eq!(
            Billing::decide(&state, &record(30, "re_fake_1", 99), &ctx(1)),
            Err(BillingError::RefundMismatch)
        );
        assert_eq!(
            Billing::decide(&state, &record(30, "pi_fake_1", 100), &ctx(1)),
            Err(BillingError::RefundMismatch)
        );
        // A refund on an intent Billing has not seen succeed waits for Stripe's retry.
        assert_eq!(
            Billing::apply_webhook(
                &created,
                "evt_fake_refund_1",
                &WebhookKind::Refunded {
                    intent: INTENT.into(),
                    refund: "re_fake_1".into(),
                    amount: Cents(100),
                    request: None
                },
                &ctx(1)
            ),
            Err(BillingError::NotPaid)
        );
    }

    #[test]
    fn a_refund_made_outside_the_bakery_is_recorded_within_what_is_left() {
        let (state, _) = paid();
        let refunded = |amount: i64| WebhookKind::Refunded {
            intent: INTENT.into(),
            refund: "re_fake_dashboard".into(),
            amount: Cents(amount),
            request: None,
        };
        assert_eq!(
            Billing::apply_webhook(&state, "evt_fake_r", &refunded(2_091), &ctx(50)),
            Err(BillingError::RefundExceedsPaid {
                available: Cents(2_090)
            })
        );
        let (state, events) = run(state, webhook("evt_fake_r", refunded(700)), 50);
        assert!(matches!(
            events.as_slice(),
            [BillingEvent::RefundIssued { refund, stripe_event: Some(_), .. }] if *refund == id(50)
        ));
        let p = state.payment(id(PAYMENT)).unwrap();
        assert_eq!((p.refund_requested, p.refunded), (Cents(700), Cents(700)));
        assert_eq!(state.refund(id(50)).unwrap().reason, None);
    }

    #[test]
    fn every_event_round_trips_through_type_and_data() {
        let (state, mut log) = paid();
        let (_, more) = run(
            state,
            BillingCommand::RequestRefund {
                payment: id(PAYMENT),
                amount: None,
                reason: RefundReason::Quality,
            },
            30,
        );
        log.extend(more);
        log.push(BillingEvent::PaymentFailed {
            payment: id(PAYMENT),
            purpose: Purpose::Order,
            reference: id(ORDER),
            code: "card_declined".into(),
            stripe_event: "evt_fake_f".into(),
        });
        log.push(BillingEvent::PaymentCanceled {
            payment: id(PAYMENT),
            purpose: Purpose::Order,
            reference: id(ORDER),
            stripe_event: None,
        });
        log.push(BillingEvent::RefundIssued {
            refund: id(30),
            payment: id(PAYMENT),
            purpose: Purpose::Order,
            reference: id(ORDER),
            amount_cents: Cents(2_090),
            stripe_refund: "re_fake_1".into(),
            stripe_event: None,
        });
        let names: BTreeSet<&str> = log.iter().map(DomainEvent::name).collect();
        assert_eq!(names.len(), BillingEvent::NAMES.len());
        for e in &log {
            assert_eq!(
                &BillingEvent::from_parts(e.name(), &e.to_data()).unwrap(),
                e
            );
        }
    }

    #[test]
    fn purposes_and_ids_parse() {
        for p in Purpose::ALL {
            assert_eq!(Purpose::parse(p.as_str()), Some(p));
            assert_eq!(serde_json::to_value(p).unwrap(), p.as_str());
        }
        assert_eq!(Purpose::parse("Order"), None);
        assert!(is_stripe_id("pi_fake_123", "pi_"));
        assert!(!is_stripe_id("pi_fake-123", "pi_"));
        assert!(!is_stripe_id(&format!("pi_{}", "a".repeat(256)), "pi_"));
    }

    // The property tests drive random command sequences over two orders, three payment ids, two
    // intents and a handful of event ids, so replays, races and mismatches all come up.

    const INTENTS: [&str; 2] = ["pi_fake_a", "pi_fake_b"];

    fn command() -> impl Strategy<Value = (u128, BillingCommand)> {
        let payment = || prop::sample::select(vec![10u128, 11, 12]).prop_map(id);
        let reference = || prop::sample::select(vec![1u128, 2]).prop_map(id);
        let intent = || prop::sample::select(INTENTS.to_vec()).prop_map(str::to_owned);
        let event = || {
            prop::sample::select(vec!["evt_fake_1", "evt_fake_2", "evt_fake_3", "evt_fake_4"])
                .prop_map(str::to_owned)
        };
        let amount = || prop::sample::select(vec![-1i64, 0, 300, 700, 1_000]).prop_map(Cents);
        let stripe_refund = || {
            prop::sample::select(vec!["re_fake_1", "re_fake_2", "re_fake_3"])
                .prop_map(str::to_owned)
        };
        let refund = || prop::sample::select(vec![40u128, 41, 42]).prop_map(id);
        let kind = prop_oneof![
            (intent(), amount())
                .prop_map(|(intent, amount)| WebhookKind::Succeeded { intent, amount }),
            intent().prop_map(|intent| WebhookKind::Failed {
                intent,
                code: "card_declined".into()
            }),
            intent().prop_map(|intent| WebhookKind::Canceled { intent }),
            (
                intent(),
                stripe_refund(),
                amount(),
                proptest::option::of(refund())
            )
                .prop_map(|(intent, refund, amount, request)| WebhookKind::Refunded {
                    intent,
                    refund,
                    amount,
                    request
                }),
        ];
        let cmd = prop_oneof![
            2 => (payment(), reference(), amount()).prop_map(|(payment, reference, amount)| BillingCommand::CreateIntent {
                payment, purpose: Purpose::Order, reference, amount
            }),
            2 => (payment(), intent(), any::<bool>()).prop_map(|(payment, stripe_id, seen)| BillingCommand::RecordIntent {
                payment, stripe_id, client_secret_seen: seen
            }),
            4 => (event(), kind).prop_map(|(event_id, kind)| BillingCommand::ApplyEvent { event_id, kind }),
            2 => (payment(), proptest::option::of(amount())).prop_map(|(payment, amount)| BillingCommand::RequestRefund {
                payment, amount, reason: RefundReason::Goodwill
            }),
            2 => (payment(), refund(), stripe_refund(), amount()).prop_map(|(payment, refund, stripe_refund, amount)| BillingCommand::RecordRefund {
                payment, refund, stripe_refund, amount
            }),
            1 => reference().prop_map(|reference| BillingCommand::CancelForExpiry { reference }),
        ];
        (prop::sample::select(vec![40u128, 41, 42, 50, 51]), cmd)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        #[test]
        fn refunds_never_exceed_paid_and_replays_change_nothing(
            steps in proptest::collection::vec(command(), 1..60),
        ) {
            let mut state = BillingState::default();
            let mut log: Vec<BillingEvent> = Vec::new();
            for (n, cmd) in &steps {
                let c = ctx(*n);
                let Ok((next, events)) = execute::<Billing>(state.clone(), cmd, &c) else {
                    continue;
                };
                // A command that emitted nothing left the state as it was.
                if events.is_empty() {
                    prop_assert_eq!(&next, &state);
                }
                // Any webhook applied once is a replay the second time, and changes nothing.
                if let BillingCommand::ApplyEvent { event_id, kind } = cmd {
                    if !events.is_empty() {
                        prop_assert_eq!(
                            Billing::apply_webhook(&next, event_id, kind, &c),
                            Ok(WebhookOutcome::Replayed)
                        );
                    }
                    let (again, more) = execute::<Billing>(next.clone(), cmd, &c).unwrap();
                    prop_assert!(more.is_empty());
                    prop_assert_eq!(&again, &next);
                }
                for e in &events {
                    prop_assert_eq!(&BillingEvent::from_parts(e.name(), &e.to_data()).unwrap(), e);
                }
                log.extend(events);
                state = next;
                for (_, p) in state.payments() {
                    // Refunds never exceed what was paid, and only a success is refunded.
                    prop_assert!(Cents::ZERO <= p.refunded);
                    prop_assert!(p.refunded <= p.refund_requested);
                    prop_assert!(p.refund_requested <= p.amount);
                    if p.refund_requested > Cents::ZERO {
                        prop_assert_eq!(p.status, PaymentStatus::Succeeded);
                    }
                }
                // One intent belongs to one payment.
                for intent in INTENTS {
                    prop_assert!(state.payments().filter(|(_, p)| p.intent.as_deref() == Some(intent)).count() <= 1);
                }
            }
            // The state is the fold of its log, and the ledger agrees with the state.
            prop_assert_eq!(&replay::<Billing>(&log), &state);
            let ledger = ledger_of(&log);
            for reference in [id(1), id(2)] {
                let (mut paid, mut refunded) = (0i64, 0i64);
                for (_, p) in state.payments().filter(|(_, p)| p.reference == reference) {
                    if p.status == PaymentStatus::Succeeded {
                        paid += p.amount.0;
                    }
                    refunded += p.refunded.0;
                }
                prop_assert_eq!(ledger.refunded(reference), Cents(refunded));
                prop_assert_eq!(ledger.paid(reference), Cents(paid));
                prop_assert_eq!(ledger.net(reference), Cents(ledger.paid(reference).0 - refunded));
                prop_assert!(ledger.net(reference) >= Cents::ZERO);
            }
            prop_assert_eq!(ledger.net_total(), Cents(ledger.paid_total().0 - ledger.refunded_total().0));
        }
    }
}
