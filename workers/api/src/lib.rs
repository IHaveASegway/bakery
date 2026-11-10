//! The Worker `bakery-api`: the router, every Durable Object class, the Queue consumer and the
//! cron handler (docs/architecture.md). PR 3 added sign-in, sandboxes and the nightly wipe to
//! PR 2's walking skeleton; PR 4 adds the menu, orders, the kitchen board with its sockets, the event relay and
//! simulated traffic; PR 5 adds payments and refunds through Stripe's sandbox, its webhooks and
//! the `Billing` object; PR 6 adds the `Schedule` object per day with its holds, bake list and
//! hold timers, the clock's steps and the loop guard; PR 7 adds the `CateringEvent` object and its
//! saga by alarm, the catering routes, the balance invoice through Stripe Invoicing and the
//! deposit's refund; PR 8 adds the `Customer`, `Crm` and `Inbox` objects, the campaign timer,
//! the projection's rebuild, the inbox's simulated opens and clicks, and the CRM routes; PR 9
//! adds the `Dispatch` object per day with its stops, the server's savings plan, the browser's
//! validated plan and the published plan, the dispatch routes, and the consumer's stop edges.
//! PR 13 adds the Analytics Engine points (`metrics`) and the status page's counters, refreshed
//! by the 15-minute cron through the SQL API (`analytics`) and kept in `Control`. PR 17 adds the
//! 15-minute cron breaker (`breaker`), which reads the account's usage through the GraphQL
//! Analytics API, keeps its state in `Control`, raises the flag and enables the WAF kill rule.
//! Since 2026-11-09 the `Recorder` per sandbox keeps the flight recorder the Queue's consumer
//! feeds after each batch (ADR 0015).

mod analytics;
mod breaker;
mod clock;
mod config;
mod cron;
mod flag;
mod http;
mod metrics;
mod objects;
mod queue;
mod random;
mod stripe;

pub use objects::account::Account;
pub use objects::billing::Billing;
pub use objects::catalog::Catalog;
pub use objects::catering::CateringEvent;
pub use objects::control::Control;
pub use objects::crm::Crm;
pub use objects::customer::Customer;
pub use objects::dispatch::Dispatch;
pub use objects::inbox::Inbox;
pub use objects::kitchen::Kitchen;
pub use objects::order::Order;
pub use objects::recorder::Recorder;
pub use objects::sandbox::Sandbox;
pub use objects::schedule::Schedule;
pub use objects::simulator::Simulator;

use worker::{Context, Env, Request, Response, Result, event};

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    http::handle(req, env).await
}
