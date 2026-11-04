//! The Worker `bakery-api`: every Durable Object class, the Queue consumer and the cron handler
//! (docs/architecture.md). PR 2 is the walking skeleton: health, today's status from `Control`,
//! CORS, and placeholders for the cron and the Queue.

mod clock;
mod cron;
mod http;
mod objects;
mod queue;

pub use objects::control::Control;

use worker::{Context, Env, Request, Response, Result, event};

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    http::handle(req, env).await
}
