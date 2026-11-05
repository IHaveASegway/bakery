//! Business time and wall time (docs/domain.md, "Money and time").
//!
//! Both are held as `i64` Unix milliseconds, so arithmetic and comparison are integer work, and
//! both travel as RFC 3339 strings in one canonical form each, so a value read from JSON writes
//! back byte for byte:
//!
//! - `WallTime`, the platform's time: UTC with milliseconds, `2026-11-04T19:12:10.318Z`. Alarms,
//!   the wipe, `recorded_at`, `Control`'s ledger and logs use it.
//! - `BusinessTime`, wall time plus the sandbox's offset, shown with the bakery's UTC offset and
//!   held to the second: `2026-11-07T12:12:10-07:00`. Every domain rule reads it.
//!
//! Neither reads a clock. The `Clock` port in `bakery-app` hands them in.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::DomainError;

pub const MS_PER_DAY: i64 = 86_400_000;
const MS_PER_SECOND: i64 = 1_000;

/// The platform's time: Unix milliseconds, shown in UTC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WallTime(i64);

impl WallTime {
    /// Refuses times outside the years 0000 to 9999, which RFC 3339 cannot write.
    pub fn from_unix_ms(unix_ms: i64) -> Result<WallTime, DomainError> {
        check_range(unix_ms)?;
        Ok(WallTime(unix_ms))
    }

    pub fn unix_ms(self) -> i64 {
        self.0
    }

    /// The UTC calendar date, `YYYY-MM-DD`: the key of `Control`'s daily ledger.
    pub fn utc_day(self) -> String {
        let (y, m, d) = civil_from_days(self.0.div_euclid(MS_PER_DAY));
        format!("{y:04}-{m:02}-{d:02}")
    }

    /// The next 00:00 UTC strictly after this instant.
    pub fn next_utc_midnight(self) -> WallTime {
        WallTime((self.0.div_euclid(MS_PER_DAY) + 1) * MS_PER_DAY)
    }

    /// This instant moved by `days` whole days, refused outside the representable range.
    pub fn plus_days(self, days: i64) -> Result<WallTime, DomainError> {
        let moved = days
            .checked_mul(MS_PER_DAY)
            .and_then(|ms| self.0.checked_add(ms))
            .ok_or_else(|| DomainError::InvalidTime(format!("{days} days from {self}")))?;
        WallTime::from_unix_ms(moved)
    }
}

impl fmt::Display for WallTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let millis = self.0.rem_euclid(MS_PER_SECOND);
        write_civil(f, self.0.div_euclid(MS_PER_SECOND))?;
        write!(f, ".{millis:03}Z")
    }
}

impl FromStr for WallTime {
    type Err = DomainError;

    /// Accepts only `YYYY-MM-DDTHH:MM:SS.mmmZ`.
    fn from_str(s: &str) -> Result<WallTime, DomainError> {
        let invalid = || DomainError::InvalidTime(s.chars().take(40).collect());
        let b = s.as_bytes();
        if b.len() != 24 || b[19] != b'.' || b[23] != b'Z' {
            return Err(invalid());
        }
        let seconds = parse_civil(&b[..19]).ok_or_else(invalid)?;
        let millis = digits(&b[20..23]).ok_or_else(invalid)?;
        WallTime::from_unix_ms(seconds * MS_PER_SECOND + millis).map_err(|_| invalid())
    }
}

/// Wall time plus the sandbox's offset, shown at the bakery's UTC offset, held to the second.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BusinessTime {
    unix_ms: i64,
    offset_minutes: i16,
}

impl BusinessTime {
    /// Truncates to the whole second, since business time is shown to the second. The offset
    /// is the bakery's, `-420` in Mountain standard time and `-360` in summer; the zone's rules
    /// arrive with the first rule that needs them.
    pub fn new(unix_ms: i64, offset_minutes: i16) -> Result<BusinessTime, DomainError> {
        if offset_minutes.unsigned_abs() >= 24 * 60 {
            return Err(DomainError::InvalidTime(format!(
                "offset {offset_minutes} minutes"
            )));
        }
        let unix_ms = unix_ms.div_euclid(MS_PER_SECOND) * MS_PER_SECOND;
        check_range(unix_ms + i64::from(offset_minutes) * 60_000)?;
        Ok(BusinessTime {
            unix_ms,
            offset_minutes,
        })
    }

    pub fn unix_ms(self) -> i64 {
        self.unix_ms
    }

    pub fn offset_minutes(self) -> i16 {
        self.offset_minutes
    }
}

/// Business times order by instant; the offset only changes how one is shown.
impl PartialOrd for BusinessTime {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for BusinessTime {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (self.unix_ms, self.offset_minutes).cmp(&(other.unix_ms, other.offset_minutes))
    }
}

impl fmt::Display for BusinessTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let local = self.unix_ms / MS_PER_SECOND + i64::from(self.offset_minutes) * 60;
        write_civil(f, local)?;
        let sign = if self.offset_minutes < 0 { '-' } else { '+' };
        let abs = self.offset_minutes.unsigned_abs();
        write!(f, "{sign}{:02}:{:02}", abs / 60, abs % 60)
    }
}

impl FromStr for BusinessTime {
    type Err = DomainError;

    /// Accepts only `YYYY-MM-DDTHH:MM:SS±HH:MM`; `-00:00`, which means "offset unknown", is
    /// refused.
    fn from_str(s: &str) -> Result<BusinessTime, DomainError> {
        let invalid = || DomainError::InvalidTime(s.chars().take(40).collect());
        let b = s.as_bytes();
        if b.len() != 25 || b[22] != b':' {
            return Err(invalid());
        }
        let local = parse_civil(&b[..19]).ok_or_else(invalid)?;
        let sign: i64 = match b[19] {
            b'+' => 1,
            b'-' => -1,
            _ => return Err(invalid()),
        };
        let hours = digits(&b[20..22]).ok_or_else(invalid)?;
        let minutes = digits(&b[23..25]).ok_or_else(invalid)?;
        if hours > 23 || minutes > 59 || (sign < 0 && hours == 0 && minutes == 0) {
            return Err(invalid());
        }
        let offset = sign * (hours * 60 + minutes);
        let offset_minutes = i16::try_from(offset).map_err(|_| invalid())?;
        BusinessTime::new((local - offset * 60) * MS_PER_SECOND, offset_minutes)
            .map_err(|_| invalid())
    }
}

macro_rules! serde_as_text {
    ($t:ty) => {
        impl Serialize for $t {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.collect_str(self)
            }
        }

        impl<'de> Deserialize<'de> for $t {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<$t, D::Error> {
                let text = String::deserialize(deserializer)?;
                text.parse().map_err(serde::de::Error::custom)
            }
        }
    };
}

serde_as_text!(WallTime);
serde_as_text!(BusinessTime);

// 0000-01-01T00:00:00Z and the last millisecond of 9999.
const MIN_MS: i64 = -62_167_219_200_000;
const MAX_MS: i64 = 253_402_300_799_999;

fn check_range(unix_ms: i64) -> Result<(), DomainError> {
    if (MIN_MS..=MAX_MS).contains(&unix_ms) {
        Ok(())
    } else {
        Err(DomainError::InvalidTime(format!(
            "{unix_ms} ms is outside 0000 to 9999"
        )))
    }
}

/// Writes `YYYY-MM-DDTHH:MM:SS` for Unix seconds.
fn write_civil(f: &mut fmt::Formatter<'_>, unix_s: i64) -> fmt::Result {
    let (y, m, d) = civil_from_days(unix_s.div_euclid(86_400));
    let secs = unix_s.rem_euclid(86_400);
    write!(
        f,
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}",
        secs / 3_600,
        secs / 60 % 60,
        secs % 60
    )
}

/// Reads `YYYY-MM-DDTHH:MM:SS` as Unix seconds, refusing impossible dates and times.
fn parse_civil(b: &[u8]) -> Option<i64> {
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, m, d) = (digits(&b[0..4])?, digits(&b[5..7])?, digits(&b[8..10])?);
    let (hh, mm, ss) = (
        digits(&b[11..13])?,
        digits(&b[14..16])?,
        digits(&b[17..19])?,
    );
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) || hh > 23 || mm > 59 || ss > 59 {
        return None;
    }
    Some(days_from_civil(y, m, d) * 86_400 + hh * 3_600 + mm * 60 + ss)
}

fn digits(b: &[u8]) -> Option<i64> {
    b.iter().try_fold(0i64, |acc, &c| {
        c.is_ascii_digit().then(|| acc * 10 + i64::from(c - b'0'))
    })
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        4 | 6 | 9 | 11 => 30,
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        _ => 31,
    }
}

// Howard Hinnant's civil-date algorithms, "chrono-Compatible Low-Level Date Algorithms".
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn wall_time_reads_and_writes_the_docs_example() {
        let text = "2026-11-04T19:12:10.318Z";
        let t: WallTime = text.parse().unwrap();
        assert_eq!(t.unix_ms(), 1_793_819_530_318);
        assert_eq!(t.to_string(), text);
    }

    #[test]
    fn business_time_reads_and_writes_the_docs_example() {
        let text = "2026-11-07T12:12:10-07:00";
        let t: BusinessTime = text.parse().unwrap();
        assert_eq!(t.offset_minutes(), -420);
        assert_eq!(
            t.unix_ms(),
            "2026-11-07T19:12:10.000Z"
                .parse::<WallTime>()
                .unwrap()
                .unix_ms()
        );
        assert_eq!(t.to_string(), text);
    }

    #[test]
    fn utc_day_and_next_midnight() {
        let t: WallTime = "2026-11-04T23:59:59.999Z".parse().unwrap();
        assert_eq!(t.utc_day(), "2026-11-04");
        assert_eq!(
            t.next_utc_midnight().to_string(),
            "2026-11-05T00:00:00.000Z"
        );
        let midnight: WallTime = "2026-11-05T00:00:00.000Z".parse().unwrap();
        assert_eq!(
            midnight.next_utc_midnight().to_string(),
            "2026-11-06T00:00:00.000Z"
        );
        assert_eq!(midnight.plus_days(-35).unwrap().utc_day(), "2026-10-01");
    }

    #[test]
    fn leap_days() {
        assert!("2028-02-29T00:00:00.000Z".parse::<WallTime>().is_ok());
        assert!("2026-02-29T00:00:00.000Z".parse::<WallTime>().is_err());
        assert!("2100-02-29T00:00:00.000Z".parse::<WallTime>().is_err());
        assert!("2000-02-29T00:00:00.000Z".parse::<WallTime>().is_ok());
    }

    #[test]
    fn refuses_non_canonical_text() {
        for bad in [
            "2026-11-04T19:12:10Z",
            "2026-11-04T19:12:10.318+00:00",
            "2026-11-04 19:12:10.318Z",
            "2026-13-04T19:12:10.318Z",
            "2026-11-04T24:00:00.000Z",
        ] {
            assert!(bad.parse::<WallTime>().is_err(), "{bad}");
        }
        for bad in [
            "2026-11-07T12:12:10.000-07:00",
            "2026-11-07T12:12:10Z",
            "2026-11-07T12:12:10-00:00",
            "2026-11-07T12:12:10-24:00",
        ] {
            assert!(bad.parse::<BusinessTime>().is_err(), "{bad}");
        }
    }

    #[test]
    fn business_time_truncates_to_the_second() {
        let t = BusinessTime::new(1_793_819_530_318, -420).unwrap();
        assert_eq!(t.unix_ms(), 1_793_819_530_000);
    }

    proptest! {
        #[test]
        fn wall_time_text_round_trips(ms in MIN_MS..=MAX_MS) {
            let t = WallTime::from_unix_ms(ms).unwrap();
            prop_assert_eq!(t.to_string().parse::<WallTime>(), Ok(t));
        }

        #[test]
        fn business_time_text_round_trips(s in -60_000_000_000i64..250_000_000_000, offset in -1_439i16..=1_439) {
            let t = BusinessTime::new(s * 1_000, offset).unwrap();
            prop_assert_eq!(t.to_string().parse::<BusinessTime>(), Ok(t));
        }
    }
}
