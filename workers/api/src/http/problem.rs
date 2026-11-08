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

/// The per-token limit, `TOKEN_LIMIT`, spent by every request a token makes.
pub fn token_rate_limit() -> Failure {
    Failure::typed(
        "rate-limit",
        429,
        "Slow down",
        "Too many requests with this API token in the last minute. Try again after the time in Retry-After.",
    )
    .retry_after(Some(60))
    .because("token-limit")
}

/// A refused API token (docs/security.md, "The API token"): 400 for a request that carries one
/// the wrong way, 401 for one that is not good here. `detail` names the rule as a whole word and
/// never the token.
pub fn token(reason: &'static str, status: u16) -> Failure {
    let (title, sentence) = match reason {
        "query" => (
            "The API token was sent the wrong way",
            "An API token goes in the Authorization header as a Bearer token, never in the URL.",
        ),
        "both" => (
            "The API token was sent the wrong way",
            "Send the session cookie or an API token, not both.",
        ),
        "expired" => (
            "The API token was refused",
            "This API token is more than 24 hours old. Issue a new one from the console.",
        ),
        "rotated" => (
            "The API token was refused",
            "This API token was rotated. Use the newest token from the console.",
        ),
        "purpose" => (
            "The API token was refused",
            "That is not an API token. Use the token the console issued.",
        ),
        "cookie-only" => (
            "The API token was refused",
            "This route takes the session cookie, never an API token: the session, sign-out, the kitchen socket, and issuing or rotating a token.",
        ),
        _ => (
            "The API token was refused",
            "The Authorization header does not hold an API token this API issued.",
        ),
    };
    Failure {
        problem: Box::new(Problem::typed(
            "token",
            status,
            title,
            format!("{sentence} The rule is {reason}."),
        )),
        retry_after: None,
        reason,
    }
}

pub fn token_error(e: bakery_app::auth::TokenError) -> Failure {
    token(e.reason(), e.status())
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
    /// A lead time's sentence, naming the hours (the menu's item name and the rule's numbers).
    #[serde(default)]
    pub message: Option<String>,
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

/// A refused clock advance: the domain's `offset-cap` or `not-positive`, the latter also for a
/// request with both `step` and `minutes`, or neither.
pub fn clock(rule: &str) -> Failure {
    let sentence = match rule {
        "offset-cap" | "too-far" => {
            "Business time moves at most 14 days ahead in all, and only forward."
        }
        _ => {
            "Advance the clock by one step (15m, 1h, 1d or next-opening) or a positive number of minutes, not both."
        }
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

/// An order whose slot is sooner than its longest lead time: 409, with the sentence naming the
/// hours, such as "Chocolate layer cake needs 48 h; the slot is 25 h away".
pub fn lead_time(message: Option<&str>) -> Failure {
    let sentence = message
        .map(|m| format!("{m}."))
        .unwrap_or_else(|| "The slot is sooner than the longest lead time among the lines.".into());
    Failure {
        problem: Box::new(Problem::typed(
            "lead-time",
            409,
            "That time is too soon for this order",
            format!("{sentence} Choose a later day or time. The rule is lead-time."),
        )),
        retry_after: None,
        reason: "lead-time",
    }
}

/// A Schedule rule a hold or a capacity change broke, by its slug
/// (`ScheduleError::rule()`): 409 for a full slot (with `next_free`, RFC 9457 section 3.2), an
/// item over its cap, or a retried placement whose place was given back and is taken now
/// (`hold-lost`, with `next_free` as `slot-full` has it); 422 for a time or a target the day
/// does not have, an item target among them (`unknown-item`).
pub fn schedule(
    rule: &str,
    next_free: Option<&str>,
    item: Option<&str>,
    free: Option<u32>,
) -> Failure {
    let (slug, status, title, detail): (&'static str, u16, &str, String) = match rule {
        "slot-full" => (
            "slot-full",
            409,
            "That time is full",
            match next_free {
                Some(t) => format!("That time is full; the next free start that day is {t}."),
                None => "That time is full, and nothing later that day is free.".into(),
            },
        ),
        "item-cap" => (
            "item-cap",
            409,
            "The kitchen cannot make that many that day",
            match (item, free) {
                (Some(i), Some(0)) => format!("No more {i} can be made that day."),
                (Some(i), Some(n)) => format!("Only {n} more {i} can be made that day."),
                _ => "An item in the order is over its daily cap that day.".into(),
            },
        ),
        "hold-lost" => (
            "hold-lost",
            409,
            "The place this order held was given back",
            match next_free {
                Some(t) => format!("The place this order held was given back before the order was placed, and that time is full now; the next free start that day is {t}."),
                None => "The place this order held was given back before the order was placed, and there is no room for it now.".into(),
            },
        ),
        "no-such-slot" => (
            "no-such-slot",
            422,
            "That is not a time the bakery takes orders for",
            "Pickup slots start every 15 minutes from 07:00 to 14:45 and delivery windows at 09:00, 11:00 and 13:00, on days from the sandbox's first to 30 days ahead.".into(),
        ),
        "closed-day" => (
            "closed-day",
            422,
            "The bakery is closed that day",
            "The bakery opens Tuesday to Sunday.".into(),
        ),
        "unknown-zone" => (
            "unknown-zone",
            422,
            "That is not a delivery zone",
            "The bakery delivers to zones z1, z2 and z3.".into(),
        ),
        "zone-required" => (
            "zone-required",
            422,
            "A delivery needs a zone",
            "A delivery needs a zone: z1, z2 or z3.".into(),
        ),
        "bad-target" => (
            "bad-target",
            422,
            "That is not a capacity target",
            "A target is slot:HH:MM (a pickup slot start), zone:z1 to zone:z3, item:<slug> or catering.".into(),
        ),
        "unknown-item" => (
            "unknown-item",
            422,
            "That item is not on the day's menu",
            "An item:<slug> target names an item of the published menu, by its slug.".into(),
        ),
        "ref-held" => (
            "ref-held",
            409,
            "This order holds another place already",
            "The order already holds a different time.".into(),
        ),
        _ => (
            "schedule",
            422,
            "The schedule refused the change",
            "The change does not fit the day's schedule.".into(),
        ),
    };
    let mut problem = Problem::typed(slug, status, title, format!("{detail} The rule is {slug}."));
    if slug == "slot-full" || slug == "hold-lost" {
        problem.next_free = next_free.map(str::to_owned);
    }
    Failure {
        problem: Box::new(problem),
        retry_after: None,
        reason: slug,
    }
}

/// A refused catering inquiry (422) or step (409), by its slug (`CateringError::rule()`). The
/// detail names the rule as a whole word, `The rule is <slug>.`, and never a value the visitor
/// sent: a brief's refusal names the class it matched, never the text; `catering-lead` carries
/// the domain's sentence, which names the 7-business-day rule and the earliest date.
pub fn catering(status: u16, rule: &str, message: Option<&str>) -> Failure {
    let sentence = match rule {
        "headcount" => "A catering event is for 10 to 200 people.".to_owned(),
        "unknown-package" => "The package is not one of pastry-platter, breakfast-spread, lunch-boxes or celebration-cake-and-coffee.".to_owned(),
        "unknown-venue" => "The venue is not one of v1 to v6.".to_owned(),
        "closed-day" => "The bakery is closed that day: it opens Tuesday to Sunday.".to_owned(),
        "catering-lead" => match message {
            Some(m) => sentence_of(m),
            None => "A catering event needs 7 business days' notice (Tuesday to Sunday).".to_owned(),
        },
        "too-early" => match message {
            Some(m) => sentence_of(m),
            None => "Production starts the day before the event, and delivery is on the event day.".to_owned(),
        },
        "brief-too-long" => "The brief is longer than 500 characters.".to_owned(),
        "brief-email" => brief_sentence("an email address"),
        "brief-phone" => brief_sentence("a phone number"),
        "brief-card-number" => brief_sentence("a card number"),
        "brief-url" => brief_sentence("a web address"),
        "quote-total" => "A quote's total is at least 1 cent.".to_owned(),
        "date" => "The date is not a day such as 2026-11-21.".to_owned(),
        "quote-expired" => "The quote expired: its 14 business days have passed, or the day before the event has begun. Ask for a new inquiry.".to_owned(),
        "out-of-order" => "The catering event is not in a state that takes this step.".to_owned(),
        "amount-mismatch" => "The payment is not the amount the quote asks for.".to_owned(),
        _ => "The catering request does not fit the bakery's rules.".to_owned(),
    };
    let title = if status == 422 {
        "The catering inquiry was refused"
    } else {
        "The catering event cannot do that now"
    };
    Failure {
        problem: Box::new(Problem::typed(
            "catering",
            status,
            title,
            format!("{sentence} The rule is {rule}."),
        )),
        retry_after: None,
        reason: "catering",
    }
}

/// The domain's clause as a sentence: a capital first letter and a full stop.
fn sentence_of(m: &str) -> String {
    let mut chars = m.chars();
    let first = chars.next().map(|c| c.to_uppercase().collect::<String>());
    format!("{}{}.", first.unwrap_or_default(), chars.as_str())
}

fn brief_sentence(what: &str) -> String {
    format!(
        "The brief looks like it holds {what}, which the bakery does not keep: describe the event without it."
    )
}

/// A refused campaign command, by its slug (`CampaignError::rule()`): 422 for
/// `schedule-too-soon`, its detail naming the earliest allowed `send_at` as an ISO business time
/// the page can put back in its picker; 409 for the rest, `out-of-order` naming the state
/// machine. The detail names the rule as a whole word, `The rule is <slug>.`
pub fn campaign(status: u16, rule: &str, earliest: Option<&str>) -> Failure {
    let sentence = match rule {
        "schedule-too-soon" => match earliest {
            Some(t) => format!(
                "A campaign is scheduled at least 15 minutes of business time ahead: the earliest allowed is {t}."
            ),
            None => "A campaign is scheduled at least 15 minutes of business time ahead.".to_owned(),
        },
        "out-of-order" => "The campaign is not in a state that takes this step: only a draft is edited or scheduled, and a sent campaign stays sent.".to_owned(),
        "campaign-exists" => "A campaign with this id exists with other content. Send a new Idempotency-Key for a new campaign.".to_owned(),
        "not-due" => "The campaign is not due yet.".to_owned(),
        "audience" => "The audience is not the campaign's segment.".to_owned(),
        _ => "The campaign request does not fit the bakery's rules.".to_owned(),
    };
    let title = if status == 422 {
        "The campaign cannot be scheduled then"
    } else {
        "The campaign cannot do that now"
    };
    Failure {
        problem: Box::new(Problem::typed(
            "campaign",
            status,
            title,
            format!("{sentence} The rule is {rule}."),
        )),
        retry_after: None,
        reason: "campaign",
    }
}

/// "Rebuild projections" while one runs: nothing new starts; the page follows the running one.
pub fn rebuild_running() -> Failure {
    Failure::typed(
        "rebuild",
        409,
        "A rebuild is already running",
        "Crm's projections are being rebuilt from its log. Follow its progress; a new rebuild can start once it has finished. The rule is rebuild.",
    )
}

/// An inbox filter that names no message kind, or a `to` that is no ULID.
pub fn inbox_filter() -> Failure {
    Failure::typed(
        "filter",
        400,
        "The inbox filter could not be read",
        "kind is one of receipt, ready, on_its_way, refund, declined, acknowledgement, quote, notice, reminder, invoice or campaign; to is a customer's ULID; limit is 1 to 500.",
    )
}

/// An acceptance on a day whose two catering places are taken: 409 `slot-full`, nothing
/// recorded.
pub fn catering_full() -> Failure {
    Failure::typed(
        "slot-full",
        409,
        "That day is fully booked for catering",
        "That day's two catering places are taken, so the quote cannot be accepted for it. The rule is slot-full.",
    )
}

/// A day with no `Schedule`: before the sandbox's birth day, more than 30 days after business
/// today, or not a date.
pub fn no_such_day() -> Failure {
    Failure::typed(
        "no-such-day",
        404,
        "No schedule for that day",
        "A day's schedule exists from the sandbox's first day to 30 days after today, as YYYY-MM-DD.",
    )
}

/// A day with no `Dispatch`: the same days as a schedule's (PR 9).
pub fn no_such_dispatch_day() -> Failure {
    Failure::typed(
        "no-such-day",
        404,
        "No dispatch for that day",
        "A day's dispatch exists from the sandbox's first day to 30 days after today, as YYYY-MM-DD.",
    )
}

/// A refused dispatch command, by its slug (`DispatchError::rule()`): 422 for a request that
/// breaks a rule as sent, 409 for what the day's state blocks (the router's `Step::status`). The
/// detail names the rule as a whole word, `The rule is <slug>.`, and never a value the visitor
/// sent: not an order id, not a van's units.
pub fn dispatch(status: u16, rule: &str) -> Failure {
    let sentence = match rule {
        "vans" => {
            "A day plans with 1 to 4 vans, and a plan names each van once, numbered from 1 to the day's vans."
        }
        "capacity" => "A van carries at least 1 unit.",
        "no-stops" => "The day has no confirmed stops to plan.",
        "place-unknown" => "A stop's place is not in the travel-time matrix.",
        "route-ends" => "Every van starts and ends at the bakery.",
        "stop-unknown" => {
            "The plan names a stop that is not a confirmed stop of this day, or the published plan has no such stop number."
        }
        "stop-twice" => "The plan lists a stop more than once.",
        "over-capacity" => "A van in the plan carries more units than its capacity.",
        "stop-missing" => "The plan leaves out a confirmed stop of this day.",
        "no-plan" => {
            "There is no such plan yet: propose, or plan in the browser, before publishing, and publish before completing a stop."
        }
        "published" => {
            "A van has already left on the published plan, so it is not replaced. Stops can still be completed."
        }
        "wrong-day" => "The stop's window is not on this day.",
        _ => "The dispatch request does not fit the bakery's rules.",
    };
    let title = if status == 422 {
        "The plan was refused"
    } else {
        "Dispatch cannot do that now"
    };
    Failure {
        problem: Box::new(Problem::typed(
            "dispatch",
            status,
            title,
            format!("{sentence} The rule is {rule}."),
        )),
        retry_after: None,
        reason: "dispatch",
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
    fn a_dispatch_refusal_names_its_rule_as_a_whole_word() {
        use bakery_domain::dispatch::DispatchError;
        let o = bakery_domain::Ulid::from_parts(1, 1);
        for e in [
            DispatchError::StopMissing { order: o },
            DispatchError::StopTwice { order: o },
            DispatchError::StopUnknown { order: o },
            DispatchError::NoSuchStop { stop: 4 },
            DispatchError::OverCapacity {
                van: 1,
                units: 9,
                capacity: 5,
            },
            DispatchError::RouteEnds { van: 1 },
            DispatchError::NoPlan,
            DispatchError::NoStops,
            DispatchError::Vans { van: 5, vans: 4 },
            DispatchError::Capacity,
            DispatchError::WrongDay,
            DispatchError::PlaceUnknown {
                order: o,
                place: 70,
            },
            DispatchError::Published,
        ] {
            for status in [409, 422] {
                let f = dispatch(status, e.rule());
                let detail = f.problem.detail.clone().unwrap();
                assert_eq!(f.problem.status, status);
                assert_eq!(
                    f.problem.problem_type,
                    "https://bakery.ihaveasegway.com/problems/dispatch"
                );
                assert!(
                    detail.ends_with(&format!(" The rule is {}.", e.rule())),
                    "{detail}"
                );
                // A sentence for every rule, and none of the request's values.
                assert!(!detail.starts_with("The dispatch request"), "{detail}");
                assert!(!detail.contains(&o.to_string()), "{detail}");
            }
        }
        assert_eq!(dispatch(422, "x").problem.title, "The plan was refused");
        assert_eq!(no_such_dispatch_day().problem.status, 404);
    }

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
    fn schedule_refusals_name_their_rule_and_the_next_free_start() {
        let full = schedule("slot-full", Some("2026-11-07T10:15:00-07:00"), None, None);
        assert_eq!(full.problem.status, 409);
        assert!(full.problem.problem_type.ends_with("/slot-full"));
        assert_eq!(
            full.problem.next_free.as_deref(),
            Some("2026-11-07T10:15:00-07:00")
        );
        assert!(full.problem.detail.unwrap().contains("10:15:00"));
        let cap = schedule("item-cap", None, Some("croissant"), Some(2));
        assert_eq!(cap.problem.status, 409);
        assert!(cap.problem.next_free.is_none());
        let lost = schedule("hold-lost", Some("2026-11-07T10:15:00-07:00"), None, None);
        assert_eq!(lost.problem.status, 409);
        assert!(lost.problem.problem_type.ends_with("/hold-lost"));
        assert_eq!(
            lost.problem.next_free.as_deref(),
            Some("2026-11-07T10:15:00-07:00")
        );
        let detail = lost.problem.detail.unwrap();
        assert!(detail.contains("given back") && detail.contains("10:15:00"));
        assert!(detail.ends_with("The rule is hold-lost."));
        let none = schedule("hold-lost", None, None, None);
        assert!(none.problem.next_free.is_none());
        assert_eq!(schedule("closed-day", None, None, None).problem.status, 422);
        assert_eq!(
            schedule("bad-target", None, None, None).reason,
            "bad-target"
        );
        let unknown = schedule("unknown-item", None, None, None);
        assert_eq!(
            (unknown.problem.status, unknown.reason),
            (422, "unknown-item")
        );
        assert!(unknown.problem.problem_type.ends_with("/unknown-item"));
        assert!(
            unknown
                .problem
                .detail
                .unwrap()
                .ends_with("The rule is unknown-item.")
        );
        let lead = lead_time(Some(
            "Chocolate layer cake needs 48 h; the slot is 25 h away",
        ));
        assert_eq!(lead.problem.status, 409);
        assert!(lead.problem.detail.unwrap().contains("48 h"));
        assert!(
            clock("offset-cap")
                .problem
                .detail
                .unwrap()
                .contains("offset-cap")
        );
    }

    #[test]
    fn catering_refusals_name_their_rule_as_a_word_and_never_the_brief() {
        for rule in [
            "headcount",
            "unknown-package",
            "unknown-venue",
            "closed-day",
            "catering-lead",
            "brief-too-long",
            "brief-email",
            "brief-phone",
            "brief-card-number",
            "brief-url",
            "quote-total",
        ] {
            let f = catering(422, rule, None);
            assert_eq!(f.problem.status, 422);
            assert!(f.problem.problem_type.ends_with("/catering"));
            assert!(
                f.problem
                    .detail
                    .unwrap()
                    .ends_with(&format!(" The rule is {rule}.")),
                "{rule}"
            );
        }
        let lead = catering(
            422,
            "catering-lead",
            Some(
                "a catering event needs 7 business days' notice (Tuesday to Sunday); the earliest date is 2026-11-17",
            ),
        );
        let detail = lead.problem.detail.unwrap();
        assert!(detail.starts_with("A catering event needs 7 business days"));
        assert!(detail.contains("2026-11-17") && detail.contains("catering-lead"));
        let step = catering(409, "quote-expired", None);
        assert_eq!(step.problem.status, 409);
        assert!(step.problem.detail.unwrap().contains("quote-expired"));
        let early = catering(
            409,
            "too-early",
            Some("production starts the day before the event: 2026-11-18 at the earliest"),
        );
        assert_eq!(early.problem.status, 409);
        assert_eq!(
            early.problem.detail.unwrap(),
            "Production starts the day before the event: 2026-11-18 at the earliest. The rule is too-early."
        );
        assert!(
            catering(409, "too-early", None)
                .problem
                .detail
                .unwrap()
                .ends_with(" The rule is too-early.")
        );
        let full = catering_full();
        assert_eq!(full.problem.status, 409);
        assert!(full.problem.problem_type.ends_with("/slot-full"));
        assert!(full.problem.detail.unwrap().contains("two catering places"));
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
            clock("offset-cap"),
            clock("not-positive"),
            lead_time(Some(
                "Chocolate layer cake needs 48 h; the slot is 25 h away",
            )),
            lead_time(None),
            schedule("slot-full", Some("2026-11-07T10:15:00-07:00"), None, None),
            schedule("slot-full", None, None, None),
            schedule("item-cap", None, Some("croissant"), Some(2)),
            schedule("hold-lost", Some("2026-11-07T10:15:00-07:00"), None, None),
            schedule("hold-lost", None, None, None),
            schedule("no-such-slot", None, None, None),
            schedule("closed-day", None, None, None),
            schedule("bad-target", None, None, None),
            schedule("unknown-item", None, None, None),
            schedule("something-new", None, None, None),
            no_such_day(),
            stripe_key(),
            stripe(true),
            stripe(false),
            order_conflict("not-payable"),
            order_conflict("no-stripe-payment"),
            catering(422, "brief-email", None),
            catering(
                422,
                "catering-lead",
                Some(
                    "a catering event needs 7 business days' notice (Tuesday to Sunday); the earliest date is 2026-11-17",
                ),
            ),
            catering(409, "out-of-order", None),
            catering(409, "something-new", None),
            catering_full(),
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
