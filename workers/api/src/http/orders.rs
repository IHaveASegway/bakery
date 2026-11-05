//! Orders: place, read and cancel (docs/architecture.md, "Placing and paying an order";
//! docs/domain.md, "Order" and "Idempotency").
//!
//! Placing is three calls. The Sandbox maps the `Idempotency-Key` to one order ULID and
//! registers `order:<sandbox>:<ulid>` before anything is written there; the Catalog gives the
//! published menu the prices come from; the Order decides. The same key again finds the same
//! ULID, and the Order's `commands_seen` answers the first result with `Idempotent-Replayed:
//! true`, appending nothing. An unpaid order waits 15 minutes of business time and expires; PR 5's
//! payment route (payments.rs) pays it, and only Stripe's webhook marks it paid.

use bakery_contracts::OrderRequest;
use bakery_domain::catalog::MenuView;
use bakery_domain::order::{DEFAULT_TAX_BP, LineInput, OrderKind};
use bakery_domain::{BusinessTime, Ulid};
use worker::{Method, Request, Response};

use super::problem::{self, Failure, Refused};
use super::sandboxes::{not_revoked, own_sandbox};
use super::{Cx, body_hash};
use crate::objects::catalog;
use crate::objects::child::Birth;
use crate::objects::order::{self, Action, Command, Place};
use crate::objects::sandbox::{self, OrderSlot, RegisterOrder};
use crate::objects::sql::{call, call_empty};
use bakery_app::names::sandbox_object_name;

type Answer = Result<Response, Failure>;

/// An Order's answer, passed on: its status, its body, and the replay header.
pub(super) async fn answered(mut res: Response, created: u16, location: Option<String>) -> Answer {
    match res.status_code() {
        200 | 201 => {
            let replayed = res.headers().get("Idempotent-Replayed")?.is_some();
            let status = if replayed { 200 } else { created };
            let mut out = Response::ok(res.text().await?)?.with_status(status);
            let headers = out.headers_mut();
            headers.set("Content-Type", "application/json")?;
            if replayed {
                headers.set("Idempotent-Replayed", "true")?;
            }
            if let Some(l) = location {
                headers.set("Location", &l)?;
            }
            Ok(out)
        }
        404 => Err(problem::not_found().because("no-order")),
        410 => Err(problem::wiped()),
        422 => {
            let refused: Refused = res.json().await?;
            if refused.error == "key-reused" {
                return Err(problem::idempotency_reused());
            }
            Err(problem::order(
                refused.rule.as_deref().unwrap_or(""),
                refused.class.as_deref(),
            ))
        }
        _ => Err(problem::internal()),
    }
}

/// `POST /v1/sandboxes/{id}/orders`: any session, a guest's included (Q45 · Q-guest-scope:
/// guests browse, order and pay).
pub async fn place(cx: &Cx, req: &mut Request, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: OrderRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    let slot: BusinessTime = body
        .slot
        .parse()
        .map_err(|_| problem::order("slot", None))?;
    let kind = match body.kind {
        bakery_contracts::OrderKind::Pickup => OrderKind::Pickup,
        bakery_contracts::OrderKind::Delivery => OrderKind::Delivery,
    };

    let mut res = call(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Post,
        "/_register-order",
        Some(&RegisterOrder {
            key: key.to_string(),
        }),
    )
    .await?;
    let slot_of: OrderSlot = match res.status_code() {
        200 => res.json().await?,
        409 => return Err(problem::seeding()),
        410 => return Err(problem::wiped()),
        _ => return Err(problem::internal()),
    };

    let mut res = call_empty(
        &cx.env,
        catalog::BINDING,
        &catalog::name(id),
        Method::Get,
        "/_menu",
    )
    .await?;
    let menu: MenuView = match res.status_code() {
        200 => res.json().await?,
        410 => return Err(problem::wiped()),
        _ => return Err(problem::internal()),
    };

    let name = order::name(id, slot_of.order);
    let res = call(
        &cx.env,
        order::BINDING,
        &name,
        Method::Post,
        "/_place",
        Some(&Place {
            key: key.to_string(),
            body_hash: body_hash(&text),
            birth: Birth {
                sandbox: id,
                name: name.clone(),
                clock_offset_s: slot_of.clock_offset_s,
                clock_v: slot_of.clock_v,
            },
            order: slot_of.order,
            customer: slot_of.persona,
            kind,
            slot,
            zone: body.zone,
            lines: body
                .lines
                .into_iter()
                .map(|l| LineInput {
                    variant: l.variant,
                    qty: l.qty,
                })
                .collect(),
            note: body.note,
            menu,
            tax_bp: DEFAULT_TAX_BP,
            cause: None,
        }),
    )
    .await?;
    let location = format!("/v1/sandboxes/{id}/orders/{}", slot_of.order);
    answered(res, 201, Some(location)).await
}

/// The order's object name, once the Sandbox's registry holds it (docs/architecture.md,
/// "Object naming": an aggregate's ULID must be registered before it is addressed).
pub(super) async fn registered(cx: &Cx, id: Ulid, oid: Option<&str>) -> Result<String, Failure> {
    let oid: Ulid = oid
        .and_then(|o| o.parse().ok())
        .ok_or_else(|| problem::not_found().because("no-order"))?;
    let name = order::name(id, oid);
    let res = call_empty(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Get,
        &format!("/_child/{name}"),
    )
    .await?;
    match res.status_code() {
        200 => Ok(name),
        410 => Err(problem::wiped()),
        _ => Err(problem::not_found().because("no-order")),
    }
}

/// `GET /v1/sandboxes/{id}/orders/{oid}`.
pub async fn get(cx: &Cx, id: Option<&str>, oid: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let name = registered(cx, id, oid).await?;
    let res = call_empty(&cx.env, order::BINDING, &name, Method::Get, "/_order").await?;
    match res.status_code() {
        // An order registered and refused holds nothing: the same 404 as none.
        410 => Err(problem::not_found().because("no-order")),
        _ => answered(res, 200, None).await,
    }
}

/// `POST /v1/sandboxes/{id}/orders/{oid}/cancel`: `CancelOrder` by the customer, before
/// payment (and, once PR 5 pays orders, before production with a refund).
pub async fn cancel(cx: &Cx, id: Option<&str>, oid: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let name = registered(cx, id, oid).await?;
    let res = call(
        &cx.env,
        order::BINDING,
        &name,
        Method::Post,
        "/_command",
        Some(&Command {
            key: key.to_string(),
            action: Action::Cancel,
            body_hash: String::new(),
            cause: None,
        }),
    )
    .await?;
    match res.status_code() {
        410 => Err(problem::not_found().because("no-order")),
        _ => answered(res, 200, None).await,
    }
}
