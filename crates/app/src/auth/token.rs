//! The sandbox's API token (docs/security.md, "The API token"; Q42 · Q-api-access).
//!
//! Signed like the session cookie, with the same keyring, under its own [`Purpose`], so a
//! cookie never verifies as a token nor a token as a cookie. The payload is the session's
//! identifiers (the version, how the account signed in, the account id, the sandbox, a 128-bit
//! id, issue and expiry times, the key id) plus the Sandbox's token version and the marker
//! `"kind": "api"`. It lives 24 h and dies sooner with the sandbox, or with a rotation: "Rotate"
//! bumps the version in the `Sandbox`, and a token naming an older one is refused.
//!
//! The token travels in `Authorization: Bearer` only. A token in a query string, or a token and
//! the cookie on one request, is refused before anything is verified; [`check_request`] reads
//! those, [`verify_bearer`] the token itself.

use bakery_contracts::SessionKind;
use bakery_domain::Ulid;
use bakery_domain::WallTime;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::encoding::{hex, is_lower_hex};
use super::session::{SessionClaims, unix_s};
use super::signing::{Keyring, Purpose, SigningError, decode_token, encode_token};

/// The payload's version; another is refused.
pub const TOKEN_VERSION: u32 = 1;
/// 24 h, as the session cookie.
pub const TOKEN_TTL_S: i64 = 86_400;
/// The problem slug every refusal answers with: 401 for a token that does not verify, 400 for
/// a request that carries one where it must not.
pub const TOKEN_PROBLEM: &str = "token";
/// Query parameter names a client might put a token under. Any of them, or any value shaped
/// like a token, refuses the request: a URL is logged, cached and shared in ways a header is
/// not.
pub const QUERY_NAMES: &[&str] = &[
    "token",
    "access_token",
    "api_token",
    "bearer",
    "authorization",
];

/// The payload's marker: always `api`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenKind {
    Api,
}

/// The signed payload:
/// `{"v":1,"kind":"api","signin":"github","acct":"<64 hex>","sbx":"<ULID>","tid":"<32 hex>",
/// "iat":<unix s>,"exp":<unix s>,"kid":1,"token_v":0}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenClaims {
    pub v: u32,
    pub kind: TokenKind,
    /// How the account signed in, as the session's `kind`: `google`, `github` or `demo`. Never
    /// `guest`: a guest has no token.
    pub signin: SessionKind,
    /// The account id, 64 hex characters.
    pub acct: String,
    /// The sandbox the token acts on: every object name is derived from it.
    pub sbx: Ulid,
    /// 128 random bits, 32 lower-case hex characters: the token's id, the rate limit's key.
    pub tid: String,
    pub iat: i64,
    pub exp: i64,
    /// The key that signed it; [`issue_token`] fills it in.
    pub kid: u32,
    /// The Sandbox's token version when it was issued.
    pub token_v: u32,
}

/// Why a bearer token was refused. No variant carries the token or a claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum TokenError {
    /// Not `Bearer <token>`, not signed by either key, not version 1, or claims that do not
    /// hang together.
    #[error("unusable API token")]
    Token,
    #[error("API token expired")]
    Expired,
    /// It names a token version older than the Sandbox's.
    #[error("API token rotated")]
    Rotated,
    /// A session cookie, or another of our signed values, presented as a token.
    #[error("not an API token")]
    Purpose,
    /// A request carrying the cookie and a token: refused rather than choosing one.
    #[error("a cookie and an API token together")]
    Both,
    /// A token in the query string.
    #[error("an API token in the query string")]
    Query,
}

impl TokenError {
    /// A reason code for a log line, as docs/security.md names them.
    pub fn reason(self) -> &'static str {
        match self {
            TokenError::Token => "token",
            TokenError::Expired => "expired",
            TokenError::Rotated => "rotated",
            TokenError::Purpose => "purpose",
            TokenError::Both => "both",
            TokenError::Query => "query",
        }
    }

    /// The status the Worker answers with, problem type [`TOKEN_PROBLEM`]: 400 for a request
    /// shaped wrong, 401 for a token that is not good.
    pub fn status(self) -> u16 {
        match self {
            TokenError::Both | TokenError::Query => 400,
            _ => 401,
        }
    }
}

impl TokenClaims {
    /// A token for a signed-in session's current sandbox, at the Sandbox's `token_v`.
    /// `tid_random` is 16 bytes from the platform's random source. `None` for a guest or a
    /// session with no sandbox: the router answers those 403 `guest-scope` and 404 first.
    pub fn for_session(
        session: &SessionClaims,
        token_v: u32,
        tid_random: &[u8; 16],
        now: WallTime,
    ) -> Option<TokenClaims> {
        if session.is_guest() {
            return None;
        }
        let iat = unix_s(now);
        Some(TokenClaims {
            v: TOKEN_VERSION,
            kind: TokenKind::Api,
            signin: session.kind,
            acct: session.acct.clone()?,
            sbx: session.sbx?,
            tid: hex(tid_random),
            iat,
            exp: iat + TOKEN_TTL_S,
            kid: 0,
            token_v,
        })
    }

    /// When the token was issued, for `TokenResponse.issued_at`.
    pub fn issued_at(&self) -> WallTime {
        WallTime::from_unix_ms(self.iat.saturating_mul(1_000)).expect("a verified time is in range")
    }

    /// When it stops being accepted, for `TokenResponse.expires_at`.
    pub fn expires_at(&self) -> WallTime {
        WallTime::from_unix_ms(self.exp.saturating_mul(1_000)).expect("a verified time is in range")
    }

    fn consistent(&self) -> bool {
        self.signin != SessionKind::Guest
            && is_lower_hex(&self.acct, 64)
            && is_lower_hex(&self.tid, 32)
            && self.iat <= self.exp
            && self.exp - self.iat <= TOKEN_TTL_S
            && WallTime::from_unix_ms(self.exp.saturating_mul(1_000)).is_ok()
            && WallTime::from_unix_ms(self.iat.saturating_mul(1_000)).is_ok()
    }
}

/// Signs `claims` with the current key, stamping its `kid`.
pub fn issue_token(claims: &TokenClaims, keyring: &Keyring) -> String {
    let claims = TokenClaims {
        kid: keyring.kid(),
        ..claims.clone()
    };
    encode_token(Purpose::ApiToken, &claims, keyring)
}

/// The request-level rules, before any token is verified: a token in the query string is
/// refused (`Query`), and so is a request with a token and the cookie (`Both`). Answers the
/// token text when there is a usable `Authorization: Bearer` header, `None` when there is no
/// `Authorization` header at all (the cookie, if any, then decides).
pub fn check_request<'a>(
    authorization: Option<&'a str>,
    has_cookie: bool,
    query: Option<&str>,
) -> Result<Option<&'a str>, TokenError> {
    if query.is_some_and(query_has_token) {
        return Err(TokenError::Query);
    }
    let Some(header) = authorization else {
        return Ok(None);
    };
    let token = bearer(header)?;
    if has_cookie {
        return Err(TokenError::Both);
    }
    Ok(Some(token))
}

/// The token in an `Authorization` header value: the scheme `Bearer`, in any case (RFC 9110,
/// section 11.1), one or more spaces, and a token with nothing after it.
fn bearer(header: &str) -> Result<&str, TokenError> {
    let (scheme, rest) = header.trim().split_once(' ').ok_or(TokenError::Token)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return Err(TokenError::Token);
    }
    let token = rest.trim_start();
    if token.is_empty() || token.contains(char::is_whitespace) {
        return Err(TokenError::Token);
    }
    Ok(token)
}

/// Whether a query string (without its `?`) carries a token: a parameter named in
/// [`QUERY_NAMES`], whatever its value, or a value shaped like one of our signed values.
fn query_has_token(query: &str) -> bool {
    query.split('&').any(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        let name = name.to_ascii_lowercase();
        QUERY_NAMES.contains(&name.as_str()) || looks_signed(value)
    })
}

/// `<base64url>.<base64url>` whose first part is a JSON object's base64url (`eyJ`) and whose
/// second is at least a MAC's 43 characters: the shape [`encode_token`] makes.
fn looks_signed(value: &str) -> bool {
    let base64url = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    match value.split_once('.') {
        Some((payload, mac)) => {
            payload.starts_with("eyJ") && base64url(payload) && mac.len() >= 43 && base64url(mac)
        }
        None => false,
    }
}

/// Everything about a bearer header but the token version: the scheme, the MAC under either
/// key in constant time (through the [`Keyring`]), the purpose, the payload's version and
/// shape, and the expiry. A token is accepted strictly before its `exp`. The router reads
/// `sbx` from the answer, checks it against the path's `{id}` and the Sandbox's `token_v`
/// with the registry lookup it already makes, then calls [`check_version`].
pub fn decode_bearer(
    header_value: &str,
    keyring: &Keyring,
    now: WallTime,
) -> Result<TokenClaims, TokenError> {
    let token = bearer(header_value)?;
    let value: serde_json::Value = match decode_token(Purpose::ApiToken, token, keyring) {
        Ok(value) => value,
        Err(SigningError::Signature) => return Err(other_purpose(token, keyring)),
        Err(_) => return Err(TokenError::Token),
    };
    if value.get("v").and_then(serde_json::Value::as_u64) != Some(u64::from(TOKEN_VERSION)) {
        return Err(TokenError::Token);
    }
    let claims: TokenClaims = serde_json::from_value(value).map_err(|_| TokenError::Token)?;
    if !claims.consistent() {
        return Err(TokenError::Token);
    }
    if unix_s(now) >= claims.exp {
        return Err(TokenError::Expired);
    }
    Ok(claims)
}

/// A token naming a version older than the Sandbox's was rotated away. A newer one than the
/// Sandbox has never issued is no token of ours.
pub fn check_version(claims: &TokenClaims, expected_token_v: u32) -> Result<(), TokenError> {
    match claims.token_v.cmp(&expected_token_v) {
        std::cmp::Ordering::Less => Err(TokenError::Rotated),
        std::cmp::Ordering::Equal => Ok(()),
        std::cmp::Ordering::Greater => Err(TokenError::Token),
    }
}

/// The whole check, for a caller that already knows the Sandbox's token version.
pub fn verify_bearer(
    header_value: &str,
    keyring: &Keyring,
    now: WallTime,
    expected_token_v: u32,
) -> Result<TokenClaims, TokenError> {
    let claims = decode_bearer(header_value, keyring, now)?;
    check_version(&claims, expected_token_v)?;
    Ok(claims)
}

/// A value that is not an API token: one of our other signed values (the session cookie, the
/// OAuth transaction) is `Purpose`, so the log says what was sent; anything else is `Token`.
fn other_purpose(token: &str, keyring: &Keyring) -> TokenError {
    let ours = [Purpose::Session, Purpose::OAuth]
        .into_iter()
        .any(|p| decode_token::<serde_json::Value>(p, token, keyring).is_ok());
    if ours {
        TokenError::Purpose
    } else {
        TokenError::Token
    }
}

/// What the console shows of a token: its first 6 and last 4 characters around `…`, enough to
/// tell two apart and never enough to use one. Anything shorter than 16 characters shows as
/// `…` alone, so a short value is never shown whole.
pub fn masked(token: &str) -> String {
    let chars: Vec<char> = token.chars().collect();
    if chars.len() < 16 {
        return "…".to_owned();
    }
    let head: String = chars[..6].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::account::AccountKind;
    use crate::auth::encoding::{base64url, base64url_decode};
    use crate::auth::session::{self, SessionError};
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

    fn signed_in(now: WallTime) -> SessionClaims {
        SessionClaims::account(
            AccountKind::Github,
            ACCT.into(),
            Some(ulid(2)),
            &[7; 16],
            now,
        )
    }

    fn token_at(now: WallTime, token_v: u32) -> (TokenClaims, String) {
        let claims = TokenClaims::for_session(&signed_in(now), token_v, &[0xcd; 16], now).unwrap();
        let token = issue_token(&claims, &keys());
        (claims, token)
    }

    fn header(token: &str) -> String {
        format!("Bearer {token}")
    }

    #[test]
    fn payload_has_the_spec_shape() {
        let now = at("2026-11-05T12:00:00.500Z");
        let (_, token) = token_at(now, 3);
        let (payload, _) = token.split_once('.').unwrap();
        let text = String::from_utf8(base64url_decode(payload).unwrap()).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            value,
            json!({"v":1,"kind":"api","signin":"github","acct":ACCT,"sbx":ulid(2).to_string(),
                   "tid":"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
                   "iat":1_793_880_000,"exp":1_793_966_400,"kid":1,"token_v":3})
        );
        assert!(text.starts_with(r#"{"v":1,"kind":"api","#), "{text}");
    }

    #[test]
    fn round_trips_until_expiry() {
        let now = at("2026-11-05T12:00:00.000Z");
        let (claims, token) = token_at(now, 0);
        let back =
            verify_bearer(&header(&token), &keys(), at("2026-11-06T11:59:59.999Z"), 0).unwrap();
        assert_eq!(back, TokenClaims { kid: 1, ..claims });
        assert_eq!(back.sbx, ulid(2));
        assert_eq!(back.issued_at(), now);
        assert_eq!(back.expires_at(), at("2026-11-06T12:00:00.000Z"));
        assert_eq!(
            verify_bearer(&header(&token), &keys(), at("2026-11-06T12:00:00.000Z"), 0),
            Err(TokenError::Expired)
        );
        // The scheme in any case, and more than one space.
        assert!(verify_bearer(&format!("bearer  {token}"), &keys(), now, 0).is_ok());
    }

    #[test]
    fn a_guest_or_a_session_without_a_sandbox_gets_no_token() {
        let now = at("2026-11-05T12:00:00.000Z");
        let guest = SessionClaims::guest(ulid(1), ulid(2), &[1; 16], now);
        assert_eq!(TokenClaims::for_session(&guest, 0, &[1; 16], now), None);
        let no_sandbox =
            SessionClaims::account(AccountKind::Demo, ACCT.into(), None, &[1; 16], now);
        assert_eq!(
            TokenClaims::for_session(&no_sandbox, 0, &[1; 16], now),
            None
        );
    }

    #[test]
    fn a_rotated_version_is_refused() {
        let now = at("2026-11-05T12:00:00.000Z");
        let (_, old) = token_at(now, 4);
        assert!(verify_bearer(&header(&old), &keys(), now, 4).is_ok());
        assert_eq!(
            verify_bearer(&header(&old), &keys(), now, 5),
            Err(TokenError::Rotated)
        );
        // A version the Sandbox never reached is not ours.
        assert_eq!(
            verify_bearer(&header(&old), &keys(), now, 3),
            Err(TokenError::Token)
        );
        let claims = decode_bearer(&header(&old), &keys(), now).unwrap();
        assert_eq!(check_version(&claims, 5), Err(TokenError::Rotated));
        assert_eq!(TokenError::Rotated.reason(), "rotated");
    }

    #[test]
    fn a_session_cookie_is_not_a_bearer_token_nor_a_token_a_cookie() {
        let now = at("2026-11-05T12:00:00.000Z");
        let cookie = session::issue(&signed_in(now), &keys());
        assert_eq!(
            verify_bearer(&header(&cookie), &keys(), now, 0),
            Err(TokenError::Purpose)
        );
        let (_, token) = token_at(now, 0);
        assert_eq!(
            session::verify(&token, &keys(), now),
            Err(SessionError::Signature)
        );
        // The token's payload re-signed as a session is still refused as a bearer.
        let (payload, _) = token.split_once('.').unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&base64url_decode(payload).unwrap()).unwrap();
        let as_session = encode_token(Purpose::Session, &json, &keys());
        assert_eq!(
            verify_bearer(&header(&as_session), &keys(), now, 0),
            Err(TokenError::Purpose)
        );
    }

    #[test]
    fn the_mac_is_checked_through_the_keyring_under_either_key() {
        let now = at("2026-11-05T12:00:00.000Z");
        let (_, token) = token_at(now, 0);
        // A rotation of SESSION_HMAC_KEY: the previous key still verifies, in constant time,
        // through Keyring::verify; once it is removed the token is refused.
        let rotated = Keyring::new(NEXT_KEY, Some(KEY.to_vec()), 2).unwrap();
        assert!(verify_bearer(&header(&token), &rotated, now, 0).is_ok());
        let after = Keyring::new(NEXT_KEY, None, 2).unwrap();
        assert_eq!(
            verify_bearer(&header(&token), &after, now, 0),
            Err(TokenError::Token)
        );
        // One character of the MAC changed, and a forged payload under the old MAC.
        let (payload, mac) = token.split_once('.').unwrap();
        let mut bytes = base64url_decode(mac).unwrap();
        bytes[31] ^= 1;
        let flipped = format!("{payload}.{}", base64url(&bytes));
        assert_eq!(
            verify_bearer(&header(&flipped), &keys(), now, 0),
            Err(TokenError::Token)
        );
        let mut forged: serde_json::Value =
            serde_json::from_slice(&base64url_decode(payload).unwrap()).unwrap();
        forged["sbx"] = json!(ulid(3).to_string());
        let forged = format!("{}.{mac}", base64url(&serde_json::to_vec(&forged).unwrap()));
        assert_eq!(
            verify_bearer(&header(&forged), &keys(), now, 0),
            Err(TokenError::Token)
        );
    }

    #[test]
    fn malformed_headers_and_claims_are_refused() {
        let now = at("2026-11-05T12:00:00.000Z");
        let (claims, token) = token_at(now, 0);
        for bad in [
            String::new(),
            token.clone(),
            format!("Basic {token}"),
            "Bearer".to_owned(),
            "Bearer ".to_owned(),
            format!("Bearer {token} extra"),
            "Bearer a.b".to_owned(),
            "Bearer !!.!!".to_owned(),
        ] {
            assert_eq!(
                verify_bearer(&bad, &keys(), now, 0),
                Err(TokenError::Token),
                "{bad:?}"
            );
        }
        let resign = |c: &TokenClaims| issue_token(c, &keys());
        for (what, bad) in [
            (
                "version",
                TokenClaims {
                    v: 2,
                    ..claims.clone()
                },
            ),
            (
                "guest",
                TokenClaims {
                    signin: SessionKind::Guest,
                    ..claims.clone()
                },
            ),
            (
                "acct",
                TokenClaims {
                    acct: "abc".into(),
                    ..claims.clone()
                },
            ),
            (
                "tid",
                TokenClaims {
                    tid: "abc".into(),
                    ..claims.clone()
                },
            ),
            (
                "too long",
                TokenClaims {
                    exp: claims.iat + TOKEN_TTL_S + 1,
                    ..claims.clone()
                },
            ),
        ] {
            assert_eq!(
                verify_bearer(&header(&resign(&bad)), &keys(), now, 0),
                Err(TokenError::Token),
                "{what}"
            );
        }
        // An unknown field is refused, even signed.
        let mut extra = serde_json::to_value(&claims).unwrap();
        extra["scope"] = json!("all");
        let extra = encode_token(Purpose::ApiToken, &extra, &keys());
        assert_eq!(
            verify_bearer(&header(&extra), &keys(), now, 0),
            Err(TokenError::Token)
        );
    }

    #[test]
    fn the_request_rules_refuse_both_and_the_query() {
        let now = at("2026-11-05T12:00:00.000Z");
        let (_, token) = token_at(now, 0);
        let h = header(&token);
        assert_eq!(
            check_request(Some(&h), false, None),
            Ok(Some(token.as_str()))
        );
        assert_eq!(check_request(None, true, None), Ok(None));
        assert_eq!(check_request(None, false, Some("limit=30")), Ok(None));
        assert_eq!(check_request(Some(&h), true, None), Err(TokenError::Both));
        assert_eq!(
            check_request(Some("Basic abc"), false, None),
            Err(TokenError::Token)
        );
        for query in [
            "token=x".to_owned(),
            "limit=30&access_token=x".to_owned(),
            "Authorization=x".to_owned(),
            format!("t={token}"),
            "bearer".to_owned(),
        ] {
            assert_eq!(
                check_request(None, false, Some(&query)),
                Err(TokenError::Query),
                "{query}"
            );
            assert_eq!(
                check_request(Some(&h), false, Some(&query)),
                Err(TokenError::Query),
                "{query}"
            );
        }
        assert_eq!(TokenError::Both.status(), 400);
        assert_eq!(TokenError::Query.status(), 400);
        assert_eq!(TokenError::Expired.status(), 401);
        assert_eq!(
            [
                TokenError::Token,
                TokenError::Expired,
                TokenError::Rotated,
                TokenError::Purpose,
                TokenError::Both,
                TokenError::Query
            ]
            .map(TokenError::reason),
            ["token", "expired", "rotated", "purpose", "both", "query"]
        );
    }

    #[test]
    fn masking_shows_six_and_four() {
        let now = at("2026-11-05T12:00:00.000Z");
        let (_, token) = token_at(now, 0);
        let shown = masked(&token);
        assert_eq!(shown.chars().count(), 11);
        assert!(shown.starts_with(&token[..6]), "{shown}");
        assert!(shown.ends_with(&token[token.len() - 4..]), "{shown}");
        assert!(shown.contains('…'));
        assert_eq!(masked("abcdefghijklmnop"), "abcdef…mnop");
        assert_eq!(masked("short"), "…");
        assert_eq!(masked(""), "…");
        // No payment-key-shaped prefix: the token starts with its JSON payload's base64url.
        assert!(token.starts_with("eyJ"), "{shown}");
    }

    #[test]
    fn errors_never_print_the_token() {
        let now = at("2026-11-05T12:00:00.000Z");
        let (_, token) = token_at(now, 0);
        let err = verify_bearer(&header(&token), &keys(), now, 9).unwrap_err();
        assert!(!format!("{err} {err:?}").contains(&token[..10]));
    }
}
