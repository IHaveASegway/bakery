//! The kitchen board's socket and the console's heartbeat (docs/architecture.md, "Durable
//! Object topology"; docs/security.md, "Cross-site WebSocket hijacking" and "Denial of service
//! against the kitchen socket").
//!
//! The upgrade reaches the Kitchen only after the router's checks: the exact `Origin` (a GET,
//! but it carries the cookie and ignores CORS), the session cookie and never a token, the
//! per-session upgrade limit, and `sbx == id`. The Kitchen accepts the socket on the Hibernation
//! API, and any session of the sandbox, a guest's included, watches the board and sends its three
//! moves (roadmap R72, 2026-11-10), so the upgrade carries no session kind.

use bakery_contracts::SandboxState;
use worker::{Headers, Method, Request, RequestInit, Response};

use super::Cx;
use super::problem::{self, Failure};
use super::sandboxes::{not_revoked, own_sandbox, state};
use crate::objects::kitchen;
use crate::objects::sql::call_empty;

type Answer = Result<Response, Failure>;

/// What a Kitchen's 410 means: the sandbox is still seeding its children, or it is gone.
async fn gone(cx: &Cx, id: bakery_domain::Ulid) -> Failure {
    match state(cx, id).await {
        Ok(Some(s)) if s.state == SandboxState::Seeding => problem::seeding(),
        Ok(_) => problem::wiped(),
        Err(f) => f,
    }
}

/// `GET /v1/sandboxes/{id}/kitchen/ws`: 101 and the socket, or a problem before any upgrade.
pub async fn socket(cx: &Cx, req: &Request, id: Option<&str>) -> Answer {
    let upgrade = req
        .headers()
        .get("Upgrade")
        .ok()
        .flatten()
        .unwrap_or_default();
    if !upgrade.eq_ignore_ascii_case("websocket") {
        return Err(problem::upgrade());
    }
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let stub = cx
        .env
        .durable_object(kitchen::BINDING)?
        .get_by_name(&kitchen::name(id))?;
    let headers = Headers::new();
    headers.set("Upgrade", "websocket")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get).with_headers(headers);
    let inner = Request::new_with_init("https://object.internal/_ws", &init)?;
    let res = stub.fetch_with_request(inner).await?;
    match res.status_code() {
        101 => {
            // A response from an object has immutable headers; a fresh one takes the router's.
            let ws = res
                .websocket()
                .ok_or_else(|| problem::internal().because("no-socket"))?;
            Ok(Response::from_websocket(ws)?)
        }
        410 => Err(gone(cx, id).await),
        426 => Err(problem::upgrade()),
        _ => Err(problem::internal()),
    }
}

/// `POST /v1/sandboxes/{id}/heartbeat`: the console is open with no socket. Any session; the
/// Kitchen keeps the time for the Simulator's 90 s window.
pub async fn heartbeat(cx: &Cx, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let res = call_empty(
        &cx.env,
        kitchen::BINDING,
        &kitchen::name(id),
        Method::Post,
        "/_heartbeat",
    )
    .await?;
    match res.status_code() {
        204 => Ok(Response::empty()?.with_status(204)),
        410 => Err(gone(cx, id).await),
        _ => Err(problem::internal()),
    }
}
