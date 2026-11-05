//! The ports: one minimal method set each, which later pull requests extend.
//!
//! Storage ports are synchronous because a Durable Object's SQLite calls are; the ports that
//! cross the network are `async`. Futures need not be `Send`: the Worker is single-threaded.

use std::fmt;

use bakery_domain::billing::Purpose;
use bakery_domain::order::RefundReason;
use bakery_domain::{BakeryDate, BusinessTime, Cents, Envelope, Ulid, WallTime};
use thiserror::Error;

/// Why an adapter could not do what a port asked.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PortError {
    /// An optimistic write found the stream at another `seq`: someone else wrote first.
    #[error("stream {stream} is at seq {actual}, not {expected}")]
    Conflict {
        stream: String,
        expected: u64,
        actual: u64,
    },
    /// The platform or the third party refused or could not be reached; retry later.
    #[error("unavailable: {0}")]
    Unavailable(String),
    /// The request was understood and refused; retrying the same request will not help.
    #[error("rejected: {0}")]
    Rejected(String),
}

/// The only source of time. Domain rules read business time; the platform reads wall time.
pub trait Clock {
    fn now_wall(&self) -> WallTime;
    /// Wall time plus the sandbox's offset (docs/architecture.md, "Time travel").
    fn now_business(&self) -> BusinessTime;
}

/// The only source of identifiers.
pub trait IdGen {
    /// A fresh ULID: its time part from the wall clock, its random part from the adapter.
    fn ulid(&self) -> Ulid;
}

/// One object's append-only event log, the `events` table.
pub trait EventStore {
    /// Appends `events` after `expected_seq`, the stream's last `seq` as the caller read it, and
    /// returns the new last `seq`. Refuses with [`PortError::Conflict`] if the stream moved.
    fn append(&self, expected_seq: u64, events: &[Envelope]) -> Result<u64, PortError>;
    /// The events with `seq` greater than `after_seq`, in order.
    fn read_after(&self, after_seq: u64) -> Result<Vec<Envelope>, PortError>;
}

/// The transactional outbox: envelopes committed with their events, relayed to the Queue after.
pub trait Outbox {
    /// Records envelopes for the relay, in the same transaction as the events they copy.
    fn enqueue(&self, envelopes: &[Envelope]) -> Result<(), PortError>;
    /// Up to `limit` unsent rows, oldest first, as `(seq, envelope)`.
    fn pending(&self, limit: usize) -> Result<Vec<(u64, Envelope)>, PortError>;
    /// Deletes rows the Queue accepted.
    fn mark_sent(&self, seqs: &[u64]) -> Result<(), PortError>;
}

/// A payment intent to create at the provider (ADR 0007, decision 3). Everything here goes to
/// Stripe: random ids, an amount and a purpose, nothing about a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentRequest {
    /// Sent as `metadata[sandbox]`, which routes the webhook back to this sandbox's Billing.
    pub sandbox: Ulid,
    /// Billing's id for the payment, `metadata[payment]`.
    pub payment: Ulid,
    pub purpose: Purpose,
    /// The order or catering job it pays for, `metadata[ref]`.
    pub reference: Ulid,
    pub amount: Cents,
    /// Sent as the provider's idempotency key, so a retry returns the first intent:
    /// `<sandbox>:<ref>:<purpose>:<attempt>` (`stripe::idempotency_key`).
    pub idempotency_key: String,
}

/// Where an intent stands at the provider, in the provider's terms reduced to four.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IntentStatus {
    /// Waiting for the browser: a payment method, a confirmation or a 3-D Secure step. A
    /// declined attempt returns here.
    AwaitingPayment,
    /// The provider is working on it.
    Processing,
    Succeeded,
    Canceled,
}

/// The provider's answer to creating an intent: its id and the secret the browser confirms
/// with. The secret is handed to the browser once and never stored or logged, so `Debug` leaves
/// it out.
#[derive(Clone, PartialEq, Eq)]
pub struct IntentCreated {
    pub provider_id: String,
    pub client_secret: String,
    pub status: IntentStatus,
}

impl fmt::Debug for IntentCreated {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IntentCreated")
            .field("provider_id", &self.provider_id)
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

/// An intent as the provider reports it after a confirm, a cancel or a read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentSnapshot {
    pub provider_id: String,
    pub status: IntentStatus,
    pub amount: Cents,
    /// The last attempt's decline code, such as `card_declined`.
    pub failure_code: Option<String>,
}

/// The provider's published test payment methods (https://docs.stripe.com/testing). The
/// server-side path, the Simulator's, confirms with one of these and nothing else: no card
/// number is ever in the bakery's code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TestCard {
    /// `pm_card_visa`: succeeds.
    Visa,
    /// `pm_card_chargeDeclined`: declined with `card_declined`.
    ChargeDeclined,
}

impl TestCard {
    pub fn payment_method(self) -> &'static str {
        match self {
            TestCard::Visa => "pm_card_visa",
            TestCard::ChargeDeclined => "pm_card_chargeDeclined",
        }
    }
}

/// Confirms an intent server-side with a test payment method.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmRequest {
    /// The provider's `pi_...` id.
    pub intent: String,
    pub card: TestCard,
    /// `stripe::idempotency_key` with `Call::Confirm`.
    pub idempotency_key: String,
}

/// Cancels an open intent: an expired order's, or the wipe's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelRequest {
    pub intent: String,
    /// `stripe::idempotency_key` with `Call::Cancel`.
    pub idempotency_key: String,
}

/// A refund of a succeeded intent, part or whole (ADR 0007, decision 5). Billing has checked the
/// amount against what is left, so it is always named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefundIntentRequest {
    /// `metadata[sandbox]`, so the `refund.created` webhook finds its way back.
    pub sandbox: Ulid,
    pub payment: Ulid,
    /// Billing's id for the refund, `metadata[refund]`: the webhook names its request by it.
    pub refund: Ulid,
    pub purpose: Purpose,
    pub reference: Ulid,
    pub intent: String,
    pub amount: Cents,
    pub reason: RefundReason,
    /// `stripe::idempotency_key` with `Call::Refund`.
    pub idempotency_key: String,
}

/// The provider's answer to a refund.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefundCreated {
    /// The provider's `re_...` id.
    pub provider_id: String,
    pub amount: Cents,
    /// `true` once the provider reports the refund `succeeded`; a sandbox's card refunds are.
    pub succeeded: bool,
}

/// A Stripe customer for a persona, the one a balance invoice is raised against (ADR 0007,
/// decision 4). It carries `metadata[sandbox]` and `metadata[persona]` and nothing else: no
/// email, no name, no address, so Stripe has no one to send the invoice to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomerRequest {
    pub sandbox: Ulid,
    /// The synthetic customer's id.
    pub persona: Ulid,
    /// `stripe::customer_key`: `<sandbox>:<persona>:customer`.
    pub idempotency_key: String,
}

/// The provider's answer to creating a customer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomerCreated {
    /// `cus_...`.
    pub provider_id: String,
}

/// A balance invoice to raise (ADR 0007, decision 4): a draft invoice with
/// `collection_method=send_invoice`, `days_until_due` from `due`, and `auto_advance=false`, one
/// invoice item for the amount on it, then the invoice finalized, in that order. With
/// `send_invoice`, Stripe emails an invoice only to a customer with an email, and this customer
/// has none; spike S3 confirms that Stripe sends nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvoiceRequest {
    /// `metadata[sandbox]`, which routes `invoice.paid` back to this sandbox's Billing.
    pub sandbox: Ulid,
    /// Billing's id for the invoice, `metadata[invoice]`.
    pub invoice: Ulid,
    /// The Stripe customer, `cus_...`.
    pub customer: String,
    /// The catering job, `metadata[ref]`.
    pub reference: Ulid,
    pub amount: Cents,
    pub due: BakeryDate,
    /// Today's bakery date, so `days_until_due` is `due - today` (at least 1).
    pub today: BakeryDate,
    /// `stripe::idempotency_key`, `<sandbox>:<ref>:balance-invoice:<n>`; the item and the
    /// finalize suffix it with `:item` and `:finalize`.
    pub idempotency_key: String,
}

/// Where an invoice stands at the provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InvoiceStatus {
    Draft,
    /// Finalized and unpaid.
    Open,
    Paid,
    Void,
    Uncollectible,
}

/// The provider's answer to raising an invoice: the finalized invoice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvoiceCreated {
    /// `in_...`.
    pub provider_id: String,
    pub status: InvoiceStatus,
}

/// An invoice as the provider reports it after a void, a payment or a read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvoiceSnapshot {
    pub provider_id: String,
    pub status: InvoiceStatus,
    pub amount_due: Cents,
    pub amount_paid: Cents,
}

/// Stripe's sandbox today; a second provider would be a second adapter (ADR 0007, decision 8).
/// Every call that changes something carries an idempotency key, so the object can retry it
/// after a timeout and get the first answer back.
#[allow(async_fn_in_trait)]
pub trait PaymentGateway {
    async fn create_intent(&self, request: IntentRequest) -> Result<IntentCreated, PortError>;
    /// Confirms with a test payment method. A decline is `Ok`, with the status back at
    /// `AwaitingPayment` and the code in `failure_code`.
    async fn confirm_intent(&self, request: ConfirmRequest) -> Result<IntentSnapshot, PortError>;
    async fn cancel_intent(&self, request: CancelRequest) -> Result<IntentSnapshot, PortError>;
    async fn refund(&self, request: RefundIntentRequest) -> Result<RefundCreated, PortError>;
    /// A read, so no idempotency key.
    async fn retrieve_intent(&self, intent: &str) -> Result<IntentSnapshot, PortError>;
    async fn create_customer(&self, request: CustomerRequest)
    -> Result<CustomerCreated, PortError>;
    /// The wipe's. A delete is idempotent by definition, so it carries no key; a customer
    /// already gone is `Ok`.
    async fn delete_customer(&self, customer: &str) -> Result<(), PortError>;
    /// The draft, its item and the finalize, in that order, each under its own key.
    async fn create_invoice(&self, request: InvoiceRequest) -> Result<InvoiceCreated, PortError>;
    /// The wipe's: an open invoice is voided.
    async fn void_invoice(
        &self,
        invoice: &str,
        idempotency_key: &str,
    ) -> Result<InvoiceSnapshot, PortError>;
    /// The test path: pays an open invoice with the provider's `pm_card_visa`. At Stripe, a
    /// visitor pays it with the Payment Element on the invoice's own payment, which spike S3
    /// builds; this call is for the fake, the smoke test and the Simulator.
    async fn pay_invoice_test(
        &self,
        invoice: &str,
        idempotency_key: &str,
    ) -> Result<InvoiceSnapshot, PortError>;
}

/// A note to the operator's own verified address. Visitors never get email.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub subject: String,
    pub body: String,
}

#[allow(async_fn_in_trait)]
pub trait Mailbox {
    async fn send(&self, note: Note) -> Result<(), PortError>;
}
