//! The isolate's copy of `Control`'s flag (roadmap R85, 2026-11-10): the router, the Queue's
//! consumer, the Kitchen's socket and the Simulator read it here, so a request with the flag
//! `live` pays no `Control` call beyond the one that refreshes the copy, at most once a
//! `FLAG_COPY_MS` (60 s) per isolate. A change of the flag therefore reaches an isolate within
//! about a minute. What to do is `bakery_app::flag_gate::flag_read`; this adapter only keeps the
//! last good copy and the time of the last failed refresh, and asks `Control` when told to.
//!
//! A failed refresh keeps the last flag read, however old, and the next refresh waits 5 s
//! (`FLAG_RETRY_MS`), so a `Control` hiccup at `off` lets no write through and a failing `Control`
//! costs the hot path one call per 5 s per isolate. For the Queue's consumer that means: at `off`
//! it goes on retrying, at `live` it goes on delivering. Only an isolate that has never read the
//! flag falls back to `live` (`flag_gate::after_failure` says why that is acceptable).

use std::cell::Cell;

use bakery_app::Clock;
use bakery_app::flag_gate::{FlagRead, after_failure, flag_read};
use bakery_contracts::Flag;
use worker::{Env, console_log};

use crate::clock::SystemClock;
use crate::objects::control;

thread_local! {
    /// The last flag read from `Control`, with the time it was read.
    static LAST_GOOD: Cell<Option<(Flag, i64)>> = const { Cell::new(None) };
    /// When the last refresh failed.
    static LAST_FAILED: Cell<Option<i64>> = const { Cell::new(None) };
}

/// The flag, as `flag_read` decides from the isolate's copy.
pub async fn current(env: &Env) -> Flag {
    let now = SystemClock::new().now_wall().unix_ms();
    let last_good = LAST_GOOD.get();
    match flag_read(last_good, LAST_FAILED.get(), now) {
        FlagRead::Use(flag) => flag,
        FlagRead::Refresh => match control::flag(env).await {
            Ok(flag) => {
                LAST_GOOD.set(Some((flag, now)));
                LAST_FAILED.set(None);
                flag
            }
            Err(_) => {
                LAST_FAILED.set(Some(now));
                let flag = after_failure(last_good);
                console_log!(
                    "{{\"event\":\"flag_unavailable\",\"using\":\"{}\",\"ever_read\":{}}}",
                    flag.as_str(),
                    last_good.is_some()
                );
                flag
            }
        },
    }
}
