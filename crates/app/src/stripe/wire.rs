//! Stripe's objects as the bakery reads them, from its JSON responses and webhook bodies
//! (https://docs.stripe.com/api, as of 2026-11-05; confirmed against the real sandbox in spike
//! S3). Each type keeps only the fields the bakery uses, and unknown fields are skipped, so a
//! newer API version that adds fields still parses.
//!
//! Two things are deliberately not kept. An intent's `client_secret` is kept but never printed:
//! `Debug` leaves it out. An error's `message` is dropped, because Stripe's message for a bad key
//! quotes part of the key; the type and code say enough for a log line.

use std::collections::BTreeMap;
use std::fmt;

use serde::Deserialize;

use crate::ports::IntentStatus;

/// An object's `metadata`: the bakery's random ids, nothing personal.
pub type Metadata = BTreeMap<String, String>;

/// `status` on a PaymentIntent (https://docs.stripe.com/payments/paymentintents/lifecycle).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StripeIntentStatus {
    RequiresPaymentMethod,
    RequiresConfirmation,
    RequiresAction,
    Processing,
    RequiresCapture,
    Canceled,
    Succeeded,
    /// A status this client does not know yet.
    #[serde(other)]
    Unknown,
}

impl StripeIntentStatus {
    /// The port's four. `requires_capture` cannot occur (the bakery never asks for manual
    /// capture), and an unknown status is treated as still in progress.
    pub fn to_port(self) -> IntentStatus {
        match self {
            StripeIntentStatus::RequiresPaymentMethod
            | StripeIntentStatus::RequiresConfirmation
            | StripeIntentStatus::RequiresAction => IntentStatus::AwaitingPayment,
            StripeIntentStatus::Processing
            | StripeIntentStatus::RequiresCapture
            | StripeIntentStatus::Unknown => IntentStatus::Processing,
            StripeIntentStatus::Canceled => IntentStatus::Canceled,
            StripeIntentStatus::Succeeded => IntentStatus::Succeeded,
        }
    }
}

/// `last_payment_error` on an intent: why the last attempt failed.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct PaymentError {
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub decline_code: Option<String>,
}

impl PaymentError {
    /// The most specific code there is, for `PaymentFailed.code`.
    pub fn best_code(&self) -> String {
        self.code
            .clone()
            .or_else(|| self.decline_code.clone())
            .or_else(|| self.kind.clone())
            .unwrap_or_else(|| "unknown".to_owned())
    }
}

/// A PaymentIntent (https://docs.stripe.com/api/payment_intents/object).
#[derive(Clone, PartialEq, Eq, Deserialize)]
pub struct PaymentIntent {
    /// `pi_...`.
    pub id: String,
    /// Cents, for `usd`.
    pub amount: i64,
    pub currency: String,
    pub status: StripeIntentStatus,
    /// `pi_..._secret_...`: the browser's, once. Never stored, logged or printed.
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub metadata: Metadata,
    #[serde(default)]
    pub livemode: bool,
    #[serde(default)]
    pub last_payment_error: Option<PaymentError>,
}

/// Leaves the client secret out.
impl fmt::Debug for PaymentIntent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PaymentIntent")
            .field("id", &self.id)
            .field("amount", &self.amount)
            .field("currency", &self.currency)
            .field("status", &self.status)
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| "<redacted>"),
            )
            .field("metadata", &self.metadata)
            .field("livemode", &self.livemode)
            .field("last_payment_error", &self.last_payment_error)
            .finish()
    }
}

/// `status` on a Refund (https://docs.stripe.com/api/refunds/object).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefundStatus {
    Pending,
    RequiresAction,
    Succeeded,
    Failed,
    Canceled,
    #[serde(other)]
    Unknown,
}

/// A Refund. Its `metadata` is its own, set when the refund is created, not the intent's.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Refund {
    /// `re_...`.
    pub id: String,
    pub amount: i64,
    pub status: RefundStatus,
    #[serde(default)]
    pub payment_intent: Option<String>,
    #[serde(default)]
    pub metadata: Metadata,
}

/// A Charge, as `charge.refunded` carries it (https://docs.stripe.com/api/charges/object).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Charge {
    /// `ch_...`.
    pub id: String,
    pub amount: i64,
    #[serde(default)]
    pub amount_refunded: i64,
    #[serde(default)]
    pub refunded: bool,
    #[serde(default)]
    pub payment_intent: Option<String>,
    #[serde(default)]
    pub metadata: Metadata,
}

/// An error response's body, `{ "error": { "type", "code", ... } }` with a 4xx or 5xx.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StripeError {
    pub error: ErrorBody,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ErrorBody {
    /// `invalid_request_error`, `card_error`, `idempotency_error`, `api_error` and so on.
    #[serde(rename = "type")]
    pub kind: String,
    /// Such as `amount_too_large`, `charge_already_refunded` or `resource_missing`.
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub decline_code: Option<String>,
    /// The request field the error is about.
    #[serde(default)]
    pub param: Option<String>,
}

/// The object a webhook event carries, told apart by its `object` field.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "object")]
pub enum EventObject {
    #[serde(rename = "payment_intent")]
    PaymentIntent(PaymentIntent),
    #[serde(rename = "refund")]
    Refund(Refund),
    #[serde(rename = "charge")]
    Charge(Charge),
    /// Any other object: the event is acknowledged and ignored.
    #[serde(other)]
    Other,
}

impl EventObject {
    pub fn metadata(&self) -> Option<&Metadata> {
        match self {
            EventObject::PaymentIntent(o) => Some(&o.metadata),
            EventObject::Refund(o) => Some(&o.metadata),
            EventObject::Charge(o) => Some(&o.metadata),
            EventObject::Other => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EventData {
    pub object: EventObject,
}

/// A webhook event (https://docs.stripe.com/api/events/object). `livemode` is required: an
/// event that does not say which mode it is from does not parse.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StripeEvent {
    /// `evt_...`: the key of Billing's `webhooks_seen`.
    pub id: String,
    /// Such as `payment_intent.succeeded`.
    #[serde(rename = "type")]
    pub event_type: String,
    pub livemode: bool,
    /// Unix seconds.
    pub created: i64,
    pub data: EventData,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_intent_parses_and_hides_its_secret() {
        let pi: PaymentIntent = serde_json::from_str(
            r#"{"id":"pi_fake_1","object":"payment_intent","amount":2090,"currency":"usd",
                "status":"requires_payment_method","client_secret":"pi_fake_1_secret_fake",
                "metadata":{"sandbox":"s"},"livemode":false,"new_field":{"x":1}}"#,
        )
        .unwrap();
        assert_eq!(pi.status, StripeIntentStatus::RequiresPaymentMethod);
        assert_eq!(pi.status.to_port(), IntentStatus::AwaitingPayment);
        assert_eq!(pi.client_secret.as_deref(), Some("pi_fake_1_secret_fake"));
        let printed = format!("{pi:?}");
        assert!(!printed.contains("secret_fake"), "{printed}");
        assert!(printed.contains("<redacted>"));
        let later: StripeIntentStatus =
            serde_json::from_str(r#""requires_something_new""#).unwrap();
        assert_eq!(later, StripeIntentStatus::Unknown);
    }

    #[test]
    fn event_objects_are_told_apart_by_their_object_field() {
        let event: StripeEvent = serde_json::from_str(
            r#"{"id":"evt_fake_1","object":"event","type":"refund.created","livemode":false,
                "created":1793900000,"data":{"object":{"id":"re_fake_1","object":"refund",
                "amount":500,"status":"succeeded","payment_intent":"pi_fake_1",
                "metadata":{"refund":"r"}}}}"#,
        )
        .unwrap();
        assert!(matches!(&event.data.object, EventObject::Refund(r) if r.amount == 500));
        let other: StripeEvent = serde_json::from_str(
            r#"{"id":"evt_fake_2","type":"customer.created","livemode":false,"created":1,
                "data":{"object":{"object":"customer","id":"cus_fake_1","email":null}}}"#,
        )
        .unwrap();
        assert_eq!(other.data.object, EventObject::Other);
        assert_eq!(other.data.object.metadata(), None);
        // No livemode, no event.
        assert!(
            serde_json::from_str::<StripeEvent>(
                r#"{"id":"evt_fake_3","type":"x","created":1,"data":{"object":{"object":"charge"}}}"#
            )
            .is_err()
        );
    }

    #[test]
    fn an_error_keeps_its_type_and_code_and_drops_the_message() {
        let e: StripeError = serde_json::from_str(
            r#"{"error":{"type":"invalid_request_error","code":"amount_too_large",
                "message":"Refund amount is greater than unrefunded amount","param":"amount"}}"#,
        )
        .unwrap();
        assert_eq!(e.error.kind, "invalid_request_error");
        assert_eq!(e.error.code.as_deref(), Some("amount_too_large"));
        assert!(!format!("{e:?}").contains("greater"));
        let declined = PaymentError {
            decline_code: Some("generic_decline".into()),
            ..PaymentError::default()
        };
        assert_eq!(declined.best_code(), "generic_decline");
        assert_eq!(PaymentError::default().best_code(), "unknown");
    }
}
