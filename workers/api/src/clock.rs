//! The one wall-clock adapter, allow-listed by the "no wall clock in objects" gate: objects and
//! handlers ask this for the time and never read the platform's clock themselves.

use bakery_app::Clock;
use bakery_domain::{BusinessTime, WallTime};
use worker::ScheduledTime;
use worker::js_sys::Date;
use worker::wasm_bindgen::JsValue;

/// Mountain standard time, until the zone's rules arrive with the first rule that needs them.
const BAKERY_UTC_OFFSET_MINUTES: i16 = -420;

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
        BusinessTime::new(ms, BAKERY_UTC_OFFSET_MINUTES).expect("business time in range")
    }
}

/// An alarm's absolute time. `ScheduledTime` from an integer would be an offset from now.
pub fn alarm_time(at: WallTime) -> ScheduledTime {
    ScheduledTime::new(Date::new(&JsValue::from_f64(at.unix_ms() as f64)))
}

/// Wall time as the bakery's business time, with no sandbox offset: a sandbox's birth date.
/// Pure arithmetic on a time already read, not a clock read.
pub fn business(at: WallTime) -> BusinessTime {
    BusinessTime::new(at.unix_ms(), BAKERY_UTC_OFFSET_MINUTES).expect("business time in range")
}
