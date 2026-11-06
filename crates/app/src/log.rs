//! The one log line per request (docs/security.md, "Privacy and data inventory").
//!
//! A line holds the route, method, status, duration, an IP hash, country and continent, the
//! sandbox id and, for the OAuth and demo routes, a reason code. Never a body, cookie, token,
//! query string, username, password, `sub` or GitHub id. The route can only come from
//! [`RequestLine::route_from_path`], which drops the query; the reason is a `&'static str`, so
//! only a code written in the source can reach it, never a value from a request.

use serde::Serialize;
use thiserror::Error;

use crate::auth::{hex, mac};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum LogError {
    /// A path with a line break or other control character would split or forge a line.
    #[error("a path for a log line held a control character")]
    ControlCharacter,
}

/// One request's line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RequestLine {
    #[serde(rename = "type")]
    line_type: &'static str,
    route: String,
    pub method: String,
    pub status: u16,
    pub ms: u64,
    /// [`ip_hash`] of `CF-Connecting-IP`; the address itself is never logged.
    pub ip_hash: Option<String>,
    pub country: Option<String>,
    pub continent: Option<String>,
    /// The session's sandbox ULID.
    pub sandbox: Option<String>,
    /// A reason code such as `state` or `locked`. `&'static str` on purpose: a code is a
    /// constant in the source, so a password, token or username cannot be put here by mistake.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    /// The API token's id when the request carried a token that verified: 32 hex characters,
    /// never the token. Set only through [`RequestLine::token_id`], which refuses anything else.
    #[serde(skip_serializing_if = "Option::is_none")]
    tid: Option<String>,
}

impl RequestLine {
    /// A line for `path`, with the query and fragment stripped.
    pub fn new(path: &str, method: &str, status: u16, ms: u64) -> Result<RequestLine, LogError> {
        Ok(RequestLine {
            line_type: "request",
            route: Self::route_from_path(path)?,
            method: method.to_owned(),
            status,
            ms,
            ip_hash: None,
            country: None,
            continent: None,
            sandbox: None,
            reason: None,
            tid: None,
        })
    }

    /// Records a token's id, if it is one: 32 lower-case hex characters. Anything else, a token
    /// above all, leaves the field empty.
    pub fn token_id(&mut self, tid: &str) {
        self.tid = crate::auth::is_lower_hex(tid, 32).then(|| tid.to_owned());
    }

    /// The path with everything from the first `?` or `#` dropped. Refuses any control
    /// character, a line break above all, rather than escaping it.
    pub fn route_from_path(path: &str) -> Result<String, LogError> {
        let route = path.split(['?', '#']).next().unwrap_or_default();
        if path.chars().any(char::is_control) {
            return Err(LogError::ControlCharacter);
        }
        Ok(route.to_owned())
    }

    pub fn route(&self) -> &str {
        &self.route
    }

    /// One JSON object, `"type":"request"` first, no trailing newline.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("a log line serializes")
    }
}

/// `hex(HMAC-SHA256(daily salt, IP))`. The salt is 32 random bytes that `Control` holds in
/// memory for one UTC day and never stores, so yesterday's hashes cannot be recomputed.
pub fn ip_hash(daily_salt: &[u8], ip: &str) -> String {
    hex(&mac(daily_salt, ip.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANARY: &str = "canary-password-7f3k-do-not-log";

    #[test]
    fn a_token_id_is_logged_and_a_token_never() {
        let mut line = RequestLine::new("/v1/sandboxes/x/menu", "GET", 200, 3).unwrap();
        line.token_id("00112233445566778899aabbccddeeff");
        assert!(
            line.to_json()
                .ends_with(",\"tid\":\"00112233445566778899aabbccddeeff\"}")
        );
        line.token_id("eyJ2IjoxfQ.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmUtc2lnbmF0dXJl");
        assert!(!line.to_json().contains("tid"));
        assert!(!line.to_json().contains("eyJ"));
    }

    #[test]
    fn a_query_never_reaches_the_line() {
        let mut line = RequestLine::new(
            &format!("/v1/auth/google/callback?code=fake-code&state=s&password={CANARY}"),
            "GET",
            303,
            12,
        )
        .unwrap();
        line.reason = Some("state");
        let json = line.to_json();
        assert_eq!(line.route(), "/v1/auth/google/callback");
        for leak in ["?", "code", "fake-code", CANARY] {
            assert!(!json.contains(leak), "{json} holds {leak}");
        }
        assert!(
            json.starts_with(r#"{"type":"request","route":"/v1/auth/google/callback","#),
            "{json}"
        );
        assert!(json.contains(r#""reason":"state""#));
        assert!(RequestLine::route_from_path("/a#frag").unwrap() == "/a");
    }

    #[test]
    fn refuses_line_breaks() {
        for bad in [
            "/v1/x\n{\"type\":\"request\"}",
            "/v1/x\r",
            "/v1/x\u{0}",
            "/v1/x?q=\n",
        ] {
            assert_eq!(
                RequestLine::route_from_path(bad),
                Err(LogError::ControlCharacter)
            );
            assert!(RequestLine::new(bad, "GET", 200, 0).is_err());
        }
    }

    #[test]
    fn the_whole_shape() {
        let mut line = RequestLine::new("/v1/sandboxes", "POST", 201, 7).unwrap();
        line.ip_hash = Some(ip_hash(b"test-daily-salt-0123456789abcdef", "192.0.2.1"));
        line.country = Some("US".into());
        line.continent = Some("NA".into());
        line.sandbox = Some("01JC8Z6K3W9QF2N4T7XRB5M0HD".into());
        let value: serde_json::Value = serde_json::from_str(&line.to_json()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "type": "request", "route": "/v1/sandboxes", "method": "POST", "status": 201,
                "ms": 7, "ip_hash": line.ip_hash, "country": "US", "continent": "NA",
                "sandbox": "01JC8Z6K3W9QF2N4T7XRB5M0HD",
            })
        );
        assert!(!line.to_json().contains("192.0.2.1"));
        assert!(!line.to_json().contains('\n'));
    }

    #[test]
    fn ip_hashes_change_with_the_salt() {
        let a = ip_hash(b"test-daily-salt-0123456789abcdef", "192.0.2.1");
        let b = ip_hash(b"test-daily-salt-fedcba9876543210", "192.0.2.1");
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert_eq!(a, ip_hash(b"test-daily-salt-0123456789abcdef", "192.0.2.1"));
    }
}
