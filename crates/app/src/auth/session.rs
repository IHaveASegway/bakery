//! The `__Host-session` cookie (docs/security.md, "The session cookie"; ADR 0006, decision 6).
//!
//! Host-only on the API's hostname, `HttpOnly`, `Secure`, `SameSite=Strict`, 24 h. The payload
//! is identifiers only: the session's kind, the account id or the guest's id, the current
//! sandbox, a 128-bit session id, issue and expiry times and the key id. A command checks the
//! cookie without an object call; sign-out also records the session id in the `Account`.

use bakery_contracts::SessionKind;
use bakery_domain::{Ulid, WallTime};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::account::AccountKind;
use super::encoding::{hex, is_lower_hex};
use super::signing::{Keyring, Purpose, SigningError, decode_token, encode_token};

/// The payload's version. A payload with another is refused, so a format change is a new
/// version and old cookies stop working rather than being misread.
pub const SESSION_VERSION: u32 = 1;
/// 24 h, the cookie's `Max-Age` and the payload's `exp - iat`.
pub const SESSION_TTL_S: i64 = 86_400;
pub const SESSION_COOKIE: &str = "__Host-session";
pub const OAUTH_COOKIE: &str = "__Host-oauth";
/// 10 minutes: GitHub's codes expire then, and a consent screen left open longer starts over.
pub const OAUTH_TTL_S: i64 = 600;

/// The signed payload, field for field as the build spec fixes it:
/// `{"v":1,"kind":"demo","acct":"<hex>"|null,"guest":"<ULID>"|null,"sbx":"<ULID>"|null,
/// "sid":"<32 hex>","iat":<unix s>,"exp":<unix s>,"kid":1}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionClaims {
    pub v: u32,
    pub kind: SessionKind,
    /// The account id, 64 hex characters; `None` for a guest.
    pub acct: Option<String>,
    /// The guest's id, minted at the guest's first sandbox; `None` for an account.
    pub guest: Option<Ulid>,
    /// The current sandbox, if any.
    pub sbx: Option<Ulid>,
    /// 128 random bits, 32 lower-case hex characters. Sign-out revokes it in the `Account`.
    pub sid: String,
    pub iat: i64,
    pub exp: i64,
    /// The key that signed it; [`issue`] fills it in.
    pub kid: u32,
}

/// Why a cookie was refused. No variant carries the cookie or a claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SessionError {
    #[error("malformed session")]
    Malformed,
    #[error("bad session signature")]
    Signature,
    #[error("unknown session version")]
    Version,
    #[error("session expired")]
    Expired,
    /// Signed by us but inconsistent: a guest with an account id, an account without one.
    #[error("inconsistent session claims")]
    Claims,
}

impl SessionError {
    /// A reason code for a log line.
    pub fn reason(self) -> &'static str {
        match self {
            SessionError::Malformed => "malformed",
            SessionError::Signature => "signature",
            SessionError::Version => "version",
            SessionError::Expired => "expired",
            SessionError::Claims => "claims",
        }
    }
}

impl From<SigningError> for SessionError {
    fn from(e: SigningError) -> SessionError {
        match e {
            SigningError::Signature => SessionError::Signature,
            SigningError::Malformed | SigningError::KeyTooShort => SessionError::Malformed,
        }
    }
}

/// Unix seconds, rounded down.
pub(crate) fn unix_s(t: WallTime) -> i64 {
    t.unix_ms().div_euclid(1_000)
}

impl SessionClaims {
    /// A guest's session: no account, a guest id and the sandbox it was admitted for.
    /// `sid_random` is 16 bytes from the platform's random source.
    pub fn guest(guest: Ulid, sandbox: Ulid, sid_random: &[u8; 16], now: WallTime) -> Self {
        Self::fresh(
            SessionKind::Guest,
            None,
            Some(guest),
            Some(sandbox),
            sid_random,
            now,
        )
    }

    /// A signed-in session for `account_id`, with the account's current sandbox if it has one.
    pub fn account(
        kind: AccountKind,
        account_id: String,
        sandbox: Option<Ulid>,
        sid_random: &[u8; 16],
        now: WallTime,
    ) -> Self {
        Self::fresh(
            kind.session_kind(),
            Some(account_id),
            None,
            sandbox,
            sid_random,
            now,
        )
    }

    fn fresh(
        kind: SessionKind,
        acct: Option<String>,
        guest: Option<Ulid>,
        sbx: Option<Ulid>,
        sid_random: &[u8; 16],
        now: WallTime,
    ) -> Self {
        let iat = unix_s(now);
        SessionClaims {
            v: SESSION_VERSION,
            kind,
            acct,
            guest,
            sbx,
            sid: hex(sid_random),
            iat,
            exp: iat + SESSION_TTL_S,
            kid: 0,
        }
    }

    /// The same session, same kind, identity and `sid`, now naming `sandbox`. Issue and expiry
    /// restart from `now`, so the payload agrees with the new cookie's `Max-Age`. Re-issuing is
    /// bounded by admission: 3 sandboxes an account a day, Turnstile for each guest sandbox.
    pub fn with_sandbox(&self, sandbox: Ulid, now: WallTime) -> Self {
        let iat = unix_s(now);
        SessionClaims {
            sbx: Some(sandbox),
            iat,
            exp: iat + SESSION_TTL_S,
            ..self.clone()
        }
    }

    /// When the session stops being accepted, for `SessionResponse.expires_at`.
    pub fn expires_at(&self) -> WallTime {
        WallTime::from_unix_ms(self.exp.saturating_mul(1_000))
            .expect("a verified expiry is in range")
    }

    pub fn is_guest(&self) -> bool {
        self.kind == SessionKind::Guest
    }

    fn consistent(&self) -> bool {
        let identity = match self.kind {
            SessionKind::Guest => self.acct.is_none() && self.guest.is_some() && self.sbx.is_some(),
            SessionKind::Google | SessionKind::Github | SessionKind::Demo => {
                self.guest.is_none() && self.acct.as_deref().is_some_and(|a| is_lower_hex(a, 64))
            }
        };
        identity && is_lower_hex(&self.sid, 32) && self.iat <= self.exp
    }
}

/// Signs `claims` with the current key, stamping its `kid`.
pub fn issue(claims: &SessionClaims, keyring: &Keyring) -> String {
    let claims = SessionClaims {
        kid: keyring.kid(),
        ..claims.clone()
    };
    encode_token(Purpose::Session, &claims, keyring)
}

/// Checks the MAC, then the version, then the expiry, then that the claims hang together.
/// A cookie is accepted strictly before its `exp`.
pub fn verify(
    token: &str,
    keyring: &Keyring,
    now: WallTime,
) -> Result<SessionClaims, SessionError> {
    // The version is read before the rest, so a future payload shape reports `Version` rather
    // than `Malformed`.
    let value: serde_json::Value = decode_token(Purpose::Session, token, keyring)?;
    if value.get("v").and_then(serde_json::Value::as_u64) != Some(u64::from(SESSION_VERSION)) {
        return Err(SessionError::Version);
    }
    let claims: SessionClaims =
        serde_json::from_value(value).map_err(|_| SessionError::Malformed)?;
    if unix_s(now) >= claims.exp {
        return Err(SessionError::Expired);
    }
    if !claims.consistent() || WallTime::from_unix_ms(claims.exp.saturating_mul(1_000)).is_err() {
        return Err(SessionError::Claims);
    }
    Ok(claims)
}

/// The `Set-Cookie` value for a session token.
pub fn session_cookie(token: &str) -> String {
    format!(
        "{SESSION_COOKIE}={token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={SESSION_TTL_S}"
    )
}

/// The `Set-Cookie` value that removes the session cookie: the same attributes, `Max-Age=0`.
pub fn clear_session_cookie() -> String {
    format!("{SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0")
}

/// The `Set-Cookie` value for an OAuth transaction. `Lax`, because the provider's redirect back
/// is a cross-site navigation, which a `Strict` cookie would miss.
pub fn oauth_cookie(token: &str) -> String {
    format!("{OAUTH_COOKIE}={token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={OAUTH_TTL_S}")
}

pub fn clear_oauth_cookie() -> String {
    format!("{OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0")
}

/// The value of the first cookie called `name` in a `Cookie` request header, if it is not
/// empty. The `__Host-` prefix means no other site or subdomain can have set a cookie of that
/// name for this host, so the first is the one.
pub fn cookie_value<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.trim())
        .filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KEY: &[u8] = b"test-session-key-0123456789abcdef";
    const NEXT_KEY: &[u8] = b"test-session-key-next-0123456789a";
    const ACCT: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

    fn keys() -> Keyring {
        Keyring::new(KEY, None, 1).unwrap()
    }

    fn at(text: &str) -> WallTime {
        text.parse().unwrap()
    }

    fn ulid(n: u128) -> Ulid {
        Ulid::from_parts(1_793_819_530_318, n)
    }

    #[test]
    fn payload_has_the_spec_shape() {
        let claims = SessionClaims::account(
            AccountKind::Demo,
            ACCT.into(),
            None,
            &[0xab; 16],
            at("2026-11-05T12:00:00.500Z"),
        );
        let token = issue(&claims, &keys());
        let (payload, _) = token.split_once('.').unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&crate::auth::encoding::base64url_decode(payload).unwrap())
                .unwrap();
        assert_eq!(
            json,
            json!({"v":1,"kind":"demo","acct":ACCT,"guest":null,"sbx":null,
                   "sid":"abababababababababababababababab",
                   "iat":1_793_880_000,"exp":1_793_966_400,"kid":1})
        );
        // Field order on the wire is the struct's.
        let text =
            String::from_utf8(crate::auth::encoding::base64url_decode(payload).unwrap()).unwrap();
        assert!(
            text.starts_with(r#"{"v":1,"kind":"demo","acct":"#),
            "{text}"
        );
    }

    #[test]
    fn verifies_until_expiry() {
        let born = at("2026-11-05T12:00:00.000Z");
        let claims = SessionClaims::guest(ulid(1), ulid(2), &[1; 16], born);
        let token = issue(&claims, &keys());
        let back = verify(&token, &keys(), at("2026-11-06T11:59:59.999Z")).unwrap();
        assert_eq!(back.kid, 1);
        assert_eq!(back.sbx, Some(ulid(2)));
        assert!(back.is_guest());
        assert_eq!(back.expires_at(), at("2026-11-06T12:00:00.000Z"));
        assert_eq!(
            verify(&token, &keys(), at("2026-11-06T12:00:00.000Z")),
            Err(SessionError::Expired)
        );
    }

    #[test]
    fn rotation_accepts_the_previous_key() {
        let now = at("2026-11-05T12:00:00.000Z");
        let claims = SessionClaims::guest(ulid(1), ulid(2), &[1; 16], now);
        let token = issue(&claims, &keys());
        let rotated = Keyring::new(NEXT_KEY, Some(KEY.to_vec()), 2).unwrap();
        assert!(verify(&token, &rotated, now).is_ok());
        let after = Keyring::new(NEXT_KEY, None, 2).unwrap();
        assert_eq!(verify(&token, &after, now), Err(SessionError::Signature));
    }

    #[test]
    fn refuses_a_tampered_payload() {
        let now = at("2026-11-05T12:00:00.000Z");
        let claims = SessionClaims::guest(ulid(1), ulid(2), &[1; 16], now);
        let token = issue(&claims, &keys());
        let (_, mac) = token.split_once('.').unwrap();
        let forged = SessionClaims {
            sbx: Some(ulid(3)),
            ..claims
        };
        let forged_payload = crate::auth::encoding::base64url(
            &serde_json::to_vec(&SessionClaims { kid: 1, ..forged }).unwrap(),
        );
        assert_eq!(
            verify(&format!("{forged_payload}.{mac}"), &keys(), now),
            Err(SessionError::Signature)
        );
    }

    #[test]
    fn refuses_another_version_and_inconsistent_claims() {
        let now = at("2026-11-05T12:00:00.000Z");
        let base = SessionClaims::guest(ulid(1), ulid(2), &[1; 16], now);

        let v2 = SessionClaims {
            v: 2,
            ..base.clone()
        };
        assert_eq!(
            verify(&issue(&v2, &keys()), &keys(), now),
            Err(SessionError::Version)
        );

        let guest_with_account = SessionClaims {
            acct: Some(ACCT.into()),
            ..base.clone()
        };
        assert_eq!(
            verify(&issue(&guest_with_account, &keys()), &keys(), now),
            Err(SessionError::Claims)
        );

        let account_without_id = SessionClaims {
            kind: SessionKind::Google,
            guest: None,
            ..base.clone()
        };
        assert_eq!(
            verify(&issue(&account_without_id, &keys()), &keys(), now),
            Err(SessionError::Claims)
        );

        let short_sid = SessionClaims {
            sid: "abc".into(),
            ..base
        };
        assert_eq!(
            verify(&issue(&short_sid, &keys()), &keys(), now),
            Err(SessionError::Claims)
        );
    }

    #[test]
    fn with_sandbox_keeps_the_session_and_restarts_its_clock() {
        let signed_in = at("2026-11-05T08:00:00.000Z");
        let claims =
            SessionClaims::account(AccountKind::Github, ACCT.into(), None, &[7; 16], signed_in);
        let later = at("2026-11-05T09:00:00.000Z");
        let moved = claims.with_sandbox(ulid(9), later);
        assert_eq!(moved.sid, claims.sid);
        assert_eq!(moved.acct, claims.acct);
        assert_eq!(moved.kind, SessionKind::Github);
        assert_eq!(moved.sbx, Some(ulid(9)));
        assert_eq!(moved.exp - moved.iat, SESSION_TTL_S);
        assert_eq!(moved.iat, unix_s(later));
    }

    #[test]
    fn cookie_attributes() {
        assert_eq!(
            session_cookie("p.m"),
            "__Host-session=p.m; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400"
        );
        assert_eq!(
            clear_session_cookie(),
            "__Host-session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
        );
        assert_eq!(
            oauth_cookie("p.m"),
            "__Host-oauth=p.m; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600"
        );
        assert_eq!(
            clear_oauth_cookie(),
            "__Host-oauth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
        );
        // ADR 0006: the session cookie is never Lax.
        assert!(!session_cookie("x").contains("Lax"));
        assert!(!session_cookie("x").contains("Domain"));
    }

    #[test]
    fn reads_one_cookie_from_the_header() {
        let header = "theme=dark; __Host-oauth=o.1;__Host-session=s.2 ; x=";
        assert_eq!(cookie_value(header, SESSION_COOKIE), Some("s.2"));
        assert_eq!(cookie_value(header, OAUTH_COOKIE), Some("o.1"));
        assert_eq!(cookie_value(header, "x"), None);
        assert_eq!(cookie_value(header, "missing"), None);
        assert_eq!(cookie_value("a__Host-session=z", SESSION_COOKIE), None);
        assert_eq!(cookie_value("", SESSION_COOKIE), None);
    }
}
