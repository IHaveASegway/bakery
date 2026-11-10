//! The flight recorder's two routes (docs/architecture.md, "The flight recorder"; ADR 0015):
//! `GET /v1/sandboxes/{id}/trace?after=<cursor>`, the hops after a cursor, for `curl` and as the
//! socket's fallback; and `GET /v1/sandboxes/{id}/trace/ws`, the socket, which takes the router's
//! checks exactly as the kitchen socket does (kitchen.rs): the exact `Origin`, the session cookie
//! and never a token, the per-session upgrade limit, and `sbx == id`. Any session of the sandbox
//! reads both, a guest's included, since the storefront's guide runs for guests too.

use bakery_contracts::{SandboxState, TraceResponse};
use worker::{Headers, Method, Request, RequestInit, Response};

use super::problem::{self, Failure};
use super::sandboxes::{not_revoked, own_sandbox, state};
use super::{Cx, json};
use crate::objects::recorder::{self, after_of};
use crate::objects::sql::call_empty;

type Answer = Result<Response, Failure>;

/// What a Recorder's 410 means, read from the sandbox's state: one rule for both routes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unrecorded {
    /// The sandbox is still seeding its children: 503 `seeding`.
    Seeding,
    /// The sandbox is being wiped, or is gone: 410 `wiped`.
    Wiped,
    /// A live sandbox whose Recorder was never seeded, one born before the recorder's deploy: it
    /// has recorded nothing. The read answers an empty page; the socket refuses with 404
    /// `not-found`, reason `no-recorder`, since there is no object to watch and nothing was wiped.
    NeverSeeded,
}

pub fn unrecorded(state: Option<SandboxState>) -> Unrecorded {
    match state {
        Some(SandboxState::Seeding) => Unrecorded::Seeding,
        Some(SandboxState::Live) => Unrecorded::NeverSeeded,
        Some(SandboxState::Wiping | SandboxState::Wiped) | None => Unrecorded::Wiped,
    }
}

/// The sandbox's state, for a Recorder that answered 410.
async fn unrecorded_for(cx: &Cx, id: bakery_domain::Ulid) -> Result<Unrecorded, Failure> {
    Ok(unrecorded(state(cx, id).await?.map(|s| s.state)))
}

/// `GET /v1/sandboxes/{id}/trace`: the Recorder's page after `after`. A live sandbox whose
/// Recorder was never seeded (one born before the recorder existed) has recorded nothing, and
/// says so with an empty page.
pub async fn get(cx: &Cx, req: &Request, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let url = req.url().map_err(|_| problem::internal())?;
    let after = after_of(url.query());
    let mut res = call_empty(
        &cx.env,
        recorder::BINDING,
        &recorder::name(id),
        Method::Get,
        &format!("/_trace?after={after}"),
    )
    .await?;
    match res.status_code() {
        200 => {
            let page: TraceResponse = res.json().await?;
            let mut out = json(&page, 200)?;
            out.headers_mut().set("Cache-Control", "no-store")?;
            Ok(out)
        }
        410 => match unrecorded_for(cx, id).await? {
            Unrecorded::Seeding => Err(problem::seeding()),
            Unrecorded::Wiped => Err(problem::wiped()),
            Unrecorded::NeverSeeded => {
                cx.reason("no-recorder");
                json(
                    &TraceResponse {
                        hops: Vec::new(),
                        cursor: after,
                        more: false,
                        missed: false,
                    },
                    200,
                )
            }
        },
        _ => Err(problem::internal()),
    }
}

/// `GET /v1/sandboxes/{id}/trace/ws`: 101 and the socket, or a problem before any upgrade.
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
        .durable_object(recorder::BINDING)?
        .get_by_name(&recorder::name(id))?;
    let headers = Headers::new();
    headers.set("Upgrade", "websocket")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get).with_headers(headers);
    let inner = Request::new_with_init("https://object.internal/_ws", &init)?;
    let res = stub.fetch_with_request(inner).await?;
    match res.status_code() {
        101 => {
            cx.reason("socket-trace");
            // A response from an object has immutable headers; a fresh one takes the router's.
            let ws = res
                .websocket()
                .ok_or_else(|| problem::internal().because("no-socket"))?;
            Ok(Response::from_websocket(ws)?)
        }
        410 => Err(match unrecorded_for(cx, id).await? {
            Unrecorded::Seeding => problem::seeding(),
            Unrecorded::Wiped => problem::wiped(),
            Unrecorded::NeverSeeded => problem::not_found().because("no-recorder"),
        }),
        426 => Err(problem::upgrade()),
        _ => Err(problem::internal()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One rule for both routes, by the sandbox's state when its Recorder answers 410.
    #[test]
    fn a_missing_recorder_is_read_from_the_sandbox_state() {
        assert_eq!(unrecorded(Some(SandboxState::Seeding)), Unrecorded::Seeding);
        assert_eq!(unrecorded(Some(SandboxState::Wiping)), Unrecorded::Wiped);
        assert_eq!(unrecorded(Some(SandboxState::Wiped)), Unrecorded::Wiped);
        assert_eq!(unrecorded(None), Unrecorded::Wiped, "no sandbox at all");
        assert_eq!(
            unrecorded(Some(SandboxState::Live)),
            Unrecorded::NeverSeeded,
            "live, but born before the recorder: not wiped"
        );
    }
}
