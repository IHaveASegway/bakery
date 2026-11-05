//! The business clock's pure rules (docs/domain.md, "Sandbox": `AdvanceClock`; docs/architecture.md,
//! "Time travel"; Q12 · Q-clock). The Sandbox holds the offset as `clock_offset_s`, whole
//! seconds added to wall time, and a `clock_v` it bumps on every move; this module says how far
//! each step moves it. The offset only grows, and never past [`MAX_OFFSET_S`], 14 days.
//!
//! Nothing here reads a clock: the Sandbox passes the business time it read from the `Clock`
//! port, and stores what comes back.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

use crate::BusinessTime;
use crate::calendar::next_opening;

/// The business clock moves at most 14 days in total (docs/domain.md, "Sandbox").
pub const MAX_OFFSET_S: i64 = 14 * 24 * 3_600;

/// How far one `AdvanceClock` moves the clock. On the wire: `15m`, `1h`, `1d`, `next-opening`,
/// and `<n>m` for the Sandbox's free `minutes` command.
///
/// `1d` is 86,400 seconds of business time, not "the same clock time tomorrow": across a
/// daylight transition the local clock reads an hour later or earlier. The offset is an
/// interval, as the Sandbox holds it, and the bakery's day boundaries are the calendar's
/// business, not the clock's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClockStep {
    Minutes15,
    Hour,
    Day,
    /// The next 07:00 on an open day strictly after now.
    NextOpening,
    /// A positive number of minutes: the Sandbox's `minutes` command as PR 3 built it.
    /// `Minutes(15)` writes as `15m`, which reads back as [`ClockStep::Minutes15`], the same move.
    Minutes(u32),
}

/// Why the clock refused to move.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ClockError {
    /// A `minutes` step of zero; the offset only grows.
    #[error("the clock moves forward by a positive number of minutes")]
    NotPositive,
    /// The move would take the offset past the cap.
    #[error("the business clock moves at most {max_s} seconds ahead of wall time in total")]
    OffsetCap { max_s: i64 },
}

impl ClockError {
    /// The slug a problem document names the rule by.
    pub fn rule(&self) -> &'static str {
        match self {
            ClockError::NotPositive => "not-positive",
            ClockError::OffsetCap { .. } => "offset-cap",
        }
    }
}

/// The new offset, in seconds, after `step` from `offset_s`, where `now_business` is the
/// business time at the current offset. Refused when the step is empty or the result passes
/// [`MAX_OFFSET_S`].
pub fn advance(
    offset_s: i64,
    step: ClockStep,
    now_business: BusinessTime,
) -> Result<i64, ClockError> {
    let cap = ClockError::OffsetCap {
        max_s: MAX_OFFSET_S,
    };
    let by_s: i64 = match step {
        ClockStep::Minutes15 => 15 * 60,
        ClockStep::Hour => 3_600,
        ClockStep::Day => 86_400,
        ClockStep::Minutes(0) => return Err(ClockError::NotPositive),
        ClockStep::Minutes(n) => i64::from(n) * 60,
        ClockStep::NextOpening => {
            // Business time is held to the second, so the difference is whole seconds.
            (next_opening(now_business).unix_ms() - now_business.unix_ms()) / 1_000
        }
    };
    let moved = offset_s.checked_add(by_s).ok_or(cap)?;
    if moved > MAX_OFFSET_S {
        return Err(cap);
    }
    Ok(moved)
}

impl fmt::Display for ClockStep {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClockStep::Minutes15 => f.write_str("15m"),
            ClockStep::Hour => f.write_str("1h"),
            ClockStep::Day => f.write_str("1d"),
            ClockStep::NextOpening => f.write_str("next-opening"),
            ClockStep::Minutes(n) => write!(f, "{n}m"),
        }
    }
}

/// A step name the clock does not know.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("unknown clock step {0:?}: one of 15m, 1h, 1d, next-opening or <minutes>m")]
pub struct UnknownStep(pub String);

impl FromStr for ClockStep {
    type Err = UnknownStep;

    fn from_str(s: &str) -> Result<ClockStep, UnknownStep> {
        let unknown = || UnknownStep(s.chars().take(20).collect());
        Ok(match s {
            "15m" => ClockStep::Minutes15,
            "1h" => ClockStep::Hour,
            "1d" => ClockStep::Day,
            "next-opening" => ClockStep::NextOpening,
            _ => {
                let digits = s.strip_suffix('m').ok_or_else(unknown)?;
                // Canonical digits only: no sign, no leading zero, so text round-trips.
                if digits.is_empty()
                    || !digits.bytes().all(|b| b.is_ascii_digit())
                    || (digits.len() > 1 && digits.starts_with('0'))
                {
                    return Err(unknown());
                }
                ClockStep::Minutes(digits.parse().map_err(|_| unknown())?)
            }
        })
    }
}

impl Serialize for ClockStep {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for ClockStep {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<ClockStep, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn at(text: &str) -> BusinessTime {
        text.parse().unwrap()
    }

    const SATURDAY_NOON: &str = "2026-11-07T12:00:00-07:00";

    #[test]
    fn each_step_moves_by_its_amount() {
        let now = at(SATURDAY_NOON);
        assert_eq!(advance(0, ClockStep::Minutes15, now), Ok(900));
        assert_eq!(advance(0, ClockStep::Hour, now), Ok(3_600));
        assert_eq!(advance(0, ClockStep::Day, now), Ok(86_400));
        assert_eq!(advance(600, ClockStep::Minutes(90), now), Ok(6_000));
        // Saturday noon to Sunday 07:00 is 19 hours.
        assert_eq!(advance(0, ClockStep::NextOpening, now), Ok(19 * 3_600));
        assert_eq!(
            advance(0, ClockStep::Minutes(0), now),
            Err(ClockError::NotPositive)
        );
        assert_eq!(ClockError::NotPositive.rule(), "not-positive");
    }

    #[test]
    fn a_sunday_evening_opens_on_tuesday() {
        let sunday = at("2026-11-08T18:30:00-07:00");
        let offset = advance(3_600, ClockStep::NextOpening, sunday).unwrap();
        // Sunday 18:30 to Tuesday 07:00 is 36 h 30 min.
        assert_eq!(offset - 3_600, 36 * 3_600 + 30 * 60);
        let then = sunday.plus_minutes((offset - 3_600) / 60).unwrap();
        assert_eq!(then.to_string(), "2026-11-10T07:00:00-07:00");
    }

    #[test]
    fn the_offset_never_passes_fourteen_days() {
        let now = at(SATURDAY_NOON);
        assert_eq!(advance(13 * 86_400, ClockStep::Day, now), Ok(MAX_OFFSET_S));
        let cap = Err(ClockError::OffsetCap {
            max_s: MAX_OFFSET_S,
        });
        assert_eq!(advance(MAX_OFFSET_S, ClockStep::Minutes15, now), cap);
        assert_eq!(advance(MAX_OFFSET_S - 899, ClockStep::Minutes15, now), cap);
        assert_eq!(advance(0, ClockStep::Minutes(14 * 24 * 60 + 1), now), cap);
        assert_eq!(advance(i64::MAX, ClockStep::Hour, now), cap);
        // Next opening from Saturday noon is 19 h; with 13 d 6 h used it would pass the cap.
        assert_eq!(
            advance(13 * 86_400 + 6 * 3_600, ClockStep::NextOpening, now),
            cap
        );
        assert_eq!(
            ClockError::OffsetCap {
                max_s: MAX_OFFSET_S
            }
            .rule(),
            "offset-cap"
        );
    }

    #[test]
    fn a_day_across_spring_forward_is_24_hours() {
        // Saturday 07:00 MST plus one day is Sunday 08:00 MDT: 86,400 s of business time.
        let sat = at("2026-03-07T07:00:00-07:00");
        let offset = advance(0, ClockStep::Day, sat).unwrap();
        let then = crate::calendar::local(sat.unix_ms() + offset * 1_000).unwrap();
        assert_eq!(then.to_string(), "2026-03-08T08:00:00-06:00");
        // Next opening from Saturday 08:00 is Sunday 07:00 MDT: 22 hours, not 23, because the
        // night loses an hour.
        let morning = at("2026-03-07T08:00:00-07:00");
        assert_eq!(advance(0, ClockStep::NextOpening, morning), Ok(22 * 3_600));
    }

    #[test]
    fn wire_names() {
        for (step, text) in [
            (ClockStep::Minutes15, "15m"),
            (ClockStep::Hour, "1h"),
            (ClockStep::Day, "1d"),
            (ClockStep::NextOpening, "next-opening"),
            (ClockStep::Minutes(90), "90m"),
        ] {
            assert_eq!(serde_json::to_value(step).unwrap(), text);
            assert_eq!(
                serde_json::from_value::<ClockStep>(text.into()).unwrap(),
                step
            );
        }
        assert_eq!("15m".parse::<ClockStep>(), Ok(ClockStep::Minutes15));
        for bad in [
            "",
            "m",
            "2h",
            "-5m",
            "05m",
            "1 d",
            "next_opening",
            "99999999999m",
        ] {
            assert!(bad.parse::<ClockStep>().is_err(), "{bad:?}");
        }
    }

    proptest! {
        #[test]
        fn the_offset_only_grows_and_stays_capped(
            start in 0i64..=MAX_OFFSET_S,
            pick in 0u8..5,
            n in 0u32..30_000,
            now_s in 1_770_000_000i64..1_830_000_000,
        ) {
            let step = match pick {
                0 => ClockStep::Minutes15,
                1 => ClockStep::Hour,
                2 => ClockStep::Day,
                3 => ClockStep::NextOpening,
                _ => ClockStep::Minutes(n),
            };
            let now = crate::calendar::local(now_s * 1_000).unwrap();
            if let Ok(moved) = advance(start, step, now) {
                prop_assert!(moved > start);
                prop_assert!(moved <= MAX_OFFSET_S);
            }
        }
    }
}
