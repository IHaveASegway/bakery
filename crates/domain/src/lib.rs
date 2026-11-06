//! The bakery's domain: values, events and rules, with no platform dependency.
//!
//! Everything here runs natively under `cargo test`. Time and identifiers arrive as values from
//! the ports in `bakery-app`; nothing in this crate reads a clock or a random source.
//!
//! - [`aggregate`]: the `decide` and `evolve` shape every aggregate shares, and events as an
//!   envelope's `type` and `data`.
//! - [`billing`]: payments, refunds and the ledger, hosted by `Billing` (ADR 0007).
//! - [`catalog`]: the menu, hosted by `Catalog` (docs/domain.md, "MenuItem availability").
//! - [`catering`]: the catering saga, hosted by `CateringEvent` (docs/domain.md,
//!   "CateringEvent").
//! - [`order`]: the Order, hosted by `Order` (docs/domain.md, "Order").
//! - [`kitchen`]: the board the `Kitchen` projects from order and schedule events.
//! - [`calendar`]: the bakery day in America/Denver, its slots, windows and openings.
//! - [`schedule`]: the Schedule, hosted by `Schedule` per day (docs/domain.md, "Schedule
//!   reservation"), and its production plan.
//! - [`clock`]: how far each `AdvanceClock` step moves the business clock.
//! - [`outbox`]: envelopes, outbox rows and the `commands_seen` rule.
//! - [`customer`]: the Customer, hosted by `Customer` per persona: consent and loyalty.
//! - [`crm`]: Crm's projection (customers, timelines, activity, leads, campaign stats, the
//!   rebuild), its segments, and the campaigns it hosts (docs/domain.md, "Campaign").
//! - [`inbox`]: the Inbox projection, its message templates and the simulated engagement.
//! - [`dispatch`]: the Dispatch, hosted by `Dispatch` per day: stops, the savings heuristic,
//!   the plan validator and the travel-time matrix (ADR 0012).

pub mod aggregate;
pub mod calendar;

pub mod billing;
pub mod catalog;
pub mod catering;
pub mod clock;
pub mod crm;
pub mod customer;
pub mod dispatch;
mod envelope;
mod error;
mod free_text;
mod id;
pub mod inbox;
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
