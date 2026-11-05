//! The bakery's domain: values, events and rules, with no platform dependency.
//!
//! Everything here runs natively under `cargo test`. Time and identifiers arrive as values from
//! the ports in `bakery-app`; nothing in this crate reads a clock or a random source.
//!
//! - [`aggregate`]: the `decide` and `evolve` shape every aggregate shares, and events as an
//!   envelope's `type` and `data`.
//! - [`billing`]: payments, refunds and the ledger, hosted by `Billing` (ADR 0007).
//! - [`catalog`]: the menu, hosted by `Catalog` (docs/domain.md, "MenuItem availability").
//! - [`order`]: the Order, hosted by `Order` (docs/domain.md, "Order").
//! - [`kitchen`]: the board the `Kitchen` projects from order events.
//! - [`outbox`]: envelopes, outbox rows and the `commands_seen` rule.

pub mod aggregate;
pub mod billing;
pub mod catalog;
mod envelope;
mod error;
mod free_text;
mod id;
pub mod kitchen;
mod money;
pub mod order;
pub mod outbox;
mod time;

pub use aggregate::{
    Aggregate, DecideContext, DomainEvent, EventCodecError, Executed, execute, replay, replay_from,
};
pub use envelope::{ENVELOPE_VERSION, Envelope};
pub use error::DomainError;
pub use free_text::{
    BRIEF_MAX_CHARS, FreeTextClass, FreeTextError, NOTE_MAX_CHARS, check_brief, check_free_text,
    check_note, normalize,
};
pub use id::Ulid;
pub use money::{BASIS_POINTS_WHOLE, Cents};
pub use time::{BusinessTime, MS_PER_DAY, WallTime};
