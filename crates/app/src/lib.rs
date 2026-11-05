//! The bakery's use cases and the ports they need.
//!
//! Time, identifiers, storage, the Queue, payments and mail are traits here. The Worker in
//! `workers/api` implements them on the platform; tests replace them with the fakes in
//! [`test_support`]. Nothing in this crate reads a clock or depends on a platform crate.

pub mod health;
pub mod ports;

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

pub use health::{BuildInfo, Health, HealthStatus, health};
pub use ports::{Clock, EventStore, IdGen, Mailbox, Outbox, PaymentGateway, PortError};
