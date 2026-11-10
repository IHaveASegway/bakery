//! A bakery day's schedule: its slots, zones, item caps, catering and bake list, and the staff's
//! capacity editor (docs/domain.md, "Schedule reservation"; docs/roadmap.md, PR 6).
//!
//! The day is the path's `YYYY-MM-DD`. The Sandbox registers `schedule:<sandbox>:<date>` for a
//! date from the sandbox's birth day to 30 days after business today, and the day is born on
//! that first touch with the default capacities; any other date is 404 `no-such-day`. A read is
//! any session's, a guest's included (the checkout's slot picker and the console's read-only
//! editor ask for it); a capacity change is staff's, so a guest gets 403 `guest-scope` from the
//! router.

use bakery_app::names::sandbox_object_name;
use bakery_contracts::{CapacityRequest, ScheduleResponse};
use bakery_domain::BakeryDate;
use bakery_domain::schedule::Target;
use worker::{Method, Request, Response};

use super::problem::{self, Failure};
use super::sandboxes::{not_revoked, own_sandbox};
use super::{Cx, body_hash, json};
use crate::objects::child::Birth;
use crate::objects::sandbox::{self, DayBirth, RegisterDay};
use crate::objects::schedule::{self, Answer as DayAnswer, Cmd, CommandIn, Open, Refusal};
use crate::objects::sql::call;
use crate::random;

type Answer = Result<Response, Failure>;

/// The day's birth from the Sandbox, which registers it first.
async fn day(cx: &Cx, id: bakery_domain::Ulid, date: Option<&str>) -> Result<Birth, Failure> {
    let date: BakeryDate = date
        .and_then(|d| d.parse().ok())
        .ok_or_else(problem::no_such_day)?;
    let mut res = call(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Post,
        "/_register-day",
        Some(&RegisterDay {
            date,
            catering: false,
        }),
    )
    .await?;
    let day: DayBirth = match res.status_code() {
        200 => res.json().await?,
        404 => return Err(problem::no_such_day()),
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

/// `GET /v1/sandboxes/{id}/schedule/{date}` → `ScheduleResponse`.
pub async fn get(cx: &Cx, id: Option<&str>, date: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let birth = day(cx, id, date).await?;
    let name = birth.name.clone();
    let mut res = call(
        &cx.env,
        schedule::BINDING,
        &name,
        Method::Post,
        "/_open",
        Some(&Open { birth }),
    )
    .await?;
    match res.status_code() {
        200 => {
            let day: ScheduleResponse = res.json().await?;
            json(&day, 200)
        }
        410 => Err(problem::wiped()),
        _ => Err(problem::internal()),
    }
}

/// `PATCH /v1/sandboxes/{id}/schedule/{date}/capacity {target, capacity}`, signed-in sessions
/// only: `SetCapacity`. A lowered capacity keeps every place already taken; it only stops new
/// holds. The `Idempotency-Key` is optional, as on every PATCH: the same body again changes
/// nothing.
pub async fn set_capacity(
    cx: &Cx,
    req: &mut Request,
    id: Option<&str>,
    date: Option<&str>,
) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: CapacityRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    let target =
        Target::parse(&body.target).map_err(|e| problem::schedule(e.rule(), None, None, None))?;
    let birth = day(cx, id, date).await?;
    let key = match cx.key {
        Some(k) => k,
        None => random::ulid(cx.now)?,
    };
    let name = birth.name.clone();
    let cause = format!("capacity:{key}");
    cx.caused(&cause);
    let mut res = call(
        &cx.env,
        schedule::BINDING,
        &name,
        Method::Post,
        "/_command",
        Some(&CommandIn {
            key: cause,
            body_hash: body_hash(&text),
            birth: Some(birth),
            cmd: Cmd::SetCapacity {
                target,
                capacity: body.capacity,
            },
            cause: None,
        }),
    )
    .await?;
    let replayed = res.headers().get("Idempotent-Replayed")?.is_some();
    match res.status_code() {
        200 => {
            let answer: DayAnswer = res.json().await?;
            let mut out = json(&answer.schedule, 200)?;
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
            Err(problem::schedule(
                refusal.rule.as_deref().unwrap_or(""),
                None,
                None,
                None,
            ))
        }
        _ => Err(problem::internal()),
    }
}
