//! Simulated traffic: read, start and stop the sandbox's `Simulator` (docs/architecture.md,
//! "Simulated traffic"; docs/domain.md, "Simulator"). Starting and stopping are console writes,
//! signed-in only (Q45 · Q-guest-scope); reading is open to any session, so a guest's console
//! shows that nothing runs.
//!
//! The router registers `simulator:<sandbox>` with the Sandbox on the first start, as every
//! child is born, and hands the Simulator what it needs from the Sandbox's state: the seed, the
//! birth and the visitor's persona, whom it never orders as.

use bakery_contracts::{SandboxState, TrafficRequest, TrafficResponse};
use bakery_domain::Ulid;
use serde::Deserialize;
use worker::{Method, Request, Response};

use super::problem::{self, Failure, Refused};
use super::sandboxes::{not_revoked, own_sandbox, state};
use super::{Cx, json};
use crate::config::traffic_minutes_cap;
use crate::objects::child::Birth;
use crate::objects::sandbox::{self, RegisterRequest};
use crate::objects::simulator::{self, Start, Stop, rate_allowed};
use crate::objects::sql::{call, call_empty};
use crate::random;
use bakery_app::names::sandbox_object_name;

type Answer = Result<Response, Failure>;

/// Whether the Sandbox holds a Simulator yet. `Err` for a wiped sandbox.
async fn registered(cx: &Cx, id: Ulid) -> Result<bool, Failure> {
    let res = call_empty(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Get,
        &format!("/_child/{}", simulator::name(id)),
    )
    .await?;
    match res.status_code() {
        200 => Ok(true),
        404 => Ok(false),
        410 => Err(problem::wiped()),
        _ => Err(problem::internal()),
    }
}

/// What a sandbox that never started traffic shows.
fn never_started(cx: &Cx) -> TrafficResponse {
    let cap = traffic_minutes_cap(&cx.env);
    TrafficResponse {
        running: false,
        rate: 0,
        minutes_used: 0,
        minutes_left: cap,
        orders: 0,
    }
}

/// The Simulator's `TrafficResponse`, passed on, or its refusal as a problem.
async fn answered(cx: &Cx, mut res: Response) -> Answer {
    match res.status_code() {
        200 => {
            let replayed = res.headers().get("Idempotent-Replayed")?.is_some();
            let body: TrafficResponse =
                serde_json::from_str(&res.text().await?).map_err(|_| problem::internal())?;
            let mut out = json(&body, 200)?;
            if replayed {
                out.headers_mut().set("Idempotent-Replayed", "true")?;
            }
            Ok(out)
        }
        409 => Err(problem::traffic_running()),
        410 => Err(problem::wiped()),
        422 => {
            let r: Refused = serde_json::from_str(&res.text().await?).unwrap_or_default();
            Err(problem::traffic(r.rule.as_deref().unwrap_or("")))
        }
        503 => {
            let midnight = cx.now.next_utc_midnight();
            let wait = (midnight.unix_ms() - cx.now.unix_ms()).div_euclid(1_000);
            Err(problem::traffic_cap(
                u32::try_from(wait).unwrap_or(0),
                traffic_minutes_cap(&cx.env),
            ))
        }
        _ => Err(problem::internal()),
    }
}

/// `GET /v1/sandboxes/{id}/traffic`.
pub async fn get(cx: &Cx, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    if !registered(cx, id).await? {
        return json(&never_started(cx), 200);
    }
    let res = call_empty(
        &cx.env,
        simulator::BINDING,
        &simulator::name(id),
        Method::Get,
        "/_traffic",
    )
    .await?;
    answered(cx, res).await
}

/// `POST /v1/sandboxes/{id}/traffic {rate}`: `StartTraffic`. 422 `traffic` for a rate outside 1
/// to 6, before any object is asked.
pub async fn start(cx: &Cx, req: &mut Request, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    cx.caused(key.to_string());
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: TrafficRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    if !rate_allowed(body.rate) {
        return Err(problem::traffic("rate"));
    }
    let sandbox = state(cx, id).await?.ok_or_else(problem::wiped)?;
    if sandbox.state == SandboxState::Seeding {
        return Err(problem::seeding());
    }
    let name = simulator::name(id);
    let mut res = call(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Post,
        "/_register",
        Some(&RegisterRequest {
            name: name.clone(),
            class: simulator::CLASS.into(),
        }),
    )
    .await?;
    #[derive(Deserialize)]
    struct Registered {
        clock_offset_s: i64,
        clock_v: u32,
    }
    let registered: Registered = match res.status_code() {
        200 => serde_json::from_str(&res.text().await?).map_err(|_| problem::internal())?,
        409 => return Err(problem::seeding()),
        410 => return Err(problem::wiped()),
        _ => return Err(problem::internal()),
    };
    let persona: Ulid = sandbox.persona.parse().map_err(|_| problem::internal())?;
    let born = sandbox.born.parse().map_err(|_| problem::internal())?;
    let res = call(
        &cx.env,
        simulator::BINDING,
        &name,
        Method::Post,
        "/_start",
        Some(&Start {
            key: key.to_string(),
            birth: Birth {
                sandbox: id,
                name: name.clone(),
                clock_offset_s: registered.clock_offset_s,
                clock_v: registered.clock_v,
            },
            seed: sandbox.seed,
            born,
            persona,
            rate: body.rate,
        }),
    )
    .await?;
    if res.status_code() == 503 {
        cx.reason("traffic-cap");
    }
    answered(cx, res).await
}

/// `DELETE /v1/sandboxes/{id}/traffic`: `StopTraffic`. A Simulator that is not running answers
/// its state unchanged, so the request can be repeated.
pub async fn stop(cx: &Cx, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    if !registered(cx, id).await? {
        return json(&never_started(cx), 200);
    }
    let key = random::ulid(cx.now)?.to_string();
    cx.caused(&key);
    let res = call(
        &cx.env,
        simulator::BINDING,
        &simulator::name(id),
        Method::Post,
        "/_stop",
        Some(&Stop { key }),
    )
    .await?;
    answered(cx, res).await
}
