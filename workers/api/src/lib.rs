//! The Worker `bakery-api`: the router, every Durable Object class, the Queue consumer and the
//! cron handler (docs/architecture.md). PR 3 added sign-in, sandboxes and the nightly wipe to
//! PR 2's walking skeleton; PR 4 adds the menu, orders, the kitchen board with its sockets, the event relay and
//! simulated traffic; PR 5 adds payments and refunds through Stripe's sandbox, its webhooks and
//! the `Billing` object; PR 6 adds the `Schedule` object per day with its holds, bake list and
//! hold timers, the clock's steps and the loop guard; PR 7 adds the `CateringEvent` object and its
//! saga by alarm, the catering routes, the balance invoice through Stripe Invoicing and the
//! deposit's refund.

mod clock;
mod config;
mod cron;
mod http;
mod objects;
mod queue;
mod random;
mod stripe;

pub use objects::account::Account;
pub use objects::billing::Billing;
pub use objects::catalog::Catalog;
pub use objects::catering::CateringEvent;
pub use objects::control::Control;
pub use objects::kitchen::Kitchen;
pub use objects::order::Order;
pub use objects::sandbox::Sandbox;
pub use objects::schedule::Schedule;
pub use objects::simulator::Simulator;

use worker::{Context, Env, Request, Response, Result, event};

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    http::handle(req, env).await
}
