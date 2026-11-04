//! The ports: one minimal method set each, which later pull requests extend.
//!
//! Storage ports are synchronous because a Durable Object's SQLite calls are; the ports that
//! cross the network are `async`. Futures need not be `Send`: the Worker is single-threaded.

use bakery_domain::{BusinessTime, Cents, Envelope, Ulid, WallTime};
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

/// A payment intent to create at the provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentRequest {
    /// The order or catering job it pays for.
    pub reference: String,
    pub amount: Cents,
    /// Sent as the provider's idempotency key, so a retry returns the first intent.
    pub idempotency_key: String,
}

/// The provider's answer: its id for the intent and the secret the browser confirms with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentCreated {
    pub provider_id: String,
    pub client_secret: String,
}

/// Stripe's sandbox today; a second provider would be a second adapter.
#[allow(async_fn_in_trait)]
pub trait PaymentGateway {
    async fn create_intent(&self, request: IntentRequest) -> Result<IntentCreated, PortError>;
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
