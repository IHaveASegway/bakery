//! The sandbox's API token (docs/security.md, "The API token"; Q42 · Q-api-access): the bearer
//! path the router takes before the cookie's, and the three token routes.
//!
//! A token is checked in this order, each step free or nearly until the last: the request's
//! shape (`check_request`, in the router), the MAC, purpose, version and expiry
//! (`decode_bearer`), its sandbox against the path's `{id}`, the per-token rate limit, then one
//! Sandbox read for its state and token version (`check_version`). The token itself is never
//! logged, stored or put in an event: the log line carries its `tid` and a reason code, and the
//! Sandbox keeps its id, times and masked form.

use bakery_app::auth::{
    SESSION_VERSION, SessionClaims, TOKEN_TTL_S, TOKEN_VERSION, TokenClaims, TokenKind,
    check_version, decode_bearer, hex, issue_token, masked,
};
use bakery_app::names::sandbox_object_name;
use bakery_contracts::{TokenInfoResponse, TokenResponse};
use bakery_domain::Ulid;
use worker::{Method, Response};

use super::problem::{self, Failure};
use super::sandboxes::{not_revoked, own_sandbox};
use super::{Cx, json, outbound};
use crate::objects::sandbox::{self, TokenCommand, TokenIssued, TokenMasked, TokenState};
use crate::objects::sql::{call, call_empty};
use crate::random;

type Answer = Result<Response, Failure>;

/// The Rate Limiting binding every request with a token spends, keyed by its `tid`, at the
/// session's command rate (wrangler.jsonc). Its own binding, so a token's spend never shares a
/// counter with a session's or an IP hash's.
pub const TOKEN_LIMIT: &str = "TOKEN_LIMIT";

/// The rate limit's key for a token: its id, never the token.
pub fn limit_key(tid: &str) -> String {
    format!("tid:{tid}")
}

/// The Sandbox's state and token version, or `None` once it is wiped (or never was).
pub(super) async fn token_state(cx: &Cx, id: Ulid) -> Result<Option<TokenState>, Failure> {
    let mut res = call_empty(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Get,
        "/_token",
    )
    .await?;
    match res.status_code() {
        200 => Ok(Some(res.json().await?)),
        410 => Ok(None),
        _ => Err(problem::internal()),
    }
}

/// A token's claims as a session's: the account and how it signed in, the sandbox, and the
/// token id where the session id would be. Never a guest's: a guest has no token.
pub fn as_session(t: &TokenClaims) -> SessionClaims {
    SessionClaims {
        v: SESSION_VERSION,
        kind: t.signin,
        acct: Some(t.acct.clone()),
        guest: None,
        sbx: Some(t.sbx),
        sid: t.tid.clone(),
        iat: t.iat,
        exp: t.exp,
        kid: t.kid,
    }
}

/// The bearer path, for a route that takes a token: the claims every route then reads, or the
/// refusal. A token for another sandbox gets the 404 of an id naming nothing; a wiped sandbox's
/// token gets 404 too, and 410 while the wipe runs ("it dies with the sandbox").
pub async fn admit(cx: &Cx, header: &str, id: Option<&str>) -> Result<SessionClaims, Failure> {
    let keyring = cx.keyring()?;
    let claims = decode_bearer(header, &keyring, cx.now).map_err(problem::token_error)?;
    cx.token_id(&claims.tid);
    cx.sandbox(Some(claims.sbx));
    if id.and_then(|i| i.parse::<Ulid>().ok()) != Some(claims.sbx) {
        return Err(problem::not_found().because("not-yours"));
    }
    if !outbound::within_limit(&cx.env, TOKEN_LIMIT, limit_key(&claims.tid)).await {
        return Err(problem::token_rate_limit());
    }
    let state = token_state(cx, claims.sbx)
        .await?
        .ok_or_else(|| problem::not_found().because("sandbox-gone"))?;
    if state.state == "wiping" {
        return Err(problem::wiped());
    }
    check_version(&claims, state.token_v).map_err(problem::token_error)?;
    Ok(as_session(&claims))
}

/// `POST /v1/sandboxes/{id}/token` (issue at the current version, or issue again) and
/// `POST /v1/sandboxes/{id}/token/rotate` (`RotateApiToken`: the version plus one and
/// `ApiTokenRotated`, so every older token stops at once). Signed in, the cookie only: the router
/// refused a guest and a token. The Sandbox records the claims under the request's key, so a
/// retry signs the same token again; the token is shown in this answer and nowhere else.
pub async fn issue(cx: &Cx, id: Option<&str>, rotate: bool) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let acct = claims.acct.clone().ok_or_else(problem::guest_scope)?;
    let keyring = cx.keyring()?;
    let key = cx.key.ok_or_else(problem::idempotency_key)?;
    cx.caused(key.to_string());
    let iat = cx.now.unix_ms().div_euclid(1_000);
    let mut res = call(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Post,
        "/_token/issue",
        Some(&TokenCommand {
            key: key.to_string(),
            rotate,
            tid: hex(&random::bytes::<16>()?),
            iat,
            exp: iat + TOKEN_TTL_S,
        }),
    )
    .await?;
    let replayed = match res.status_code() {
        200 => res.headers().get("Idempotent-Replayed")?.is_some(),
        410 => return Err(problem::wiped()),
        422 => return Err(problem::idempotency_reused()),
        _ => return Err(problem::internal()),
    };
    let issued: TokenIssued = res.json().await?;
    let token_claims = TokenClaims {
        v: TOKEN_VERSION,
        kind: TokenKind::Api,
        signin: claims.kind,
        acct,
        sbx: id,
        tid: issued.tid.clone(),
        iat: issued.iat,
        exp: issued.exp,
        kid: 0,
        token_v: issued.token_v,
    };
    let token = issue_token(&token_claims, &keyring);
    let kept = call(
        &cx.env,
        sandbox::BINDING,
        &sandbox_object_name(id),
        Method::Post,
        "/_token/masked",
        Some(&TokenMasked {
            token_v: issued.token_v,
            tid: issued.tid.clone(),
            masked: masked(&token),
        }),
    )
    .await?;
    if kept.status_code() != 200 {
        // The token is good; only the console's masked line is missing until the next issue.
        cx.reason("masked-not-kept");
    } else {
        cx.reason(if rotate {
            "token-rotated"
        } else {
            "token-issued"
        });
    }
    cx.token_id(&issued.tid);
    let body = TokenResponse {
        token,
        token_v: issued.token_v,
        issued_at: token_claims.issued_at().to_string(),
        expires_at: token_claims.expires_at().to_string(),
    };
    let mut out = json(&body, 200)?;
    if replayed {
        out.headers_mut().set("Idempotent-Replayed", "true")?;
    }
    Ok(out)
}

/// `GET /v1/sandboxes/{id}/token`: the version, the last issued token's times and its masked
/// form, never the token. Signed in, by the cookie or by the token itself.
pub async fn info(cx: &Cx, id: Option<&str>) -> Answer {
    let (claims, id) = own_sandbox(cx, id)?;
    not_revoked(cx, &claims).await?;
    let state = token_state(cx, id).await?.ok_or_else(problem::wiped)?;
    if state.state == "wiping" {
        return Err(problem::wiped());
    }
    json(
        &TokenInfoResponse {
            token_v: state.token_v,
            issued_at: state.issued_at,
            expires_at: state.expires_at,
            masked: state.masked,
        },
        200,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakery_app::auth::{Keyring, verify_bearer};
    use bakery_contracts::SessionKind;
    use bakery_domain::WallTime;

    const KEY: &[u8] = b"test-session-key-0123456789abcdef";
    const ACCT: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

    fn claims(token_v: u32) -> TokenClaims {
        TokenClaims {
            v: TOKEN_VERSION,
            kind: TokenKind::Api,
            signin: SessionKind::Demo,
            acct: ACCT.into(),
            sbx: "01JC8Z6K3W9QF2N4T7XRB5M0HD".parse().unwrap(),
            tid: "00112233445566778899aabbccddeeff".into(),
            iat: 1_793_000_000,
            exp: 1_793_000_000 + TOKEN_TTL_S,
            kid: 0,
            token_v,
        }
    }

    #[test]
    fn a_token_reads_as_its_account_session() {
        let s = as_session(&claims(3));
        assert_eq!(s.kind, SessionKind::Demo);
        assert_eq!(s.acct.as_deref(), Some(ACCT));
        assert_eq!(s.guest, None);
        assert_eq!(s.sbx, Some(claims(3).sbx));
        assert_eq!(s.sid, claims(3).tid);
        assert!(!s.is_guest());
    }

    #[test]
    fn the_same_claims_sign_the_same_token_so_a_replay_is_the_first_answer() {
        let keyring = Keyring::new(KEY, None, 1).unwrap();
        let a = issue_token(&claims(2), &keyring);
        let b = issue_token(&claims(2), &keyring);
        assert_eq!(a, b);
        assert!(a.starts_with("eyJ"));
        let now = WallTime::from_unix_ms(1_793_000_060_000).unwrap();
        let header = format!("Bearer {a}");
        assert!(verify_bearer(&header, &keyring, now, 2).is_ok());
        assert_eq!(
            verify_bearer(&header, &keyring, now, 3)
                .unwrap_err()
                .reason(),
            "rotated"
        );
        let m = masked(&a);
        assert!(m.starts_with("eyJ2Ij") && m.chars().count() == 11, "{m}");
    }

    #[test]
    fn the_limit_key_is_the_token_id() {
        assert_eq!(
            limit_key("00112233445566778899aabbccddeeff"),
            "tid:00112233445566778899aabbccddeeff"
        );
    }

    #[test]
    fn refusals_name_the_rule_and_never_the_token() {
        for (reason, status) in [
            ("query", 400),
            ("both", 400),
            ("token", 401),
            ("expired", 401),
            ("rotated", 401),
            ("purpose", 401),
            ("cookie-only", 401),
        ] {
            let f = problem::token(reason, status);
            assert_eq!(f.problem.status, status);
            assert_eq!(f.reason, reason);
            let detail = f.problem.detail.clone().unwrap_or_default();
            assert!(
                detail.ends_with(&format!("The rule is {reason}.")),
                "{detail}"
            );
            assert!(!detail.contains("eyJ"), "{detail}");
        }
        let limited = problem::token_rate_limit();
        assert_eq!(limited.problem.status, 429);
        assert_eq!(limited.retry_after, Some(60));
    }
}
