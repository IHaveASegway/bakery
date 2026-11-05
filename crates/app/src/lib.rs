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

pub mod admission;
pub mod auth;
pub mod health;
pub mod log;
pub mod names;
pub mod ports;
pub mod wipe;

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

pub use health::{BuildInfo, Health, HealthStatus, health};
pub use ports::{Clock, EventStore, IdGen, Mailbox, Outbox, PaymentGateway, PortError};
