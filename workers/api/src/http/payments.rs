//! Paying and refunding an order, and the ledger (docs/architecture.md, "Placing and paying an
//! order"; ADR 0007, decisions 3, 5 and 6).
//!
//! - `POST .../orders/{oid}/payment` asks `Billing` for the order's payment and Stripe intent,
//!   and answers the client secret the Payment Element mounts with. A remount (the storefront
//!   sends the order's own ULID as the key every time) gets the same payment and the same
//!   intent: Billing reuses the open payment, and Stripe answers the same idempotency key with
//!   the same intent. Only Stripe's webhook marks the order paid, never this route.
//! - `POST .../orders/{oid}/refund`, staff only: the Order's `RefundOrder`, whose
//!   `OrderRefundRequested` reaches `Billing` through the Queue; Billing refunds at Stripe and
//!   its `RefundIssued` comes back to the Order as `OrderRefunded`.
//! - `GET .../billing/ledger`: every payment and refund Billing recorded, signed, with totals.
//!
//! Each answers 503 `stripe-key` when the API's key is not a sandbox key (stripe.rs). The client
//! secret passes through this file once, into the response body, and is never logged.

use bakery_contracts::{
    OrderResponse, OrderStatus, PaymentResponse, PaymentStatus as WireStatus, RefundReason as Wire,
    RefundRequest, RefundResponse,
};
use bakery_domain::billing::{PaymentStatus, Purpose};
use bakery_domain::order::RefundReason;
use bakery_domain::{Cents, Ulid};
use worker::{Method, Request, Response};

use super::orders::registered;
use super::problem::{self, Failure, Refused};
use super::sandboxes::{not_revoked, own_sandbox};
use super::{Cx, body_hash, json};
use crate::config::ConfigError;
use crate::objects::billing::{self, IntentIn, IntentOut};
use crate::objects::order::{self, Refund, RefundAnswer};
use crate::objects::sql::{call, call_empty};
use crate::stripe::{self, Unavailable};

type Answer = Result<Response, Failure>;

/// The key guard, first on every payment route.
fn guard(cx: &Cx) -> Result<(), Failure> {
    stripe::key_guard(&cx.env).map(|_| ()).map_err(refusal)
}

fn refusal(u: Unavailable) -> Failure {
    match u {
        Unavailable::Key => problem::stripe_key(),
        Unavailable::Config(e) => e.into(),
    }
}

/// A Billing refusal, mapped to the visitor's problem.
async fn billing_failure(mut res: Response) -> Failure {
    #[derive(Default, serde::Deserialize)]
    struct Body {
        #[serde(default)]
        error: String,
        #[serde(default)]
        name: String,
    }
    let status = res.status_code();
    let body: Body = res.json().await.unwrap_or_default();
    match (status, body.error.as_str()) {
        (410, _) => problem::wiped(),
        (409, "paid") => problem::order_conflict("paid"),
        (409, "canceled") => problem::order_conflict("canceled"),
        (503, "stripe-key") => problem::stripe_key(),
        (503, "config") => Failure::from(match body.name.as_str() {
            stripe::WEBHOOK_SECRET => ConfigError::Missing(stripe::WEBHOOK_SECRET),
            _ => ConfigError::Missing(stripe::SECRET_KEY),
        }),
        (503, "stripe") => problem::stripe(true),
        (502, "stripe") => problem::stripe(false),
        _ => problem::internal().because("billing"),
    }
}

/// The order, as its object holds it, or the 404 an unknown one gets.
async fn order_of(cx: &Cx, name: &str) -> Result<OrderResponse, Failure> {
    let mut res = call_empty(&cx.env, order::BINDING, name, Method::Get, "/_order").await?;
    match res.status_code() {
        200 => Ok(res.json().await?),
        410 | 404 => Err(problem::not_found().because("no-order")),
        _ => Err(problem::internal()),
    }
}

fn wire_status(s: PaymentStatus) -> WireStatus {
    match s {
        PaymentStatus::Created => WireStatus::Created,
        PaymentStatus::Succeeded => WireStatus::Succeeded,
        PaymentStatus::Failed => WireStatus::Failed,
        PaymentStatus::Canceled => WireStatus::Canceled,
    }
}

/// `POST /v1/sandboxes/{id}/orders/{oid}/payment`: any session, a guest's included (guests
/// browse, order and pay). No body.
pub async fn pay(cx: &Cx, id: Option<&str>, oid: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    guard(cx)?;
    let name = registered(cx, id, oid).await?;
    let order = order_of(cx, &name).await?;
    if order.status != OrderStatus::Placed {
        return Err(problem::order_conflict("not-payable"));
    }
    let reference: Ulid = order.id.parse().map_err(|_| problem::internal())?;
    let mut res = call(
        &cx.env,
        billing::BINDING,
        &billing::name(id),
        Method::Post,
        "/_intent",
        Some(&IntentIn {
            purpose: Purpose::Order,
            reference,
            amount: Cents(order.total_cents),
        }),
    )
    .await?;
    if res.status_code() != 200 {
        return Err(billing_failure(res).await);
    }
    let out: IntentOut =
        serde_json::from_str(&res.text().await?).map_err(|_| problem::internal())?;
    json(
        &PaymentResponse {
            payment: out.payment.to_string(),
            client_secret: out.client_secret,
            publishable_key: stripe::publishable_key(&cx.env),
            amount_cents: out.amount_cents.0,
            status: wire_status(out.status),
        },
        200,
    )
}

/// `POST /v1/sandboxes/{id}/orders/{oid}/refund`, signed in: `{reason}` for all that is left,
/// `{amount_cents, reason}` for a part.
pub async fn refund(cx: &Cx, req: &mut Request, id: Option<&str>, oid: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    guard(cx)?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: RefundRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    let name = registered(cx, id, oid).await?;
    let oid: Ulid = oid
        .and_then(|o| o.parse().ok())
        .ok_or_else(|| problem::not_found().because("no-order"))?;

    // Only a payment Billing took can be refunded at Stripe.
    let res = call_empty(
        &cx.env,
        billing::BINDING,
        &billing::name(id),
        Method::Get,
        &format!("/_payment/{oid}"),
    )
    .await?;
    match res.status_code() {
        200 => {}
        404 => {
            let order = order_of(cx, &name).await?;
            return Err(match order.status {
                OrderStatus::Placed
                | OrderStatus::Expired
                | OrderStatus::Cancelled
                | OrderStatus::RefundPending => problem::order("out-of-order", None),
                _ => problem::order_conflict("no-stripe-payment"),
            });
        }
        _ => return Err(billing_failure(res).await),
    }

    let reason = match body.reason {
        Wire::MissingItem => RefundReason::MissingItem,
        Wire::Quality => RefundReason::Quality,
        Wire::Goodwill => RefundReason::Goodwill,
    };
    let mut res = call(
        &cx.env,
        order::BINDING,
        &name,
        Method::Post,
        "/_refund",
        Some(&Refund {
            key: key.to_string(),
            body_hash: body_hash(&text),
            amount: body.amount_cents.map(Cents),
            reason,
        }),
    )
    .await?;
    match res.status_code() {
        200 => {
            let replayed = res.headers().get("Idempotent-Replayed")?.is_some();
            let answer: RefundAnswer =
                serde_json::from_str(&res.text().await?).map_err(|_| problem::internal())?;
            let mut out = json(
                &RefundResponse {
                    refund: answer.refund.to_string(),
                    amount_cents: answer.amount_cents.0,
                    status: answer.order.status,
                },
                200,
            )?;
            if replayed {
                out.headers_mut().set("Idempotent-Replayed", "true")?;
            }
            Ok(out)
        }
        410 => Err(problem::not_found().because("no-order")),
        422 => {
            let refused: Refused = res.json().await?;
            if refused.error == "key-reused" {
                return Err(problem::idempotency_reused());
            }
            Err(problem::order(refused.rule.as_deref().unwrap_or(""), None))
        }
        _ => Err(problem::internal()),
    }
}

/// `GET /v1/sandboxes/{id}/billing/ledger`.
pub async fn ledger(cx: &Cx, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    guard(cx)?;
    let mut res = call_empty(
        &cx.env,
        billing::BINDING,
        &billing::name(id),
        Method::Get,
        "/_ledger",
    )
    .await?;
    match res.status_code() {
        200 => {
            let mut out = Response::ok(res.text().await?)?;
            out.headers_mut().set("Content-Type", "application/json")?;
            Ok(out)
        }
        410 => {
            // A sandbox seeded before Billing existed has none; a wiped one is gone.
            match super::sandboxes::state(cx, id).await? {
                Some(_) => Err(problem::not_found().because("no-billing")),
                None => Err(problem::wiped()),
            }
        }
        _ => Err(billing_failure(res).await),
    }
}
