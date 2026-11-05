//! Civil-date arithmetic for the seed: the day of the week, the birth date and business times
//! under America/Denver's rule.
//!
//! The day-count functions (Howard Hinnant's `days_from_civil` and `civil_from_days`, and the
//! weekday) live in `bakery_domain::calendar`, the one copy, and are re-exported here. The seed's
//! business times go through the same calendar, so a summer date carries `-06:00` and a winter
//! date `-07:00`.

use std::fmt;

use bakery_domain::BusinessTime;
use bakery_domain::calendar::BakeryDate;
pub use bakery_domain::calendar::{civil_from_days, days_from_civil, weekday};
use serde::{Serialize, Serializer};

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

/// The instant the local clock reads `minutes` after midnight on the civil day `days`, at the
/// offset Denver uses then. Minutes outside the day (negative, or past 24 hours) count elapsed
/// minutes from that day's midnight, so they reach into the neighbouring days.
pub fn business_time(days: i64, minutes: i64) -> BusinessTime {
    let date = BakeryDate::from_days(days);
    match u16::try_from(minutes) {
        Ok(m) if m < 24 * 60 => date.at_local(m),
        _ => {
            let midnight = date.at_local(0);
            bakery_domain::calendar::local(midnight.unix_ms() + minutes * 60_000)
                .expect("seed dates are far inside the year range")
        }
    }
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

    #[test]
    fn summer_business_times_carry_the_daylight_offset() {
        let t = business_time(days_from_civil(2026, 7, 14), 14 * 60 + 45);
        assert_eq!(t.to_string(), "2026-07-14T14:45:00-06:00");
        assert_eq!(BakeryDate::of(t).to_string(), "2026-07-14");
        let earlier = business_time(days_from_civil(2026, 7, 14), -30);
        assert_eq!(earlier.to_string(), "2026-07-13T23:30:00-06:00");
        // The day the clocks go forward: 07:00 is already daylight time.
        let spring = business_time(days_from_civil(2026, 3, 8), 7 * 60);
        assert_eq!(spring.to_string(), "2026-03-08T07:00:00-06:00");
    }
}
