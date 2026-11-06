//! The bakery's use cases and the ports they need.
//!
//! Time, identifiers, storage, the Queue, payments and mail are traits here. The Worker in
//! `workers/api` implements them on the platform; tests replace them with the fakes in
//! [`test_support`]. Nothing in this crate reads a clock, draws a random byte or depends on a
//! platform crate: a function that needs randomness takes the bytes as an argument.
//!
//! - [`auth`]: cookies, the OAuth flows, ID tokens, account ids, passwords, the lockout and
//!   Turnstile (docs/security.md, "Sign-in and sessions").
//! - [`admission`]: the daily caps and the flag (docs/security.md, "Sandbox isolation").
//! - [`names`]: object names (docs/architecture.md, "Object naming").
//! - [`wipe`]: when sandboxes and accounts end (docs/security.md, "The wipe").
//! - [`log`]: the request log line (docs/security.md, "Privacy and data inventory").
//! - [`stripe`]: Stripe's calls, answers and webhooks as data, and the key guard (ADR 0007).
//! - [`routing`]: the subscriber table the Queue consumer reads (docs/domain.md, "The event
//!   catalog").
//! - [`dispatch_view`]: the dispatch screen's wire shapes from the Dispatch aggregate (ADR 0012).
//! - [`analytics`]: the Analytics Engine points, the kept queries and the SQL API's answers, for
//!   the status page's counters (docs/operations.md, "Observability").

pub mod admission;
pub mod analytics;
pub mod auth;
pub mod dispatch_view;
pub mod health;
pub mod log;
pub mod names;
pub mod ports;
pub mod routing;
pub mod stripe;
pub mod wipe;

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

#[cfg(test)]
mod scheduling_flow;

pub use health::{BuildInfo, Health, HealthStatus, health};
pub use ports::{
    CancelRequest, Clock, ConfirmRequest, CustomerCreated, CustomerRequest, EventStore, IdGen,
    IntentCreated, IntentRequest, IntentSnapshot, IntentStatus, InvoiceCreated, InvoiceRequest,
    InvoiceSnapshot, InvoiceStatus, Mailbox, Note, Outbox, PaymentGateway, PortError, Recipient,
    RefundCreated, RefundIntentRequest, TestCard,
};
