//! `POST /v1/stripe/webhook`: Stripe's events, into the sandbox's `Billing` (ADR 0007, decision
//! 7; docs/security.md, "Payments safety"; docs/architecture.md, "Placing and paying an order").
//!
//! Stripe calls this, not a browser, so the router gives it no CORS headers, no preflight, no
//! Origin check, no session and no `Idempotency-Key`; it answers before any of those run. In
//! order:
//!
//! 1. The key guard: an API whose `STRIPE_SECRET_KEY` is not a sandbox key answers 503
//!    `stripe-key`, so Stripe keeps the event and retries once the key is fixed.
//! 2. The raw body, as bytes, before anything parses it, and `Stripe-Signature` checked over it
//!    with `STRIPE_WEBHOOK_SECRET`: 400 `signature`, or 400 `timestamp` for a `t` more than five
//!    minutes from now. An unverified body never picks a sandbox.
//! 3. The parse (400 `body`) and the mode (400 `livemode`).
//! 4. An event Billing has no use for (`charge.refunded`, anything not the bakery's) is 200.
//! 5. The sandbox: from the intent's `metadata[sandbox]`. A payment intent's event carries it;
//!    a refund's object carries the refund's own metadata, which is not the intent's, so the
//!    intent is read from Stripe for it. None is 200: not the bakery's.
//! 6. `billing:<sandbox>`'s `/_webhook`: 200 for an event applied, replayed or with no effect;
//!    200 for a sandbox that is wiped or never was, so Stripe stops retrying; 409
//!    `webhook-later` for one Billing cannot apply yet (an unknown intent, a refund before its
//!    payment), so Stripe retries.
//!
//! The log line carries the route, the status and a reason code; Billing's line carries the
//! Stripe event id. Never the body, the header or the secret.

use bakery_app::ports::PortError;
use bakery_app::stripe::{EventObject, TOLERANCE_S, parse_event, verify_signature};
use bakery_domain::Ulid;
use bakery_domain::billing::BillingCommand;
use worker::{Method, Request, Response};

use super::problem::{self, Failure};
use super::{Cx, json};
use crate::objects::billing::{self, WebhookIn};
use crate::objects::sql::call;
use crate::stripe::{self, Stripe, Unavailable};

type Answer = Result<Response, Failure>;

fn received(cx: &Cx, reason: &'static str) -> Answer {
    cx.reason(reason);
    json(&serde_json::json!({ "received": true }), 200)
}

fn unavailable(u: Unavailable) -> Failure {
    match u {
        Unavailable::Key => problem::stripe_key(),
        Unavailable::Config(e) => e.into(),
    }
}

pub async fn receive(cx: &Cx, req: &mut Request) -> Answer {
    stripe::key_guard(&cx.env).map_err(unavailable)?;
    let secret = stripe::webhook_secret(&cx.env)?;
    let body = req.bytes().await.map_err(|_| problem::webhook("body"))?;
    let Some(header) = req.headers().get("Stripe-Signature").ok().flatten() else {
        return Err(problem::webhook("signature"));
    };
    let now_s = cx.now.unix_ms().div_euclid(1_000);
    verify_signature(&header, &body, &secret, now_s, TOLERANCE_S)
        .map_err(|e| problem::webhook(e.reason()))?;
    let event = parse_event(&body).map_err(|e| problem::webhook(e.reason()))?;
    event
        .require_test()
        .map_err(|e| problem::webhook(e.reason()))?;
    let Some(BillingCommand::ApplyEvent { event_id, kind }) = event.billing_command() else {
        return received(cx, "ignored");
    };
    let sandbox: Option<Ulid> = match &event.data.object {
        EventObject::Refund(r) => {
            let Some(intent) = r.payment_intent.as_deref() else {
                return received(cx, "no-sandbox");
            };
            let gateway = Stripe::from_env(&cx.env).map_err(unavailable)?;
            match gateway.intent_metadata(intent).await {
                Ok(m) => m.get("sandbox").and_then(|s| s.parse().ok()),
                Err(PortError::Unavailable(_)) => return Err(problem::stripe(true)),
                // An intent Stripe does not know, or one from the other mode: not the bakery's.
                Err(_) => None,
            }
        }
        _ => event.sandbox(),
    };
    let Some(sandbox) = sandbox else {
        return received(cx, "no-sandbox");
    };
    cx.sandbox(Some(sandbox));
    let res = call(
        &cx.env,
        billing::BINDING,
        &billing::name(sandbox),
        Method::Post,
        "/_webhook",
        Some(&WebhookIn { event_id, kind }),
    )
    .await?;
    match res.status_code() {
        200 => received(cx, "delivered"),
        410 => received(cx, "wiped"),
        409 => Err(problem::webhook_later()),
        _ => Err(problem::internal()),
    }
}
