//! The cron handler. The 15-minute wall limit applies here, so a cron only asks `Control` to
//! start work and returns; `Control`'s alarm does the work (docs/delivery.md, "Config as code").
//! The 15-minute cron also refreshes the status page's counters (PR 13): the kept Analytics
//! Engine queries run here, in the Worker, and `Control` stores the answer by command, so no
//! object reads Analytics Engine or keeps a timer for it. Then the breaker (PR 17) reads the
//! last window's usage the same way and hands it to `Control`, which keeps its state.

use worker::{Env, ScheduleContext, ScheduledEvent, console_log, event};

use crate::objects::control;
use crate::{analytics, breaker};

/// The nightly wipe at 10:00 UTC, and the 15-minute sweep that retries what it missed,
/// refreshes the status snapshot and runs the breaker.
const WIPE: &str = "0 10 * * *";
const SWEEP: &str = "*/15 * * * *";

#[event(scheduled)]
async fn scheduled(event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let cron = event.cron();
    let result = match cron.as_str() {
        WIPE => control::wipe(&env).await.map(|s| ("wipe", s.stamped)),
        SWEEP => control::sweep(&env).await.map(|s| ("sweep", s.stamped)),
        other => {
            console_log!("{{\"event\":\"cron_unknown\",\"cron\":{other:?}}}");
            return;
        }
    };
    match result {
        Ok((action, rows)) => console_log!(
            "{{\"event\":\"cron\",\"cron\":{cron:?},\"action\":\"{action}\",\"rows\":{rows}}}"
        ),
        Err(e) => console_log!(
            "{{\"event\":\"cron_error\",\"cron\":{cron:?},\"error\":{:?}}}",
            e.to_string()
        ),
    }
    // After the sweep, whatever it answered: a refresh that fails keeps the old snapshot, and
    // the breaker reads its own requests, so neither waits on the other's answer.
    if cron == SWEEP {
        analytics::refresh(&env).await;
        breaker::run(&env).await;
    }
}
