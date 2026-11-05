//! The bakery's domain: values, events and rules, with no platform dependency.
//!
//! Everything here runs natively under `cargo test`. Time and identifiers arrive as values from
//! the ports in `bakery-app`; nothing in this crate reads a clock or a random source.
//!
//! - [`aggregate`]: the `decide` and `evolve` shape every aggregate shares, and events as an
//!   envelope's `type` and `data`.
//! - [`catalog`]: the menu, hosted by `Catalog` (docs/domain.md, "MenuItem availability").
//! - [`order`]: the Order, hosted by `Order` (docs/domain.md, "Order").
//! - [`kitchen`]: the board the `Kitchen` projects from order and schedule events.
//! - [`calendar`]: the bakery day in America/Denver, its slots, windows and openings.
//! - [`schedule`]: the Schedule, hosted by `Schedule` per day (docs/domain.md, "Schedule
//!   reservation"), and its production plan.
//! - [`clock`]: how far each `AdvanceClock` step moves the business clock.
//! - [`outbox`]: envelopes, outbox rows and the `commands_seen` rule.

pub mod aggregate;
pub mod calendar;
pub mod catalog;
pub mod clock;
mod envelope;
mod error;
mod free_text;
mod id;
pub mod kitchen;
mod money;
pub mod order;
pub mod outbox;
pub mod schedule;
mod time;

pub use aggregate::{
    Aggregate, DecideContext, DomainEvent, EventCodecError, Executed, execute, replay, replay_from,
};
pub use calendar::BakeryDate;
pub use envelope::{ENVELOPE_VERSION, Envelope};
pub use error::DomainError;
pub use free_text::{
    BRIEF_MAX_CHARS, FreeTextClass, FreeTextError, NOTE_MAX_CHARS, check_brief, check_free_text,
    check_note, normalize,
};
pub use id::Ulid;
pub use money::{BASIS_POINTS_WHOLE, Cents};
pub use time::{BusinessTime, MS_PER_DAY, WallTime};
