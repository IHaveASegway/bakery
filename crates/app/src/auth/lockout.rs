//! The demo sign-in lockout (docs/security.md, "Demo accounts"): 10 failures within 15 minutes
//! lock the account until the oldest of those 10 is 15 minutes old. The `Account` keeps the
//! failure times; this decides.

use bakery_domain::WallTime;

pub const LOCKOUT_FAILURES: usize = 10;
pub const LOCKOUT_WINDOW_MS: i64 = 15 * 60 * 1_000;

pub struct Lockout;

impl Lockout {
    /// `None` when sign-in may proceed; otherwise the seconds until it may, rounded up, for
    /// `Retry-After`. `failures_at` may be in any order and may hold old rows the `Account` has
    /// not pruned yet.
    pub fn check(failures_at: &[WallTime], now: WallTime) -> Option<u32> {
        let window_start = now.unix_ms() - LOCKOUT_WINDOW_MS;
        let mut recent: Vec<i64> = failures_at
            .iter()
            .map(|t| t.unix_ms())
            .filter(|&ms| ms > window_start && ms <= now.unix_ms())
            .collect();
        if recent.len() < LOCKOUT_FAILURES {
            return None;
        }
        recent.sort_unstable_by(|a, b| b.cmp(a));
        let tenth_most_recent = recent[LOCKOUT_FAILURES - 1];
        let wait_ms = tenth_most_recent + LOCKOUT_WINDOW_MS - now.unix_ms();
        let wait_s = (wait_ms + 999) / 1_000;
        Some(u32::try_from(wait_s.max(1)).unwrap_or(u32::MAX))
    }

    /// Failure rows older than this can be deleted: they can no longer count.
    pub fn prune_before(now: WallTime) -> i64 {
        now.unix_ms() - LOCKOUT_WINDOW_MS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(ms: i64) -> WallTime {
        WallTime::from_unix_ms(1_793_966_400_000 + ms).unwrap()
    }

    const MIN: i64 = 60_000;

    #[test]
    fn nine_failures_do_not_lock() {
        let failures: Vec<_> = (0..9).map(|i| t(i * MIN)).collect();
        assert_eq!(Lockout::check(&failures, t(9 * MIN)), None);
    }

    #[test]
    fn ten_failures_in_fifteen_minutes_lock_until_the_tenth_most_recent_ages_out() {
        // One a minute from 0 to 9; now is minute 10.
        let failures: Vec<_> = (0..10).map(|i| t(i * MIN)).collect();
        assert_eq!(Lockout::check(&failures, t(10 * MIN)), Some(5 * 60));
        // A second before minute 15 it is still locked, for a second.
        assert_eq!(Lockout::check(&failures, t(15 * MIN - 1_000)), Some(1));
        // At minute 15 the first failure has left the window.
        assert_eq!(Lockout::check(&failures, t(15 * MIN)), None);
    }

    #[test]
    fn more_failures_extend_the_lock() {
        let failures: Vec<_> = (0..12).map(|i| t(i * MIN)).rev().collect();
        // The 10th most recent is minute 2, so the lock lasts to minute 17.
        assert_eq!(Lockout::check(&failures, t(12 * MIN)), Some(5 * 60));
    }

    #[test]
    fn old_failures_do_not_count() {
        let mut failures: Vec<_> = (0..9).map(|i| t(i * 1_000)).collect();
        failures.push(t(-20 * MIN));
        assert_eq!(Lockout::check(&failures, t(MIN)), None);
    }

    #[test]
    fn rounds_up_to_whole_seconds() {
        let failures: Vec<_> = (0..10).map(|_| t(500)).collect();
        assert_eq!(Lockout::check(&failures, t(1_000)), Some(15 * 60));
        assert_eq!(Lockout::prune_before(t(LOCKOUT_WINDOW_MS)), t(0).unix_ms());
    }
}
