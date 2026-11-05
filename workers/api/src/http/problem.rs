//! Every refusal the API gives, as problem+json (RFC 9457). The storefront shows `title` and
//! `detail` verbatim, so both are sentences a visitor can act on, and neither ever carries a
//! value from the request.

use bakery_app::admission::Refusal;
use bakery_contracts::Problem;
use worker::{Response, Result};

use super::headers::BodyKind;
use crate::config::ConfigError;

/// A refusal on its way out: the problem, `Retry-After` if it has one, and the reason code the
/// request's log line carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    /// Boxed so a `Result` carrying a refusal stays small.
    pub problem: Box<Problem>,
    pub retry_after: Option<u32>,
    pub reason: &'static str,
}

impl Failure {
    pub fn typed(slug: &'static str, status: u16, title: &str, detail: &str) -> Failure {
        Failure {
            problem: Box::new(Problem::typed(slug, status, title, detail)),
            retry_after: None,
            reason: slug,
        }
    }

    pub fn plain(status: u16, title: &str, reason: &'static str) -> Failure {
        Failure {
            problem: Box::new(Problem::status(status, title)),
            retry_after: None,
            reason,
        }
    }

    pub fn retry_after(mut self, seconds: Option<u32>) -> Failure {
        self.retry_after = seconds;
        self
    }

    /// A different reason for the log than the slug, such as `no-origin` for `origin`.
    pub fn because(mut self, reason: &'static str) -> Failure {
        self.reason = reason;
        self
    }

    pub fn into_response(self, instance: &str) -> Result<Response> {
        let status = self.problem.status;
        let mut res =
            Response::from_json(&self.problem.with_instance(instance))?.with_status(status);
        res.headers_mut()
            .set("Content-Type", BodyKind::Problem.content_type())?;
        if let Some(s) = self.retry_after {
            res.headers_mut().set("Retry-After", &s.to_string())?;
        }
        Ok(res)
    }
}

/// A platform error, answered with nothing but the status. Its text is logged only for the
/// Worker's own messages and the runtime's: a parser's message can quote the input it choked
/// on, and that input can be a body.
impl From<worker::Error> for Failure {
    fn from(e: worker::Error) -> Failure {
        let text = match &e {
            worker::Error::RustError(m) | worker::Error::JsError(m) => m.as_str(),
            worker::Error::UnknownJsError { message, .. } => message.as_str(),
            _ => "other",
        };
        worker::console_error!("{{\"event\":\"route_error\",\"error\":{text:?}}}");
        internal()
    }
}

impl From<ConfigError> for Failure {
    fn from(e: ConfigError) -> Failure {
        Failure::typed("config", 503, "The API is not configured", &e.detail()).because("config")
    }
}

pub fn internal() -> Failure {
    Failure::plain(500, "Internal Server Error", "internal")
}

pub fn not_found() -> Failure {
    Failure::plain(404, "Not Found", "not-found")
}

pub fn origin() -> Failure {
    Failure::typed(
        "origin",
        403,
        "Request refused",
        "This API accepts changes only from the bakery's own pages.",
    )
}

pub fn idempotency_key() -> Failure {
    Failure::typed(
        "idempotency-key",
        400,
        "An Idempotency-Key is needed",
        "Every POST needs an Idempotency-Key header holding a ULID, such as 01JC8Z6K3W9QF2N4T7XRB5M0HD.",
    )
}

pub fn idempotency_reused() -> Failure {
    Failure::typed(
        "idempotency-key",
        422,
        "This Idempotency-Key was already used",
        "This Idempotency-Key was used for a different request. Send a new key with each new request.",
    )
    .because("key-reused")
}

pub fn body() -> Failure {
    Failure::typed(
        "body",
        400,
        "The request body could not be read",
        "The request body is not the JSON this route expects.",
    )
}

pub fn session() -> Failure {
    Failure::typed(
        "session",
        401,
        "You are not signed in",
        "There is no session, or it has ended. Sign in, or start as a guest.",
    )
}

pub fn credentials() -> Failure {
    Failure::typed(
        "credentials",
        401,
        "Wrong username or password",
        "That username and password do not match a demo account.",
    )
}

pub fn locked(retry_after: u32) -> Failure {
    Failure::typed(
        "locked",
        429,
        "Too many wrong passwords",
        "After 10 wrong passwords in 15 minutes a demo account waits 15 minutes. Try again after the time in Retry-After.",
    )
    .retry_after(Some(retry_after))
}

pub fn turnstile() -> Failure {
    Failure::typed(
        "turnstile",
        403,
        "The human check did not pass",
        "The Turnstile check failed or expired. Reload the page and try again.",
    )
}

pub fn password() -> Failure {
    Failure::typed(
        "password",
        422,
        "That password does not fit",
        "A password needs 12 to 128 characters. Any characters will do.",
    )
}

pub fn rate_limit() -> Failure {
    Failure::typed(
        "rate-limit",
        429,
        "Slow down",
        "Too many requests from here in the last minute. Try again in a minute.",
    )
    .retry_after(Some(60))
}

pub fn wiped() -> Failure {
    Failure::typed(
        "wiped",
        410,
        "This sandbox was wiped",
        "Every sandbox is wiped at 10:00 UTC, or sooner with Wipe now. Start a new one from the console.",
    )
}

/// The rule, named, as docs/architecture.md "Creating a sandbox" states it.
pub fn guest_scope() -> Failure {
    Failure::typed(
        "guest-scope",
        403,
        "Sign in to change the sandbox",
        "Guests browse, order and pay. Sign in to use the console's writes (Q45 · Q-guest-scope).",
    )
}

/// A cap or the flag, with `Retry-After` to the next 00:00 UTC for a cap.
pub fn refusal(r: Refusal, retry_after: Option<u32>, account_cap: u32) -> Failure {
    let f = match r {
        Refusal::Off => Failure::typed(
            "off",
            503,
            "The demo is switched off",
            "The demo is off for now. The storefront's pages still work.",
        ),
        Refusal::ReadOnly => Failure::typed(
            "read-only",
            503,
            "The demo is read-only",
            "The demo is read-only for now: sandboxes can be looked at, not created.",
        ),
        Refusal::SandboxCap => Failure::typed(
            "sandbox-cap",
            503,
            "No sandboxes left today",
            "Today's sandboxes are all taken. New ones open at 00:00 UTC.",
        ),
        Refusal::GuestCap => Failure::typed(
            "guest-cap",
            503,
            "No guest sandboxes left today",
            "Guests have used today's share of sandboxes. Sign in for one of your own, or come back after 00:00 UTC.",
        ),
        Refusal::DemoCap => Failure::typed(
            "demo-cap",
            503,
            "No demo accounts left today",
            "Today's demo accounts are all taken. Sign in with Google or GitHub, or come back after 00:00 UTC.",
        ),
        Refusal::AccountSandboxCap => Failure {
            problem: Box::new(Problem::typed(
                "account-sandbox-cap",
                429,
                "No more sandboxes for this account today",
                format!(
                    "An account can create {account_cap} sandbox{} a UTC day. New ones open at 00:00 UTC.",
                    if account_cap == 1 { "" } else { "es" }
                ),
            )),
            retry_after: None,
            reason: "account-sandbox-cap",
        },
    };
    f.retry_after(retry_after)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_refusal_maps_to_its_slug_and_status() {
        for r in [
            Refusal::Off,
            Refusal::ReadOnly,
            Refusal::SandboxCap,
            Refusal::GuestCap,
            Refusal::DemoCap,
            Refusal::AccountSandboxCap,
        ] {
            let f = refusal(r, Some(5), 3);
            assert_eq!(f.problem.status, r.status());
            assert_eq!(
                f.problem.problem_type,
                format!("https://bakery.ihaveasegway.com/problems/{}", r.slug())
            );
            assert_eq!(f.reason, r.slug());
            assert_eq!(f.retry_after, Some(5));
        }
        assert!(
            refusal(Refusal::AccountSandboxCap, None, 1)
                .problem
                .detail
                .unwrap()
                .contains("1 sandbox a UTC day")
        );
    }

    #[test]
    fn the_guest_rule_is_named() {
        let f = guest_scope();
        assert_eq!(f.problem.status, 403);
        assert!(f.problem.detail.unwrap().contains("Q45 · Q-guest-scope"));
    }

    #[test]
    fn problems_carry_sentences_and_no_request_values() {
        for f in [
            origin(),
            idempotency_key(),
            idempotency_reused(),
            body(),
            session(),
            credentials(),
            locked(30),
            turnstile(),
            password(),
            rate_limit(),
            wiped(),
            guest_scope(),
            Failure::from(ConfigError::Missing("TURNSTILE_SECRET")),
        ] {
            let detail = f.problem.detail.clone().unwrap();
            assert!(detail.ends_with('.') || detail.ends_with(')'), "{detail}");
            assert!(!f.problem.title.is_empty());
        }
        assert_eq!(locked(30).retry_after, Some(30));
        assert_eq!(rate_limit().retry_after, Some(60));
        let config = Failure::from(ConfigError::Missing("TURNSTILE_SECRET"));
        assert_eq!(config.problem.status, 503);
        assert!(config.problem.detail.unwrap().contains("TURNSTILE_SECRET"));
    }
}
