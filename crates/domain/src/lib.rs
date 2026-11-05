//! The bakery's domain: values, events and rules, with no platform dependency.
//!
//! Everything here runs natively under `cargo test`. Time and identifiers arrive as values from
//! the ports in `bakery-app`; nothing in this crate reads a clock or a random source.

mod envelope;
mod error;
mod free_text;
mod id;
mod money;
mod time;

pub use envelope::{ENVELOPE_VERSION, Envelope};
pub use error::DomainError;
pub use free_text::{FreeTextClass, check_free_text, normalize};
pub use id::Ulid;
pub use money::{BASIS_POINTS_WHOLE, Cents};
pub use time::{BusinessTime, MS_PER_DAY, WallTime};
