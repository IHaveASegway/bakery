//! Catering: the inquiry, the visitor's events, the customer's and the staff's steps, the
//! deposit and the balance (docs/architecture.md, "The catering saga"; docs/domain.md,
//! "CateringEvent"; docs/roadmap.md, PR 7).
//!
//! Creating is two calls, as placing an order is: the Sandbox maps the `Idempotency-Key` to
//! one catering ULID and registers `catering:<sandbox>:<ulid>` before anything is written there;
//! then the CateringEvent decides the inquiry. The same key again finds the same ULID, and the
//! event's `commands_seen` answers the first result with `Idempotent-Replayed: true`.
//!
//! - Any session, a guest's included: the inquiry, the list (newest first), one event, and
//!   the customer's `accept`, `deposit`, `pay-balance` and `cancel` (`by: customer`).
//! - Signed in (a guest gets 403 `guest-scope` from the router): `quote`, `decline`,
//!   `start-production`, `delivered` and `staff-cancel` (`by: staff`).
//!
//! `accept` holds one of the event day's two catering places in its `Schedule` first, through
//! the event; a day with both taken is 409 `slot-full` and nothing is recorded. `deposit` asks
//! Billing for the deposit's payment and intent (the catering id as the key, so a remount gets
//! the same client secret); only Stripe's webhook confirms the event. `pay-balance` pays the
//! invoice on Stripe's test path (`pay_invoice_test`, decision 3 of PR 7; how a visitor pays at
//! real Stripe is spike S3's question) and answers 202: the webhook's `invoice.paid` moves the
//! event to `paid` and `closed`, and the page polls. A refused inquiry is 422 `catering` naming
//! the rule and a refused step 409 `catering` naming it; neither ever echoes the brief.

use bakery_app::names::sandbox_object_name;
use bakery_contracts::{
    CateringCancelRequest, CateringInquiryRequest, CateringListResponse, CateringResponse,
    CateringState, DeclineRequest, PaymentResponse, QuoteRequest,
};
use bakery_domain::billing::Purpose;
use bakery_domain::catering::{CancelReason, DeclineReason};
use bakery_domain::order::CancelledBy;
use bakery_domain::{BakeryDate, BusinessTime, Cents, Ulid};
use worker::{Method, Request, Response};

use super::payments::{billing_failure, guard, wire_status};
use super::problem::{self, Failure};
use super::sandboxes::{not_revoked, own_sandbox};
use super::{Cx, body_hash, json};
use crate::objects::billing::{self, CancelIn, IntentIn, IntentOut};
use crate::objects::catering::{self, Cmd, CommandIn, Refusal};
use crate::objects::child::Birth;
use crate::objects::sandbox::{self, CateringSlot, DayBirth, RegisterCatering, RegisterDay};
use crate::objects::sql::{call, call_empty};
use crate::stripe;

type Answer = Result<Response, Failure>;

/// A refusal from the CateringEvent, as the visitor's problem.
fn refused(status: u16, r: &Refusal) -> Failure {
    match r.error.as_str() {
        "key-reused" => problem::idempotency_reused(),
        "schedule" if r.rule.as_deref() == Some("slot-full") => problem::catering_full(),
        "schedule" => problem::schedule(r.rule.as_deref().unwrap_or(""), None, None, None),
        "catering" => problem::catering(
            status,
            r.rule.as_deref().unwrap_or(""),
            r.message.as_deref(),
        ),
        _ => problem::internal(),
    }
}

/// The CateringEvent's answer, passed on: its status, its body, and the replay header.
async fn answered(mut res: Response, created: u16, location: Option<String>) -> Answer {
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
        // Registered and never born (a refused inquiry), or gone: the same 404 as none.
        404 | 410 => Err(problem::not_found().because("no-catering")),
        status @ (409 | 422) => {
            let r: Refusal = res.json().await.unwrap_or_default();
            Err(refused(status, &r))
        }
        _ => Err(problem::internal()),
    }
}

/// The event's object name and id, once the Sandbox's registry holds it; any other id is the
/// 404 an unknown one gets, another sandbox's included.
async fn registered(cx: &Cx, id: Ulid, cid: Option<&str>) -> Result<(String, Ulid), Failure> {
    let cid: Ulid = cid
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| problem::not_found().because("no-catering"))?;
    let name = catering::name(id, cid);
    let res = call_empty(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Get,
        &format!("/_child/{name}"),
    )
    .await?;
    match res.status_code() {
        200 => Ok((name, cid)),
        410 => Err(problem::wiped()),
        _ => Err(problem::not_found().because("no-catering")),
    }
}

/// The event as its object holds it.
async fn state_of(cx: &Cx, name: &str) -> Result<CateringResponse, Failure> {
    let mut res = call_empty(&cx.env, catering::BINDING, name, Method::Get, "/_state").await?;
    match res.status_code() {
        200 => Ok(res.json().await?),
        404 | 410 => Err(problem::not_found().because("no-catering")),
        _ => Err(problem::internal()),
    }
}

/// One command on a registered event.
async fn send(cx: &Cx, name: &str, body: &CommandIn) -> Answer {
    let res = call(
        &cx.env,
        catering::BINDING,
        name,
        Method::Post,
        "/_command",
        Some(body),
    )
    .await?;
    answered(res, 200, None).await
}

/// The quote's body: `{}`, `{total_cents}`, or none at all, which is the package's price.
fn quote_body(text: &str) -> Result<QuoteRequest, Failure> {
    if text.trim().is_empty() {
        return Ok(QuoteRequest { total_cents: None });
    }
    serde_json::from_str(text).map_err(|_| problem::body())
}

/// `POST /v1/sandboxes/{id}/catering`: any session. 201 with `Location`; 422 naming the rule.
pub async fn create(cx: &Cx, req: &mut Request, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: CateringInquiryRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    let date: BakeryDate = body
        .date
        .parse()
        .map_err(|_| problem::catering(422, "date", None))?;
    let mut res = call(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Post,
        "/_register-catering",
        Some(&RegisterCatering {
            key: key.to_string(),
        }),
    )
    .await?;
    let slot: CateringSlot = match res.status_code() {
        200 => res.json().await?,
        409 => return Err(problem::seeding()),
        410 => return Err(problem::wiped()),
        _ => return Err(problem::internal()),
    };
    let name = catering::name(id, slot.catering);
    let res = call(
        &cx.env,
        catering::BINDING,
        &name,
        Method::Post,
        "/_command",
        Some(&CommandIn {
            key: key.to_string(),
            body_hash: body_hash(&text),
            birth: Some(Birth {
                sandbox: id,
                name: name.clone(),
                clock_offset_s: slot.clock_offset_s,
                clock_v: slot.clock_v,
            }),
            cmd: Cmd::Submit {
                catering: slot.catering,
                customer: slot.persona,
                date,
                headcount: body.headcount,
                package: body.package,
                venue: body.venue,
                brief: body.brief,
            },
            day: None,
            cause: None,
        }),
    )
    .await?;
    if res.status_code() == 422 {
        cx.reason("catering-refused");
    }
    let location = format!("/v1/sandboxes/{id}/catering/{}", slot.catering);
    answered(res, 201, Some(location)).await
}

/// `GET /v1/sandboxes/{id}/catering` → `CateringListResponse`, newest first: every registered
/// event that holds one (an inquiry refused at its first write holds none).
pub async fn list(cx: &Cx, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let mut res = call_empty(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Get,
        &format!("/_children/{}", catering::CLASS),
    )
    .await?;
    let names: Vec<String> = match res.status_code() {
        200 => res.json().await?,
        410 => return Err(problem::wiped()),
        _ => return Err(problem::internal()),
    };
    let mut events = Vec::with_capacity(names.len());
    for name in &names {
        let mut res = call_empty(&cx.env, catering::BINDING, name, Method::Get, "/_state").await?;
        if res.status_code() == 200 {
            events.push(res.json::<CateringResponse>().await?);
        }
    }
    sort_newest_first(&mut events);
    json(&CateringListResponse { events }, 200)
}

/// Newest inquiry first, by its business time as an instant (the offsets differ across a DST
/// change, so the text alone would not order them), then by id.
fn sort_newest_first(events: &mut [CateringResponse]) {
    let at = |e: &CateringResponse| {
        e.created_at
            .parse::<BusinessTime>()
            .map_or(0, |t| t.unix_ms())
    };
    events.sort_by(|a, b| at(b).cmp(&at(a)).then_with(|| b.catering.cmp(&a.catering)));
}

/// `GET /v1/sandboxes/{id}/catering/{cid}` → `CateringResponse`.
pub async fn get(cx: &Cx, id: Option<&str>, cid: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let (name, _) = registered(cx, id, cid).await?;
    json(&state_of(cx, &name).await?, 200)
}

/// `POST .../catering/{cid}/accept`, any session: `AcceptQuote`, the day held first.
pub async fn accept(cx: &Cx, id: Option<&str>, cid: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let (name, _) = registered(cx, id, cid).await?;
    let event = state_of(cx, &name).await?;
    // Only a quoted event takes a hold; any other state is the event's to refuse (or, accepted
    // already, to answer as it stands), and registers no day.
    let day = if event.state == CateringState::Quoted {
        let date: BakeryDate = event.date.parse().map_err(|_| problem::internal())?;
        let mut res = call(
            &cx.env,
            sandbox::BINDING,
            &sandbox_object_name(id),
            Method::Post,
            "/_register-day",
            Some(&RegisterDay {
                date,
                catering: true,
            }),
        )
        .await?;
        let day: DayBirth = match res.status_code() {
            200 => res.json().await?,
            404 => return Err(problem::catering(409, "out-of-order", None)),
            409 => return Err(problem::seeding()),
            410 => return Err(problem::wiped()),
            _ => return Err(problem::internal()),
        };
        Some(Birth {
            sandbox: id,
            name: day.name,
            clock_offset_s: day.clock_offset_s,
            clock_v: day.clock_v,
        })
    } else {
        None
    };
    let out = send(
        cx,
        &name,
        &CommandIn {
            key: key.to_string(),
            body_hash: String::new(),
            birth: None,
            cmd: Cmd::Accept,
            day,
            cause: None,
        },
    )
    .await;
    if let Err(f) = &out
        && f.reason == "slot-full"
    {
        cx.reason("slot-full");
    }
    out
}

/// `POST .../catering/{cid}/deposit`, any session, no body, the catering id as the key: the
/// deposit's payment and intent from Billing, exactly as an order's `/payment` answers. 409
/// `catering` unless the event is accepted.
pub async fn deposit(cx: &Cx, id: Option<&str>, cid: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    guard(cx)?;
    let (name, reference) = registered(cx, id, cid).await?;
    let event = state_of(cx, &name).await?;
    let (CateringState::Accepted, Some(amount)) = (event.state, event.deposit_cents) else {
        return Err(problem::catering(409, "out-of-order", None));
    };
    let mut res = call(
        &cx.env,
        billing::BINDING,
        &billing::name(id),
        Method::Post,
        "/_intent",
        Some(&IntentIn {
            purpose: Purpose::Deposit,
            reference,
            amount: Cents(amount),
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

/// `POST .../catering/{cid}/pay-balance`, any session, no body, the catering id as the key:
/// the balance invoice paid with Stripe's test card. 202 with the event as it stands; the
/// webhook does the rest. 409 `catering` unless the event is invoiced.
pub async fn pay_balance(cx: &Cx, id: Option<&str>, cid: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    guard(cx)?;
    let (name, reference) = registered(cx, id, cid).await?;
    let event = state_of(cx, &name).await?;
    if event.state != CateringState::Invoiced {
        return Err(problem::catering(409, "out-of-order", None));
    }
    let res = call(
        &cx.env,
        billing::BINDING,
        &billing::name(id),
        Method::Post,
        "/_pay-invoice",
        Some(&CancelIn { reference }),
    )
    .await?;
    match res.status_code() {
        200 => {}
        // Billing holds no open invoice for it: paid already, or not yet recorded.
        409 => return Err(problem::catering(409, "out-of-order", None)),
        _ => return Err(billing_failure(res).await),
    }
    json(&state_of(cx, &name).await?, 202)
}

/// `POST .../catering/{cid}/cancel {reason}`, any session: `Cancel { by: customer }`.
pub async fn cancel(cx: &Cx, req: &mut Request, id: Option<&str>, cid: Option<&str>) -> Answer {
    cancel_by(cx, req, id, cid, CancelledBy::Customer).await
}

/// `POST .../catering/{cid}/staff-cancel {reason}`, signed in: `Cancel { by: staff }`.
pub async fn staff_cancel(
    cx: &Cx,
    req: &mut Request,
    id: Option<&str>,
    cid: Option<&str>,
) -> Answer {
    cancel_by(cx, req, id, cid, CancelledBy::Staff).await
}

async fn cancel_by(
    cx: &Cx,
    req: &mut Request,
    id: Option<&str>,
    cid: Option<&str>,
    by: CancelledBy,
) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: CateringCancelRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    let reason = match body.reason {
        bakery_contracts::CateringCancelReason::CustomerChange => CancelReason::CustomerChange,
        bakery_contracts::CateringCancelReason::VenueLost => CancelReason::VenueLost,
        bakery_contracts::CateringCancelReason::Other => CancelReason::Other,
    };
    let (name, _) = registered(cx, id, cid).await?;
    send(
        cx,
        &name,
        &CommandIn {
            key: key.to_string(),
            body_hash: body_hash(&text),
            birth: None,
            cmd: Cmd::Cancel { by, reason },
            day: None,
            cause: None,
        },
    )
    .await
}

/// `POST .../catering/{cid}/quote {total_cents?}`, signed in: `SendQuote`, priced per head
/// times the headcount when no total is given.
pub async fn quote(cx: &Cx, req: &mut Request, id: Option<&str>, cid: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let text = req.text().await.map_err(|_| problem::body())?;
    let body = quote_body(&text)?;
    let (name, _) = registered(cx, id, cid).await?;
    send(
        cx,
        &name,
        &CommandIn {
            key: key.to_string(),
            body_hash: body_hash(&text),
            birth: None,
            cmd: Cmd::Quote {
                total: body.total_cents.map(Cents),
            },
            day: None,
            cause: None,
        },
    )
    .await
}

/// `POST .../catering/{cid}/decline {reason}`, signed in: `Decline`.
pub async fn decline(cx: &Cx, req: &mut Request, id: Option<&str>, cid: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: DeclineRequest = serde_json::from_str(&text).map_err(|_| problem::body())?;
    let reason = match body.reason {
        bakery_contracts::DeclineReason::TooSoon => DeclineReason::TooSoon,
        bakery_contracts::DeclineReason::OverCapacity => DeclineReason::OverCapacity,
        bakery_contracts::DeclineReason::Other => DeclineReason::Other,
    };
    let (name, _) = registered(cx, id, cid).await?;
    send(
        cx,
        &name,
        &CommandIn {
            key: key.to_string(),
            body_hash: body_hash(&text),
            birth: None,
            cmd: Cmd::Decline { reason },
            day: None,
            cause: None,
        },
    )
    .await
}

/// `POST .../catering/{cid}/start-production` and `.../delivered`, signed in, no body.
pub async fn staff_step(cx: &Cx, id: Option<&str>, cid: Option<&str>, cmd: Cmd) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let (name, _) = registered(cx, id, cid).await?;
    send(
        cx,
        &name,
        &CommandIn {
            key: key.to_string(),
            body_hash: String::new(),
            birth: None,
            cmd,
            day: None,
            cause: None,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, created_at: &str) -> CateringResponse {
        CateringResponse {
            catering: id.into(),
            state: CateringState::Inquiry,
            date: "2026-11-21".into(),
            headcount: 40,
            package: "breakfast-spread".into(),
            venue: "v1".into(),
            brief: None,
            total_cents: None,
            deposit_cents: None,
            balance_cents: None,
            valid_until: None,
            deposit_payment: None,
            invoice: None,
            invoice_due: None,
            reminders: Vec::new(),
            refund_deposit: None,
            created_at: created_at.into(),
            updated_at: created_at.into(),
        }
    }

    #[test]
    fn the_list_is_newest_first_by_instant() {
        // 01:30 MDT is the same instant as 00:30 MST an hour later: the instant decides.
        let mut events = vec![
            event("A", "2026-11-01T01:30:00-06:00"),
            event("B", "2026-11-01T01:15:00-07:00"),
            event("C", "2026-10-30T09:00:00-06:00"),
        ];
        sort_newest_first(&mut events);
        let ids: Vec<&str> = events.iter().map(|e| e.catering.as_str()).collect();
        assert_eq!(ids, ["B", "A", "C"]);
    }

    #[test]
    fn refusals_map_to_their_problems() {
        let r = |error: &str, rule: Option<&str>| Refusal {
            error: error.into(),
            rule: rule.map(str::to_owned),
            message: None,
            next_free: None,
        };
        let full = refused(409, &r("schedule", Some("slot-full")));
        assert_eq!(full.problem.status, 409);
        assert!(full.problem.problem_type.ends_with("/slot-full"));
        let step = refused(409, &r("catering", Some("out-of-order")));
        assert!(step.problem.problem_type.ends_with("/catering"));
        assert!(step.problem.detail.unwrap().contains("out-of-order"));
        let brief = refused(422, &r("catering", Some("brief-phone")));
        assert_eq!(brief.problem.status, 422);
        assert_eq!(
            refused(422, &r("key-reused", None)).problem.status,
            problem::idempotency_reused().problem.status
        );
    }

    #[test]
    fn an_empty_body_is_a_quote_at_the_package_price() {
        assert_eq!(quote_body("").unwrap().total_cents, None);
        assert_eq!(quote_body("{}").unwrap().total_cents, None);
        assert_eq!(
            quote_body(r#"{"total_cents":120000}"#).unwrap().total_cents,
            Some(120_000)
        );
        assert!(quote_body("{nope").is_err());
        assert!(quote_body(r#"{"total_cents":1,"by":"staff"}"#).is_err());
    }
}
