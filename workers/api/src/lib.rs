//! The Worker `bakery-api`: the router, every Durable Object class, the Queue consumer and the
//! cron handler (docs/architecture.md). PR 3 adds sign-in, sandboxes and the nightly wipe to
//! PR 2's walking skeleton.

mod clock;
mod config;
mod cron;
mod http;
mod objects;
mod queue;
mod random;

pub use objects::account::Account;
pub use objects::control::Control;
pub use objects::sandbox::Sandbox;

use worker::{Context, Env, Request, Response, Result, event};

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    http::handle(req, env).await
}
