//! Fakes for the ports, deterministic so a test can state exact times and ids.

use std::cell::Cell;

use bakery_domain::{BusinessTime, Ulid, WallTime};

use crate::{Clock, IdGen};

/// A clock that stands still until told to move. Business time is wall time plus an offset.
#[derive(Debug)]
pub struct FixedClock {
    wall_ms: Cell<i64>,
    business_offset_ms: Cell<i64>,
    utc_offset_minutes: i16,
}

impl FixedClock {
    /// Panics on a time outside 0000 to 9999: a test's typo, not a case to handle.
    pub fn at(wall: &str, utc_offset_minutes: i16) -> FixedClock {
        let wall: WallTime = wall.parse().expect("a canonical wall time");
        FixedClock {
            wall_ms: Cell::new(wall.unix_ms()),
            business_offset_ms: Cell::new(0),
            utc_offset_minutes,
        }
    }

    /// Moves wall time, and business time with it.
    pub fn advance_wall_ms(&self, ms: i64) {
        self.wall_ms.set(self.wall_ms.get() + ms);
    }

    /// Moves business time alone, as "Advance time" does.
    pub fn advance_business_ms(&self, ms: i64) {
        self.business_offset_ms
            .set(self.business_offset_ms.get() + ms);
    }
}

impl Clock for FixedClock {
    fn now_wall(&self) -> WallTime {
        WallTime::from_unix_ms(self.wall_ms.get()).expect("wall time in range")
    }

    fn now_business(&self) -> BusinessTime {
        let ms = self.wall_ms.get() + self.business_offset_ms.get();
        BusinessTime::new(ms, self.utc_offset_minutes).expect("business time in range")
    }
}

/// ULIDs whose time part is a fixed millisecond and whose random part counts up from 1.
#[derive(Debug)]
pub struct SequentialIds {
    unix_ms: u64,
    next: Cell<u128>,
}

impl SequentialIds {
    pub fn starting_at(unix_ms: u64) -> SequentialIds {
        SequentialIds {
            unix_ms,
            next: Cell::new(1),
        }
    }
}

impl IdGen for SequentialIds {
    fn ulid(&self) -> Ulid {
        let n = self.next.get();
        self.next.set(n + 1);
        Ulid::from_parts(self.unix_ms, n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_clock_moves_only_when_told() {
        let clock = FixedClock::at("2026-11-04T19:12:10.318Z", -420);
        assert_eq!(clock.now_wall().to_string(), "2026-11-04T19:12:10.318Z");
        assert_eq!(
            clock.now_business().to_string(),
            "2026-11-04T12:12:10-07:00"
        );

        clock.advance_business_ms(3 * 86_400_000);
        assert_eq!(clock.now_wall().to_string(), "2026-11-04T19:12:10.318Z");
        assert_eq!(
            clock.now_business().to_string(),
            "2026-11-07T12:12:10-07:00"
        );

        clock.advance_wall_ms(1_000);
        assert_eq!(clock.now_wall().to_string(), "2026-11-04T19:12:11.318Z");
        assert_eq!(
            clock.now_business().to_string(),
            "2026-11-07T12:12:11-07:00"
        );
    }

    #[test]
    fn sequential_ids_are_ordered_and_distinct() {
        let ids = SequentialIds::starting_at(1_793_819_530_318);
        let a = ids.ulid();
        let b = ids.ulid();
        assert!(a < b);
        assert_eq!(a.unix_ms(), 1_793_819_530_318);
        assert_eq!(b.as_u128() - a.as_u128(), 1);
    }

    #[test]
    fn fakes_serve_through_the_ports() {
        fn stamp(clock: &impl Clock, ids: &impl IdGen) -> String {
            format!("{} {}", ids.ulid(), clock.now_wall())
        }
        let clock = FixedClock::at("2026-11-04T00:00:00.000Z", 0);
        let ids = SequentialIds::starting_at(0);
        assert_eq!(
            stamp(&clock, &ids),
            "00000000000000000000000001 2026-11-04T00:00:00.000Z"
        );
    }
}
