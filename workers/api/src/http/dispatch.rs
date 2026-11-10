//! A bakery day's dispatch: its stops, the server's proposed plan, the browser's plan, the
//! published plan and the stops completed (docs/roadmap.md, PR 9; ADR 0012).
//!
//! The day is the path's `YYYY-MM-DD`. The Sandbox registers `dispatch:<sandbox>:<date>` for a
//! date from the sandbox's birth day to 30 days after business today, as for a Schedule day, and
//! the day is born on that first touch, empty; any other date is 404 `no-such-day`. A read is any
//! session's, a guest's included; the four commands are staff's, so a guest gets 403
//! `guest-scope` from the router. Every command takes an `Idempotency-Key`: the same key and body
//! again answer the stored result with `Idempotent-Replayed: true`, and the same key with another
//! body is 422 `idempotency-key`.
//!
//! A rule the object refuses is a `dispatch` problem whose `detail` names the rule as a whole
//! word ("The rule is stop-twice."), the status by route: 422 for a proposal (`vans`, `capacity`,
//! `no-stops`, `place-unknown`) and for the browser's plan (`route-ends`, `vans`, `stop-unknown`,
//! `stop-twice`, `over-capacity`, `stop-missing`, `window`, `no-stops`); 409 for a publish
//! (`no-plan`, `stop-missing`, `published` once a van has left, and the plan's own rules again
//! when stops came or went since it was stored); for a completion 409 `no-plan` and `not-ready`
//! (the stop's order is not ready yet) and 422 `stop-unknown`.

use bakery_app::dispatch_view::{plan_choice, submitted_routes};
use bakery_app::names::sandbox_object_name;
use bakery_contracts::{
    CompleteStopRequest, DispatchResponse, PlanRequest, ProposeRequest, PublishRequest,
};
use bakery_domain::BakeryDate;
use worker::{Method, Request, Response};

use super::problem::{self, Failure};
use super::sandboxes::{not_revoked, own_sandbox};
use super::{Cx, body_hash, json};
use crate::objects::child::Birth;
use crate::objects::dispatch::{self, Answer as DayAnswer, Cmd, CommandIn, Open, Refusal};
use crate::objects::sandbox::{self, DayBirth, RegisterDay};
use crate::objects::sql::call;

type Answer = Result<Response, Failure>;

/// Which command a refusal came from: it picks the problem's status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Propose,
    Plan,
    Publish,
    Complete,
}

impl Step {
    /// The command's key prefix in the object's `commands_seen`.
    fn prefix(self) -> &'static str {
        match self {
            Step::Propose => "propose",
            Step::Plan => "plan",
            Step::Publish => "publish",
            Step::Complete => "complete",
        }
    }

    /// 409 for what the day's state blocks (a publish, a completion with no plan), 422 for a
    /// request that breaks a rule as sent.
    pub fn status(self, rule: &str) -> u16 {
        match (self, rule) {
            (Step::Publish, _) | (Step::Complete, "no-plan" | "not-ready") => 409,
            _ => 422,
        }
    }
}

/// The day's birth from the Sandbox, which registers it first.
async fn day(cx: &Cx, id: bakery_domain::Ulid, date: Option<&str>) -> Result<Birth, Failure> {
    let date: BakeryDate = date
        .and_then(|d| d.parse().ok())
        .ok_or_else(problem::no_such_dispatch_day)?;
    let mut res = call(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Post,
        "/_register-dispatch",
        Some(&RegisterDay {
            date,
            catering: false,
        }),
    )
    .await?;
    let day: DayBirth = match res.status_code() {
        200 => res.json().await?,
        404 => return Err(problem::no_such_dispatch_day()),
        409 => return Err(problem::seeding()),
        410 => return Err(problem::wiped()),
        _ => return Err(problem::internal()),
    };
    Ok(Birth {
        sandbox: id,
        name: day.name,
        clock_offset_s: day.clock_offset_s,
        clock_v: day.clock_v,
    })
}

/// `GET /v1/sandboxes/{id}/dispatch/{date}` → `DispatchResponse`.
pub async fn get(cx: &Cx, id: Option<&str>, date: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let birth = day(cx, id, date).await?;
    let name = birth.name.clone();
    let mut res = call(
        &cx.env,
        dispatch::BINDING,
        &name,
        Method::Post,
        "/_open",
        Some(&Open { birth }),
    )
    .await?;
    match res.status_code() {
        200 => {
            let day: DispatchResponse = res.json().await?;
            json(&day, 200)
        }
        410 => Err(problem::wiped()),
        _ => Err(problem::internal()),
    }
}

/// `POST .../dispatch/{date}/propose {vans, capacity}`: the server's savings plan.
pub async fn propose(cx: &Cx, req: &mut Request, id: Option<&str>, date: Option<&str>) -> Answer {
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: ProposeRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    let cmd = Cmd::Propose {
        vans: body.vans,
        capacity: body.capacity,
    };
    command(cx, id, date, &text, cmd, Step::Propose).await
}

/// `POST .../dispatch/{date}/plan {vans: [{van, stops, start?, end?}]}`: the browser's plan,
/// validated, its minutes recomputed from the matrix.
pub async fn plan(cx: &Cx, req: &mut Request, id: Option<&str>, date: Option<&str>) -> Answer {
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: PlanRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    // A stop that is not even an order id is not a stop of this day.
    let routes = submitted_routes(&body).map_err(|_| problem::dispatch(422, "stop-unknown"))?;
    command(cx, id, date, &text, Cmd::SubmitPlan { routes }, Step::Plan).await
}

/// `POST .../dispatch/{date}/publish {plan: proposed | submitted}`.
pub async fn publish(cx: &Cx, req: &mut Request, id: Option<&str>, date: Option<&str>) -> Answer {
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: PublishRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    let cmd = Cmd::Publish {
        plan: plan_choice(&body),
    };
    command(cx, id, date, &text, cmd, Step::Publish).await
}

/// `POST .../dispatch/{date}/complete {stop}`: stop number `stop` of the published plan is
/// delivered.
pub async fn complete(cx: &Cx, req: &mut Request, id: Option<&str>, date: Option<&str>) -> Answer {
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: CompleteStopRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    let cmd = Cmd::CompleteStop { stop: body.stop };
    command(cx, id, date, &text, cmd, Step::Complete).await
}

/// One staff command to the day, keyed `<step>:<Idempotency-Key>`, answered with the day.
async fn command(
    cx: &Cx,
    id: Option<&str>,
    date: Option<&str>,
    text: &str,
    cmd: Cmd,
    step: Step,
) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let birth = day(cx, id, date).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let name = birth.name.clone();
    let cause = format!("{}:{key}", step.prefix());
    cx.caused(&cause);
    let mut res = call(
        &cx.env,
        dispatch::BINDING,
        &name,
        Method::Post,
        "/_command",
        Some(&CommandIn {
            key: cause,
            body_hash: body_hash(text),
            birth: Some(birth),
            cmd,
            cause: None,
        }),
    )
    .await?;
    let replayed = res.headers().get("Idempotent-Replayed")?.is_some();
    match res.status_code() {
        200 => {
            let answer: DayAnswer = res.json().await?;
            let mut out = json(&answer.dispatch, 200)?;
            if replayed {
                out.headers_mut().set("Idempotent-Replayed", "true")?;
            }
            Ok(out)
        }
        410 => Err(problem::wiped()),
        422 => {
            let refusal: Refusal = res.json().await?;
            if refusal.error == "key-reused" {
                return Err(problem::idempotency_reused());
            }
            let rule = refusal.rule.unwrap_or_default();
            Err(problem::dispatch(step.status(&rule), &rule))
        }
        _ => Err(problem::internal()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_is_409_where_the_days_state_blocks_it_and_422_where_the_request_does() {
        for rule in ["vans", "capacity", "no-stops", "place-unknown"] {
            assert_eq!(Step::Propose.status(rule), 422, "{rule}");
        }
        for rule in [
            "route-ends",
            "vans",
            "stop-unknown",
            "stop-twice",
            "over-capacity",
            "stop-missing",
        ] {
            assert_eq!(Step::Plan.status(rule), 422, "{rule}");
        }
        for rule in ["no-plan", "stop-missing", "published", "stop-unknown"] {
            assert_eq!(Step::Publish.status(rule), 409, "{rule}");
        }
        assert_eq!(Step::Complete.status("no-plan"), 409);
        assert_eq!(Step::Complete.status("not-ready"), 409);
        assert_eq!(Step::Plan.status("window"), 422);
        assert_eq!(Step::Complete.status("stop-unknown"), 422);
    }
}
