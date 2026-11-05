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
