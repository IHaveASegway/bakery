//! Whether a dead letter was made while the bakery was `off` (roadmap R21 and R67, built on
//! 2026-11-10; docs/operations.md, "Breaker tripped").
//!
//! At `off` the Queue's consumer retries every message, so events in flight reach the dead-letter
//! queue after 3 retries for no fault of theirs. The dead-letter queue's consumer keeps each one,
//! marks it with [`made_while_off`], and writes no `dlq` point for a marked one, so the morning
//! check opens no issue for the switch doing its job.
//!
//! What the mark can know: the flag, and when it last changed, as `Control` holds them when the
//! dead letter arrives. The binding gives no attempt count and no reason (roadmap R75), so the mark
//! cannot tell a message the switch killed from one a real fault killed while the flag was `off`,
//! or in the window after it: both are marked. A message that died of the switch and reached the
//! dead-letter queue later than the window is not marked, and is counted.

use bakery_contracts::Flag;
use bakery_domain::WallTime;

/// How long after a change of the flag a dead letter is still taken as made while `off`: two
/// minutes. After the flag leaves `off`, a consumer isolate keeps its copy of `off` for up to 60 s
/// (`FLAG_CACHE_MS` in workers/api/src/queue.rs) and retries what it gets; a retry has no delay
/// (`bakery-events` sets no `retry_delay` in workers/api/wrangler.jsonc), so 3 retries take a few
/// batches; and the dead-letter queue's consumer waits up to 5 s for a batch (its
/// `max_batch_timeout` is the default, "Defaults to `5` seconds", Queues configuration,
/// https://developers.cloudflare.com/queues/configuration/configure-queues/, read on 2026-11-10).
/// That is about 65 s plus a few seconds of retries; the rest of the two minutes is margin for a
/// short backlog in the dead-letter queue.
pub const AFTER_OFF_MS: i64 = 2 * 60 * 1_000;

/// A dead letter arriving at `now` is marked when the flag is `off`, or when it is not `off` but
/// changed in the last [`AFTER_OFF_MS`]. `Control` keeps no earlier value of the flag, so a
/// change from `live` to `read-only` marks for two minutes too. `changed_at` is `None` when
/// `Control` could not say; then nothing but `off` marks. A change in the future (a clock skew
/// between isolates) marks, as one just made would.
pub fn made_while_off(flag: Flag, changed_at: Option<WallTime>, now: WallTime) -> bool {
    match flag {
        Flag::Off => true,
        Flag::Live | Flag::ReadOnly => {
            changed_at.is_some_and(|at| now.unix_ms() - at.unix_ms() <= AFTER_OFF_MS)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(text: &str) -> WallTime {
        format!("{text}.000Z").parse().unwrap()
    }

    fn plus_ms(t: WallTime, ms: i64) -> WallTime {
        WallTime::from_unix_ms(t.unix_ms() + ms).unwrap()
    }

    #[test]
    fn off_now_marks_whenever_the_flag_changed() {
        let now = utc("2026-11-10T14:00:00");
        assert!(made_while_off(
            Flag::Off,
            Some(utc("2026-11-10T13:00:00")),
            now
        ));
        assert!(made_while_off(
            Flag::Off,
            Some(utc("2026-11-03T13:00:00")),
            now
        ));
        assert!(made_while_off(Flag::Off, None, now));
    }

    #[test]
    fn just_back_to_live_marks_for_two_minutes() {
        let changed = utc("2026-11-10T14:00:00");
        assert!(made_while_off(
            Flag::Live,
            Some(changed),
            plus_ms(changed, 30_000)
        ));
        assert!(made_while_off(
            Flag::Live,
            Some(changed),
            plus_ms(changed, AFTER_OFF_MS)
        ));
        assert!(!made_while_off(
            Flag::Live,
            Some(changed),
            plus_ms(changed, AFTER_OFF_MS + 1)
        ));
        // A change Control holds as later than now, between isolates' clocks.
        assert!(made_while_off(
            Flag::Live,
            Some(changed),
            plus_ms(changed, -500)
        ));
    }

    #[test]
    fn live_for_long_does_not_mark() {
        let now = utc("2026-11-10T14:00:00");
        assert!(!made_while_off(
            Flag::Live,
            Some(utc("2026-11-10T09:00:00")),
            now
        ));
        assert!(!made_while_off(Flag::Live, None, now));
    }

    #[test]
    fn read_only_is_not_off_but_a_recent_change_still_marks() {
        let now = utc("2026-11-10T14:00:00");
        assert!(!made_while_off(
            Flag::ReadOnly,
            Some(utc("2026-11-10T12:00:00")),
            now
        ));
        // Control cannot say whether read-only came down from off or up from live.
        assert!(made_while_off(
            Flag::ReadOnly,
            Some(plus_ms(now, -60_000)),
            now
        ));
    }
}
