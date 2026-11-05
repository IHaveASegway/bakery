//! Demo accounts, sign-out and `GET /v1/session` (docs/security.md, "Demo accounts").
//!
//! The password is checked against the policy, hashed and verified here in the stateless
//! Worker; the `Account` only ever sees the PHC string. Neither the username nor the password
//! reaches a log line: the line holds the route and a reason code.

use std::cell::OnceCell;

use bakery_app::admission::Refusal;
use bakery_app::auth::{
    AccountKind, PasswordPolicy, SessionClaims, account_id, demo_username, hash_password, hex,
    is_demo_username, verify_password,
};
use bakery_app::names::account_object_name;
use bakery_contracts::{DemoSigninRequest, DemoSignupRequest, DemoSignupResponse};
use worker::{Method, Request, Response};

use super::auth::{clear_session, session_response, set_session};
use super::problem::{self, Failure};
use super::{Cx, json, outbound};
use crate::objects::account::{self, CreateDemo, Current, DemoHash, Locked, Sid, SignIn};
use crate::objects::control::{self, AdmitDemoRequest};
use crate::objects::sql::{call, call_empty};
use crate::random;

type Answer = Result<Response, Failure>;

/// Draws of a fresh username before giving up; a clash is about 1 in 10,000 at 100 accounts.
const USERNAME_DRAWS: usize = 3;

thread_local! {
    /// A hash to verify against when the username is unknown, so the answer takes about as
    /// long as a wrong password does.
    static DUMMY_PHC: OnceCell<String> = const { OnceCell::new() };
}

pub async fn read_body<T: serde::de::DeserializeOwned>(req: &mut Request) -> Result<T, Failure> {
    let text = req.text().await.map_err(|_| problem::body())?;
    serde_json::from_str(&text).map_err(|_| problem::body())
}

fn spend_a_verify(password: &str) {
    DUMMY_PHC.with(|cell| {
        let phc = cell.get_or_init(|| {
            hash_password("not-a-real-password-for-timing", &[0x5a; 16]).unwrap_or_default()
        });
        let _ = verify_password(password, phc);
    });
}

/// `POST /v1/auth/demo`: the policy, Turnstile, a free username, `Control`'s daily cap, the
/// hash, the `Account`, and a session.
pub async fn signup(cx: &Cx, req: &mut Request) -> Answer {
    let body: DemoSignupRequest = read_body(req).await?;
    PasswordPolicy::check(&body.password).map_err(|_| problem::password())?;
    outbound::siteverify(&cx.cfg, Some(&body.turnstile_token)).await?;
    let account_key = cx.cfg.account_key()?;
    let keyring = cx.keyring()?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;

    let mut username = None;
    for _ in 0..USERNAME_DRAWS {
        let candidate = demo_username(&random::bytes::<4>()?);
        let id = account_id(account_key, AccountKind::Demo, &candidate);
        let res = call_empty(
            &cx.env,
            account::BINDING,
            &account_object_name(&id),
            Method::Get,
            "/_demo-hash",
        )
        .await?;
        if res.status_code() == 410 {
            username = Some(candidate);
            break;
        }
    }
    let username = username.ok_or_else(problem::internal)?;

    let answer = control::admit_demo(
        &cx.env,
        &AdmitDemoRequest {
            key: key.to_string(),
            username,
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
            cx.cfg.caps.account_sandboxes,
        ));
    }
    let username = answer.username.ok_or_else(problem::internal)?;
    let id = account_id(account_key, AccountKind::Demo, &username);
    let name = account_object_name(&id);

    if answer.replayed {
        // The first request with this key made the account. A retry may only sign in to it,
        // with the same password; anything else is a reused key.
        let mut res =
            call_empty(&cx.env, account::BINDING, &name, Method::Get, "/_demo-hash").await?;
        let phc: Option<DemoHash> = match res.status_code() {
            200 => Some(res.json().await?),
            _ => None,
        };
        if !phc.is_some_and(|p| verify_password(&body.password, &p.phc).unwrap_or(false)) {
            return Err(problem::idempotency_reused());
        }
    } else {
        let phc = hash_password(&body.password, &random::bytes::<16>()?)
            .map_err(|_| problem::password())?;
        let res = call(
            &cx.env,
            account::BINDING,
            &name,
            Method::Post,
            "/_create-demo",
            Some(&CreateDemo {
                account_id: id.clone(),
                username: username.clone(),
                phc,
            }),
        )
        .await?;
        if res.status_code() != 201 {
            // Two sign-ups drew the same name in the same moment; the visitor tries again.
            cx.reason("username-clash");
            return Err(problem::internal());
        }
    }

    let claims =
        SessionClaims::account(AccountKind::Demo, id, None, &random::bytes::<16>()?, cx.now);
    let mut res = json(&DemoSignupResponse { username }, 201)?;
    if answer.replayed {
        res.headers_mut().set("Idempotent-Replayed", "true")?;
    }
    set_session(&mut res, &claims, &keyring)?;
    Ok(res)
}

/// `POST /v1/auth/demo/signin`. An unknown username and a wrong password get the same answer,
/// after about the same work.
pub async fn signin(cx: &Cx, req: &mut Request) -> Answer {
    let body: DemoSigninRequest = read_body(req).await?;
    let account_key = cx.cfg.account_key()?;
    let keyring = cx.keyring()?;
    if !is_demo_username(&body.username) {
        spend_a_verify(&body.password);
        return Err(problem::credentials().because("unknown"));
    }
    let id = account_id(account_key, AccountKind::Demo, &body.username);
    let name = account_object_name(&id);
    let mut res = call_empty(&cx.env, account::BINDING, &name, Method::Get, "/_demo-hash").await?;
    let phc = match res.status_code() {
        200 => res.json::<DemoHash>().await?.phc,
        429 => {
            let locked: Locked = res.json().await?;
            return Err(problem::locked(locked.retry_after));
        }
        _ => {
            spend_a_verify(&body.password);
            return Err(problem::credentials().because("unknown"));
        }
    };
    if !verify_password(&body.password, &phc).unwrap_or(false) {
        call_empty(&cx.env, account::BINDING, &name, Method::Post, "/_failed").await?;
        return Err(problem::credentials());
    }
    let sid = random::bytes::<16>()?;
    let mut signed = call(
        &cx.env,
        account::BINDING,
        &name,
        Method::Post,
        "/_signin",
        Some(&SignIn {
            account_id: id.clone(),
            kind: AccountKind::Demo,
            sid: hex(&sid),
        }),
    )
    .await?;
    if signed.status_code() != 200 {
        return Err(problem::credentials().because("account"));
    }
    let current: Current = signed.json().await?;
    cx.sandbox(current.current_sandbox);
    let claims =
        SessionClaims::account(AccountKind::Demo, id, current.current_sandbox, &sid, cx.now);
    let mut res = json(&session_response(&claims), 200)?;
    set_session(&mut res, &claims, &keyring)?;
    Ok(res)
}

/// `POST /v1/auth/signout`: the cookie is cleared, and an account's session id is revoked so
/// a copy of the cookie stops working too.
pub async fn signout(cx: &Cx) -> Answer {
    let claims = cx.claims().ok_or_else(problem::session)?;
    if let Some(acct) = &claims.acct {
        let res = call(
            &cx.env,
            account::BINDING,
            &account_object_name(acct),
            Method::Post,
            "/_revoke",
            Some(&Sid {
                sid: claims.sid.clone(),
            }),
        )
        .await?;
        if res.status_code() != 200 {
            cx.reason("revoke-failed");
        }
    }
    let mut res = Response::empty()?.with_status(204);
    clear_session(&mut res)?;
    Ok(res)
}

/// `GET /v1/session`: the cookie, decoded, with no object call.
pub fn session(cx: &Cx) -> Answer {
    let claims = cx.claims().ok_or_else(problem::session)?;
    json(&session_response(claims), 200)
}
