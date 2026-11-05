//! Civil-date arithmetic for the seed: the day of the week, the birth date and business times
//! at the bakery's Mountain standard offset.
//!
//! The day-count functions (Howard Hinnant's `days_from_civil` and `civil_from_days`, and the
//! weekday) live in `bakery_domain::calendar`, the one copy, and are re-exported here.
//!
//! The seed's business times use the standard offset, `-07:00`, all year, while the domain's
//! calendar is daylight-aware. Its pinned ULIDs take their time parts from these times, so
//! moving the seed to the calendar's offset would change every pin for a birth date in summer.

use std::fmt;

pub use bakery_domain::calendar::{civil_from_days, days_from_civil, weekday};
use bakery_domain::{BusinessTime, MS_PER_DAY};
use serde::{Serialize, Serializer};

/// Mountain standard time, minutes east of UTC. The seed uses `-07:00` throughout; the domain's
/// calendar (`bakery_domain::calendar`) applies the zone's summer rule.
pub const OFFSET_MINUTES: i16 = -420;

/// Short names, Monday first, as `days_baked` lists them.
pub const WEEKDAY_NAMES: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
pub const MONDAY: u8 = 0;
pub const SATURDAY: u8 = 5;
pub const SUNDAY: u8 = 6;

/// `YYYY-MM-DD` for a day count.
pub fn date_string(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// A business time `minutes` after midnight of the day `days`, at the Mountain offset. Negative
/// minutes reach back into earlier days.
pub fn business_time(days: i64, minutes: i64) -> BusinessTime {
    let utc_ms = days * MS_PER_DAY + (minutes - i64::from(OFFSET_MINUTES)) * 60_000;
    BusinessTime::new(utc_ms, OFFSET_MINUTES).expect("seed dates are far inside the year range")
}

/// The sandbox's birth business date, `YYYY-MM-DD`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BirthDate {
    days: i64,
}

/// What was wrong with a birth date.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BirthDateError;

impl fmt::Display for BirthDateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a birth date is YYYY-MM-DD, a real date from 1971 to 9000")
    }
}

impl std::error::Error for BirthDateError {}

impl BirthDate {
    /// Exactly `YYYY-MM-DD`, ASCII digits, a date that exists. Years from 1971 leave room for
    /// the 90 days of history before it; 9000 keeps every time inside the year range.
    pub fn parse(text: &str) -> Result<BirthDate, BirthDateError> {
        let b = text.as_bytes();
        if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
            return Err(BirthDateError);
        }
        let digits = |range: std::ops::Range<usize>| -> Result<i64, BirthDateError> {
            let mut n = 0i64;
            for &c in &b[range] {
                if !c.is_ascii_digit() {
                    return Err(BirthDateError);
                }
                n = n * 10 + i64::from(c - b'0');
            }
            Ok(n)
        };
        let (y, m, d) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
        if !(1971..=9000).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
            return Err(BirthDateError);
        }
        let days = days_from_civil(y, m, d);
        // A date that does not exist (February 30) comes back as another one.
        if civil_from_days(days) != (y, m, d) {
            return Err(BirthDateError);
        }
        Ok(BirthDate { days })
    }

    /// Days since 1970-01-01.
    pub fn days(self) -> i64 {
        self.days
    }
}

impl fmt::Display for BirthDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&date_string(self.days))
    }
}

impl Serialize for BirthDate {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_dates_round_trip() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(days_from_civil(2026, 11, 7), 20_764);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        for z in [-1, 0, 59, 60, 11_016, 11_017, 20_764, 47_482, -719_468] {
            let (y, m, d) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z);
        }
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }

    #[test]
    fn weekdays_match_the_calendar() {
        let wd = |y, m, d| WEEKDAY_NAMES[usize::from(weekday(days_from_civil(y, m, d)))];
        assert_eq!(wd(1970, 1, 1), "thu");
        assert_eq!(wd(2000, 1, 1), "sat");
        assert_eq!(wd(2026, 11, 5), "thu");
        assert_eq!(wd(2026, 11, 7), "sat");
        assert_eq!(wd(2026, 11, 8), "sun");
        assert_eq!(wd(2026, 11, 9), "mon");
        assert_eq!(wd(1969, 12, 29), "mon");
    }

    #[test]
    fn birth_dates_parse_strictly() {
        let d = BirthDate::parse("2026-11-07").unwrap();
        assert_eq!(d.to_string(), "2026-11-07");
        assert_eq!(d.days(), 20_764);
        assert!(BirthDate::parse("2024-02-29").is_ok());
        for bad in [
            "",
            "2026-11-7",
            "2026/11/07",
            "2026-13-01",
            "2026-02-30",
            "2025-02-29",
            "2026-11-07 ",
            "２０２６-11-07",
            "1970-01-01",
            "20261107",
            "abcd-ef-gh",
        ] {
            assert!(BirthDate::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn business_times_carry_the_mountain_offset() {
        let t = business_time(days_from_civil(2026, 11, 7), 9 * 60 + 15);
        assert_eq!(t.to_string(), "2026-11-07T09:15:00-07:00");
        let earlier = business_time(days_from_civil(2026, 11, 7), -30);
        assert_eq!(earlier.to_string(), "2026-11-06T23:30:00-07:00");
    }
}
