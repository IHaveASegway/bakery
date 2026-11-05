//! The cron handler. The 15-minute wall limit applies here, so a cron only asks `Control` to
//! start work and returns (docs/delivery.md, "Config as code").

use worker::{Env, ScheduleContext, ScheduledEvent, console_log, event};

use crate::objects::control;

/// The nightly wipe at 10:00 UTC (PR 3) and the 15-minute breaker and retry sweep (PR 11).
const WIPE: &str = "0 10 * * *";
const SWEEP: &str = "*/15 * * * *";

#[event(scheduled)]
async fn scheduled(event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let cron = event.cron();
    match cron.as_str() {
        WIPE => {
            // Placeholder until PR 3 adds the wipe. Pruning the ledger here backs up Control's
            // own midnight alarm, and is idempotent.
            console_log!("{{\"event\":\"cron\",\"cron\":\"{WIPE}\",\"action\":\"prune\"}}");
            if let Err(e) = control::prune(&env).await {
                console_log!(
                    "{{\"event\":\"cron_error\",\"cron\":\"{WIPE}\",\"error\":{:?}}}",
                    e.to_string()
                );
            }
        }
        SWEEP => {
            // Placeholder until PR 11 adds the breaker and the retry sweep.
            console_log!("{{\"event\":\"cron\",\"cron\":\"{SWEEP}\",\"action\":\"none\"}}");
        }
        other => console_log!("{{\"event\":\"cron_unknown\",\"cron\":{other:?}}}"),
    }
}
