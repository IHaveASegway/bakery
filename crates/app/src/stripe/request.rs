//! The calls the bakery makes, as data: method, path, form body and idempotency key, and the
//! readers that turn Stripe's answers into the port's types. The Worker's adapter adds the base
//! URL and the headers and sends it with `fetch`; nothing here touches the network.
//!
//! PR 5's five are the intent calls and the refund. PR 7 adds the balance invoice's: a customer
//! (created, and deleted at the wipe), and an invoice drafted, given its one item, finalized,
//! voided, paid on the test path and read. The draft comes before its item, and the item names
//! the invoice: an item created first is a pending item of the customer, and a draft made with
//! `pending_invoice_items_behavior=include` would sweep up every pending item the persona has,
//! two catering balances in one invoice if two were raised together. The draft says `exclude`
//! for the same reason.

use bakery_domain::billing::{Purpose, is_stripe_id};
use bakery_domain::{Cents, Ulid};
use serde::de::DeserializeOwned;

use super::form::Form;
use super::wire::{
    Customer, Deleted, Invoice, InvoiceItem, PaymentIntent, Refund, RefundStatus, StripeError,
};
use crate::ports::{
    CancelRequest, ConfirmRequest, CustomerCreated, CustomerRequest, IntentCreated, IntentRequest,
    IntentSnapshot, InvoiceCreated, InvoiceRequest, InvoiceSnapshot, PortError, RefundCreated,
    RefundIntentRequest, TestCard,
};

/// Stripe's API origin. `STRIPE_API_BASE` replaces it locally, loopback hosts only.
pub const API_BASE: &str = "https://api.stripe.com";

/// The only currency (docs/domain.md, "Money and time").
pub const CURRENCY: &str = "usd";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    Get,
    Post,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Delete => "DELETE",
        }
    }
}

/// One call to Stripe, ready to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StripeRequest {
    pub method: Method,
    /// Such as `/v1/payment_intents/pi_.../confirm`.
    pub path: String,
    /// The form body of a POST; `None` for a GET or a DELETE.
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
    /// The balance invoice's draft; its item and finalize suffix the key ([`invoice_item`],
    /// [`finalize_invoice`]).
    Invoice,
    Void,
    Pay,
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
        Call::Invoice => format!("{reference}:{purpose}-invoice:{attempt}"),
        Call::Void => format!("{reference}:{purpose}-void:{attempt}"),
        Call::Pay => format!("{reference}:{purpose}-pay:{attempt}"),
    }
}

/// The key of a persona's Stripe customer, `<sandbox>:<persona>:customer`. The sandbox is in it
/// because two sandboxes born from one seed share their personas' ids.
pub fn customer_key(sandbox: Ulid, persona: Ulid) -> String {
    format!("{sandbox}:{persona}:customer")
}

fn checked_path(id: &str, prefix: &str, base: &str, suffix: &str) -> Result<String, PortError> {
    if !is_stripe_id(id, prefix) {
        let what = prefix.trim_end_matches('_');
        let name = match what {
            "in" => "invoice-id",
            "cus" => "customer-id",
            _ => "id",
        };
        return Err(PortError::Rejected(name.into()));
    }
    Ok(format!("{base}/{id}{suffix}"))
}

/// `POST /v1/customers`: the sandbox and the persona in metadata, and nothing else.
pub fn create_customer(r: &CustomerRequest) -> StripeRequest {
    let form = Form::new()
        .nested(&["metadata", "sandbox"], r.sandbox.to_string())
        .nested(&["metadata", "persona"], r.persona.to_string());
    post("/v1/customers".to_owned(), form, &r.idempotency_key)
}

/// `DELETE /v1/customers/{id}`, with no body and no key.
pub fn delete_customer(customer: &str) -> Result<StripeRequest, PortError> {
    Ok(StripeRequest {
        method: Method::Delete,
        path: checked_path(customer, "cus_", "/v1/customers", "")?,
        body: None,
        idempotency_key: None,
    })
}

/// `days_until_due`: the days from today to the due date, at least 1.
pub fn days_until_due(r: &InvoiceRequest) -> i64 {
    r.today.days_until(r.due).max(1)
}

fn invoice_metadata(form: Form, r: &InvoiceRequest) -> Form {
    form.nested(&["metadata", "sandbox"], r.sandbox.to_string())
        .nested(&["metadata", "invoice"], r.invoice.to_string())
        .nested(&["metadata", "purpose"], Purpose::Balance.as_str())
        .nested(&["metadata", "ref"], r.reference.to_string())
}

/// `POST /v1/invoices`: the draft. `send_invoice` with `days_until_due`, so Stripe charges
/// nothing automatically; `auto_advance=false`, so it finalizes nothing on its own; no pending
/// items swept in.
pub fn create_invoice_draft(r: &InvoiceRequest) -> Result<StripeRequest, PortError> {
    if !is_stripe_id(&r.customer, "cus_") {
        return Err(PortError::Rejected("customer-id".into()));
    }
    if r.amount <= Cents::ZERO {
        return Err(PortError::Rejected("amount".into()));
    }
    let form = Form::new()
        .field("customer", &r.customer)
        .field("currency", CURRENCY)
        .field("collection_method", "send_invoice")
        .field("days_until_due", days_until_due(r).to_string())
        .field("auto_advance", "false")
        .field("pending_invoice_items_behavior", "exclude");
    Ok(post(
        "/v1/invoices".to_owned(),
        invoice_metadata(form, r),
        &r.idempotency_key,
    ))
}

/// `POST /v1/invoiceitems`: the balance, on the draft `invoice`, under the key `<key>:item`.
pub fn invoice_item(r: &InvoiceRequest, invoice: &str) -> Result<StripeRequest, PortError> {
    if !is_stripe_id(invoice, "in_") {
        return Err(PortError::Rejected("invoice-id".into()));
    }
    let form = Form::new()
        .field("customer", &r.customer)
        .field("invoice", invoice)
        .field("amount", r.amount.0.to_string())
        .field("currency", CURRENCY)
        .field("description", "Catering balance");
    Ok(post(
        "/v1/invoiceitems".to_owned(),
        invoice_metadata(form, r),
        &format!("{}:item", r.idempotency_key),
    ))
}

/// `POST /v1/invoices/{id}/finalize`, still not auto-advancing, under the key `<key>:finalize`.
pub fn finalize_invoice(r: &InvoiceRequest, invoice: &str) -> Result<StripeRequest, PortError> {
    Ok(post(
        checked_path(invoice, "in_", "/v1/invoices", "/finalize")?,
        Form::new().field("auto_advance", "false"),
        &format!("{}:finalize", r.idempotency_key),
    ))
}

/// `POST /v1/invoices/{id}/void`.
pub fn void_invoice(invoice: &str, idempotency_key: &str) -> Result<StripeRequest, PortError> {
    Ok(post(
        checked_path(invoice, "in_", "/v1/invoices", "/void")?,
        Form::new(),
        idempotency_key,
    ))
}

/// `POST /v1/invoices/{id}/pay` with the provider's test card: the test path only.
pub fn pay_invoice_test(invoice: &str, idempotency_key: &str) -> Result<StripeRequest, PortError> {
    Ok(post(
        checked_path(invoice, "in_", "/v1/invoices", "/pay")?,
        Form::new().field("payment_method", TestCard::Visa.payment_method()),
        idempotency_key,
    ))
}

/// `GET /v1/invoices/{id}`.
pub fn retrieve_invoice(invoice: &str) -> Result<StripeRequest, PortError> {
    Ok(StripeRequest {
        method: Method::Get,
        path: checked_path(invoice, "in_", "/v1/invoices", "")?,
        body: None,
        idempotency_key: None,
    })
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

fn live(livemode: bool) -> Result<(), PortError> {
    if livemode {
        Err(PortError::Rejected("livemode".into()))
    } else {
        Ok(())
    }
}

/// The port's answer to [`create_customer`].
pub fn read_customer(status: u16, body: &str) -> Result<CustomerCreated, PortError> {
    let c: Customer = parse(status, body)?;
    live(c.livemode)?;
    Ok(CustomerCreated { provider_id: c.id })
}

/// The port's answer to [`delete_customer`]: a customer already gone is no error.
pub fn read_deleted(status: u16, body: &str) -> Result<(), PortError> {
    match parse::<Deleted>(status, body) {
        Ok(d) if d.deleted => Ok(()),
        Ok(_) => Err(PortError::Unavailable("not-deleted".into())),
        Err(StripeFailure::Api {
            status: 404,
            code: Some(code),
            ..
        }) if code == "resource_missing" => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// An invoice read from any of its answers: the draft, the finalize, the void, the payment or a
/// read.
pub fn read_invoice(status: u16, body: &str) -> Result<InvoiceSnapshot, PortError> {
    let inv: Invoice = parse(status, body)?;
    live(inv.livemode)?;
    Ok(InvoiceSnapshot {
        provider_id: inv.id,
        status: inv.status.to_port(),
        amount_due: Cents(inv.amount_due),
        amount_paid: Cents(inv.amount_paid),
    })
}

/// The port's answer to [`finalize_invoice`], the last of `create_invoice`'s three calls.
pub fn read_invoice_created(status: u16, body: &str) -> Result<InvoiceCreated, PortError> {
    let s = read_invoice(status, body)?;
    Ok(InvoiceCreated {
        provider_id: s.provider_id,
        status: s.status,
    })
}

/// The answer to [`invoice_item`]: the item must be on the invoice it named, for the amount.
pub fn read_invoice_item(
    status: u16,
    body: &str,
    invoice: &str,
    amount: Cents,
) -> Result<(), PortError> {
    let item: InvoiceItem = parse(status, body)?;
    live(item.livemode)?;
    if item.invoice.as_deref() != Some(invoice) || item.amount != amount.0 {
        return Err(PortError::Rejected("invoice-item".into()));
    }
    Ok(())
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

    fn invoice_request() -> InvoiceRequest {
        InvoiceRequest {
            sandbox: ulid(1),
            invoice: ulid(6),
            customer: "cus_fake_1".into(),
            reference: ulid(5),
            amount: Cents(43_500),
            due: "2026-11-28".parse().unwrap(),
            today: "2026-11-21".parse().unwrap(),
            idempotency_key: idempotency_key(Call::Invoice, ulid(5), Purpose::Balance, 1),
        }
    }

    #[test]
    fn a_customer_carries_ids_and_nothing_else() {
        assert_eq!(
            customer_key(ulid(1), ulid(7)),
            format!("{}:{}:customer", ulid(1), ulid(7))
        );
        let req = create_customer(&CustomerRequest {
            sandbox: ulid(1),
            persona: ulid(7),
            idempotency_key: "k1".into(),
        });
        assert_eq!(
            (req.method, req.path.as_str()),
            (Method::Post, "/v1/customers")
        );
        assert_eq!(
            req.body.as_deref().unwrap(),
            format!(
                "metadata[sandbox]={}&metadata[persona]={}",
                ulid(1),
                ulid(7)
            )
        );
        assert_eq!(req.idempotency_key.as_deref(), Some("k1"));
        let del = delete_customer("cus_fake_1").unwrap();
        assert_eq!(
            (
                del.method,
                del.path.as_str(),
                &del.body,
                &del.idempotency_key
            ),
            (Method::Delete, "/v1/customers/cus_fake_1", &None, &None)
        );
        assert_eq!(Method::Delete.as_str(), "DELETE");
        assert_eq!(
            del.headers("sk_test_not_a_key", None)
                .len(),
            1,
            "no content type and no key on a delete"
        );
        assert_eq!(
            delete_customer("cus_x/../../v1/refunds"),
            Err(PortError::Rejected("customer-id".into()))
        );
        assert_eq!(
            read_customer(
                200,
                r#"{"id":"cus_fake_1","object":"customer","email":null,"metadata":{},"livemode":false}"#
            ),
            Ok(CustomerCreated {
                provider_id: "cus_fake_1".into()
            })
        );
        assert_eq!(
            read_customer(200, r#"{"id":"cus_fake_1","livemode":true}"#),
            Err(PortError::Rejected("livemode".into()))
        );
        assert_eq!(
            read_deleted(
                200,
                r#"{"id":"cus_fake_1","object":"customer","deleted":true}"#
            ),
            Ok(())
        );
        assert_eq!(
            read_deleted(
                404,
                r#"{"error":{"type":"invalid_request_error","code":"resource_missing"}}"#
            ),
            Ok(())
        );
    }

    #[test]
    fn an_invoice_is_drafted_given_its_item_and_finalized() {
        let r = invoice_request();
        let keys = |call| idempotency_key(call, ulid(5), Purpose::Balance, 1);
        assert_eq!(r.idempotency_key, format!("{}:balance-invoice:1", ulid(5)));
        assert_eq!(keys(Call::Void), format!("{}:balance-void:1", ulid(5)));
        assert_eq!(keys(Call::Pay), format!("{}:balance-pay:1", ulid(5)));
        assert_eq!(days_until_due(&r), 7);
        let draft = create_invoice_draft(&r).unwrap();
        assert_eq!(
            (draft.method, draft.path.as_str()),
            (Method::Post, "/v1/invoices")
        );
        let meta = format!(
            "&metadata[sandbox]={}&metadata[invoice]={}&metadata[purpose]=balance&metadata[ref]={}",
            ulid(1),
            ulid(6),
            ulid(5)
        );
        assert_eq!(
            draft.body.as_deref().unwrap(),
            format!(
                "customer=cus_fake_1&currency=usd&collection_method=send_invoice\
                 &days_until_due=7&auto_advance=false&pending_invoice_items_behavior=exclude{meta}"
            )
        );
        let item = invoice_item(&r, "in_fake_2").unwrap();
        assert_eq!(item.path, "/v1/invoiceitems");
        assert_eq!(
            item.body.as_deref().unwrap(),
            format!(
                "customer=cus_fake_1&invoice=in_fake_2&amount=43500&currency=usd\
                 &description=Catering%20balance{meta}"
            )
        );
        assert_eq!(
            item.idempotency_key,
            Some(format!("{}:balance-invoice:1:item", ulid(5)))
        );
        let fin = finalize_invoice(&r, "in_fake_2").unwrap();
        assert_eq!(fin.path, "/v1/invoices/in_fake_2/finalize");
        assert_eq!(fin.body.as_deref(), Some("auto_advance=false"));
        assert_eq!(
            fin.idempotency_key,
            Some(format!("{}:balance-invoice:1:finalize", ulid(5)))
        );
        let void = void_invoice("in_fake_2", "kv").unwrap();
        assert_eq!(
            (void.path.as_str(), void.body.as_deref()),
            ("/v1/invoices/in_fake_2/void", Some(""))
        );
        let pay = pay_invoice_test("in_fake_2", "kp").unwrap();
        assert_eq!(
            (pay.path.as_str(), pay.body.as_deref()),
            (
                "/v1/invoices/in_fake_2/pay",
                Some("payment_method=pm_card_visa")
            )
        );
        let get = retrieve_invoice("in_fake_2").unwrap();
        assert_eq!(
            (get.method, get.path.as_str()),
            (Method::Get, "/v1/invoices/in_fake_2")
        );
        // Ids that are not an invoice's never reach a path, and a due date today is a day.
        for bad in ["in_fake/../../v1/refunds", "pi_fake_1", "in_"] {
            assert_eq!(
                retrieve_invoice(bad),
                Err(PortError::Rejected("invoice-id".into()))
            );
            assert!(invoice_item(&r, bad).is_err());
        }
        let mut same_day = invoice_request();
        same_day.due = same_day.today;
        assert_eq!(days_until_due(&same_day), 1);
        let mut no_customer = invoice_request();
        no_customer.customer = "someone".into();
        assert_eq!(
            create_invoice_draft(&no_customer),
            Err(PortError::Rejected("customer-id".into()))
        );
    }

    #[test]
    fn reading_invoices() {
        let open = r#"{"id":"in_fake_2","object":"invoice","status":"open","amount_due":43500,
            "amount_paid":0,"customer":"cus_fake_1","livemode":false}"#;
        assert_eq!(
            read_invoice_created(200, open),
            Ok(InvoiceCreated {
                provider_id: "in_fake_2".into(),
                status: crate::ports::InvoiceStatus::Open
            })
        );
        let paid = read_invoice(
            200,
            r#"{"id":"in_fake_2","status":"paid","amount_due":43500,"amount_paid":43500}"#,
        )
        .unwrap();
        assert_eq!(paid.status, crate::ports::InvoiceStatus::Paid);
        assert_eq!(paid.amount_paid, Cents(43_500));
        assert_eq!(
            read_invoice(200, r#"{"id":"in_fake_2","status":"open","livemode":true}"#),
            Err(PortError::Rejected("livemode".into()))
        );
        let item =
            r#"{"id":"ii_fake_3","object":"invoiceitem","amount":43500,"invoice":"in_fake_2"}"#;
        assert_eq!(
            read_invoice_item(200, item, "in_fake_2", Cents(43_500)),
            Ok(())
        );
        assert_eq!(
            read_invoice_item(200, item, "in_fake_9", Cents(43_500)),
            Err(PortError::Rejected("invoice-item".into()))
        );
        assert_eq!(
            read_invoice(
                400,
                r#"{"error":{"type":"invalid_request_error","code":"invoice_not_editable"}}"#
            ),
            Err(PortError::Rejected("invoice_not_editable".into()))
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
