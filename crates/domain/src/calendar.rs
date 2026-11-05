//! The bakery's calendar (docs/domain.md, "Money and time"): the bakery day is a calendar date
//! in America/Denver, open 07:00 to 15:00 Tuesday to Sunday, with pickup slots on the quarter
//! hour and delivery windows at 09:00, 11:00 and 13:00.
//!
//! Pure arithmetic, no time-zone crate. America/Denver's offset follows the US rule in force
//! since 2007: standard time is `-07:00`, and daylight time, `-06:00`, runs from 02:00 local on
//! the second Sunday in March to 02:00 local on the first Sunday in November. The rule is
//! computed for any year; dates before 2007 get the same rule, which is wrong for them and
//! irrelevant here, since no sandbox lives before 2026.
//!
//! The civil-day functions ([`days_from_civil`], [`civil_from_days`], [`weekday`]) are the one
//! copy in the workspace: `time` uses them and `bakery-seed` re-exports them.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::catalog::Weekday;
use crate::{BusinessTime, DomainError, MS_PER_DAY};

/// Mountain standard time, minutes east of UTC.
pub const STANDARD_OFFSET_MINUTES: i16 = -420;
/// Mountain daylight time, minutes east of UTC.
pub const DAYLIGHT_OFFSET_MINUTES: i16 = -360;
/// The bakery opens at 07:00 local, minutes after midnight.
pub const OPENING_MINUTES: u16 = 7 * 60;
/// The bakery closes at 15:00 local, minutes after midnight.
pub const CLOSING_MINUTES: u16 = 15 * 60;
/// A pickup slot is 15 minutes long.
pub const SLOT_MINUTES: u16 = 15;
/// 32 pickup slots a day: 07:00 to 14:45 on the quarter hour.
pub const SLOTS_PER_DAY: usize = ((CLOSING_MINUTES - OPENING_MINUTES) / SLOT_MINUTES) as usize;
/// A delivery window is 2 hours long.
pub const WINDOW_MINUTES: u16 = 120;
/// The three delivery windows' starts, minutes after midnight: 09:00, 11:00 and 13:00.
pub const WINDOW_STARTS: [u16; 3] = [9 * 60, 11 * 60, 13 * 60];

const MS_PER_MINUTE: i64 = 60_000;
const MS_PER_HOUR: i64 = 3_600_000;

// Howard Hinnant's civil-date algorithms, "chrono-Compatible Low-Level Date Algorithms".

/// Days since 1970-01-01 of a proleptic Gregorian date.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The `(year, month, day)` of a day count from 1970-01-01.
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
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

/// The day of the week of a day count, Monday 0 to Sunday 6. 1970-01-01 was a Thursday.
pub fn weekday(days: i64) -> u8 {
    // The remainder is 0 to 6, so it fits.
    (days + 3).rem_euclid(7) as u8
}

/// The day count of the `n`th Sunday (1-based) of a month.
fn nth_sunday(y: i64, m: i64, n: i64) -> i64 {
    let first = days_from_civil(y, m, 1);
    let to_sunday = (6 - i64::from(weekday(first))).rem_euclid(7);
    first + to_sunday + 7 * (n - 1)
}

/// The UTC instants daylight time starts and ends in year `y`: 02:00 standard time (09:00 UTC)
/// on the second Sunday in March, and 02:00 daylight time (08:00 UTC) on the first Sunday in
/// November.
fn daylight_bounds(y: i64) -> (i64, i64) {
    let start = nth_sunday(y, 3, 2) * MS_PER_DAY + 9 * MS_PER_HOUR;
    let end = nth_sunday(y, 11, 1) * MS_PER_DAY + 8 * MS_PER_HOUR;
    (start, end)
}

/// America/Denver's offset from UTC at an instant, in minutes: `-360` in daylight time, `-420`
/// otherwise.
pub fn offset_minutes_at(unix_ms: i64) -> i16 {
    // The transitions are in March and November, so the UTC year is the local year there.
    let (y, _, _) = civil_from_days(unix_ms.div_euclid(MS_PER_DAY));
    let (start, end) = daylight_bounds(y);
    if (start..end).contains(&unix_ms) {
        DAYLIGHT_OFFSET_MINUTES
    } else {
        STANDARD_OFFSET_MINUTES
    }
}

/// An instant as the bakery's business time, at the offset Denver uses then. Refused outside
/// the years 0000 to 9999.
pub fn local(unix_ms: i64) -> Result<BusinessTime, DomainError> {
    BusinessTime::new(unix_ms, offset_minutes_at(unix_ms))
}

/// A bakery day: a calendar date in America/Denver. `YYYY-MM-DD` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BakeryDate {
    y: i32,
    m: u8,
    d: u8,
}

impl BakeryDate {
    /// Refuses a date that does not exist and years outside 0001 to 9998, so the day's every
    /// time is representable.
    pub fn new(y: i32, m: u8, d: u8) -> Option<BakeryDate> {
        if !(1..=9998).contains(&y) || !(1..=12).contains(&m) || d == 0 {
            return None;
        }
        let days = days_from_civil(i64::from(y), i64::from(m), i64::from(d));
        (civil_from_days(days) == (i64::from(y), i64::from(m), i64::from(d)))
            .then_some(BakeryDate { y, m, d })
    }

    /// The bakery day an instant falls on, read at Denver's offset at that instant, whatever
    /// offset `t` is shown at.
    pub fn of(t: BusinessTime) -> BakeryDate {
        let local_ms = t.unix_ms() + i64::from(offset_minutes_at(t.unix_ms())) * MS_PER_MINUTE;
        BakeryDate::from_days(local_ms.div_euclid(MS_PER_DAY))
    }

    /// The date `days` after 1970-01-01.
    pub fn from_days(days: i64) -> BakeryDate {
        let (y, m, d) = civil_from_days(days);
        // A business time's day is within 0000 to 9999, and a month and day always fit.
        BakeryDate {
            y: y as i32,
            m: m as u8,
            d: d as u8,
        }
    }

    pub fn y(self) -> i32 {
        self.y
    }

    pub fn m(self) -> u8 {
        self.m
    }

    pub fn d(self) -> u8 {
        self.d
    }

    /// Days since 1970-01-01.
    pub fn days(self) -> i64 {
        days_from_civil(i64::from(self.y), i64::from(self.m), i64::from(self.d))
    }

    /// The date `n` days later (earlier when negative).
    pub fn plus_days(self, n: i64) -> BakeryDate {
        BakeryDate::from_days(self.days() + n)
    }

    pub fn weekday(self) -> Weekday {
        Weekday::ALL[usize::from(weekday(self.days()))]
    }

    /// Whether the bakery opens this day: Tuesday to Sunday.
    pub fn is_open(self) -> bool {
        self.weekday() != Weekday::Mon
    }

    /// The instant the local clock reads `minutes` after midnight on this day, at the offset
    /// in force then. Bakery hours never meet a transition (they are at 02:00); for the record,
    /// a time in the spring gap reads at standard time, and one in the autumn's repeated hour
    /// is its first, daylight, occurrence.
    pub fn at_local(self, minutes: u16) -> BusinessTime {
        let local_ms = self.days() * MS_PER_DAY + i64::from(minutes) * MS_PER_MINUTE;
        let utc = [DAYLIGHT_OFFSET_MINUTES, STANDARD_OFFSET_MINUTES]
            .into_iter()
            .map(|off| local_ms - i64::from(off) * MS_PER_MINUTE)
            .find(|&utc| {
                let off = offset_minutes_at(utc);
                utc + i64::from(off) * MS_PER_MINUTE == local_ms
            })
            .unwrap_or(local_ms - i64::from(STANDARD_OFFSET_MINUTES) * MS_PER_MINUTE);
        local(utc).expect("a bakery date's times are within the year range")
    }

    /// The `n`th open day (a business day: Tuesday to Sunday) strictly after this one, so
    /// `n = 1` is the next open day. This day never counts itself, open or not.
    pub fn nth_open_day_after(self, n: u32) -> BakeryDate {
        let mut day = self;
        let mut left = n;
        while left > 0 {
            day = day.plus_days(1);
            if day.is_open() {
                left -= 1;
            }
        }
        day
    }

    /// Calendar days from `self` to `later`; negative when `later` comes first.
    pub fn days_until(self, later: BakeryDate) -> i64 {
        later.days() - self.days()
    }

    /// 07:00 local.
    pub fn opening(self) -> BusinessTime {
        self.at_local(OPENING_MINUTES)
    }

    /// 15:00 local.
    pub fn closing(self) -> BusinessTime {
        self.at_local(CLOSING_MINUTES)
    }

    /// The 32 pickup slot starts, 07:00 to 14:45 on the quarter hour.
    pub fn slot_starts(self) -> Vec<BusinessTime> {
        slot_minutes().map(|m| self.at_local(m)).collect()
    }

    /// The three delivery window starts, 09:00, 11:00 and 13:00.
    pub fn window_starts(self) -> Vec<BusinessTime> {
        WINDOW_STARTS.iter().map(|&m| self.at_local(m)).collect()
    }
}

/// The local minutes after midnight of the 32 slot starts.
pub fn slot_minutes() -> impl Iterator<Item = u16> {
    (OPENING_MINUTES..CLOSING_MINUTES).step_by(usize::from(SLOT_MINUTES))
}

/// The local minutes after midnight of a business time, on its bakery day.
pub fn local_minutes(t: BusinessTime) -> u16 {
    let local_ms = t.unix_ms() + i64::from(offset_minutes_at(t.unix_ms())) * MS_PER_MINUTE;
    // A day has 1,440 minutes, so it fits.
    (local_ms.rem_euclid(MS_PER_DAY) / MS_PER_MINUTE) as u16
}

/// `t` moved by `days` calendar days at the same local wall-clock time, at the offset Denver
/// uses on the day it lands: "a week later" across a daylight transition is still the same hour
/// on the clock.
pub fn same_time_days_later(t: BusinessTime, days: i64) -> BusinessTime {
    BakeryDate::of(t).plus_days(days).at_local(local_minutes(t))
}

/// `t` plus `minutes` of elapsed time, shown at the offset Denver uses then.
pub fn plus_elapsed_minutes(t: BusinessTime, minutes: i64) -> Result<BusinessTime, DomainError> {
    let ms = minutes
        .checked_mul(MS_PER_MINUTE)
        .and_then(|d| t.unix_ms().checked_add(d))
        .ok_or_else(|| DomainError::InvalidTime(format!("{minutes} minutes from {t}")))?;
    local(ms)
}

/// The next 07:00 on an open day strictly after `after`: what "next opening" moves the clock to.
pub fn next_opening(after: BusinessTime) -> BusinessTime {
    let mut day = BakeryDate::of(after);
    loop {
        let opening = day.opening();
        if day.is_open() && opening.unix_ms() > after.unix_ms() {
            return opening;
        }
        day = day.plus_days(1);
    }
}

impl fmt::Display for BakeryDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.y, self.m, self.d)
    }
}

impl FromStr for BakeryDate {
    type Err = DomainError;

    /// Accepts only `YYYY-MM-DD`, a date that exists.
    fn from_str(s: &str) -> Result<BakeryDate, DomainError> {
        let invalid = || DomainError::InvalidTime(s.chars().take(20).collect());
        let b = s.as_bytes();
        if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
            return Err(invalid());
        }
        let num = |r: std::ops::Range<usize>| -> Option<u32> {
            b[r].iter().try_fold(0u32, |acc, &c| {
                c.is_ascii_digit().then(|| acc * 10 + u32::from(c - b'0'))
            })
        };
        let (y, m, d) = (
            num(0..4).ok_or_else(invalid)?,
            num(5..7).ok_or_else(invalid)?,
            num(8..10).ok_or_else(invalid)?,
        );
        // Four digits and two digits always fit.
        BakeryDate::new(y as i32, m as u8, d as u8).ok_or_else(invalid)
    }
}

impl Serialize for BakeryDate {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for BakeryDate {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<BakeryDate, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WallTime;
    use proptest::prelude::*;

    fn wall(text: &str) -> i64 {
        text.parse::<WallTime>().unwrap().unix_ms()
    }

    fn date(text: &str) -> BakeryDate {
        text.parse().unwrap()
    }

    #[test]
    fn civil_days_round_trip_known_dates() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 11, 7), 20_764);
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(weekday(0), 3);
        assert_eq!(weekday(days_from_civil(2026, 11, 9)), 0);
    }

    #[test]
    fn spring_forward_2026_03_08() {
        // 02:00 MST on the second Sunday in March is 09:00 UTC.
        assert_eq!(offset_minutes_at(wall("2026-03-08T08:59:59.999Z")), -420);
        assert_eq!(offset_minutes_at(wall("2026-03-08T09:00:00.000Z")), -360);
        assert_eq!(
            local(wall("2026-03-08T08:59:59.000Z")).unwrap().to_string(),
            "2026-03-08T01:59:59-07:00"
        );
        assert_eq!(
            local(wall("2026-03-08T09:00:00.000Z")).unwrap().to_string(),
            "2026-03-08T03:00:00-06:00"
        );
        // The second Sunday, not the first or the third.
        assert_eq!(offset_minutes_at(wall("2026-03-01T12:00:00.000Z")), -420);
        assert_eq!(offset_minutes_at(wall("2026-03-15T12:00:00.000Z")), -360);
    }

    #[test]
    fn fall_back_2026_11_01() {
        // 02:00 MDT on the first Sunday in November is 08:00 UTC.
        assert_eq!(offset_minutes_at(wall("2026-11-01T07:59:59.999Z")), -360);
        assert_eq!(offset_minutes_at(wall("2026-11-01T08:00:00.000Z")), -420);
        assert_eq!(
            local(wall("2026-11-01T07:59:59.000Z")).unwrap().to_string(),
            "2026-11-01T01:59:59-06:00"
        );
        assert_eq!(
            local(wall("2026-11-01T08:00:00.000Z")).unwrap().to_string(),
            "2026-11-01T01:00:00-07:00"
        );
        // The repeated hour reads at its first, daylight, occurrence.
        assert_eq!(
            date("2026-11-01").at_local(90).to_string(),
            "2026-11-01T01:30:00-06:00"
        );
        // A time in the spring gap reads at standard time.
        assert_eq!(
            date("2026-03-08").at_local(150).to_string(),
            "2026-03-08T03:30:00-06:00"
        );
    }

    #[test]
    fn other_years_follow_the_rule() {
        // 2027: 14 March and 7 November.
        assert_eq!(offset_minutes_at(wall("2027-03-14T08:59:59.000Z")), -420);
        assert_eq!(offset_minutes_at(wall("2027-03-14T09:00:00.000Z")), -360);
        assert_eq!(offset_minutes_at(wall("2027-11-07T07:59:59.000Z")), -360);
        assert_eq!(offset_minutes_at(wall("2027-11-07T08:00:00.000Z")), -420);
        assert_eq!(offset_minutes_at(wall("2027-01-15T12:00:00.000Z")), -420);
        assert_eq!(offset_minutes_at(wall("2027-07-04T12:00:00.000Z")), -360);
    }

    #[test]
    fn slots_on_each_side_of_a_transition() {
        // Saturday before spring forward: 07:00 MST is 14:00 UTC.
        let sat = date("2026-03-07").slot_starts();
        assert_eq!(sat[0].to_string(), "2026-03-07T07:00:00-07:00");
        assert_eq!(sat[0].unix_ms(), wall("2026-03-07T14:00:00.000Z"));
        // The Sunday it happens: 07:00 MDT is 13:00 UTC.
        let sun = date("2026-03-08").slot_starts();
        assert_eq!(sun[0].to_string(), "2026-03-08T07:00:00-06:00");
        assert_eq!(sun[0].unix_ms(), wall("2026-03-08T13:00:00.000Z"));
        assert_eq!(sun[31].to_string(), "2026-03-08T14:45:00-06:00");
        // Autumn: Saturday 31 October in daylight time, Sunday 1 November in standard time.
        assert_eq!(
            date("2026-10-31").slot_starts()[4].to_string(),
            "2026-10-31T08:00:00-06:00"
        );
        assert_eq!(
            date("2026-11-01").slot_starts()[4].to_string(),
            "2026-11-01T08:00:00-07:00"
        );
    }

    #[test]
    fn a_day_has_32_slots_and_3_windows() {
        let d = date("2026-11-07");
        let slots = d.slot_starts();
        assert_eq!(slots.len(), SLOTS_PER_DAY);
        assert_eq!(SLOTS_PER_DAY, 32);
        assert_eq!(slots[0].to_string(), "2026-11-07T07:00:00-07:00");
        assert_eq!(slots[31].to_string(), "2026-11-07T14:45:00-07:00");
        assert!(
            slots
                .windows(2)
                .all(|w| w[1].unix_ms() - w[0].unix_ms() == 900_000)
        );
        let windows: Vec<String> = d.window_starts().iter().map(|t| t.to_string()).collect();
        assert_eq!(
            windows,
            [
                "2026-11-07T09:00:00-07:00",
                "2026-11-07T11:00:00-07:00",
                "2026-11-07T13:00:00-07:00"
            ]
        );
        assert_eq!(d.opening().to_string(), "2026-11-07T07:00:00-07:00");
        assert_eq!(d.closing().to_string(), "2026-11-07T15:00:00-07:00");
        assert_eq!(local_minutes(slots[5]), 7 * 60 + 75);
    }

    #[test]
    fn mondays_are_closed() {
        let monday = date("2026-11-09");
        assert_eq!(monday.weekday(), Weekday::Mon);
        assert!(!monday.is_open());
        assert!(date("2026-11-10").is_open());
        assert!(date("2026-11-08").is_open());
        assert_eq!(date("2026-11-08").weekday(), Weekday::Sun);
    }

    #[test]
    fn the_bakery_day_reads_denver_whatever_the_shown_offset() {
        // 23:30 MST on Saturday is Sunday in UTC, still Saturday in Denver.
        let t: BusinessTime = "2026-11-07T23:30:00-07:00".parse().unwrap();
        assert_eq!(BakeryDate::of(t).to_string(), "2026-11-07");
        // A summer time shown at the standard offset (as the seed writes it) is read at
        // daylight time: 23:30 at -07:00 is 00:30 the next day in Denver.
        let summer: BusinessTime = "2026-07-04T23:30:00-07:00".parse().unwrap();
        assert_eq!(BakeryDate::of(summer).to_string(), "2026-07-05");
    }

    #[test]
    fn next_opening_skips_monday_and_is_strictly_after() {
        let sunday_evening: BusinessTime = "2026-11-08T18:00:00-07:00".parse().unwrap();
        assert_eq!(
            next_opening(sunday_evening).to_string(),
            "2026-11-10T07:00:00-07:00"
        );
        let at_opening: BusinessTime = "2026-11-07T07:00:00-07:00".parse().unwrap();
        assert_eq!(
            next_opening(at_opening).to_string(),
            "2026-11-08T07:00:00-07:00"
        );
        let before: BusinessTime = "2026-11-07T06:59:59-07:00".parse().unwrap();
        assert_eq!(
            next_opening(before).to_string(),
            "2026-11-07T07:00:00-07:00"
        );
        // Saturday night before spring forward: Sunday opens at 07:00 MDT.
        let sat: BusinessTime = "2026-03-07T20:00:00-07:00".parse().unwrap();
        assert_eq!(next_opening(sat).to_string(), "2026-03-08T07:00:00-06:00");
    }

    #[test]
    fn dates_parse_strictly_and_serialize_as_text() {
        let d = date("2028-02-29");
        assert_eq!((d.y(), d.m(), d.d()), (2028, 2, 29));
        assert_eq!(serde_json::to_value(d).unwrap(), "2028-02-29");
        assert_eq!(
            serde_json::from_value::<BakeryDate>("2026-11-07".into()).unwrap(),
            date("2026-11-07")
        );
        for bad in [
            "2026-02-29",
            "2026-13-01",
            "2026-11-7",
            "2026/11/07",
            "",
            "2026-11-00",
        ] {
            assert!(bad.parse::<BakeryDate>().is_err(), "{bad:?}");
        }
        assert_eq!(date("2026-12-31").plus_days(1), date("2027-01-01"));
        assert!(date("2026-11-07") < date("2026-11-08"));
    }

    #[test]
    fn business_days_skip_mondays_and_never_count_the_start() {
        // Saturday 2026-11-07: Sun 1, (Mon closed), Tue 2 ... Sat 14 is the 6th, Sun 15 the 7th.
        assert_eq!(date("2026-11-07").nth_open_day_after(1), date("2026-11-08"));
        assert_eq!(date("2026-11-07").nth_open_day_after(2), date("2026-11-10"));
        assert_eq!(date("2026-11-07").nth_open_day_after(7), date("2026-11-15"));
        // From a Monday, the closed day itself is not counted either.
        assert_eq!(date("2026-11-09").nth_open_day_after(1), date("2026-11-10"));
        assert_eq!(date("2026-11-09").nth_open_day_after(7), date("2026-11-17"));
        assert_eq!(date("2026-11-07").nth_open_day_after(0), date("2026-11-07"));
        assert_eq!(date("2026-11-07").days_until(date("2026-11-15")), 8);
        assert_eq!(date("2026-11-15").days_until(date("2026-11-07")), -8);
    }

    #[test]
    fn same_time_later_keeps_the_wall_clock_across_a_transition() {
        let before: BusinessTime = "2026-10-29T14:00:00-06:00".parse().unwrap();
        assert_eq!(
            same_time_days_later(before, 7).to_string(),
            "2026-11-05T14:00:00-07:00"
        );
        let t = plus_elapsed_minutes("2026-11-01T01:50:00-06:00".parse().unwrap(), 15).unwrap();
        // 01:50 MDT plus 15 minutes is 01:05 MST, the repeated hour's second pass.
        assert_eq!(t.to_string(), "2026-11-01T01:05:00-07:00");
    }

    proptest! {
        #[test]
        fn dates_round_trip(days in -700_000i64..2_900_000) {
            let d = BakeryDate::from_days(days);
            prop_assert_eq!(d.days(), days);
            prop_assert_eq!(d.to_string().parse::<BakeryDate>(), Ok(d));
        }

        #[test]
        fn every_slot_start_is_on_its_day_at_its_local_minute(days in 19_000i64..30_000) {
            let d = BakeryDate::from_days(days);
            for (t, m) in d.slot_starts().into_iter().zip(slot_minutes()) {
                prop_assert_eq!(BakeryDate::of(t), d);
                prop_assert_eq!(local_minutes(t), m);
                prop_assert_eq!(t.offset_minutes(), offset_minutes_at(t.unix_ms()));
            }
        }

        #[test]
        fn the_offset_is_one_of_two(ms in 0i64..4_000_000_000_000) {
            prop_assert!([-420, -360].contains(&offset_minutes_at(ms)));
        }
    }
}
