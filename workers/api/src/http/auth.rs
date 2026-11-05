//! The session cookie, decoded once per request into an [`Auth`], and re-issued by the routes
//! that change what it says (docs/security.md, "The session cookie").

use bakery_app::auth::{
    Keyring, SESSION_COOKIE, SessionClaims, clear_session_cookie, cookie_value, issue,
    session_cookie, verify,
};
use bakery_contracts::SessionResponse;
use bakery_domain::WallTime;
use worker::{Request, Response, Result};

/// What the request's `__Host-session` says.
#[derive(Debug, Clone)]
pub enum Auth {
    /// No cookie.
    None,
    Session(SessionClaims),
    /// A cookie that did not verify; the reason goes to the log line.
    Invalid(&'static str),
}

impl Auth {
    pub fn read(req: &Request, keyring: &Keyring, now: WallTime) -> Auth {
        let header = req.headers().get("Cookie").ok().flatten();
        let Some(token) = header
            .as_deref()
            .and_then(|h| cookie_value(h, SESSION_COOKIE))
        else {
            return Auth::None;
        };
        match verify(token, keyring, now) {
            Ok(claims) => Auth::Session(claims),
            Err(e) => Auth::Invalid(e.reason()),
        }
    }

    pub fn claims(&self) -> Option<&SessionClaims> {
        match self {
            Auth::Session(c) => Some(c),
            _ => None,
        }
    }
}

/// `GET /v1/session`'s body, from the claims alone.
pub fn session_response(c: &SessionClaims) -> SessionResponse {
    SessionResponse {
        kind: c.kind,
        account: c.acct.clone(),
        sandbox: c.sbx.map(|s| s.to_string()),
        expires_at: c.expires_at().to_string(),
    }
}

/// A claims set with no sandbox, for an account after "Wipe now". A guest has no session
/// without a sandbox (the claims would not verify), so a guest's cookie is cleared instead.
pub fn without_sandbox(c: &SessionClaims, now: WallTime) -> Option<SessionClaims> {
    if c.is_guest() {
        return None;
    }
    let iat = now.unix_ms().div_euclid(1_000);
    Some(SessionClaims {
        sbx: None,
        iat,
        exp: iat + bakery_app::auth::SESSION_TTL_S,
        ..c.clone()
    })
}

pub fn set_session(res: &mut Response, claims: &SessionClaims, keyring: &Keyring) -> Result<()> {
    res.headers_mut()
        .append("Set-Cookie", &session_cookie(&issue(claims, keyring)))
}

pub fn clear_session(res: &mut Response) -> Result<()> {
    res.headers_mut()
        .append("Set-Cookie", &clear_session_cookie())
}
