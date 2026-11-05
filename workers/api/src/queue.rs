//! The `bakery-events` consumer (`#[event(queue)]`, beta in workers-rs). PR 2 logs each batch
//! and acknowledges it; delivery to subscribers arrives with the first event (PR 4).

use worker::{Context, Env, MessageBatch, Result, console_log, event};

#[event(queue)]
async fn queue(batch: MessageBatch<serde_json::Value>, _env: Env, _ctx: Context) -> Result<()> {
    let count = batch.messages()?.len();
    console_log!(
        "{{\"event\":\"queue_batch\",\"queue\":{:?},\"messages\":{count}}}",
        batch.queue()
    );
    batch.ack_all();
    Ok(())
}
