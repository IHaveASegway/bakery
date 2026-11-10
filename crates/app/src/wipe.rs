//! When things end (docs/security.md, "The wipe"; ADR 0005; Q25 · Q-ttl).
//!
//! Every sandbox is wiped at the first 10:00 UTC after its birth, by `Control`'s cron and by
//! its own timer; a backstop 36 h after birth catches a missed wipe. An `Account` deletes
//! itself 30 days after its last sign-in.

use bakery_domain::{DomainError, MS_PER_DAY, WallTime};

/// 10:00 UTC: 03:00 Mountain standard time, 04:00 in summer.
pub const WIPE_HOUR_UTC: i64 = 10;
pub const BACKSTOP_HOURS: i64 = 36;
pub const ACCOUNT_IDLE_DAYS: i64 = 30;
const MS_PER_HOUR: i64 = 3_600_000;

/// How long after its 10:00 UTC wipe a sandbox may still be unwiped before it is counted as past
/// its wipe: 2 hours. The wipe in progress takes that long at worst. `Control`'s fan-out wipes 50
/// sandboxes an alarm run, so the day's cap of 300 is six runs, and an alarm handler may run for
/// 15 minutes of wall time ("Alarm handler invocations have a maximum wall time of 15 minutes",
/// https://developers.cloudflare.com/workers/platform/limits/, read on 2026-11-10): 90 minutes
/// if every run took its limit. A sandbox whose wipe failed is tried again by the 15-minute
/// sweep, which has run twice more by the end of the grace. A sandbox still unwiped two hours
/// after its wipe is not being wiped: its wipe failed, or never started.
pub const PAST_WIPE_GRACE_HOURS: i64 = 2;
/// How long the sweep's count of sandboxes past their wipe is served: 20 minutes, as the status
/// counters. The sweep counts every 15 minutes, so an older count means the cron has stopped, and
/// the route then says it does not know rather than serve a count that can no longer rise.
pub const PAST_WIPE_COUNT_FRESH_MS: i64 = 20 * 60 * 1_000;

/// The first 10:00:00.000 UTC strictly after `born`. Born at 09:59:59 UTC, a sandbox lasts a
/// second; born at exactly 10:00:00.000 it lasts a day, since the wipe that instant is already
/// running.
pub fn next_wipe_at(born: WallTime) -> Result<WallTime, DomainError> {
    let offset = WIPE_HOUR_UTC * MS_PER_HOUR;
    // Days counted from 10:00 UTC rather than from midnight.
    let day = (born.unix_ms() - offset).div_euclid(MS_PER_DAY);
    WallTime::from_unix_ms((day + 1) * MS_PER_DAY + offset)
}

/// 36 h after birth: every sandbox object's own alarm runs `deleteAll()` then, if the wipe
/// missed it.
pub fn backstop_at(born: WallTime) -> Result<WallTime, DomainError> {
    WallTime::from_unix_ms(born.unix_ms().saturating_add(BACKSTOP_HOURS * MS_PER_HOUR))
}

/// Whether a sandbox born at `born` is past its wipe at `now`: not wiped, and `now` later than its
/// first 10:00 UTC after birth by more than [`PAST_WIPE_GRACE_HOURS`]. A sandbox born after
/// today's wipe is due at tomorrow's, so it is never past today's. The due time comes from the
/// birth and not from `Control`'s `wipe_due`, which the 10:00 cron writes and every sweep moves
/// on: a cron that never ran would leave `wipe_due` empty and hide the very sandboxes this counts.
pub fn is_past_wipe(born: WallTime, wiped: bool, now: WallTime) -> bool {
    if wiped {
        return false;
    }
    // Only a birth near year 9999 has no next wipe; nothing can be past it.
    next_wipe_at(born).is_ok_and(|due| {
        now.unix_ms().saturating_sub(due.unix_ms()) > PAST_WIPE_GRACE_HOURS * MS_PER_HOUR
    })
}

/// How many of `sandboxes`, each its birth and whether it is wiped, are past their wipe at `now`.
pub fn count_past_wipe<I>(sandboxes: I, now: WallTime) -> u32
where
    I: IntoIterator<Item = (WallTime, bool)>,
{
    let n = sandboxes
        .into_iter()
        .filter(|&(born, wiped)| is_past_wipe(born, wiped, now))
        .count();
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The stored count as the status route serves it: the count while it is at most
/// [`PAST_WIPE_COUNT_FRESH_MS`] old, `None` when there is none or it is older.
pub fn served_past_wipe(stored: Option<(u32, WallTime)>, now: WallTime) -> Option<u32> {
    stored
        .filter(|&(_, at)| now.unix_ms() - at.unix_ms() <= PAST_WIPE_COUNT_FRESH_MS)
        .map(|(count, _)| count)
}

/// 30 days after the last sign-in, the `Account`'s alarm deletes it.
pub fn account_idle_delete_at(last_signin: WallTime) -> Result<WallTime, DomainError> {
    last_signin.plus_days(ACCOUNT_IDLE_DAYS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> WallTime {
        text.parse().unwrap()
    }

    fn wipe(born: &str) -> String {
        next_wipe_at(at(born)).unwrap().to_string()
    }

    #[test]
    fn created_at_09_55_utc_lasts_five_minutes() {
        // ADR 0005, "Consequences".
        let born = at("2026-11-05T09:55:00.000Z");
        let wipe = next_wipe_at(born).unwrap();
        assert_eq!(wipe.unix_ms() - born.unix_ms(), 5 * 60 * 1_000);
    }

    #[test]
    fn the_wipe_is_strictly_after_birth() {
        assert_eq!(wipe("2026-11-05T09:59:59.000Z"), "2026-11-05T10:00:00.000Z");
        assert_eq!(wipe("2026-11-05T09:59:59.999Z"), "2026-11-05T10:00:00.000Z");
        assert_eq!(wipe("2026-11-05T10:00:00.000Z"), "2026-11-06T10:00:00.000Z");
        assert_eq!(wipe("2026-11-05T10:00:00.001Z"), "2026-11-06T10:00:00.000Z");
        assert_eq!(wipe("2026-11-05T00:00:00.000Z"), "2026-11-05T10:00:00.000Z");
        assert_eq!(wipe("2026-12-31T23:59:59.999Z"), "2027-01-01T10:00:00.000Z");
        assert_eq!(wipe("2028-02-28T12:00:00.000Z"), "2028-02-29T10:00:00.000Z");
        assert_eq!(wipe("1969-12-31T12:00:00.000Z"), "1970-01-01T10:00:00.000Z");
    }

    #[test]
    fn no_sandbox_outlives_a_day_and_the_backstop_is_later() {
        for born in [
            "2026-11-05T10:00:00.000Z",
            "2026-11-05T09:00:00.000Z",
            "2026-11-05T17:31:07.250Z",
        ] {
            let born = at(born);
            let wipe = next_wipe_at(born).unwrap();
            assert!(wipe > born);
            assert!(wipe.unix_ms() - born.unix_ms() <= MS_PER_DAY);
            assert!(backstop_at(born).unwrap() > wipe);
        }
        assert_eq!(
            backstop_at(at("2026-11-05T09:55:00.000Z"))
                .unwrap()
                .to_string(),
            "2026-11-06T21:55:00.000Z"
        );
    }

    /// A UTC time to the second, written without its milliseconds.
    fn utc(text: &str) -> WallTime {
        format!("{text}.000Z").parse().unwrap()
    }

    /// One millisecond after `t`.
    fn later(t: WallTime) -> WallTime {
        WallTime::from_unix_ms(t.unix_ms() + 1).unwrap()
    }

    #[test]
    fn nothing_past_its_wipe() {
        let now = utc("2026-11-10T12:17:00");
        assert_eq!(count_past_wipe(Vec::<(WallTime, bool)>::new(), now), 0);
        // Born yesterday afternoon and wiped this morning.
        assert_eq!(
            count_past_wipe([(utc("2026-11-09T15:00:00"), true)], now),
            0
        );
    }

    #[test]
    fn past_its_wipe_by_less_than_the_grace_is_not_counted() {
        let born = utc("2026-11-09T15:00:00");
        // The wipe is in progress: 10:00 plus less than two hours.
        for now in [
            "2026-11-10T10:00:00",
            "2026-11-10T10:45:00",
            "2026-11-10T11:59:59",
            "2026-11-10T12:00:00",
        ] {
            assert!(!is_past_wipe(born, false, utc(now)), "{now}");
        }
        assert_eq!(
            count_past_wipe([(born, false)], utc("2026-11-10T11:30:00")),
            0
        );
    }

    #[test]
    fn past_its_wipe_by_more_than_the_grace_is_counted() {
        let born = utc("2026-11-09T15:00:00");
        assert!(is_past_wipe(born, false, later(utc("2026-11-10T12:00:00"))));
        assert_eq!(
            count_past_wipe([(born, false)], utc("2026-11-10T12:17:00")),
            1
        );
        // Days late still counts: nothing ages out.
        assert_eq!(
            count_past_wipe([(born, false)], utc("2026-11-13T12:17:00")),
            1
        );
    }

    #[test]
    fn an_already_wiped_sandbox_is_not_counted() {
        let born = utc("2026-11-09T15:00:00");
        assert!(!is_past_wipe(born, true, utc("2026-11-10T22:27:00")));
    }

    #[test]
    fn a_sandbox_made_after_todays_wipe_is_not_counted() {
        // Issue 99: a guest sandbox made at 17:43 UTC, read at 22:27 UTC the same day. Its wipe is
        // tomorrow's.
        let born = utc("2026-11-09T17:43:00");
        assert_eq!(
            count_past_wipe([(born, false)], utc("2026-11-09T22:27:00")),
            0
        );
        // Born the instant the wipe started, it is tomorrow's too.
        assert!(!is_past_wipe(
            utc("2026-11-09T10:00:00"),
            false,
            utc("2026-11-09T22:27:00")
        ));
    }

    #[test]
    fn the_count_takes_each_sandbox_on_its_own() {
        let now = utc("2026-11-10T12:17:00");
        let sandboxes = [
            (utc("2026-11-09T15:00:00"), false), // past
            (utc("2026-11-09T16:00:00"), true),  // wiped
            (utc("2026-11-10T11:00:00"), false), // tomorrow's
            (utc("2026-11-08T20:00:00"), false), // two wipes late
        ];
        assert_eq!(count_past_wipe(sandboxes, now), 2);
    }

    #[test]
    fn the_count_is_served_while_it_is_fresh() {
        let counted = utc("2026-11-10T12:15:00");
        assert_eq!(served_past_wipe(None, counted), None);
        assert_eq!(served_past_wipe(Some((3, counted)), counted), Some(3));
        assert_eq!(
            served_past_wipe(Some((3, counted)), utc("2026-11-10T12:35:00")),
            Some(3)
        );
        assert_eq!(
            served_past_wipe(Some((3, counted)), later(utc("2026-11-10T12:35:00"))),
            None
        );
    }

    #[test]
    fn accounts_idle_for_thirty_days() {
        assert_eq!(
            account_idle_delete_at(at("2026-11-05T12:00:00.000Z"))
                .unwrap()
                .to_string(),
            "2026-12-05T12:00:00.000Z"
        );
        assert!(account_idle_delete_at(at("9999-12-31T00:00:00.000Z")).is_err());
    }
}
