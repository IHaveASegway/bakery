//! The five calls the bakery makes, as data: method, path, form body and idempotency key, and the
//! readers that turn Stripe's answers into the port's types. The Worker's adapter adds the base
//! URL and the headers and sends it with `fetch`; nothing here touches the network.

use bakery_domain::billing::{Purpose, is_stripe_id};
use bakery_domain::{Cents, Ulid};
use serde::de::DeserializeOwned;

use super::form::Form;
use super::wire::{PaymentIntent, Refund, RefundStatus, StripeError};
use crate::ports::{
    CancelRequest, ConfirmRequest, IntentCreated, IntentRequest, IntentSnapshot, PortError,
    RefundCreated, RefundIntentRequest,
};

/// Stripe's API origin. `STRIPE_API_BASE` replaces it locally, loopback hosts only.
pub const API_BASE: &str = "https://api.stripe.com";

/// The only currency (docs/domain.md, "Money and time").
pub const CURRENCY: &str = "usd";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    Get,
    Post,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
        }
    }
}

/// One call to Stripe, ready to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StripeRequest {
    pub method: Method,
    /// Such as `/v1/payment_intents/pi_.../confirm`.
    pub path: String,
    /// The form body of a POST; `None` for a GET.
    pub body: Option<String>,
    /// Stripe's `Idempotency-Key` header, on every POST.
    pub idempotency_key: Option<String>,
}

impl StripeRequest {
    /// The full URL under `base`, with or without its trailing slash.
    pub fn url(&self, base: &str) -> String {
        format!("{}{}", base.trim_end_matches('/'), self.path)
    }

    /// The request's headers: `Authorization: Bearer <key>`, the form content type on a POST,
    /// `Idempotency-Key` when there is one and `Stripe-Version` when one is pinned. The values
    /// hold the key, so a caller never logs them.
    pub fn headers(
        &self,
        secret_key: &str,
        api_version: Option<&str>,
    ) -> Vec<(&'static str, String)> {
        let mut headers = vec![("Authorization", format!("Bearer {secret_key}"))];
        if self.body.is_some() {
            headers.push((
                "Content-Type",
                "application/x-www-form-urlencoded".to_owned(),
            ));
        }
        if let Some(key) = &self.idempotency_key {
            headers.push(("Idempotency-Key", key.clone()));
        }
        if let Some(version) = api_version.filter(|v| !v.is_empty()) {
            headers.push(("Stripe-Version", version.to_owned()));
        }
        headers
    }
}

/// Which call an idempotency key is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Call {
    Create,
    Confirm,
    Cancel,
    Refund,
}

/// Stripe idempotency keys, `<ref>:<purpose>:<attempt>` (docs/domain.md, "Idempotency"). The
/// create call uses the purpose as it is; the other calls suffix it with the call, so no two
/// calls share a key, since Stripe refuses one key on two different requests. `attempt` is the
/// payment's [`attempt`](bakery_domain::billing::PaymentRecord::attempt) for the three intent
/// calls and the refund's [`ordinal`](bakery_domain::billing::RefundRecord::ordinal) for a
/// refund. A confirm is made once per intent: a second confirm with another card needs another
/// attempt number.
pub fn idempotency_key(call: Call, reference: Ulid, purpose: Purpose, attempt: u32) -> String {
    let purpose = purpose.as_str();
    match call {
        Call::Create => format!("{reference}:{purpose}:{attempt}"),
        Call::Confirm => format!("{reference}:{purpose}-confirm:{attempt}"),
        Call::Cancel => format!("{reference}:{purpose}-cancel:{attempt}"),
        Call::Refund => format!("{reference}:{purpose}-refund:{attempt}"),
    }
}

fn intent_path(intent: &str, suffix: &str) -> Result<String, PortError> {
    if !is_stripe_id(intent, "pi_") {
        return Err(PortError::Rejected("intent-id".into()));
    }
    Ok(format!("/v1/payment_intents/{intent}{suffix}"))
}

fn post(path: String, form: Form, key: &str) -> StripeRequest {
    StripeRequest {
        method: Method::Post,
        path,
        body: Some(form.encode()),
        idempotency_key: Some(key.to_owned()),
    }
}

/// The form body of [`create_intent`], for a test to read.
fn intent_form(r: &IntentRequest) -> Form {
    Form::new()
        .field("amount", r.amount.0.to_string())
        .field("currency", CURRENCY)
        .nested(&["automatic_payment_methods", "enabled"], "true")
        // Cards and other methods that never leave the page, so the Payment Element's
        // `redirect: 'if_required'` never redirects and a server-side confirm needs no
        // `return_url`. Confirmed against the real sandbox in spike S3.
        .nested(&["automatic_payment_methods", "allow_redirects"], "never")
        .nested(&["metadata", "sandbox"], r.sandbox.to_string())
        .nested(&["metadata", "payment"], r.payment.to_string())
        .nested(&["metadata", "purpose"], r.purpose.as_str())
        .nested(&["metadata", "ref"], r.reference.to_string())
}

/// `POST /v1/payment_intents`.
pub fn create_intent(r: &IntentRequest) -> StripeRequest {
    post(
        "/v1/payment_intents".to_owned(),
        intent_form(r),
        &r.idempotency_key,
    )
}

/// `POST /v1/payment_intents/{id}/confirm` with a test payment method.
pub fn confirm_intent(r: &ConfirmRequest) -> Result<StripeRequest, PortError> {
    Ok(post(
        intent_path(&r.intent, "/confirm")?,
        Form::new().field("payment_method", r.card.payment_method()),
        &r.idempotency_key,
    ))
}

/// `POST /v1/payment_intents/{id}/cancel`, as `abandoned`: the visitor did not pay in time.
pub fn cancel_intent(r: &CancelRequest) -> Result<StripeRequest, PortError> {
    Ok(post(
        intent_path(&r.intent, "/cancel")?,
        Form::new().field("cancellation_reason", "abandoned"),
        &r.idempotency_key,
    ))
}

/// `POST /v1/refunds`. Stripe's `reason` is always `requested_by_customer`, since none of the
/// bakery's reasons is a duplicate or a fraud; the bakery's own reason rides in metadata.
pub fn create_refund(r: &RefundIntentRequest) -> Result<StripeRequest, PortError> {
    if !is_stripe_id(&r.intent, "pi_") {
        return Err(PortError::Rejected("intent-id".into()));
    }
    if r.amount <= Cents::ZERO {
        return Err(PortError::Rejected("amount".into()));
    }
    let reason = serde_json::to_value(r.reason)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let form = Form::new()
        .field("payment_intent", &r.intent)
        .field("amount", r.amount.0.to_string())
        .field("reason", "requested_by_customer")
        .nested(&["metadata", "sandbox"], r.sandbox.to_string())
        .nested(&["metadata", "payment"], r.payment.to_string())
        .nested(&["metadata", "refund"], r.refund.to_string())
        .nested(&["metadata", "purpose"], r.purpose.as_str())
        .nested(&["metadata", "ref"], r.reference.to_string())
        .nested(&["metadata", "reason"], reason);
    Ok(post("/v1/refunds".to_owned(), form, &r.idempotency_key))
}

/// `GET /v1/payment_intents/{id}`.
pub fn retrieve_intent(intent: &str) -> Result<StripeRequest, PortError> {
    Ok(StripeRequest {
        method: Method::Get,
        path: intent_path(intent, "")?,
        body: None,
        idempotency_key: None,
    })
}

/// Why Stripe's answer was not the object asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StripeFailure {
    /// An error body: its HTTP status, `type` and `code`.
    Api {
        status: u16,
        kind: String,
        code: Option<String>,
    },
    /// A body that is neither the object nor an error, such as a proxy's HTML page.
    Unreadable { status: u16 },
}

impl StripeFailure {
    /// A reason code for a log line: the error's code, else its type, else the status.
    pub fn reason(&self) -> String {
        match self {
            StripeFailure::Api { code: Some(c), .. } => c.clone(),
            StripeFailure::Api { kind, .. } => kind.clone(),
            StripeFailure::Unreadable { status } => format!("unreadable-{status}"),
        }
    }

    /// Whether the same request may succeed later: a rate limit, a conflict on an idempotency
    /// key still in flight, Stripe's own errors, or an unreadable answer.
    pub fn is_retryable(&self) -> bool {
        match self {
            StripeFailure::Api { status, kind, .. } => {
                matches!(status, 409 | 429) || *status >= 500 || kind == "api_error"
            }
            StripeFailure::Unreadable { .. } => true,
        }
    }
}

impl From<StripeFailure> for PortError {
    fn from(f: StripeFailure) -> PortError {
        if f.is_retryable() {
            PortError::Unavailable(f.reason())
        } else {
            PortError::Rejected(f.reason())
        }
    }
}

/// Stripe's answer as `T` on a 2xx, or why not.
pub fn parse<T: DeserializeOwned>(status: u16, body: &str) -> Result<T, StripeFailure> {
    if (200..300).contains(&status) {
        return serde_json::from_str(body).map_err(|_| StripeFailure::Unreadable { status });
    }
    match serde_json::from_str::<StripeError>(body) {
        Ok(e) => Err(StripeFailure::Api {
            status,
            kind: e.error.kind,
            code: e.error.code,
        }),
        Err(_) => Err(StripeFailure::Unreadable { status }),
    }
}

/// An answer from the other mode is refused whatever it says.
fn test_mode(pi: &PaymentIntent) -> Result<(), PortError> {
    if pi.livemode {
        Err(PortError::Rejected("livemode".into()))
    } else {
        Ok(())
    }
}

/// The port's answer to [`create_intent`]: it must carry a client secret.
pub fn read_intent_created(status: u16, body: &str) -> Result<IntentCreated, PortError> {
    let pi: PaymentIntent = parse(status, body)?;
    test_mode(&pi)?;
    let client_secret = pi
        .client_secret
        .clone()
        .ok_or_else(|| PortError::Rejected("no-client-secret".into()))?;
    Ok(IntentCreated {
        provider_id: pi.id,
        client_secret,
        status: pi.status.to_port(),
    })
}

/// The port's answer to [`confirm_intent`], [`cancel_intent`] and [`retrieve_intent`]. A decline
/// is a 402 `card_error` whose body is an error, not the intent, so it is read as an intent
/// still awaiting payment with the decline's code.
pub fn read_intent(status: u16, body: &str, intent: &str) -> Result<IntentSnapshot, PortError> {
    if status == 402
        && let Ok(e) = serde_json::from_str::<StripeError>(body)
        && e.error.kind == "card_error"
    {
        return Ok(IntentSnapshot {
            provider_id: intent.to_owned(),
            status: crate::ports::IntentStatus::AwaitingPayment,
            amount: Cents::ZERO,
            failure_code: Some(
                e.error
                    .code
                    .or(e.error.decline_code)
                    .unwrap_or_else(|| "card_error".into()),
            ),
        });
    }
    let pi: PaymentIntent = parse(status, body)?;
    test_mode(&pi)?;
    Ok(snapshot(&pi))
}

/// An intent as the port reports it.
pub fn snapshot(pi: &PaymentIntent) -> IntentSnapshot {
    IntentSnapshot {
        provider_id: pi.id.clone(),
        status: pi.status.to_port(),
        amount: Cents(pi.amount),
        failure_code: pi.last_payment_error.as_ref().map(|e| e.best_code()),
    }
}

/// The port's answer to [`create_refund`]. A failed or canceled refund is refused.
pub fn read_refund(status: u16, body: &str) -> Result<RefundCreated, PortError> {
    let refund: Refund = parse(status, body)?;
    match refund.status {
        RefundStatus::Failed | RefundStatus::Canceled => {
            return Err(PortError::Rejected("refund-failed".into()));
        }
        RefundStatus::Pending
        | RefundStatus::RequiresAction
        | RefundStatus::Succeeded
        | RefundStatus::Unknown => {}
    }
    Ok(RefundCreated {
        provider_id: refund.id,
        amount: Cents(refund.amount),
        succeeded: refund.status == RefundStatus::Succeeded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::{IntentStatus, TestCard};
    use bakery_domain::order::RefundReason;

    fn ulid(n: u128) -> Ulid {
        Ulid::from_parts(1_793_819_530_318, n)
    }

    const SECRET: &str = "sk_test_not_a_key";

    #[test]
    fn idempotency_keys_follow_the_domain_doc() {
        let r = ulid(2);
        assert_eq!(
            idempotency_key(Call::Create, r, Purpose::Order, 1),
            format!("{r}:order:1")
        );
        assert_eq!(
            idempotency_key(Call::Confirm, r, Purpose::Order, 1),
            format!("{r}:order-confirm:1")
        );
        assert_eq!(
            idempotency_key(Call::Cancel, r, Purpose::Deposit, 2),
            format!("{r}:deposit-cancel:2")
        );
        assert_eq!(
            idempotency_key(Call::Refund, r, Purpose::Balance, 3),
            format!("{r}:balance-refund:3")
        );
    }

    #[test]
    fn creating_an_intent() {
        let req = create_intent(&IntentRequest {
            sandbox: ulid(1),
            payment: ulid(3),
            purpose: Purpose::Order,
            reference: ulid(2),
            amount: Cents(2_090),
            idempotency_key: "k1".into(),
        });
        assert_eq!(req.method, Method::Post);
        assert_eq!(req.path, "/v1/payment_intents");
        assert_eq!(
            req.body.as_deref().unwrap(),
            format!(
                "amount=2090&currency=usd&automatic_payment_methods[enabled]=true\
                 &automatic_payment_methods[allow_redirects]=never&metadata[sandbox]={}\
                 &metadata[payment]={}&metadata[purpose]=order&metadata[ref]={}",
                ulid(1),
                ulid(3),
                ulid(2)
            )
        );
        assert_eq!(
            req.url("https://api.stripe.com/"),
            "https://api.stripe.com/v1/payment_intents"
        );
        assert_eq!(
            req.headers(SECRET, Some("2026-10-29.test")),
            [
                ("Authorization", format!("Bearer {SECRET}")),
                (
                    "Content-Type",
                    "application/x-www-form-urlencoded".to_owned()
                ),
                ("Idempotency-Key", "k1".to_owned()),
                ("Stripe-Version", "2026-10-29.test".to_owned()),
            ]
        );
    }

    #[test]
    fn confirming_canceling_refunding_and_reading() {
        let confirm = confirm_intent(&ConfirmRequest {
            intent: "pi_fake_1".into(),
            card: TestCard::ChargeDeclined,
            idempotency_key: "k2".into(),
        })
        .unwrap();
        assert_eq!(confirm.path, "/v1/payment_intents/pi_fake_1/confirm");
        assert_eq!(
            confirm.body.as_deref(),
            Some("payment_method=pm_card_chargeDeclined")
        );
        let cancel = cancel_intent(&CancelRequest {
            intent: "pi_fake_1".into(),
            idempotency_key: "k3".into(),
        })
        .unwrap();
        assert_eq!(cancel.path, "/v1/payment_intents/pi_fake_1/cancel");
        assert_eq!(
            cancel.body.as_deref(),
            Some("cancellation_reason=abandoned")
        );
        let refund = create_refund(&RefundIntentRequest {
            sandbox: ulid(1),
            payment: ulid(3),
            refund: ulid(4),
            purpose: Purpose::Order,
            reference: ulid(2),
            intent: "pi_fake_1".into(),
            amount: Cents(500),
            reason: RefundReason::MissingItem,
            idempotency_key: "k4".into(),
        })
        .unwrap();
        assert_eq!(refund.path, "/v1/refunds");
        assert_eq!(
            refund.body.as_deref().unwrap(),
            format!(
                "payment_intent=pi_fake_1&amount=500&reason=requested_by_customer\
                 &metadata[sandbox]={}&metadata[payment]={}&metadata[refund]={}\
                 &metadata[purpose]=order&metadata[ref]={}&metadata[reason]=missing_item",
                ulid(1),
                ulid(3),
                ulid(4),
                ulid(2)
            )
        );
        let get = retrieve_intent("pi_fake_1").unwrap();
        assert_eq!(
            (get.method, get.path.as_str()),
            (Method::Get, "/v1/payment_intents/pi_fake_1")
        );
        assert_eq!((&get.body, &get.idempotency_key), (&None, &None));
        assert_eq!(
            get.headers(SECRET, None),
            [("Authorization", format!("Bearer {SECRET}"))]
        );
        // An id that is not an intent's never reaches a path.
        for bad in ["pi_fake/../../v1/refunds", "re_fake_1", "pi_", "pi_a?b=c"] {
            assert_eq!(
                retrieve_intent(bad),
                Err(PortError::Rejected("intent-id".into())),
                "{bad}"
            );
        }
    }

    #[test]
    fn reading_answers() {
        let created = read_intent_created(
            200,
            r#"{"id":"pi_fake_1","object":"payment_intent","amount":2090,"currency":"usd",
                "status":"requires_payment_method","client_secret":"pi_fake_1_secret_fake",
                "metadata":{},"livemode":false}"#,
        )
        .unwrap();
        assert_eq!(created.provider_id, "pi_fake_1");
        assert_eq!(created.status, IntentStatus::AwaitingPayment);
        assert!(!format!("{created:?}").contains("secret_fake"));
        assert_eq!(
            read_intent_created(
                200,
                r#"{"id":"pi_fake_1","amount":1,"currency":"usd","status":"succeeded","livemode":false}"#
            ),
            Err(PortError::Rejected("no-client-secret".into()))
        );
        assert_eq!(
            read_intent(
                200,
                r#"{"id":"pi_fake_1","amount":1,"currency":"usd","status":"succeeded","livemode":true}"#,
                "pi_fake_1"
            ),
            Err(PortError::Rejected("livemode".into()))
        );
        let declined = read_intent(
            402,
            r#"{"error":{"type":"card_error","code":"card_declined","decline_code":"generic_decline",
                "message":"Your card was declined."}}"#,
            "pi_fake_1",
        )
        .unwrap();
        assert_eq!(declined.status, IntentStatus::AwaitingPayment);
        assert_eq!(declined.failure_code.as_deref(), Some("card_declined"));
        let failed = read_intent(
            200,
            r#"{"id":"pi_fake_1","amount":2090,"currency":"usd","status":"requires_payment_method",
                "livemode":false,"last_payment_error":{"type":"card_error","code":"card_declined"}}"#,
            "pi_fake_1",
        )
        .unwrap();
        assert_eq!(failed.failure_code.as_deref(), Some("card_declined"));
        assert_eq!(failed.amount, Cents(2_090));
        let refund = read_refund(
            200,
            r#"{"id":"re_fake_1","object":"refund","amount":500,"status":"succeeded","payment_intent":"pi_fake_1"}"#,
        )
        .unwrap();
        assert_eq!(
            refund,
            RefundCreated {
                provider_id: "re_fake_1".into(),
                amount: Cents(500),
                succeeded: true
            }
        );
        assert_eq!(
            read_refund(200, r#"{"id":"re_fake_1","amount":500,"status":"failed"}"#),
            Err(PortError::Rejected("refund-failed".into()))
        );
    }

    #[test]
    fn errors_are_rejected_or_retried_by_kind() {
        let too_large = r#"{"error":{"type":"invalid_request_error","code":"amount_too_large"}}"#;
        assert_eq!(
            read_refund(400, too_large),
            Err(PortError::Rejected("amount_too_large".into()))
        );
        let reused = r#"{"error":{"type":"idempotency_error","message":"Keys for idempotent requests can only be used with the same parameters"}}"#;
        assert_eq!(
            read_refund(400, reused),
            Err(PortError::Rejected("idempotency_error".into()))
        );
        let bad_key = r#"{"error":{"type":"invalid_request_error","message":"Invalid API Key provided: sk_test_****0000"}}"#;
        let refused = read_intent_created(401, bad_key).unwrap_err();
        assert_eq!(refused, PortError::Rejected("invalid_request_error".into()));
        assert!(!refused.to_string().contains("sk_test"));
        assert_eq!(
            read_refund(
                429,
                r#"{"error":{"type":"invalid_request_error","code":"rate_limit"}}"#
            ),
            Err(PortError::Unavailable("rate_limit".into()))
        );
        assert_eq!(
            read_refund(500, r#"{"error":{"type":"api_error"}}"#),
            Err(PortError::Unavailable("api_error".into()))
        );
        assert_eq!(
            read_refund(502, "<html>bad gateway</html>"),
            Err(PortError::Unavailable("unreadable-502".into()))
        );
        assert_eq!(
            read_refund(200, "{}"),
            Err(PortError::Unavailable("unreadable-200".into()))
        );
    }
}
