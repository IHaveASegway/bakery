//! The one wall-clock adapter, allow-listed by the "no wall clock in objects" gate: objects and
//! handlers ask this for the time and never read the platform's clock themselves.

use bakery_app::Clock;
use bakery_domain::{BusinessTime, WallTime, calendar};
use worker::ScheduledTime;
use worker::js_sys::Date;
use worker::wasm_bindgen::JsValue;

/// The platform's clock. Business time is wall time plus a sandbox's offset, zero outside one.
pub struct SystemClock {
    business_offset_ms: i64,
}

impl SystemClock {
    pub fn new() -> SystemClock {
        SystemClock {
            business_offset_ms: 0,
        }
    }
}

impl Clock for SystemClock {
    fn now_wall(&self) -> WallTime {
        // The platform's clock stays within 0000 to 9999; a failure here is a runtime defect.
        let ms = worker::Date::now().as_millis() as i64;
        WallTime::from_unix_ms(ms).expect("the platform clock is in range")
    }

    fn now_business(&self) -> BusinessTime {
        let ms = self.now_wall().unix_ms() + self.business_offset_ms;
        calendar::local(ms).expect("business time in range")
    }
}

/// An alarm's absolute time. `ScheduledTime` from an integer would be an offset from now.
pub fn alarm_time(at: WallTime) -> ScheduledTime {
    ScheduledTime::new(Date::new(&JsValue::from_f64(at.unix_ms() as f64)))
}

/// Wall time as the bakery's business time, with no sandbox offset: a sandbox's birth date.
/// Pure arithmetic on a time already read, not a clock read.
pub fn business(at: WallTime) -> BusinessTime {
    business_at(at, 0)
}

/// Wall time as a sandbox's business time: `offset_s` seconds later, shown at the offset
/// America/Denver has at that instant (`-07:00` in winter, `-06:00` in summer).
pub fn business_at(at: WallTime, offset_s: i64) -> BusinessTime {
    calendar::local(at.unix_ms().saturating_add(offset_s.saturating_mul(1_000)))
        .expect("business time in range")
}

/// The wall time at which a sandbox's business clock reads `at`: what an alarm is armed for.
pub fn wall_at(at: BusinessTime, offset_s: i64) -> WallTime {
    let ms = at.unix_ms().saturating_sub(offset_s.saturating_mul(1_000));
    WallTime::from_unix_ms(ms).expect("wall time in range")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn business_time_is_shown_at_denvers_offset_for_that_instant() {
        // 2026-11-07T16:42:10Z is 09:42:10 standard time.
        let winter = WallTime::from_unix_ms(1_794_069_730_000).unwrap();
        assert_eq!(business(winter).to_string(), "2026-11-07T09:42:10-07:00");
        // A day later in wall time, the same instant plus the sandbox's offset.
        assert_eq!(
            business_at(winter, 86_400).to_string(),
            "2026-11-08T09:42:10-07:00"
        );
        // 2026-07-14T16:00:00Z is 10:00 daylight time.
        let summer = WallTime::from_unix_ms(1_784_044_800_000).unwrap();
        assert_eq!(business(summer).to_string(), "2026-07-14T10:00:00-06:00");
        // A sandbox offset that carries a summer instant into winter shows the winter offset, and
        // wall_at undoes business_at.
        let before = WallTime::from_unix_ms(1_793_500_000_000).unwrap();
        let shifted = business_at(before, 14 * 86_400);
        assert_eq!(shifted.offset_minutes(), -420);
        assert_eq!(wall_at(shifted, 14 * 86_400), before);
    }
}
