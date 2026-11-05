//! CRM, campaigns and the inbox (docs/roadmap.md, PR 8; docs/domain.md, "Campaign";
//! docs/architecture.md, "A campaign send"). Every read is answered from Crm's projection or the
//! Inbox's messages, and is open to any session of the sandbox, a guest's included; every staff
//! action is a signed-in session's, so a guest gets 403 `guest-scope` from the router. A path
//! naming a customer, a segment, a campaign or a message the sandbox does not hold is 404.
//!
//! - Customers: the list, one customer, its timeline, and its consent (`POST
//!   .../customers/{cid}/consent`), which a guest may change for the sandbox's own persona only
//!   (403 `guest-scope` for another's) and a signed-in session for any persona. The change is
//!   the persona's `Customer`, born on that first touch; the answer is Crm's row with the
//!   Customer's new consent, since Crm learns it through the Queue a moment later.
//! - Segments: the five, and one with its member count and a sample of five.
//! - Campaigns: the list and one (any session); create (201 with `Location`; the
//!   `Idempotency-Key` is the campaign's id), edit a draft by `PATCH` (409 `campaign` naming
//!   `out-of-order` otherwise; an `Idempotency-Key` is accepted and replays), schedule (422
//!   `campaign` naming `schedule-too-soon`, its detail the earliest allowed time as an ISO
//!   business time), cancel. The send is Crm's timer, never a route.
//! - The inbox, newest first with `kind`, `to` and `limit` filters and the `total`, and one
//!   message.
//! - The lead pipeline and the activity feed (`limit`), newest first.
//! - The rebuild: `POST` 202 (409 `rebuild` while one runs), `GET` its progress, `finished`
//!   until the next start.
//!
//! While a rebuild runs, Crm's reads answer the partial projection with the header
//! `Projection-State: rebuilding`.

use bakery_app::names::sandbox_object_name;
use bakery_contracts::{
    CampaignRequest, CampaignResponse, ConsentRequest, CustomerResponse, ScheduleRequest,
};
use bakery_domain::{BusinessTime, Ulid};
use worker::{Method, Request, Response};

use super::problem::{self, Failure};
use super::sandboxes::{not_revoked, own_sandbox, state};
use super::{Cx, body_hash, json};
use crate::objects::child::Birth;
use crate::objects::crm::{self, Cmd, CommandIn, RebuildIn, Refusal};
use crate::objects::customer::{self, CustomerOut};
use crate::objects::inbox;
use crate::objects::sandbox::{self, CustomerBirth, RegisterCustomer};
use crate::objects::sql::{call, call_empty};
use crate::random;

type Answer = Result<Response, Failure>;

/// Domain values from wire values through their shared serde names.
fn via_json<T: serde::Serialize, U: serde::de::DeserializeOwned>(value: T) -> Result<U, Failure> {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
        .ok_or_else(problem::internal)
}

/// An object's answer passed on as it is: its status, its body, and the replay and projection
/// headers. A 404 is `missing`; a 410 is the wiped sandbox.
async fn passed(mut res: Response, missing: &'static str) -> Answer {
    match res.status_code() {
        200 | 202 => {
            let status = res.status_code();
            let replayed = res.headers().get("Idempotent-Replayed")?.is_some();
            let rebuilding = res.headers().get("Projection-State")?;
            let mut out = Response::ok(res.text().await?)?.with_status(status);
            let headers = out.headers_mut();
            headers.set("Content-Type", "application/json")?;
            if replayed {
                headers.set("Idempotent-Replayed", "true")?;
            }
            if let Some(r) = rebuilding {
                headers.set("Projection-State", &r)?;
            }
            Ok(out)
        }
        404 => Err(problem::not_found().because(missing)),
        410 => Err(problem::wiped()),
        _ => Err(problem::internal()),
    }
}

/// One read of the sandbox's Crm.
async fn crm_get(cx: &Cx, id: Ulid, path: &str, missing: &'static str) -> Answer {
    let res = call_empty(&cx.env, crm::BINDING, &crm::name(id), Method::Get, path).await?;
    passed(res, missing).await
}

/// The path's sandbox, the session's own and not revoked.
async fn sandbox_of(cx: &Cx, id: Option<&str>) -> Result<Ulid, Failure> {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    Ok(id)
}

/// A path segment as a ULID; anything else is the 404 an unknown one gets.
fn ulid_of(sub: Option<&str>, missing: &'static str) -> Result<Ulid, Failure> {
    sub.and_then(|s| s.parse().ok())
        .ok_or_else(|| problem::not_found().because(missing))
}

/// The query string of the request, for the reads that take filters.
fn query_of(req: &Request) -> Result<String, Failure> {
    Ok(req
        .url()
        .map_err(|_| problem::internal())?
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default())
}

// ---------- customers ----------

/// `GET /v1/sandboxes/{id}/customers` → `CustomerListResponse`.
pub async fn customers(cx: &Cx, id: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    crm_get(cx, id, "/_customers", "no-crm").await
}

/// `GET /v1/sandboxes/{id}/customers/{cid}` → `CustomerResponse`.
pub async fn customer(cx: &Cx, id: Option<&str>, cid: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    let cid = ulid_of(cid, "no-customer")?;
    crm_get(cx, id, &format!("/_customer/{cid}"), "no-customer").await
}

/// `GET /v1/sandboxes/{id}/customers/{cid}/timeline` → `TimelineResponse`.
pub async fn timeline(cx: &Cx, id: Option<&str>, cid: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    let cid = ulid_of(cid, "no-customer")?;
    crm_get(cx, id, &format!("/_timeline/{cid}"), "no-customer").await
}

/// `POST /v1/sandboxes/{id}/customers/{cid}/consent` (`ConsentRequest`) → 200
/// `CustomerResponse`: the persona's own consent by a guest, anyone's by a signed-in session.
pub async fn consent(cx: &Cx, req: &mut Request, id: Option<&str>, cid: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let cid = ulid_of(cid, "no-customer")?;
    if claims.is_guest() {
        let sandbox = state(cx, id).await?.ok_or_else(problem::wiped)?;
        if sandbox.persona != cid.to_string() {
            return Err(problem::guest_scope().because("not-own-persona"));
        }
    }
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: ConsentRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    let mut res = call(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Post,
        "/_register-customer",
        Some(&RegisterCustomer { customer: cid }),
    )
    .await?;
    let birth: CustomerBirth = match res.status_code() {
        200 => res.json().await?,
        404 => return Err(problem::not_found().because("no-customer")),
        409 => return Err(problem::seeding()),
        410 => return Err(problem::wiped()),
        _ => return Err(problem::internal()),
    };
    let mut res = call(
        &cx.env,
        customer::BINDING,
        &birth.name.clone(),
        Method::Post,
        "/_command",
        Some(&customer::CommandIn {
            key: format!("consent:{key}"),
            body_hash: body_hash(&text),
            birth: Some(Birth {
                sandbox: id,
                name: birth.name,
                clock_offset_s: birth.clock_offset_s,
                clock_v: birth.clock_v,
            }),
            register: Some(birth.register),
            cmd: customer::Cmd::SetConsent {
                marketing: body.marketing,
            },
        }),
    )
    .await?;
    let replayed = res.headers().get("Idempotent-Replayed")?.is_some();
    let out: CustomerOut = match res.status_code() {
        200 => res.json().await?,
        410 => return Err(problem::wiped()),
        422 => {
            let r: Refusal = res.json().await.unwrap_or_default();
            if r.error == "key-reused" {
                return Err(problem::idempotency_reused());
            }
            return Err(problem::internal());
        }
        _ => return Err(problem::internal()),
    };
    let mut res = call_empty(
        &cx.env,
        crm::BINDING,
        &crm::name(id),
        Method::Get,
        &format!("/_customer/{cid}"),
    )
    .await?;
    let mut row: CustomerResponse = match res.status_code() {
        200 => res.json().await?,
        404 => return Err(problem::not_found().because("no-customer")),
        410 => return Err(problem::wiped()),
        _ => return Err(problem::internal()),
    };
    // Crm learns the change through the Queue; the Customer has it now.
    row.marketing = out.marketing;
    let mut answer = json(&row, 200)?;
    if replayed {
        answer.headers_mut().set("Idempotent-Replayed", "true")?;
    }
    Ok(answer)
}

// ---------- segments ----------

/// `GET /v1/sandboxes/{id}/segments` → `SegmentListResponse`.
pub async fn segments(cx: &Cx, id: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    crm_get(cx, id, "/_segments", "no-crm").await
}

/// `GET /v1/sandboxes/{id}/segments/{segment}` → `SegmentResponse`; 404 for no such segment.
pub async fn segment(cx: &Cx, id: Option<&str>, slug: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    let slug = slug
        .and_then(bakery_domain::crm::Segment::parse)
        .ok_or_else(|| problem::not_found().because("no-segment"))?;
    crm_get(cx, id, &format!("/_segment/{}", slug.slug()), "no-segment").await
}

// ---------- campaigns ----------

/// `GET /v1/sandboxes/{id}/campaigns` → `CampaignListResponse`.
pub async fn campaigns(cx: &Cx, id: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    crm_get(cx, id, "/_campaigns", "no-crm").await
}

/// `GET /v1/sandboxes/{id}/campaigns/{cid}` → `CampaignResponse`.
pub async fn campaign(cx: &Cx, id: Option<&str>, cid: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    let cid = ulid_of(cid, "no-campaign")?;
    crm_get(cx, id, &format!("/_campaign/{cid}"), "no-campaign").await
}

/// A campaign refusal from Crm, as the visitor's problem.
fn refused(status: u16, r: &Refusal) -> Failure {
    match r.error.as_str() {
        "key-reused" => problem::idempotency_reused(),
        "unknown-campaign" => problem::not_found().because("no-campaign"),
        "campaign" => problem::campaign(
            status,
            r.rule.as_deref().unwrap_or(""),
            r.earliest.as_deref(),
        ),
        _ => problem::internal(),
    }
}

/// One campaign command, Crm's answer passed on with `status` for a fresh one.
async fn command(cx: &Cx, id: Ulid, body: CommandIn, status: u16, location: bool) -> Answer {
    let campaign = match body.cmd {
        Cmd::Draft { campaign, .. }
        | Cmd::Edit { campaign, .. }
        | Cmd::Schedule { campaign, .. }
        | Cmd::Cancel { campaign } => campaign,
    };
    let mut res = call(
        &cx.env,
        crm::BINDING,
        &crm::name(id),
        Method::Post,
        "/_command",
        Some(&body),
    )
    .await?;
    match res.status_code() {
        200 => {
            let replayed = res.headers().get("Idempotent-Replayed")?.is_some();
            let answer: CampaignResponse = res.json().await?;
            let mut out = json(&answer, if replayed { 200 } else { status })?;
            if replayed {
                out.headers_mut().set("Idempotent-Replayed", "true")?;
            }
            if location {
                out.headers_mut().set(
                    "Location",
                    &format!("/v1/sandboxes/{id}/campaigns/{campaign}"),
                )?;
            }
            Ok(out)
        }
        410 => Err(problem::wiped()),
        status @ (404 | 409 | 422) => {
            let r: Refusal = res.json().await.unwrap_or_default();
            if status != 404 {
                cx.reason("campaign-refused");
            }
            Err(refused(status, &r))
        }
        _ => Err(problem::internal()),
    }
}

fn campaign_body(text: &str) -> Result<CampaignRequest, Failure> {
    serde_json::from_str(text).map_err(|_| problem::body())
}

/// `POST /v1/sandboxes/{id}/campaigns` (`CampaignRequest`), signed in: a draft, 201 with
/// `Location`. The `Idempotency-Key` is the campaign's id, so the same key is the same campaign.
pub async fn create_campaign(cx: &Cx, req: &mut Request, id: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let text = req.text().await.map_err(|_| problem::body())?;
    let body = campaign_body(&text)?;
    let cmd = Cmd::Draft {
        campaign: key,
        subject: via_json(body.subject)?,
        body: via_json(body.body)?,
        segment: via_json(body.segment)?,
    };
    let body = CommandIn {
        key: format!("draft:{key}"),
        body_hash: body_hash(&text),
        cmd,
    };
    command(cx, id, body, 201, true).await
}

/// `PATCH /v1/sandboxes/{id}/campaigns/{cid}` (`CampaignRequest`), signed in: a draft edited.
pub async fn edit_campaign(
    cx: &Cx,
    req: &mut Request,
    id: Option<&str>,
    cid: Option<&str>,
) -> Answer {
    let id = sandbox_of(cx, id).await?;
    let cid = ulid_of(cid, "no-campaign")?;
    let text = req.text().await.map_err(|_| problem::body())?;
    let body = campaign_body(&text)?;
    let key = match cx.key {
        Some(k) => k,
        None => random::ulid(cx.now)?,
    };
    let cmd = Cmd::Edit {
        campaign: cid,
        subject: via_json(body.subject)?,
        body: via_json(body.body)?,
        segment: via_json(body.segment)?,
    };
    let body = CommandIn {
        key: format!("edit:{cid}:{key}"),
        body_hash: body_hash(&text),
        cmd,
    };
    command(cx, id, body, 200, false).await
}

/// `POST .../campaigns/{cid}/schedule` (`ScheduleRequest`), signed in.
pub async fn schedule_campaign(
    cx: &Cx,
    req: &mut Request,
    id: Option<&str>,
    cid: Option<&str>,
) -> Answer {
    let id = sandbox_of(cx, id).await?;
    let cid = ulid_of(cid, "no-campaign")?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: ScheduleRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    let send_at: BusinessTime = body.send_at.parse().map_err(|_| problem::body())?;
    let body = CommandIn {
        key: format!("schedule:{cid}:{key}"),
        body_hash: body_hash(&text),
        cmd: Cmd::Schedule {
            campaign: cid,
            send_at,
        },
    };
    command(cx, id, body, 200, false).await
}

/// `POST .../campaigns/{cid}/cancel`, signed in, no body.
pub async fn cancel_campaign(cx: &Cx, id: Option<&str>, cid: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    let cid = ulid_of(cid, "no-campaign")?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let body = CommandIn {
        key: format!("cancel:{cid}:{key}"),
        body_hash: String::new(),
        cmd: Cmd::Cancel { campaign: cid },
    };
    command(cx, id, body, 200, false).await
}

// ---------- the inbox ----------

/// `GET /v1/sandboxes/{id}/inbox?kind=&to=&limit=` → `InboxResponse`, newest first.
pub async fn inbox(cx: &Cx, req: &Request, id: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    let query = query_of(req)?;
    if inbox::filters_of(query.strip_prefix('?')).is_none() {
        return Err(problem::inbox_filter());
    }
    let res = call_empty(
        &cx.env,
        inbox::BINDING,
        &inbox::name(id),
        Method::Get,
        &format!("/_messages{query}"),
    )
    .await?;
    passed(res, "no-inbox").await
}

/// `GET /v1/sandboxes/{id}/inbox/{mid}` → `MessageResponse`.
pub async fn message(cx: &Cx, id: Option<&str>, mid: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    let mid = ulid_of(mid, "no-message")?;
    let res = call_empty(
        &cx.env,
        inbox::BINDING,
        &inbox::name(id),
        Method::Get,
        &format!("/_message/{mid}"),
    )
    .await?;
    passed(res, "no-message").await
}

// ---------- leads, activity, the rebuild ----------

/// `GET /v1/sandboxes/{id}/leads` → `LeadPipelineResponse`.
pub async fn leads(cx: &Cx, id: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    crm_get(cx, id, "/_leads", "no-crm").await
}

/// `GET /v1/sandboxes/{id}/activity?limit=` → `ActivityResponse`, newest first.
pub async fn activity(cx: &Cx, req: &Request, id: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    let query = query_of(req)?;
    crm_get(cx, id, &format!("/_activity{query}"), "no-crm").await
}

/// `GET /v1/sandboxes/{id}/rebuild` → `RebuildResponse`.
pub async fn rebuild_progress(cx: &Cx, id: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    crm_get(cx, id, "/_rebuild", "no-crm").await
}

/// `POST /v1/sandboxes/{id}/rebuild`, signed in: 202 `RebuildResponse`; 409 `rebuild` while one
/// runs.
pub async fn start_rebuild(cx: &Cx, id: Option<&str>) -> Answer {
    let id = sandbox_of(cx, id).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let res = call(
        &cx.env,
        crm::BINDING,
        &crm::name(id),
        Method::Post,
        "/_rebuild",
        Some(&RebuildIn {
            key: format!("rebuild:{key}"),
        }),
    )
    .await?;
    if res.status_code() == 409 {
        cx.reason("rebuild-running");
        return Err(problem::rebuild_running());
    }
    passed(res, "no-crm").await
}
