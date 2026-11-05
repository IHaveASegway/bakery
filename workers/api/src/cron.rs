//! The cron handler. The 15-minute wall limit applies here, so a cron only asks `Control` to
//! start work and returns; `Control`'s alarm does the work (docs/delivery.md, "Config as code").

use worker::{Env, ScheduleContext, ScheduledEvent, console_log, event};

use crate::objects::control;

/// The nightly wipe at 10:00 UTC, and the 15-minute sweep that retries what it missed (the
/// breaker joins the sweep in PR 11).
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
}
