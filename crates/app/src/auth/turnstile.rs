//! Turnstile's siteverify call (docs/security.md, "Sandbox isolation"; Q24 · Q-guest).
//!
//! The visitor's IP is not sent: `remoteip` is optional, and leaving it out keeps the address
//! out of one more request. Locally the secret is Turnstile's documented always-pass test value.

use serde::Deserialize;

use super::encoding::form;

/// The `application/x-www-form-urlencoded` body for `POST .../turnstile/v0/siteverify`.
pub fn siteverify_body(secret: &str, token: &str) -> String {
    form(&[("secret", secret), ("response", token)])
}

/// The reply, read for its verdict and error codes. The hostname, action and timestamp beside
/// them are skipped.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SiteverifyResponse {
    pub success: bool,
    #[serde(default, rename = "error-codes")]
    pub error_codes: Vec<String>,
}

impl SiteverifyResponse {
    /// An unreadable reply is a failure, never a pass.
    pub fn parse(body: &str) -> SiteverifyResponse {
        serde_json::from_str(body).unwrap_or(SiteverifyResponse {
            success: false,
            error_codes: vec!["unparsable-response".to_owned()],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_has_no_remote_ip() {
        let body = siteverify_body("1x0000000000000000000000000000000AA", "tok+en/1");
        assert_eq!(
            body,
            "secret=1x0000000000000000000000000000000AA&response=tok%2Ben%2F1"
        );
        assert!(!body.contains("remoteip"));
    }

    #[test]
    fn reads_the_verdict() {
        let pass = SiteverifyResponse::parse(
            r#"{"success":true,"challenge_ts":"2026-11-05T12:00:00.000Z","hostname":"example.com",
                "error-codes":[],"action":"","cdata":""}"#,
        );
        assert!(pass.success);
        assert!(pass.error_codes.is_empty());

        let fail = SiteverifyResponse::parse(
            r#"{"success":false,"error-codes":["invalid-input-response"]}"#,
        );
        assert!(!fail.success);
        assert_eq!(fail.error_codes, ["invalid-input-response"]);

        assert!(!SiteverifyResponse::parse("<html>").success);
    }
}
