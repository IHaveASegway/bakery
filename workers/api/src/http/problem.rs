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

/// An object's refusal body: `{error, rule?, class?}`, codes only.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct Refused {
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub rule: Option<String>,
    #[serde(default)]
    pub class: Option<String>,
}

/// The sandbox is still being seeded: the console polls `GET /v1/sandboxes/{id}` until `live`.
pub fn seeding() -> Failure {
    Failure::typed(
        "seeding",
        503,
        "The sandbox is still being set up",
        "The sandbox is still being seeded with its menu and orders. Try again in a moment.",
    )
    .retry_after(Some(1))
}

/// A note refused by the free-text rules: the class it matched is named, the text never is.
fn note_detail(class: &str) -> String {
    let what = match class {
        "email" => "an email address",
        "phone" => "a phone number",
        "card-number" => "a card number",
        "url" => "a link",
        "too-long" => {
            return "The note is longer than 140 characters. The rule is note-too-long.".into();
        }
        _ => "something the bakery does not store",
    };
    format!(
        "The note looks like it holds {what}, which an order note may not. The rule is note-{class}."
    )
}

/// A broken order rule, named by its slug (`OrderError::rule()`), with a sentence for the
/// rules a visitor's cart can break.
pub fn order(rule: &str, class: Option<&str>) -> Failure {
    let detail = match (rule, class) {
        ("note", Some(class)) => note_detail(class),
        _ => {
            let sentence = match rule {
                "no-lines" => "An order needs at least one line.",
                "too-many-lines" => "An order holds at most 20 lines.",
                "qty-out-of-range" => "Each line is a quantity of 1 to 24.",
                "not-on-menu" => "A line names a variant that is not on the published menu.",
                "item-paused" => "A line names an item the bakery has paused.",
                "not-baked-that-day" => "A line names an item that is not baked on the slot's day.",
                "out-of-season" => "A line names an item that is out of season on the slot's day.",
                "pickup-only" => "A line names an item that is sold for pickup only.",
                "zone-required" => "A delivery needs a zone: z1, z2 or z3.",
                "zone-on-pickup" => "A pickup has no zone.",
                "lead-time" => "The slot is sooner than the longest lead time among the lines.",
                "slot" => "The slot is not a business time such as 2026-11-07T09:45:00-07:00.",
                "cancel-too-late" => "The order is in production or later and cannot be cancelled.",
                "refund-exceeds-paid" => "The refund is more than what is left of the payment.",
                "refund-not-positive" => "A refund is a positive number of cents.",
                "out-of-order" => "The order is not in a state that takes this command.",
                _ => "The order does not fit the bakery's rules.",
            };
            format!("{sentence} The rule is {rule}.")
        }
    };
    Failure {
        problem: Box::new(Problem::typed(
            "order",
            422,
            "The order was refused",
            detail,
        )),
        retry_after: None,
        reason: "order",
    }
}

/// The API's `STRIPE_SECRET_KEY` is not a sandbox key: no payment path calls Stripe with it
/// (ADR 0007, decision 2).
pub fn stripe_key() -> Failure {
    Failure::typed(
        "stripe-key",
        503,
        "Payments are switched off on this API",
        "The API's Stripe key is not a sandbox key, so it takes no payment and makes no refund. The rule is stripe-key.",
    )
}

/// Stripe refused the call, or could not be reached; the reason is Stripe's error code, in the
/// log line only.
pub fn stripe(retryable: bool) -> Failure {
    if retryable {
        Failure::typed(
            "stripe",
            503,
            "Stripe did not answer",
            "Stripe's sandbox could not be reached. Try again in a moment.",
        )
        .retry_after(Some(5))
    } else {
        Failure::typed(
            "stripe",
            502,
            "Stripe refused the request",
            "Stripe's sandbox refused the request. Nothing was charged or refunded.",
        )
    }
}

/// The order cannot be paid (or refunded) in its state, with the rule named.
pub fn order_conflict(rule: &str) -> Failure {
    let sentence = match rule {
        "not-payable" => {
            "Only an order waiting for payment can be paid: this one is paid, expired or cancelled."
        }
        "paid" => "This order is paid already.",
        "canceled" => "The order expired while Stripe answered, so its payment was cancelled.",
        "no-stripe-payment" => {
            "This order was not paid through Stripe (the seed made it paid), so there is nothing to refund there."
        }
        _ => "The order is not in a state that takes this request.",
    };
    Failure {
        problem: Box::new(Problem::typed(
            "order",
            409,
            "The order cannot do that now",
            format!("{sentence} The rule is {rule}."),
        )),
        retry_after: None,
        reason: "order",
    }
}

/// A webhook refused before it reached an object: 400, the reason code its type and its log.
pub fn webhook(reason: &'static str) -> Failure {
    let detail = match reason {
        "signature" => {
            "The Stripe-Signature header is missing or no v1 signature matches the body."
        }
        "timestamp" => "The signature's timestamp is more than five minutes from now.",
        "livemode" => "The event is not a test-mode event; this API takes only Stripe's sandbox.",
        _ => "The signed body is not a Stripe event this API reads.",
    };
    Failure::typed(reason, 400, "The webhook was refused", detail)
}

/// A webhook Billing cannot apply yet, such as a refund before its payment: Stripe delivers it
/// again later.
pub fn webhook_later() -> Failure {
    Failure::typed(
        "webhook-later",
        409,
        "The webhook cannot be applied yet",
        "Billing does not know this event's payment yet. Stripe will deliver it again.",
    )
}

/// The kitchen socket's path without `Upgrade: websocket`.
pub fn upgrade() -> Failure {
    Failure::typed(
        "upgrade",
        426,
        "This path is a WebSocket",
        "Open it with a WebSocket client, which sends Upgrade: websocket.",
    )
}

/// A rate the Simulator does not run at.
pub fn traffic(rule: &str) -> Failure {
    let detail = match rule {
        "rate" => "Simulated traffic runs at 1 to 6 orders a minute. The rule is rate.".to_owned(),
        _ => format!("The traffic request was refused. The rule is {rule}."),
    };
    Failure {
        problem: Box::new(Problem::typed(
            "traffic",
            422,
            "That traffic rate is not offered",
            detail,
        )),
        retry_after: None,
        reason: "traffic",
    }
}

/// "Start traffic" while it runs.
pub fn traffic_running() -> Failure {
    Failure::typed(
        "traffic-running",
        409,
        "Traffic is already running",
        "Stop the traffic first to start it at another rate.",
    )
}

/// The sandbox spent today's minutes of simulated traffic, with `Retry-After` to 00:00 UTC.
pub fn traffic_cap(retry_after: u32, cap: u16) -> Failure {
    Failure::typed(
        "traffic-cap",
        503,
        "Today's simulated traffic is spent",
        &format!(
            "A sandbox runs at most {cap} minutes of simulated traffic a UTC day. Try after 00:00 UTC."
        ),
    )
    .retry_after(Some(retry_after))
}

/// A broken menu rule (`CatalogError::rule()`).
pub fn menu(rule: &str) -> Failure {
    let sentence = match rule {
        "nothing-to-publish" => "There are no draft changes to publish.",
        "price-not-positive" => "A price is a positive number of cents.",
        "out-of-order" => "The item is not in a state that change applies to.",
        "retired" => "The item is retired.",
        "empty-patch" => "Send a price_cents, a status, or both.",
        _ => "The change does not fit the menu's rules.",
    };
    Failure {
        problem: Box::new(Problem::typed(
            "menu",
            422,
            "The menu change was refused",
            format!("{sentence} The rule is {rule}."),
        )),
        retry_after: None,
        reason: "menu",
    }
}

/// A refused clock advance.
pub fn clock(rule: &str) -> Failure {
    let sentence = match rule {
        "too-far" => "Business time moves at most 14 days ahead in all, and only forward.",
        _ => "Advance the clock by a positive number of minutes.",
    };
    Failure {
        problem: Box::new(Problem::typed(
            "clock",
            422,
            "The clock cannot move that far",
            format!("{sentence} The rule is {rule}."),
        )),
        retry_after: None,
        reason: "clock",
    }
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
    fn a_refused_note_names_its_class_never_its_text() {
        let f = order("note", Some("phone"));
        assert_eq!(f.problem.status, 422);
        assert_eq!(
            f.problem.problem_type,
            "https://bakery.ihaveasegway.com/problems/order"
        );
        let detail = f.problem.detail.unwrap();
        assert!(detail.contains("note-phone") && detail.contains("phone number"));
        assert!(
            order("lead-time", None)
                .problem
                .detail
                .unwrap()
                .contains("The rule is lead-time.")
        );
        assert_eq!(seeding().retry_after, Some(1));
    }

    #[test]
    fn payment_refusals_name_their_slugs() {
        assert_eq!(stripe_key().problem.status, 503);
        assert_eq!(stripe_key().reason, "stripe-key");
        assert_eq!(stripe(true).retry_after, Some(5));
        assert_eq!(stripe(false).problem.status, 502);
        let f = order_conflict("not-payable");
        assert_eq!(
            (f.problem.status, f.problem.problem_type.as_str()),
            (409, "https://bakery.ihaveasegway.com/problems/order")
        );
        for reason in ["signature", "timestamp", "body", "livemode"] {
            let f = webhook(reason);
            assert_eq!(f.problem.status, 400);
            assert_eq!(f.reason, reason);
            assert!(f.problem.problem_type.ends_with(reason));
        }
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
            seeding(),
            order("too-many-lines", None),
            order("note", Some("email")),
            order("note", Some("too-long")),
            order("something-new", None),
            menu("nothing-to-publish"),
            clock("too-far"),
            stripe_key(),
            stripe(true),
            stripe(false),
            order_conflict("not-payable"),
            order_conflict("no-stripe-payment"),
            order("refund-exceeds-paid", None),
            webhook("signature"),
            webhook("timestamp"),
            webhook("body"),
            webhook("livemode"),
            webhook_later(),
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
