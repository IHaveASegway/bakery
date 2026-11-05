//! Sandboxes: create, read, "Wipe now", the fault switches, the dead letters and the clock
//! (docs/architecture.md, "Creating a sandbox" and "Time travel"; docs/security.md, "Sandbox
//! isolation").
//!
//! A path's sandbox id must be the session's: any other id gets the 404 an unknown one gets,
//! so a visitor cannot tell another's sandbox exists. Every object name is built here from
//! the session's ids, never from the path.

use bakery_app::admission::Refusal;
use bakery_app::auth::SessionClaims;
use bakery_app::names::{account_object_name, account_owner, guest_owner, sandbox_object_name};
use bakery_contracts::{
    ClockRequest, CreateSandboxRequest, FaultRequest, SandboxKind, SandboxResponse, SandboxState,
    WipedResponse,
};
use bakery_domain::clock::ClockStep;
use bakery_domain::{Ulid, WallTime};
use worker::{Method, Request, Response};

use super::auth::{clear_session, set_session, without_sandbox};
use super::demo::read_body;
use super::problem::{self, Failure};
use super::{Cx, json, outbound};
use crate::objects::account::{self, ClearSandbox, Current, SetSandbox};
use crate::objects::control::{self, AdmitRequest};
use crate::objects::sandbox::{
    self, ClockCommand, CreateRequest, FaultCommand, Redrive, WipeAnswer, WipeRequest,
};
use crate::objects::sql::{call, call_empty};
use crate::random;

type Answer = Result<Response, Failure>;

/// The path's id, if it is the session's sandbox; otherwise the same 404 as for nothing.
pub(super) fn own_sandbox(cx: &Cx, id: Option<&str>) -> Result<(SessionClaims, Ulid), Failure> {
    let claims = cx.claims().ok_or_else(problem::session)?.clone();
    let id: Ulid = id
        .and_then(|i| i.parse().ok())
        .ok_or_else(|| problem::not_found().because("not-yours"))?;
    if claims.sbx != Some(id) {
        return Err(problem::not_found().because("not-yours"));
    }
    Ok((claims, id))
}

/// An account's session id is refused once signed out, even from a copied cookie. A guest's
/// session has nothing to revoke: it ends when its sandbox does.
pub(super) async fn not_revoked(cx: &Cx, claims: &SessionClaims) -> Result<(), Failure> {
    let Some(acct) = &claims.acct else {
        return Ok(());
    };
    let mut res = call_empty(
        &cx.env,
        account::BINDING,
        &account_object_name(acct),
        Method::Get,
        &format!("/_revoked/{}", claims.sid),
    )
    .await?;
    match res.status_code() {
        200 if !res.json::<account::Revoked>().await?.revoked => Ok(()),
        200 => Err(problem::session().because("revoked")),
        _ => Err(problem::session().because("account-gone")),
    }
}

/// The sandbox's state, or `None` once it is wiped (or never was).
pub(super) async fn state(cx: &Cx, id: Ulid) -> Result<Option<SandboxResponse>, Failure> {
    let mut res = call_empty(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Get,
        "/_state",
    )
    .await?;
    match res.status_code() {
        200 => Ok(Some(res.json().await?)),
        410 => Ok(None),
        _ => Err(problem::internal()),
    }
}

async fn wipe_one(cx: &Cx, id: Ulid, cause: &str) -> Result<WipeAnswer, Failure> {
    let mut res = call(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Post,
        "/_wipe",
        Some(&WipeRequest {
            cause: cause.into(),
        }),
    )
    .await?;
    if res.status_code() != 200 {
        return Err(problem::internal().because("wipe-failed"));
    }
    Ok(res.json().await?)
}

async fn clear_current(cx: &Cx, acct: &str, id: Ulid) -> Result<(), Failure> {
    call(
        &cx.env,
        account::BINDING,
        &account_object_name(acct),
        Method::Post,
        "/_clear-sandbox",
        Some(&ClearSandbox { sandbox_id: id }),
    )
    .await?;
    Ok(())
}

/// `POST /v1/sandboxes`. In order: Turnstile for a guest; an account's live sandbox back
/// unless `replace`; the account's own cap; `Control`'s admission with the request's key;
/// the old sandbox wiped if replaced; the new one created; the account told; the cookie
/// re-issued with the sandbox. The rate limit ran before this, in the router.
pub async fn create(cx: &Cx, req: &mut Request) -> Answer {
    let text = req.text().await.map_err(|_| problem::body())?;
    let body: CreateSandboxRequest = if text.trim().is_empty() {
        CreateSandboxRequest::default()
    } else {
        serde_json::from_str(&text).map_err(|_| problem::body())?
    };
    let keyring = cx.keyring()?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let claims = cx.claims().cloned();
    let acct = claims.as_ref().and_then(|c| c.acct.clone());
    let kind = if acct.is_some() {
        SandboxKind::Account
    } else {
        SandboxKind::Guest
    };
    let caps = cx.cfg.caps;
    let day = cx.now.utc_day();

    if kind == SandboxKind::Guest {
        outbound::siteverify(&cx.cfg, body.turnstile_token.as_deref()).await?;
    }
    let current = match (&acct, &claims) {
        (Some(acct), Some(c)) => {
            not_revoked(cx, c).await?;
            let mut res = call_empty(
                &cx.env,
                account::BINDING,
                &account_object_name(acct),
                Method::Get,
                &format!("/_current?day={day}"),
            )
            .await?;
            if res.status_code() != 200 {
                return Err(problem::session().because("account-gone"));
            }
            res.json::<Current>().await?
        }
        _ => Current {
            current_sandbox: claims.as_ref().and_then(|c| c.sbx),
            ..Current::default()
        },
    };

    if let Some(old) = current.current_sandbox.filter(|_| !body.replace)
        && let Some(s) = state(cx, old)
            .await?
            .filter(|s| matches!(s.state, SandboxState::Live | SandboxState::Seeding))
    {
        cx.sandbox(Some(old));
        let mut res = json(&s, 200)?;
        if let Some(c) = claims.as_ref().filter(|c| c.sbx != Some(old)) {
            set_session(&mut res, &c.with_sandbox(old, cx.now), &keyring)?;
        }
        return Ok(res);
    }
    let refuse_account_cap = || {
        problem::refusal(
            Refusal::AccountSandboxCap,
            Refusal::AccountSandboxCap.retry_after(cx.now),
            caps.account_sandboxes,
        )
    };
    if kind == SandboxKind::Account
        && bakery_app::admission::admit_account_sandbox(current.created_today, caps).is_err()
    {
        return Err(refuse_account_cap());
    }

    let minted = random::ulid(cx.now)?;
    let answer = control::admit(
        &cx.env,
        &AdmitRequest {
            key: key.to_string(),
            kind,
            sandbox_id: minted,
        },
    )
    .await?;
    if !answer.admitted {
        let r = answer
            .reason
            .as_deref()
            .and_then(Refusal::parse)
            .unwrap_or(Refusal::Off);
        return Err(problem::refusal(
            r,
            r.retry_after(cx.now),
            caps.account_sandboxes,
        ));
    }
    let id = answer.sandbox_id.unwrap_or(minted);
    cx.sandbox(Some(id));

    let (status, sandbox) = if answer.replayed {
        // The first request with this key created the sandbox; its answer again.
        let s = state(cx, id).await?.ok_or_else(problem::wiped)?;
        (201, s)
    } else {
        if body.replace
            && let Some(old) = current.current_sandbox
        {
            wipe_one(cx, old, "replace").await?;
        }
        // A guest keeps its guest id across sandboxes; a first visit gets one.
        let known_guest = claims.as_ref().and_then(|c| c.guest);
        let fresh_guest = match (&acct, known_guest) {
            (None, None) => Some(random::ulid(cx.now)?),
            _ => None,
        };
        let owner = match (&acct, known_guest.or(fresh_guest)) {
            (Some(acct), _) => account_owner(acct),
            (None, Some(guest)) => guest_owner(guest),
            (None, None) => return Err(problem::internal()),
        };
        let mut res = call(
            &cx.env,
            sandbox::BINDING,
            &sandbox_object_name(id),
            Method::Post,
            "/_create",
            Some(&CreateRequest {
                id,
                owner,
                kind,
                seed: match crate::config::fixed_seed(&cx.env) {
                    Some(seed) => seed,
                    None => random::seed()?,
                },
                born: cx.now,
            }),
        )
        .await?;
        if !matches!(res.status_code(), 200 | 201) {
            return Err(problem::internal().because("create-failed"));
        }
        let s: SandboxResponse = res.json().await?;
        if let Some(acct) = &acct {
            let wipe_at: WallTime = s.wipe_at.parse().map_err(|_| problem::internal())?;
            let set = call(
                &cx.env,
                account::BINDING,
                &account_object_name(acct),
                Method::Post,
                "/_set-sandbox",
                Some(&SetSandbox {
                    sandbox_id: id,
                    wipe_at,
                    day: day.clone(),
                }),
            )
            .await?;
            if set.status_code() == 429 {
                // Another request of this account's took the last place first.
                wipe_one(cx, id, "account-cap").await?;
                return Err(refuse_account_cap());
            }
        }
        let new_claims = match (claims.as_ref(), fresh_guest) {
            (_, Some(g)) => SessionClaims::guest(g, id, &random::bytes::<16>()?, cx.now),
            (Some(c), None) => c.with_sandbox(id, cx.now),
            (None, None) => return Err(problem::internal()),
        };
        let mut res = json(&s, 201)?;
        set_session(&mut res, &new_claims, &keyring)?;
        return Ok(res);
    };

    // A replay: the cookie names the sandbox, whichever session sent the retry.
    let new_claims = match claims.as_ref() {
        Some(c) => c.with_sandbox(id, cx.now),
        None => SessionClaims::guest(random::ulid(cx.now)?, id, &random::bytes::<16>()?, cx.now),
    };
    let mut res = json(&sandbox, status)?;
    res.headers_mut().set("Idempotent-Replayed", "true")?;
    set_session(&mut res, &new_claims, &keyring)?;
    Ok(res)
}

/// `GET /v1/sandboxes/{id}`.
pub async fn get(cx: &Cx, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    match state(cx, id).await? {
        Some(s) => json(&s, 200),
        None => Err(problem::wiped()),
    }
}

/// `DELETE /v1/sandboxes/{id}`, "Wipe now": the Sandbox wipes itself and its children in this
/// request, 14 of them after seeding plus one an order, and tells `Control`. The cookie loses its sandbox: an account's is
/// re-issued without it, a guest's is cleared, since a guest session is its sandbox.
pub async fn wipe(cx: &Cx, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let keyring = cx.keyring()?;
    let answer = wipe_one(cx, id, "wipe-now").await?;
    if answer.already {
        return Err(problem::wiped());
    }
    if let Some(acct) = &claims.acct {
        clear_current(cx, acct, id).await?;
    }
    let mut res = json(&WipedResponse::new(id.to_string()), 200)?;
    match without_sandbox(&claims, cx.now) {
        Some(c) => set_session(&mut res, &c, &keyring)?,
        None => clear_session(&mut res)?,
    }
    Ok(res)
}

/// `POST /v1/sandboxes/{id}/faults`, signed-in sessions only (the router refused guests).
pub async fn set_fault(cx: &Cx, req: &mut Request, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let body: FaultRequest = read_body(req).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let mut res = call(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Post,
        "/_faults",
        Some(&FaultCommand {
            key: key.to_string(),
            fault: body.fault,
            on: body.on,
        }),
    )
    .await?;
    match res.status_code() {
        200 => {
            let replayed = res.headers().get("Idempotent-Replayed")?.is_some();
            let faults: bakery_contracts::FaultsResponse = res.json().await?;
            let mut out = json(&faults, 200)?;
            if replayed {
                out.headers_mut().set("Idempotent-Replayed", "true")?;
            }
            Ok(out)
        }
        410 => Err(problem::wiped()),
        _ => Err(problem::internal()),
    }
}

/// The answer of a Sandbox command that may be a replay, passed on with its header.
async fn passed_on(mut res: Response) -> Answer {
    let replayed = res.headers().get("Idempotent-Replayed")?.is_some();
    let text = res.text().await?;
    let mut out = Response::ok(text)?;
    out.headers_mut().set("Content-Type", "application/json")?;
    if replayed {
        out.headers_mut().set("Idempotent-Replayed", "true")?;
    }
    Ok(out)
}

/// `GET /v1/sandboxes/{id}/dead-letters`: the Queue screen's list, oldest first. Any session
/// may read it; redriving is a console write.
pub async fn dead_letters(cx: &Cx, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let res = call_empty(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Get,
        "/_dead-letters",
    )
    .await?;
    match res.status_code() {
        200 => passed_on(res).await,
        410 => Err(problem::wiped()),
        _ => Err(problem::internal()),
    }
}

/// `POST /v1/sandboxes/{id}/dead-letters/{eventId}/redrive`, signed-in sessions only.
pub async fn redrive(cx: &Cx, id: Option<&str>, event: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let event: bakery_domain::Ulid = event
        .and_then(|e| e.parse().ok())
        .ok_or_else(|| problem::not_found().because("unknown-dead-letter"))?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let res = call(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Post,
        "/_redrive",
        Some(&Redrive {
            key: key.to_string(),
            id: event.to_string(),
        }),
    )
    .await?;
    match res.status_code() {
        200 => passed_on(res).await,
        404 => Err(problem::not_found().because("unknown-dead-letter")),
        410 => Err(problem::wiped()),
        _ => Err(problem::internal()),
    }
}

/// `POST /v1/sandboxes/{id}/clock {step} | {minutes}`, signed-in sessions only: exactly one of
/// `step` (`15m`, `1h`, `1d`, `next-opening`) and `minutes` (the older form, as the step
/// `<n>m`); both or neither is 422 `clock` with the rule `not-positive`, as the contract says.
pub async fn advance_clock(cx: &Cx, req: &mut Request, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let body: ClockRequest = read_body(req).await?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    let step = clock_step(&body).ok_or_else(|| problem::clock("not-positive"))?;
    let mut res = call(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Post,
        "/_clock",
        Some(&ClockCommand {
            key: key.to_string(),
            step,
        }),
    )
    .await?;
    match res.status_code() {
        200 => passed_on(res).await,
        409 => Err(problem::seeding()),
        410 => Err(problem::wiped()),
        422 => {
            let refusal: problem::Refused = res.json().await?;
            Err(problem::clock(refusal.rule.as_deref().unwrap_or("")))
        }
        _ => Err(problem::internal()),
    }
}

/// The one step a clock request names: its `step`, or its `minutes` as `<n>m`; `None` for both
/// or neither.
fn clock_step(body: &ClockRequest) -> Option<ClockStep> {
    match (body.step, body.minutes) {
        (Some(step), None) => Some(match step {
            bakery_contracts::ClockStep::Minutes15 => ClockStep::Minutes15,
            bakery_contracts::ClockStep::Hour => ClockStep::Hour,
            bakery_contracts::ClockStep::Day => ClockStep::Day,
            bakery_contracts::ClockStep::NextOpening => ClockStep::NextOpening,
        }),
        (None, Some(minutes)) => Some(ClockStep::Minutes(minutes)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clock_request_names_exactly_one_step() {
        let req = |v: serde_json::Value| serde_json::from_value::<ClockRequest>(v).unwrap();
        assert_eq!(
            clock_step(&req(serde_json::json!({ "step": "1d" }))),
            Some(ClockStep::Day)
        );
        assert_eq!(
            clock_step(&req(serde_json::json!({ "step": "next-opening" }))),
            Some(ClockStep::NextOpening)
        );
        assert_eq!(
            clock_step(&req(serde_json::json!({ "minutes": 30 }))),
            Some(ClockStep::Minutes(30))
        );
        assert_eq!(
            clock_step(&req(serde_json::json!({ "minutes": 0 }))),
            Some(ClockStep::Minutes(0)),
            "the domain refuses it as not-positive"
        );
        assert_eq!(clock_step(&req(serde_json::json!({}))), None);
        assert_eq!(
            clock_step(&req(serde_json::json!({ "step": "1h", "minutes": 60 }))),
            None
        );
    }
}
