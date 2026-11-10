//! The isolate's copy of `Control`'s flag (roadmap R85, 2026-11-10): the router, the Queue's
//! consumer, the Kitchen's socket and the Simulator read it here, so a request with the flag
//! `live` pays no `Control` call beyond the one that refreshes the copy, at most once a
//! `FLAG_COPY_MS` (60 s) per isolate. A change of the flag therefore reaches an isolate within
//! about a minute (`bakery_app::flag_gate`).

use std::cell::RefCell;

use bakery_app::Clock;
use bakery_app::flag_gate::copy_is_fresh;
use bakery_contracts::Flag;
use worker::{Env, console_log};

use crate::clock::SystemClock;
use crate::objects::control;

thread_local! {
    static FLAG: RefCell<Option<(Flag, i64)>> = const { RefCell::new(None) };
}

/// The flag, from the isolate's copy while it is fresh. An unreachable `Control` reads as `live`
/// and is not kept, so the next request asks again: a stalled flag read must not take the demo
/// down or drain every sandbox's events to the dead-letter queue, and `Control`'s own admission
/// still refuses a new sandbox at `read-only` or `off` (it reads the flag in its transaction).
pub async fn current(env: &Env) -> Flag {
    let now = SystemClock::new().now_wall().unix_ms();
    let cached = FLAG.with_borrow(|f| f.filter(|(_, at)| copy_is_fresh(*at, now)));
    if let Some((flag, _)) = cached {
        return flag;
    }
    match control::flag(env).await {
        Ok(flag) => {
            FLAG.with_borrow_mut(|f| *f = Some((flag, now)));
            flag
        }
        Err(_) => {
            console_log!("{{\"event\":\"flag_unavailable\"}}");
            Flag::Live
        }
    }
}
