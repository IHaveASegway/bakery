//! The route table as data: every route the API answers, with its session rule, its
//! `Idempotency-Key`, the contract types it reads and writes, and the answers it can give. The
//! OpenAPI document (`openapi.rs`) is built from it; the Worker's own table
//! (`workers/api/src/http/routes.rs`) holds the method, pattern, scope and rate limit it routes
//! by, and the tests below hold the two in agreement, and this table in agreement with the
//! Worker's README, whose routes table is the doc of record for statuses and problem slugs.
//!
//! A route's [`RouteSpec::answers`] are the ones particular to it, as the README writes them.
//! The answers every route of a kind shares (401 `session` for a route that needs a session,
//! 403 `guest-scope` for a signed-in one, 403 `origin` for a command, 400 and 422
//! `idempotency-key` for a POST and the rest) are derived once by [`answers`], so the table does
//! not repeat them 70 times and cannot forget one.

/// Who may call a route, and with what.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Session {
    /// Anyone. A session, if present, is read but not required.
    Public,
    /// Any valid session, a guest's included, whatever sandbox it names.
    Any,
    /// A session whose sandbox is the path's `{id}`, a guest's included: another id gets the
    /// 404 of an id naming nothing.
    Sandbox,
    /// A signed-in session whose sandbox is the path's `{id}`: a guest gets 403 `guest-scope`.
    SignedIn,
    /// The cookie only, never a bearer token, with the exact `Origin`: the kitchen socket.
    Cookie,
    /// Stripe's signature on the raw body, and nothing else: the webhook.
    Stripe,
}

impl Session {
    pub fn as_str(self) -> &'static str {
        match self {
            Session::Public => "public",
            Session::Any => "any",
            Session::Sandbox => "sandbox",
            Session::SignedIn => "signed-in",
            Session::Cookie => "cookie",
            Session::Stripe => "stripe",
        }
    }

    /// Whether the route needs a session at all.
    pub fn needs_session(self) -> bool {
        matches!(
            self,
            Session::Any | Session::Sandbox | Session::SignedIn | Session::Cookie
        )
    }
}

/// One answer a route can give. `problem` is the problem type's slug
/// (`https://bakery.ihaveasegway.com/problems/<slug>`); `None` for a success, a redirect or a
/// plain `about:blank` problem such as a 404.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub problem: Option<&'static str>,
    pub note: &'static str,
}

/// A query parameter a route reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Query {
    pub name: &'static str,
    /// A JSON Schema type: `string` or `integer`.
    pub ty: &'static str,
    pub note: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteSpec {
    /// The Worker's `RouteId` name in kebab-case, such as `place-order`: the operation's id.
    pub id: &'static str,
    pub method: &'static str,
    /// The public pattern, with the README's names for its segments: `{id}` the sandbox,
    /// `{oid}` an order, `{cid}` a catering event, a customer or a campaign, `{mid}` a message,
    /// `{date}` a bakery day, `{segment}`, `{slug}` a menu item and `{eventId}` a dead letter.
    pub path: &'static str,
    pub summary: &'static str,
    pub session: Session,
    /// Whether an API token in `Authorization: Bearer` may stand in for the cookie
    /// (docs/security.md, "The API token"). Never on the socket, the webhook, the account-level
    /// routes, or the two that mint a token: a token never mints its successor.
    pub bearer: bool,
    /// Whether the request must carry an `Idempotency-Key` (every POST but the webhook).
    pub idempotent: bool,
    /// The request body's contract type, or `None` for no body.
    pub request: Option<&'static str>,
    /// The success body's contract type; `Name[]` for an array of them; `None` for no body
    /// (a 204, a redirect, the socket's 101).
    pub response: Option<&'static str>,
    pub query: &'static [Query],
    /// The answers particular to this route; [`answers`] adds the shared ones.
    pub answers: &'static [Answer],
    /// The pull request that added it (docs/roadmap.md).
    pub pr: u8,
}

const fn ok(status: u16, note: &'static str) -> Answer {
    Answer {
        status,
        problem: None,
        note,
    }
}

const fn no(status: u16, problem: &'static str, note: &'static str) -> Answer {
    Answer {
        status,
        problem: Some(problem),
        note,
    }
}

const fn q(name: &'static str, ty: &'static str, note: &'static str) -> Query {
    Query { name, ty, note }
}

const NOT_FOUND: Answer = ok(
    404,
    "an id this sandbox has not registered, another's included",
);
const REPLAYED: Answer = ok(
    200,
    "the same `Idempotency-Key` again: the first answer, replayed",
);
const SEEDING: Answer = no(503, "seeding", "the sandbox is still being seeded");
const STRIPE_KEY: Answer = no(503, "stripe-key", "the API has no sandbox Stripe key");
const NO_SUCH_DAY: Answer = no(404, "no-such-day", "a date outside the sandbox's days");

/// One route of the table, with nothing else to say: no query, the README's default
/// `Idempotency-Key` rule (every POST but the webhook) and a bearer token accepted wherever a
/// sandbox's session is.
#[allow(clippy::too_many_arguments)]
const fn r(
    pr: u8,
    id: &'static str,
    method: &'static str,
    path: &'static str,
    session: Session,
    summary: &'static str,
    request: Option<&'static str>,
    response: Option<&'static str>,
    answers: &'static [Answer],
) -> RouteSpec {
    let post = matches!(method.as_bytes(), b"POST");
    RouteSpec {
        id,
        method,
        path,
        summary,
        session,
        bearer: matches!(session, Session::Sandbox | Session::SignedIn),
        idempotent: post && !matches!(session, Session::Stripe),
        request,
        response,
        query: &[],
        answers,
        pr,
    }
}

const fn with_query(mut route: RouteSpec, query: &'static [Query]) -> RouteSpec {
    route.query = query;
    route
}

const fn cookie_only(mut route: RouteSpec) -> RouteSpec {
    route.bearer = false;
    route
}

use Session::{Any, Cookie, Public, Sandbox, SignedIn, Stripe};

const S: &str = "/v1/sandboxes/{id}";

/// Every route: the Worker's after PR 7 (its README's table, in its order), then PR 8's, PR 9's
/// dispatch and PR 10's token, each held to the Worker as built and its README by the tests
/// below.
pub const ROUTES: &[RouteSpec] = &[
    r(
        2,
        "health",
        "GET",
        "/v1/health",
        Public,
        "The Worker answers, and which build it is",
        None,
        Some("HealthResponse"),
        &[ok(200, "`{status, commit, version}`; touches no object")],
    ),
    r(
        2,
        "status",
        "GET",
        "/v1/status",
        Public,
        "Today's admission state, the status page's counters and the breaker's state, from the Control object",
        None,
        Some("StatusResponse"),
        &[ok(
            200,
            "today's sandboxes, guests and demo accounts with their caps, the last snapshot of the kept Analytics Engine queries with `counters_as_of` and `counters_state` (`live`, `stale` or `unavailable`), the breaker's state (`unconfigured`, `armed`, `read-only` or `off`) with its last run, and the flag",
        )],
    ),
    with_query(
        r(
            3,
            "google-start",
            "GET",
            "/v1/auth/google/start",
            Public,
            "Start a Google sign-in",
            None,
            None,
            &[ok(
                302,
                "to Google with `scope=openid` alone; sets `__Host-oauth`",
            )],
        ),
        &[q(
            "return",
            "string",
            "the storefront path to come back to, such as `/app/`",
        )],
    ),
    with_query(
        r(
            3,
            "google-callback",
            "GET",
            "/v1/auth/google/callback",
            Public,
            "Google's redirect back: the `__Host-oauth` cookie and `state` are the check",
            None,
            None,
            &[
                ok(303, "to the storefront's path, setting `__Host-session`"),
                ok(
                    303,
                    "to `/signin/?error=state`, `exchange`, `token`, `provider` or `oauth`",
                ),
            ],
        ),
        &[
            q("code", "string", "Google's authorization code"),
            q("state", "string", "the value `__Host-oauth` holds"),
        ],
    ),
    with_query(
        r(
            3,
            "github-start",
            "GET",
            "/v1/auth/github/start",
            Public,
            "Start a GitHub sign-in",
            None,
            None,
            &[ok(
                302,
                "to GitHub with no `scope` parameter; sets `__Host-oauth`",
            )],
        ),
        &[q(
            "return",
            "string",
            "the storefront path to come back to, such as `/app/`",
        )],
    ),
    with_query(
        r(
            3,
            "github-callback",
            "GET",
            "/v1/auth/github/callback",
            Public,
            "GitHub's redirect back: the numeric user id is all it keeps",
            None,
            None,
            &[
                ok(303, "to the storefront's path, setting `__Host-session`"),
                ok(
                    303,
                    "to `/signin/?error=state`, `exchange`, `token`, `provider` or `oauth`",
                ),
            ],
        ),
        &[
            q("code", "string", "GitHub's authorization code"),
            q("state", "string", "the value `__Host-oauth` holds"),
        ],
    ),
    r(
        3,
        "demo-signup",
        "POST",
        "/v1/auth/demo",
        Public,
        "Create a demo account behind Turnstile; the username is shown once",
        Some("DemoSignupRequest"),
        Some("DemoSignupResponse"),
        &[
            ok(201, "the generated username, and the cookie"),
            no(403, "turnstile", "Turnstile refused the token"),
            no(422, "password", "12 to 128 characters"),
            no(503, "demo-cap", "the day's demo accounts are used up"),
        ],
    ),
    r(
        3,
        "demo-signin",
        "POST",
        "/v1/auth/demo/signin",
        Public,
        "Sign in to a demo account",
        Some("DemoSigninRequest"),
        Some("SessionResponse"),
        &[
            ok(200, "the session, and the cookie"),
            no(
                401,
                "credentials",
                "no such username, or the wrong password",
            ),
            no(
                429,
                "locked",
                "10 failures in 15 minutes; with `Retry-After`",
            ),
        ],
    ),
    r(
        3,
        "signout",
        "POST",
        "/v1/auth/signout",
        Any,
        "Sign out: the cookie is cleared and an account's session id revoked",
        None,
        None,
        &[ok(204, "the cookie cleared")],
    ),
    r(
        3,
        "session",
        "GET",
        "/v1/session",
        Any,
        "What the cookie says, read without an object call",
        None,
        Some("SessionResponse"),
        &[ok(200, "the cookie, decoded")],
    ),
    r(
        3,
        "create-sandbox",
        "POST",
        "/v1/sandboxes",
        Public,
        "A sandbox: Turnstile for a guest, admitted by Control, seeded",
        Some("CreateSandboxRequest"),
        Some("SandboxResponse"),
        &[
            ok(201, "a new sandbox; the cookie is re-issued with `sbx`"),
            ok(200, "an account's live sandbox, unless `replace`"),
            no(403, "turnstile", "a guest without a good Turnstile token"),
            no(429, "rate-limit", "this IP hash's creations this minute"),
            no(429, "account-sandbox-cap", "3 sandboxes an account a day"),
            no(503, "sandbox-cap", "300 sandboxes a UTC day"),
            no(503, "guest-cap", "100 guest sandboxes a UTC day"),
            no(503, "read-only", "the demo's flag is read-only"),
            no(503, "off", "the demo's flag is off"),
        ],
    ),
    r(
        3,
        "get-sandbox",
        "GET",
        S,
        Sandbox,
        "The sandbox's state",
        None,
        Some("SandboxResponse"),
        &[ok(200, "the Sandbox's state")],
    ),
    r(
        3,
        "wipe-sandbox",
        "DELETE",
        S,
        Sandbox,
        "Wipe now, finished in the request",
        None,
        Some("WipedResponse"),
        &[ok(
            200,
            "`{id, state: wiped}`; an account's cookie loses `sbx`, a guest's is cleared",
        )],
    ),
    r(
        3,
        "set-fault",
        "POST",
        "/v1/sandboxes/{id}/faults",
        SignedIn,
        "Switch the Kitchen's or the Inbox's broken-subscriber fault",
        Some("FaultRequest"),
        Some("FaultsResponse"),
        &[ok(200, "every switch as it now stands")],
    ),
    r(
        4,
        "get-menu",
        "GET",
        "/v1/sandboxes/{id}/menu",
        Sandbox,
        "The published menu, with `ETag: \"v<n>\"`",
        None,
        Some("MenuResponse"),
        &[
            ok(200, "the Catalog's published menu"),
            ok(304, "a matching `If-None-Match`"),
            SEEDING,
        ],
    ),
    r(
        4,
        "patch-menu-item",
        "PATCH",
        "/v1/sandboxes/{id}/menu/items/{slug}",
        SignedIn,
        "A draft price on every variant, or a pause or resume published at once",
        Some("MenuItemPatch"),
        Some("MenuEditResponse"),
        &[
            ok(200, "`{version, pending}`"),
            ok(404, "no such item"),
            no(422, "menu", "the rule is named in `detail`"),
        ],
    ),
    r(
        4,
        "publish-menu",
        "POST",
        "/v1/sandboxes/{id}/menu/publish",
        SignedIn,
        "Publish the drafts: `MenuPublished`, the version plus one",
        None,
        Some("MenuEditResponse"),
        &[
            ok(200, "`{version, pending}`"),
            no(422, "menu", "no drafts to publish"),
        ],
    ),
    r(
        4,
        "place-order",
        "POST",
        "/v1/sandboxes/{id}/orders",
        Sandbox,
        "Place an order as the sandbox's persona; its slot is held until it is paid",
        Some("OrderRequest"),
        Some("OrderResponse"),
        &[
            ok(201, "the order, with `Location`"),
            REPLAYED,
            no(
                409,
                "slot-full",
                "with `next_free`, the next free start that day",
            ),
            no(409, "item-cap", "an item's daily cap is reached"),
            no(
                409,
                "lead-time",
                "naming the hours, such as a 48 h cake for tomorrow",
            ),
            no(
                409,
                "hold-lost",
                "a retry whose place was given back before any order was placed, with no room left; with `next_free`",
            ),
            no(
                422,
                "no-such-slot",
                "not a slot or window start, or a day outside the sandbox's",
            ),
            no(422, "closed-day", "the bakery is closed that day"),
            no(
                422,
                "order",
                "naming the rule (`note-<class>` for the note)",
            ),
            SEEDING,
        ],
    ),
    r(
        4,
        "get-order",
        "GET",
        "/v1/sandboxes/{id}/orders/{oid}",
        Sandbox,
        "One order, once the Sandbox's registry holds it",
        None,
        Some("OrderResponse"),
        &[ok(200, "the order"), NOT_FOUND],
    ),
    r(
        4,
        "cancel-order",
        "POST",
        "/v1/sandboxes/{id}/orders/{oid}/cancel",
        Sandbox,
        "The customer cancels",
        None,
        Some("OrderResponse"),
        &[
            ok(200, "the order, cancelled"),
            NOT_FOUND,
            no(422, "order", "naming the rule"),
        ],
    ),
    r(
        4,
        "list-dead-letters",
        "GET",
        "/v1/sandboxes/{id}/dead-letters",
        Sandbox,
        "The messages the Queue gave up on, oldest first",
        None,
        Some("DeadLetter[]"),
        &[ok(200, "an array of dead letters")],
    ),
    r(
        4,
        "redrive",
        "POST",
        "/v1/sandboxes/{id}/dead-letters/{eventId}/redrive",
        SignedIn,
        "Send a dead letter again with its own id",
        None,
        Some("DeadLetter"),
        &[
            ok(200, "the dead letter sent again, its row removed"),
            NOT_FOUND,
        ],
    ),
    r(
        4,
        "advance-clock",
        "POST",
        "/v1/sandboxes/{id}/clock",
        SignedIn,
        "Move business time forward, at most 14 days in all",
        Some("ClockRequest"),
        Some("ClockResponse"),
        &[
            ok(200, "the clock, with `step`"),
            ok(
                200,
                "the same key again: the first answer, and nothing moves again",
            ),
            no(
                422,
                "clock",
                "naming `offset-cap` or `not-positive` (also for both or neither)",
            ),
        ],
    ),
    cookie_only(r(
        4,
        "kitchen-socket",
        "GET",
        "/v1/sandboxes/{id}/kitchen/ws",
        Cookie,
        "The kitchen board's socket, protocol v1 (`x-websocket`)",
        None,
        None,
        &[
            ok(101, "the socket; frames in `x-websocket`"),
            ok(404, "another sandbox's id"),
            no(426, "upgrade", "without `Upgrade: websocket`"),
            SEEDING,
        ],
    )),
    r(
        4,
        "heartbeat",
        "POST",
        "/v1/sandboxes/{id}/heartbeat",
        Sandbox,
        "The console is open with no socket: the Kitchen keeps the time for the Simulator",
        None,
        None,
        &[ok(204, "noted"), ok(404, "another sandbox's id")],
    ),
    r(
        4,
        "get-traffic",
        "GET",
        "/v1/sandboxes/{id}/traffic",
        Sandbox,
        "The Simulator's state, today's",
        None,
        Some("TrafficResponse"),
        &[ok(
            200,
            "`{running, rate, minutes_used, minutes_left, orders}`",
        )],
    ),
    r(
        4,
        "start-traffic",
        "POST",
        "/v1/sandboxes/{id}/traffic",
        SignedIn,
        "Start simulated orders, 1 to 6 a minute, within today's 30 minutes",
        Some("TrafficRequest"),
        Some("TrafficResponse"),
        &[
            ok(200, "the Simulator, running"),
            REPLAYED,
            no(409, "traffic-running", "a run is already going"),
            no(422, "traffic", "naming the rule"),
            no(
                503,
                "traffic-cap",
                "today's minutes are used; with `Retry-After`",
            ),
        ],
    ),
    r(
        4,
        "stop-traffic",
        "DELETE",
        "/v1/sandboxes/{id}/traffic",
        SignedIn,
        "Stop simulated orders; the unused minutes go back to Control",
        None,
        Some("TrafficResponse"),
        &[ok(200, "the Simulator, stopped")],
    ),
    r(
        5,
        "pay",
        "POST",
        "/v1/sandboxes/{id}/orders/{oid}/payment",
        Sandbox,
        "What the browser needs to mount Stripe's Payment Element; only the webhook marks it paid",
        None,
        Some("PaymentResponse"),
        &[
            ok(200, "the payment and its one-time `client_secret`"),
            ok(404, "an unknown order"),
            no(409, "order", "unless the order is `placed`"),
            STRIPE_KEY,
        ],
    ),
    r(
        5,
        "refund",
        "POST",
        "/v1/sandboxes/{id}/orders/{oid}/refund",
        SignedIn,
        "Staff refund a part or all that is left; Billing refunds at Stripe from the Queue",
        Some("RefundRequest"),
        Some("RefundResponse"),
        &[
            ok(200, "the refund, on its way to Stripe"),
            REPLAYED,
            no(
                409,
                "order",
                "`no-stripe-payment`: a seeded order Stripe never charged",
            ),
            no(422, "order", "`refund-exceeds-paid` or `out-of-order`"),
            STRIPE_KEY,
        ],
    ),
    r(
        5,
        "ledger",
        "GET",
        "/v1/sandboxes/{id}/billing/ledger",
        Sandbox,
        "Every payment and refund Billing recorded, and the totals",
        None,
        Some("LedgerResponse"),
        &[ok(200, "the ledger"), STRIPE_KEY],
    ),
    r(
        5,
        "stripe-webhook",
        "POST",
        "/v1/stripe/webhook",
        Stripe,
        "Stripe's events, checked against `Stripe-Signature`, test mode only; no CORS, Origin, session, key or rate limit",
        None,
        None,
        &[
            ok(
                200,
                "an event applied, replayed or ignored, and for a wiped or unknown sandbox",
            ),
            no(400, "signature", "the signature does not verify"),
            no(
                400,
                "timestamp",
                "the signature's timestamp is outside the tolerance",
            ),
            no(400, "body", "not a Stripe event"),
            no(400, "livemode", "a live-mode event"),
            ok(405, "`OPTIONS`, with `Allow: POST`: no preflight"),
            no(409, "webhook-later", "an event `Billing` cannot apply yet"),
            STRIPE_KEY,
        ],
    ),
    r(
        6,
        "get-schedule",
        "GET",
        "/v1/sandboxes/{id}/schedule/{date}",
        Sandbox,
        "One bakery day: slots, zones, item caps, catering and the bake list",
        None,
        Some("ScheduleResponse"),
        &[ok(200, "the day"), NO_SUCH_DAY, SEEDING],
    ),
    r(
        6,
        "set-capacity",
        "PATCH",
        "/v1/sandboxes/{id}/schedule/{date}/capacity",
        SignedIn,
        "Set one capacity for the day; places already taken stay",
        Some("CapacityRequest"),
        Some("ScheduleResponse"),
        &[
            ok(200, "the day"),
            no(
                422,
                "bad-target",
                "not `slot:HH:MM`, `zone:z1` to `z3`, `item:<slug>` or `catering`",
            ),
            NO_SUCH_DAY,
        ],
    ),
    r(
        7,
        "create-catering",
        "POST",
        "/v1/sandboxes/{id}/catering",
        Sandbox,
        "A catering inquiry, as the sandbox's persona",
        Some("CateringInquiryRequest"),
        Some("CateringResponse"),
        &[
            ok(201, "the inquiry, with `Location`"),
            REPLAYED,
            no(
                422,
                "catering",
                "`detail` ends `The rule is <slug>.`; never echoes the brief",
            ),
        ],
    ),
    r(
        7,
        "list-catering",
        "GET",
        "/v1/sandboxes/{id}/catering",
        Sandbox,
        "Every registered catering event, newest inquiry first",
        None,
        Some("CateringListResponse"),
        &[ok(200, "the events, the seeded eight included")],
    ),
    r(
        7,
        "get-catering",
        "GET",
        "/v1/sandboxes/{id}/catering/{cid}",
        Sandbox,
        "One catering event, with the reminders still to come",
        None,
        Some("CateringResponse"),
        &[ok(200, "the event"), NOT_FOUND],
    ),
    r(
        7,
        "accept-quote",
        "POST",
        "/v1/sandboxes/{id}/catering/{cid}/accept",
        Sandbox,
        "Accept the quote: the day's catering place is held while the deposit is paid",
        None,
        Some("CateringResponse"),
        &[
            ok(200, "`accepted`"),
            no(
                409,
                "slot-full",
                "both of the day's catering places are taken; nothing recorded",
            ),
            no(409, "catering", "`out-of-order` or `quote-expired`"),
        ],
    ),
    r(
        7,
        "catering-deposit",
        "POST",
        "/v1/sandboxes/{id}/catering/{cid}/deposit",
        Sandbox,
        "The deposit's payment, 25% of the quote, as an order's `/payment`",
        None,
        Some("PaymentResponse"),
        &[
            ok(200, "the payment and its one-time `client_secret`"),
            no(409, "catering", "unless accepted"),
            STRIPE_KEY,
        ],
    ),
    r(
        7,
        "pay-balance",
        "POST",
        "/v1/sandboxes/{id}/catering/{cid}/pay-balance",
        Sandbox,
        "Pay the balance invoice on Stripe's test path; the webhook closes the event",
        None,
        Some("CateringResponse"),
        &[
            ok(202, "the event as it stands: poll until `closed`"),
            no(409, "catering", "unless invoiced"),
        ],
    ),
    r(
        7,
        "cancel-catering",
        "POST",
        "/v1/sandboxes/{id}/catering/{cid}/cancel",
        Sandbox,
        "The customer cancels a confirmed event; more than 7 days out the deposit is refunded",
        Some("CateringCancelRequest"),
        Some("CateringResponse"),
        &[
            ok(200, "`cancelled`, with `refund_deposit`"),
            no(409, "catering", "`out-of-order`"),
        ],
    ),
    r(
        7,
        "send-quote",
        "POST",
        "/v1/sandboxes/{id}/catering/{cid}/quote",
        SignedIn,
        "Staff quote an inquiry",
        Some("QuoteRequest"),
        Some("CateringResponse"),
        &[
            ok(200, "`quoted`"),
            no(422, "catering", "`quote-total`, a total under 1 cent"),
            no(409, "catering", "`out-of-order`"),
        ],
    ),
    r(
        7,
        "decline-catering",
        "POST",
        "/v1/sandboxes/{id}/catering/{cid}/decline",
        SignedIn,
        "Staff decline an inquiry",
        Some("DeclineRequest"),
        Some("CateringResponse"),
        &[ok(200, "`declined`"), no(409, "catering", "past `inquiry`")],
    ),
    r(
        7,
        "start-catering-production",
        "POST",
        "/v1/sandboxes/{id}/catering/{cid}/start-production",
        SignedIn,
        "Staff start production of a confirmed event",
        None,
        Some("CateringResponse"),
        &[
            ok(200, "`in_production`"),
            no(409, "catering", "unless confirmed"),
        ],
    ),
    r(
        7,
        "mark-catering-delivered",
        "POST",
        "/v1/sandboxes/{id}/catering/{cid}/delivered",
        SignedIn,
        "Staff mark it delivered; Billing raises the balance invoice",
        None,
        Some("CateringResponse"),
        &[
            ok(200, "`delivered`; poll for `invoice`"),
            no(409, "catering", "out of order"),
        ],
    ),
    r(
        7,
        "staff-cancel-catering",
        "POST",
        "/v1/sandboxes/{id}/catering/{cid}/staff-cancel",
        SignedIn,
        "Staff cancel a confirmed event",
        Some("CateringCancelRequest"),
        Some("CateringResponse"),
        &[ok(200, "`cancelled`"), no(409, "catering", "out of order")],
    ),
    // PR 8: customers, segments, campaigns, the inbox, leads, activity and the rebuild
    // (pr8-web-brief.md, "The routes the Worker will answer"). Reads are any session's.
    r(
        8,
        "list-customers",
        "GET",
        "/v1/sandboxes/{id}/customers",
        Sandbox,
        "The sandbox's 60 synthetic customers",
        None,
        Some("CustomerListResponse"),
        &[ok(200, "the customers, by id")],
    ),
    r(
        8,
        "get-customer",
        "GET",
        "/v1/sandboxes/{id}/customers/{cid}",
        Sandbox,
        "One customer as Crm's projection holds it",
        None,
        Some("CustomerResponse"),
        &[ok(200, "the customer"), ok(404, "an unknown customer")],
    ),
    r(
        8,
        "get-timeline",
        "GET",
        "/v1/sandboxes/{id}/customers/{cid}/timeline",
        Sandbox,
        "A customer's events in business-time order",
        None,
        Some("TimelineResponse"),
        &[
            ok(200, "the timeline; partial while a rebuild runs"),
            ok(404, "an unknown customer"),
        ],
    ),
    r(
        8,
        "set-consent",
        "POST",
        "/v1/sandboxes/{id}/customers/{cid}/consent",
        Sandbox,
        "Marketing consent, by the customer's own persona or by staff",
        Some("ConsentRequest"),
        Some("CustomerResponse"),
        &[
            ok(
                200,
                "the customer; the same `Idempotency-Key` again replays it, with `Idempotent-Replayed`",
            ),
            ok(404, "an unknown customer"),
            no(
                403,
                "guest-scope",
                "a guest changing another persona's consent",
            ),
        ],
    ),
    r(
        8,
        "list-segments",
        "GET",
        "/v1/sandboxes/{id}/segments",
        Sandbox,
        "Every segment, with its member count and a sample",
        None,
        Some("SegmentListResponse"),
        &[ok(200, "the five segments, in the fixed order")],
    ),
    r(
        8,
        "get-segment",
        "GET",
        "/v1/sandboxes/{id}/segments/{segment}",
        Sandbox,
        "How many customers a segment holds now",
        None,
        Some("SegmentResponse"),
        &[ok(200, "the segment"), ok(404, "an unknown segment")],
    ),
    r(
        8,
        "list-campaigns",
        "GET",
        "/v1/sandboxes/{id}/campaigns",
        Sandbox,
        "Every campaign, by id",
        None,
        Some("CampaignListResponse"),
        &[ok(200, "the campaigns")],
    ),
    r(
        8,
        "create-campaign",
        "POST",
        "/v1/sandboxes/{id}/campaigns",
        SignedIn,
        "A draft campaign, from the fixed templates",
        Some("CampaignRequest"),
        Some("CampaignResponse"),
        &[ok(201, "the draft, with `Location`"), REPLAYED],
    ),
    r(
        8,
        "get-campaign",
        "GET",
        "/v1/sandboxes/{id}/campaigns/{cid}",
        Sandbox,
        "One campaign",
        None,
        Some("CampaignResponse"),
        &[ok(200, "the campaign"), ok(404, "an unknown campaign")],
    ),
    r(
        8,
        "edit-campaign",
        "PATCH",
        "/v1/sandboxes/{id}/campaigns/{cid}",
        SignedIn,
        "Edit a draft campaign",
        Some("CampaignRequest"),
        Some("CampaignResponse"),
        &[
            ok(
                200,
                "the draft; the same optional `Idempotency-Key` again replays it",
            ),
            ok(404, "an unknown campaign"),
            no(
                409,
                "campaign",
                "`out-of-order`: scheduled, sent or cancelled",
            ),
        ],
    ),
    r(
        8,
        "schedule-campaign",
        "POST",
        "/v1/sandboxes/{id}/campaigns/{cid}/schedule",
        SignedIn,
        "Schedule a draft; the send is the object's timer, never a route",
        Some("ScheduleRequest"),
        Some("CampaignResponse"),
        &[
            ok(200, "`scheduled`; the same key again replays it"),
            ok(404, "an unknown campaign"),
            no(
                422,
                "campaign",
                "`schedule-too-soon`, its detail the earliest time allowed",
            ),
            no(409, "campaign", "`out-of-order`: not a draft"),
        ],
    ),
    r(
        8,
        "cancel-campaign",
        "POST",
        "/v1/sandboxes/{id}/campaigns/{cid}/cancel",
        SignedIn,
        "A scheduled campaign back to draft, or a draft cancelled",
        None,
        Some("CampaignResponse"),
        &[
            ok(200, "the campaign"),
            ok(404, "an unknown campaign"),
            no(409, "campaign", "`out-of-order`: already sent"),
        ],
    ),
    with_query(
        r(
            8,
            "list-inbox",
            "GET",
            "/v1/sandboxes/{id}/inbox",
            Sandbox,
            "The sandbox's inbox, newest first",
            None,
            Some("InboxResponse"),
            &[
                ok(200, "the messages and the filters' total"),
                no(400, "filter", "a filter the inbox refuses"),
            ],
        ),
        &[
            q("kind", "string", "one message kind, such as `receipt`"),
            q("to", "string", "one customer's ULID"),
            q("limit", "integer", "how many, 50 when left out"),
        ],
    ),
    r(
        8,
        "get-message",
        "GET",
        "/v1/sandboxes/{id}/inbox/{mid}",
        Sandbox,
        "One message, with its opens and clicks as the Inbox simulated them",
        None,
        Some("MessageResponse"),
        &[ok(200, "the message"), ok(404, "an unknown message")],
    ),
    r(
        8,
        "get-leads",
        "GET",
        "/v1/sandboxes/{id}/leads",
        Sandbox,
        "The catering lead pipeline, by stage",
        None,
        Some("LeadPipelineResponse"),
        &[ok(200, "every stage, in order")],
    ),
    with_query(
        r(
            8,
            "get-activity",
            "GET",
            "/v1/sandboxes/{id}/activity",
            Sandbox,
            "The sandbox's logged events, newest first",
            None,
            Some("ActivityResponse"),
            &[ok(200, "the activity feed")],
        ),
        &[q("limit", "integer", "how many entries")],
    ),
    r(
        8,
        "start-rebuild",
        "POST",
        "/v1/sandboxes/{id}/rebuild",
        SignedIn,
        "Rebuild projections: drop Crm's projections and replay its log",
        None,
        Some("RebuildResponse"),
        &[
            ok(202, "the rebuild, started"),
            no(
                409,
                "rebuild",
                "a second start while one is running; other commands still run",
            ),
        ],
    ),
    r(
        8,
        "get-rebuild",
        "GET",
        "/v1/sandboxes/{id}/rebuild",
        Sandbox,
        "The rebuild's progress; ask every second while `rebuilding`",
        None,
        Some("RebuildResponse"),
        &[ok(200, "the cursor")],
    ),
    // PR 9: dispatch (workers/api/src/http/dispatch.rs; the README's dispatch rows).
    r(
        9,
        "get-dispatch",
        "GET",
        "/v1/sandboxes/{id}/dispatch/{date}",
        Sandbox,
        "One bakery day's delivery stops and plans",
        None,
        Some("DispatchResponse"),
        &[ok(200, "the day"), NO_SUCH_DAY, SEEDING],
    ),
    r(
        9,
        "propose-dispatch",
        "POST",
        "/v1/sandboxes/{id}/dispatch/{date}/propose",
        SignedIn,
        "The server's savings plan for the confirmed stops",
        Some("ProposeRequest"),
        Some("DispatchResponse"),
        &[
            ok(200, "the day, with `proposed`"),
            NO_SUCH_DAY,
            no(
                422,
                "dispatch",
                "`vans`, `capacity`, `no-stops` or `place-unknown`",
            ),
            SEEDING,
        ],
    ),
    r(
        9,
        "submit-plan",
        "POST",
        "/v1/sandboxes/{id}/dispatch/{date}/plan",
        SignedIn,
        "The plan VROOM made in the browser; the server computes its minutes",
        Some("PlanRequest"),
        Some("DispatchResponse"),
        &[
            ok(200, "the day, with `submitted` and `comparison`"),
            NO_SUCH_DAY,
            no(
                422,
                "dispatch",
                "`route-ends`, `vans`, `stop-unknown`, `stop-twice`, `over-capacity`, `stop-missing` or `no-stops`",
            ),
            SEEDING,
        ],
    ),
    r(
        9,
        "publish-dispatch",
        "POST",
        "/v1/sandboxes/{id}/dispatch/{date}/publish",
        SignedIn,
        "Make a stored plan the record",
        Some("PublishRequest"),
        Some("DispatchResponse"),
        &[
            ok(200, "the day, with `published`"),
            REPLAYED,
            NO_SUCH_DAY,
            no(
                409,
                "dispatch",
                "`no-plan`, `stop-missing`, `published` (a van has left) or the plan's own rules again",
            ),
            SEEDING,
        ],
    ),
    r(
        9,
        "complete-stop",
        "POST",
        "/v1/sandboxes/{id}/dispatch/{date}/complete",
        SignedIn,
        "A stop of the published plan is delivered",
        Some("CompleteStopRequest"),
        Some("DispatchResponse"),
        &[
            ok(200, "the day; again for a delivered stop changes nothing"),
            NO_SUCH_DAY,
            no(409, "dispatch", "`no-plan`"),
            no(422, "dispatch", "`stop-unknown`"),
            SEEDING,
        ],
    ),
    // PR 10: the sandbox's API token (docs/security.md, "The API token"). Issuing and rotating
    // take the cookie: a token never mints its successor.
    cookie_only(r(
        10,
        "issue-token",
        "POST",
        "/v1/sandboxes/{id}/token",
        SignedIn,
        "Issue the sandbox's API token at its current version, or issue it again; shown once",
        None,
        Some("TokenResponse"),
        &[ok(200, "the token, shown once"), REPLAYED],
    )),
    cookie_only(r(
        10,
        "rotate-token",
        "POST",
        "/v1/sandboxes/{id}/token/rotate",
        SignedIn,
        "Rotate: the Sandbox's token version goes up (`ApiTokenRotated`) and every older token stops",
        None,
        Some("TokenResponse"),
        &[ok(200, "the new token, shown once"), REPLAYED],
    )),
    r(
        10,
        "get-token",
        "GET",
        "/v1/sandboxes/{id}/token",
        SignedIn,
        "The token's version and times, and the last issued one masked; never the token",
        None,
        Some("TokenInfoResponse"),
        &[ok(200, "the token's info")],
    ),
];

/// The methods the Origin check guards (docs/security.md, "Origin checks").
pub fn is_command(method: &str) -> bool {
    matches!(method, "POST" | "PATCH" | "DELETE")
}

/// Whether the route spends a rate limit: every command a browser sends, and the socket's
/// upgrade. The webhook is gated by its signature instead.
pub fn is_limited(route: &RouteSpec) -> bool {
    match route.session {
        Session::Stripe => false,
        Session::Cookie => true,
        _ => is_command(route.method),
    }
}

/// Every answer `route` can give: its own, then the ones its kind shares, in status order with
/// its own first within a status. The shared ones follow docs/security.md and the README's
/// paragraph under its routes table.
pub fn answers(route: &RouteSpec) -> Vec<Answer> {
    let mut out: Vec<Answer> = route.answers.to_vec();
    let has = |out: &[Answer], status: u16, problem: Option<&str>| {
        out.iter()
            .any(|a| a.status == status && a.problem == problem)
    };
    let mut add = |status: u16, problem: Option<&'static str>, note: &'static str| {
        if !has(&out, status, problem) {
            out.push(Answer {
                status,
                problem,
                note,
            });
        }
    };
    if route.idempotent {
        add(
            400,
            Some("idempotency-key"),
            "no `Idempotency-Key`, or not a ULID",
        );
        add(
            422,
            Some("idempotency-key"),
            "the same key again with a different body",
        );
    }
    if route.request.is_some() {
        add(400, Some("body"), "a body that is not the contract's JSON");
    }
    // Every route that needs a session reads `Authorization` (the Worker's router, as built in
    // PR 10): a token in the query string or beside the cookie is 400 there, and a route that
    // takes the cookie only refuses a token in its place, so no token is ever silently ignored.
    if route.bearer || route.session.needs_session() {
        add(
            400,
            Some("token"),
            "a cookie and a token both (`both`), or a token in the query string (`query`)",
        );
        add(
            401,
            Some("token"),
            if route.bearer {
                "a token that is malformed, expired, rotated or not an API token (`token`, `expired`, `rotated`, `purpose`)"
            } else {
                "an API token: this route takes the session cookie only (`cookie-only`)"
            },
        );
    }
    if route.session.needs_session() {
        add(
            401,
            Some("session"),
            "no session, or one that does not verify",
        );
    }
    if (is_command(route.method) || route.session == Session::Cookie)
        && route.session != Session::Stripe
    {
        add(
            403,
            Some("origin"),
            "a cookie request without the storefront's exact `Origin`, or `Sec-Fetch-Site: cross-site`",
        );
    }
    if route.session == Session::SignedIn {
        add(
            403,
            Some("guest-scope"),
            "a guest's session: sign in for this",
        );
    }
    if route.path.starts_with("/v1/sandboxes/{id}") {
        if !route.answers.iter().any(|a| a.status == 404) {
            add(404, None, "another sandbox's id, or one naming nothing");
        }
        add(410, Some("wiped"), "the sandbox is being wiped or is gone");
    }
    // A token spends its own limit on every request it makes, reads included.
    match (is_limited(route), route.bearer) {
        (true, true) => add(
            429,
            Some("rate-limit"),
            "the session's or IP hash's limit, or with a token the token's, with `Retry-After`",
        ),
        (true, false) => add(
            429,
            Some("rate-limit"),
            "the session's or IP hash's limit, with `Retry-After`",
        ),
        (false, true) => add(
            429,
            Some("rate-limit"),
            "with a token, the token's limit: every request it makes counts, with `Retry-After`",
        ),
        (false, false) => {}
    }
    out.sort_by_key(|a| a.status);
    out
}

/// The route with this method and path, if any.
pub fn find(method: &str, path: &str) -> Option<&'static RouteSpec> {
    ROUTES.iter().find(|r| r.method == method && r.path == path)
}

/// The names of a path's `{segments}`, in order.
pub fn path_params(path: &str) -> Vec<&str> {
    path.split('/')
        .filter_map(|seg| seg.strip_prefix('{').and_then(|s| s.strip_suffix('}')))
        .collect()
}

/// A response or request type name without its `[]`, and whether it is an array.
pub fn type_name(name: &str) -> (&str, bool) {
    match name.strip_suffix("[]") {
        Some(inner) => (inner, true),
        None => (name, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    const README: &str = include_str!("../../../workers/api/README.md");
    const WORKER_ROUTES: &str = include_str!("../../../workers/api/src/http/routes.rs");
    const LIB: &str = include_str!("lib.rs");

    fn rendered() -> BTreeSet<String> {
        crate::schemas()
            .into_iter()
            .map(|(file, _)| file.trim_end_matches(".schema.json").to_owned())
            .collect()
    }

    /// `PlaceOrder` to `place-order`.
    fn kebab(name: &str) -> String {
        let mut out = String::new();
        for (i, c) in name.chars().enumerate() {
            if c.is_ascii_uppercase() {
                if i > 0 {
                    out.push('-');
                }
                out.push(c.to_ascii_lowercase());
            } else {
                out.push(c);
            }
        }
        out
    }

    /// A path with every `{segment}` written `{}`, to compare patterns whose segments are named
    /// differently (the Worker's `{sub}`, the README's `{oid}`).
    fn shape(path: &str) -> String {
        path.split('/')
            .map(|s| if s.starts_with('{') { "{}" } else { s })
            .collect::<Vec<_>>()
            .join("/")
    }

    #[test]
    fn every_type_is_rendered() {
        let rendered = rendered();
        for route in ROUTES {
            for name in [route.request, route.response].into_iter().flatten() {
                let (name, _) = type_name(name);
                assert!(
                    rendered.contains(name),
                    "{}: {name} is not in the render list (lib.rs, `schemas`)",
                    route.id
                );
            }
        }
    }

    #[test]
    fn no_two_routes_share_a_method_and_path_or_an_id() {
        let mut seen = BTreeSet::new();
        let mut ids = BTreeSet::new();
        for route in ROUTES {
            assert!(
                seen.insert((route.method, shape(route.path))),
                "{} {} twice",
                route.method,
                route.path
            );
            assert!(ids.insert(route.id), "{} twice", route.id);
        }
    }

    #[test]
    fn the_rules_hold_for_every_route() {
        for route in ROUTES {
            assert!(route.path.starts_with("/v1/"), "{}", route.id);
            assert!(
                matches!(route.method, "GET" | "POST" | "PATCH" | "DELETE"),
                "{}",
                route.id
            );
            assert_eq!(
                route.idempotent,
                route.method == "POST" && route.session != Session::Stripe,
                "{}: every POST but the webhook carries an Idempotency-Key",
                route.id
            );
            if route.bearer {
                assert!(
                    matches!(route.session, Session::Sandbox | Session::SignedIn),
                    "{}: a token names a sandbox",
                    route.id
                );
            }
            if route.method == "GET" {
                assert_eq!(route.request, None, "{}: a GET has no body", route.id);
            }
            let names = path_params(route.path);
            if route.path.starts_with("/v1/sandboxes/") {
                assert_eq!(names.first(), Some(&"id"), "{}", route.id);
            }
            for name in &names {
                assert!(
                    [
                        "id", "oid", "cid", "mid", "date", "segment", "slug", "eventId"
                    ]
                    .contains(name),
                    "{}: {{{name}}} is not a name the README uses",
                    route.id
                );
            }
            let all = answers(route);
            assert!(
                all.iter().any(|a| a.status < 400),
                "{}: a route answers something",
                route.id
            );
            for a in &all {
                if let Some(slug) = a.problem {
                    assert!(a.status >= 400, "{}: {slug} on {}", route.id, a.status);
                    assert!(
                        slug.bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
                        "{}: {slug}",
                        route.id
                    );
                }
            }
            let success = all
                .iter()
                .any(|a| (200..300).contains(&a.status) && a.status != 204);
            if route.response.is_some() {
                assert!(success, "{}: a body needs a 2xx to carry it", route.id);
            }
        }
        // The two token routes that mint take the cookie only, and the socket never a token.
        for id in ["issue-token", "rotate-token", "kitchen-socket"] {
            assert!(!ROUTES.iter().find(|r| r.id == id).unwrap().bearer, "{id}");
        }
    }

    #[test]
    fn shared_answers_follow_the_route_kind() {
        let place = find("POST", "/v1/sandboxes/{id}/orders").unwrap();
        let all = answers(place);
        for (status, slug) in [
            (400, Some("idempotency-key")),
            (422, Some("idempotency-key")),
            (400, Some("body")),
            (401, Some("session")),
            (401, Some("token")),
            (403, Some("origin")),
            (410, Some("wiped")),
            (429, Some("rate-limit")),
        ] {
            assert!(
                all.iter().any(|a| a.status == status && a.problem == slug),
                "{status} {slug:?}"
            );
        }
        assert!(!all.iter().any(|a| a.problem == Some("guest-scope")));
        let statuses: Vec<u16> = all.iter().map(|a| a.status).collect();
        let mut sorted = statuses.clone();
        sorted.sort();
        assert_eq!(statuses, sorted);

        let hook = find("POST", "/v1/stripe/webhook").unwrap();
        let all = answers(hook);
        for slug in [
            "origin",
            "idempotency-key",
            "session",
            "rate-limit",
            "token",
        ] {
            assert!(!all.iter().any(|a| a.problem == Some(slug)), "{slug}");
        }
        let health = answers(find("GET", "/v1/health").unwrap());
        assert_eq!(health.len(), 1);

        let rotate = answers(find("POST", "/v1/sandboxes/{id}/token/rotate").unwrap());
        assert!(rotate.iter().any(|a| a.problem == Some("guest-scope")));
        assert!(rotate.iter().any(|a| a.status == 404));
        // A token is refused there, never accepted: the route takes the cookie only.
        assert!(rotate.iter().any(|a| a.status == 401
            && a.problem == Some("token")
            && a.note.contains("`cookie-only`")));
        let menu = answers(find("GET", "/v1/sandboxes/{id}/menu").unwrap());
        assert!(
            menu.iter()
                .any(|a| a.status == 401 && a.note.contains("`rotated`"))
        );
        assert!(
            menu.iter()
                .any(|a| a.status == 429 && a.problem == Some("rate-limit"))
        );
        let sandboxes = answers(find("POST", "/v1/sandboxes").unwrap());
        assert!(
            !sandboxes.iter().any(|a| a.problem == Some("token")),
            "public: no token read"
        );
    }

    /// The pull request the README's routes table covers, from its lead line
    /// "Through PR <n> it answers:".
    fn readme_pr() -> u8 {
        README
            .lines()
            .find_map(|l| {
                l.strip_prefix("Through PR ")
                    .and_then(|rest| rest.strip_suffix(" it answers:"))
            })
            .and_then(|n| n.trim().parse().ok())
            .expect("workers/api/README.md says which pull request its routes table covers")
    }

    /// `(METHOD, path, session cell, token cell, answers cell)` for each row of the README's
    /// routes table, the path without its query string.
    fn readme_rows() -> Vec<(String, String, String, String, String)> {
        // The README's lead line names the latest pull request it covers; any number will do.
        let table = README
            .split(" it answers:\n")
            .nth(1)
            .and_then(|rest| rest.split("\n\n").next())
            .expect("workers/api/README.md has its routes table");
        table
            .lines()
            .filter(|l| l.starts_with("| `"))
            .filter_map(|l| {
                let cells: Vec<&str> = l.trim_matches('|').split('|').map(str::trim).collect();
                let route = cells[0].trim_matches('`');
                let (method, path) = route.split_once(' ')?;
                if method == "OPTIONS" || !path.starts_with('/') {
                    return None;
                }
                let path = path.split('?').next().unwrap();
                Some((
                    method.to_owned(),
                    path.to_owned(),
                    cells[1].to_owned(),
                    cells[2].to_owned(),
                    cells[4].to_owned(),
                ))
            })
            .collect()
    }

    /// The statuses an answers cell names, each with the problem slugs written right after it
    /// (`409 \`slot-full\``, `400 \`signature\`, \`timestamp\` or \`body\``). A backticked word
    /// after other words is a rule or a header, not a slug.
    fn readme_answers(cell: &str) -> Vec<(u16, Vec<String>)> {
        let bytes = cell.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        let mut in_code = false;
        while i < bytes.len() {
            if bytes[i] == b'`' {
                in_code = !in_code;
                i += 1;
                continue;
            }
            let boundary = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
            let three = i + 3 <= bytes.len()
                && bytes[i..i + 3].iter().all(u8::is_ascii_digit)
                && (i + 3 == bytes.len() || !bytes[i + 3].is_ascii_alphanumeric());
            if !in_code && boundary && three && (b'1'..=b'5').contains(&bytes[i]) {
                let status: u16 = cell[i..i + 3].parse().unwrap();
                let mut slugs = Vec::new();
                let mut rest = &cell[i + 3..];
                loop {
                    let trimmed = rest.trim_start();
                    let Some(code) = trimmed.strip_prefix('`') else {
                        break;
                    };
                    let Some((word, after)) = code.split_once('`') else {
                        break;
                    };
                    if !word
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    {
                        break;
                    }
                    slugs.push(word.to_owned());
                    let after = after.trim_start();
                    rest = match after
                        .strip_prefix(',')
                        .or_else(|| after.strip_prefix("or "))
                    {
                        Some(more) => more,
                        None => break,
                    };
                }
                if status >= 400 || slugs.is_empty() {
                    out.push((status, if status >= 400 { slugs } else { Vec::new() }));
                }
                i += 3;
                continue;
            }
            i += 1;
        }
        out
    }

    #[test]
    fn readme_cells_parse_as_written() {
        assert_eq!(
            readme_answers("200; 404 for any other id; 410 `wiped`"),
            vec![
                (200, vec![]),
                (404, vec![]),
                (410, vec!["wiped".to_owned()])
            ]
        );
        assert_eq!(
            readme_answers("400 `signature`, `timestamp`, `body` or `livemode`; 503 `stripe-key`"),
            vec![
                (
                    400,
                    vec![
                        "signature".into(),
                        "timestamp".into(),
                        "body".into(),
                        "livemode".into()
                    ]
                ),
                (503, vec!["stripe-key".into()])
            ]
        );
        assert_eq!(
            readme_answers("409 `catering` `out-of-order` or `quote-expired`; a 48 h cake"),
            vec![(409, vec!["catering".into()])]
        );
        assert_eq!(
            readme_answers("422 `clock` naming `offset-cap`; 200 `TrafficResponse`"),
            vec![(422, vec!["clock".into()]), (200, vec![])]
        );
    }

    #[test]
    fn every_readme_route_is_in_the_table_with_its_answers() {
        let rows = readme_rows();
        assert!(rows.len() >= 46, "{} rows", rows.len());
        let covered = readme_pr();
        let mut listed = BTreeSet::new();
        // (a) Every README row is in the table with its method, pattern, session rule, bearer
        // rule and answers, whatever its pull request: the README may list a later one's routes
        // (PR 10's token routes) before its lead line moves. (b) Every table row up to the lead
        // line's pull request is in the README; a later one (PR 9's, before its merge) may be
        // missing.
        for (method, path, session, token, cell) in &rows {
            let route = find(method, path)
                .unwrap_or_else(|| panic!("README's {method} {path} is not in the table"));
            listed.insert(route.id);
            let bearer = match token.as_str() {
                "yes" => true,
                "no" => false,
                other => panic!("{method} {path}: an unknown token cell {other:?}"),
            };
            assert_eq!(route.bearer, bearer, "{method} {path}: the token cell");
            let all = answers(route);
            for (status, slugs) in readme_answers(cell) {
                assert!(
                    all.iter().any(|a| a.status == status),
                    "{method} {path}: the README answers {status}, the table does not"
                );
                for slug in slugs {
                    // The README sometimes names the rule where the problem's slug would go
                    // ("409 `out-of-order`" on schedule and cancel). The Worker's problem is
                    // `campaign` and the rule is in its detail, so a name the table writes as
                    // `rule` in that status's note counts too.
                    let rule = format!("`{slug}`");
                    assert!(
                        all.iter().any(|a| a.status == status
                            && (a.problem == Some(&slug) || a.note.contains(&rule))),
                        "{method} {path}: the README answers {status} `{slug}`, the table does not"
                    );
                }
            }
            let expected = match session.as_str() {
                "none" | "optional" | "the cookie" => Session::Public,
                "any" => Session::Any,
                "signed in" => Session::SignedIn,
                "`sbx == id`" => Session::Sandbox,
                // "`sbx == id`; a guest for its own persona only": the consent route. The
                // session is a sandbox's, a guest's included, so `Session::Sandbox`; the
                // handler itself refuses a guest on another persona (403 `guest-scope`, which
                // the route lists in its own answers) and no variant says "own persona".
                s if s.starts_with("`sbx == id`; a guest for its own persona only") => {
                    Session::Sandbox
                }
                s if s.contains("the cookie only") => Session::Cookie,
                s if s.contains("Stripe's signature") => Session::Stripe,
                other => panic!("{method} {path}: an unknown session cell {other:?}"),
            };
            assert_eq!(route.session, expected, "{method} {path}");
        }
        for route in ROUTES.iter().filter(|r| r.pr <= covered) {
            assert!(
                listed.contains(route.id),
                "{}: PR {} but not in the README",
                route.id,
                route.pr
            );
        }
    }

    /// `(RouteId, method, pattern, scope, bearer)` for each `route(...)` in the Worker's table.
    fn worker_routes() -> Vec<(String, String, String, String, bool)> {
        let table = WORKER_ROUTES
            .split("pub const ROUTES: &[Route] = &[")
            .nth(1)
            .and_then(|rest| rest.split("\n];").next())
            .expect("the Worker's ROUTES table");
        table
            .split("route(")
            .skip(1)
            .map(|call| {
                let args: Vec<String> = call
                    .split(',')
                    .map(|a| a.trim().trim_matches('"').to_owned())
                    .collect();
                let id = args[0].trim_start_matches("RouteId::").to_owned();
                let scope = args[3].trim_start_matches("Scope::").to_owned();
                let bearer = match args[5].trim_end_matches(')').trim() {
                    "Bearer::Yes" => true,
                    "Bearer::No" => false,
                    other => panic!("{id}: an unknown bearer rule {other:?}"),
                };
                (id, args[1].clone(), args[2].clone(), scope, bearer)
            })
            .collect()
    }

    #[test]
    fn every_worker_route_is_in_the_table() {
        let worker = worker_routes();
        assert!(worker.len() >= 46, "{} Worker routes", worker.len());
        // (c) Every route the Worker serves is in the table, a later pull request's included;
        // workers/api's own test holds (d), every table row up to the README's pull request
        // served.
        for (id, method, pattern, scope, bearer) in &worker {
            let kebab = kebab(id);
            let route = ROUTES
                .iter()
                .find(|r| r.id == kebab)
                .unwrap_or_else(|| panic!("the Worker's {id} ({kebab}) is not in the table"));
            assert_eq!(route.method, method, "{kebab}");
            assert_eq!(shape(route.path), shape(pattern), "{kebab}");
            let expected: &[Session] = match scope.as_str() {
                "Public" => &[Session::Public, Session::Stripe],
                "Session" => &[Session::Any, Session::Sandbox, Session::Cookie],
                "SignedIn" => &[Session::SignedIn],
                other => panic!("{kebab}: unknown scope {other}"),
            };
            assert!(expected.contains(&route.session), "{kebab}: {scope}");
            assert_eq!(route.bearer, *bearer, "{kebab}: bearer");
        }
        let covered = readme_pr();
        for route in ROUTES.iter().filter(|r| r.pr <= covered) {
            assert!(
                worker.iter().any(|(id, ..)| kebab(id) == route.id),
                "{}: PR {} but the Worker does not serve it",
                route.id,
                route.pr
            );
        }
    }

    /// Every contract type whose doc comment names a full route, with the routes it names.
    fn documented_routes() -> BTreeMap<String, Vec<(String, String)>> {
        let mut out: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        let mut doc = String::new();
        for line in LIB.lines() {
            let line = line.trim();
            if let Some(text) = line.strip_prefix("///") {
                doc.push_str(text);
                doc.push(' ');
                continue;
            }
            if line.starts_with("#[") {
                continue;
            }
            let name = line
                .strip_prefix("pub struct ")
                .and_then(|rest| rest.split([' ', '{', '(']).next());
            if let Some(name) = name {
                for code in doc.split('`').skip(1).step_by(2) {
                    let Some((method, path)) = code.split_once(' ') else {
                        continue;
                    };
                    if matches!(method, "GET" | "POST" | "PATCH" | "DELETE")
                        && path.starts_with("/v1/")
                    {
                        out.entry(name.to_owned())
                            .or_default()
                            .push((method.to_owned(), path.to_owned()));
                    }
                }
            }
            doc.clear();
        }
        out
    }

    #[test]
    fn every_documented_route_is_in_the_table_and_reaches_its_type() {
        let documented = documented_routes();
        assert!(documented.len() > 40, "{} types", documented.len());
        let schemas: BTreeMap<String, serde_json::Value> = crate::schemas()
            .into_iter()
            .map(|(file, text)| {
                (
                    file.trim_end_matches(".schema.json").to_owned(),
                    serde_json::from_str(&text).unwrap(),
                )
            })
            .collect();
        // The types a route names, and every type their schemas define.
        let mut reachable = BTreeSet::new();
        for route in ROUTES {
            for name in [route.request, route.response].into_iter().flatten() {
                let (name, _) = type_name(name);
                reachable.insert(name.to_owned());
                if let Some(defs) = schemas[name].get("$defs").and_then(|d| d.as_object()) {
                    reachable.extend(defs.keys().cloned());
                }
            }
        }
        for (name, routes) in &documented {
            for (method, path) in routes {
                assert!(
                    find(method, path).is_some(),
                    "{name}'s doc names {method} {path}, which the table does not have"
                );
            }
            assert!(
                reachable.contains(name),
                "{name}'s doc names a route, but no route reaches it"
            );
        }
    }
}
