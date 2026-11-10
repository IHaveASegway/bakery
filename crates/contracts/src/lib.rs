//! The API's types, written once (docs/architecture.md, "The published language").
//!
//! Each type derives `serde` for the wire and `schemars::JsonSchema` for the web app: the
//! `export-schemas` binary writes one JSON Schema per type into `schemas/`, the web build turns
//! those into TypeScript, and a test fails when the committed schemas are stale.
//!
//! [`routes::ROUTES`] is the route table as data, and [`openapi`] builds the OpenAPI document
//! from it and the schemas (crates/contracts/README.md has the commands).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub mod openapi;
pub mod routes;

/// `GET /v1/health`: the Worker answers, and which build it is. Touches no object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HealthResponse {
    pub status: HealthStatus,
    /// The commit the bundle was built from; `dev` on a laptop.
    pub commit: String,
    /// The API's version.
    pub version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Ok,
}

/// `GET /v1/status`: today's admission state, from the `Control` object.
///
/// The field order is fixed and is the wire order: the day and the sandbox count and cap
/// (PR 2), then the guest and demo-account counts and caps (PR 3), then the status page's
/// counters with their time and state (PR 13), then the breaker's state (PR 17), then the count
/// of sandboxes past their wipe (2026-11-10), then the flag. Readers go by name, so PR 2's
/// smoke check still passes; a new field is added before `flag`.
///
/// The counters are a snapshot of the kept Analytics Engine queries that the 15-minute cron
/// refreshes, never a query per request (docs/operations.md, "Observability").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(transform = require_every_property)]
pub struct StatusResponse {
    /// Today's UTC date, `YYYY-MM-DD`: the key of the daily ledger.
    pub day: String,
    /// Sandboxes admitted today, guests' included.
    pub sandboxes_today: u32,
    /// The most sandboxes admitted in one UTC day.
    pub sandbox_cap: u32,
    /// Guest sandboxes admitted today.
    pub guests_today: u32,
    /// The guests' share of the day's sandboxes.
    pub guest_cap: u32,
    /// Demo accounts created today.
    pub demo_accounts_today: u32,
    /// The most demo accounts created in one UTC day.
    pub demo_account_cap: u32,
    /// The last snapshot of the kept queries; `null` until the first refresh succeeds.
    pub counters: Option<StatusCounters>,
    /// When that snapshot was taken, an RFC 3339 UTC time such as `2026-11-06T10:15:02.114Z`;
    /// `null` with `counters`.
    pub counters_as_of: Option<String>,
    /// Whether the counters are fresh: `live`, `stale` or `unavailable`.
    pub counters_state: CountersState,
    /// The 15-minute cron breaker's state and its last run, kept in `Control`.
    pub breaker: BreakerStatus,
    /// Sandboxes not wiped more than 2 hours after their nightly wipe, the first 10:00 UTC after
    /// each was made (added 2026-11-10). A sandbox made after today's wipe is due at tomorrow's,
    /// so it is not counted. `Control` counts at each 15-minute sweep, so the route reads one
    /// stored number; `null` when the sweep has not counted in the last 20 minutes. Anything above
    /// 0 means a wipe failed (docs/operations.md, "The nightly wipe").
    pub sandboxes_past_wipe: Option<u32>,
    /// The demo's flag.
    pub flag: Flag,
}

/// Every property is required, an `Option` one included: the type always sends its fields,
/// `null` when there is nothing, so a reader can tell an old API (no field) from no value.
fn require_every_property(schema: &mut schemars::Schema) {
    let names: Vec<serde_json::Value> = schema
        .get("properties")
        .and_then(serde_json::Value::as_object)
        .map(|p| p.keys().map(|k| k.as_str().into()).collect())
        .unwrap_or_default();
    if let Some(serde_json::Value::Array(required)) = schema.get_mut("required") {
        for name in names {
            if !required.contains(&name) {
                required.push(name);
            }
        }
    }
}

/// The status page's counters: the kept Analytics Engine queries over the last 24 hours, and
/// the last nightly wipe (docs/operations.md, "Observability"). Counts are sums of the points'
/// sample intervals, so they stay counts when Analytics Engine samples.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(transform = require_every_property)]
pub struct StatusCounters {
    /// `order_placed` points in the last 24 hours.
    pub orders_24h: u32,
    /// `payment_succeeded` points in the last 24 hours.
    pub payments_24h: u32,
    /// `payment_failed` points in the last 24 hours.
    pub payment_failures_24h: u32,
    /// `refund_issued` points in the last 24 hours.
    pub refunds_24h: u32,
    /// `sandbox_created` points in the last 24 hours, to read against the daily cap.
    pub sandboxes_24h: u32,
    /// `dlq` points in the last 24 hours: messages the dead-letter writer kept.
    pub dlq_24h: u32,
    /// The latest `wipe` point; `null` when none is in the dataset.
    pub last_wipe: Option<LastWipe>,
}

/// One nightly wipe, as its `wipe` point recorded it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LastWipe {
    /// When the point was written, at the wipe's end: an RFC 3339 UTC time such as
    /// `2026-11-06T10:00:04Z`.
    pub at: String,
    /// Sandboxes the wipe ended.
    pub sandboxes: u32,
    /// Objects those sandboxes emptied, each Sandbox and its children.
    pub objects: u32,
    /// Milliseconds from the 10:00 UTC cron to the wipe's last run.
    pub ms: u32,
}

/// How fresh `counters` are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CountersState {
    /// Refreshed within the last 20 minutes.
    Live,
    /// An older snapshot: the last refresh failed, or none has run for 20 minutes. The
    /// failure's reason is in the Worker's log only.
    Stale,
    /// No snapshot yet.
    Unavailable,
}

/// The 15-minute cron breaker, as `Control` keeps it (kill switch L0; docs/cost.md,
/// "Guardrails"). Every property is sent, `null` or empty when there is nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(transform = require_every_property)]
pub struct BreakerStatus {
    /// `unconfigured` until the breaker's first configured run, then `armed`, `read-only` or
    /// `off`. It only rises; a person resets it.
    pub state: BreakerState,
    /// When the state last changed, an RFC 3339 UTC time; `null` while `unconfigured`.
    pub since: Option<String>,
    /// When the last run's window was handed to `Control`, an RFC 3339 UTC time.
    pub last_run: Option<String>,
    /// The last window's usage priced in dollars with four decimals, such as `"0.0123"`.
    pub last_usd: Option<String>,
    /// The meters the last run could not read, counted as 0, such as `["rows_written"]`.
    pub unread: Vec<String>,
}

/// The breaker's state, in the order it rises.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum BreakerState {
    /// No run has had its token, ids and lines: the status keeps saying so.
    Unconfigured,
    /// Running, and no window has crossed a line.
    Armed,
    /// A window crossed a line: the flag was raised to `read-only`.
    ReadOnly,
    /// A window crossed the `off` line, or crossed a line again after `read-only`: the flag is
    /// `off` and the WAF kill rule is enabled.
    Off,
}

impl BreakerState {
    /// The text stored in `Control`'s `breaker_state` table, the same as on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            BreakerState::Unconfigured => "unconfigured",
            BreakerState::Armed => "armed",
            BreakerState::ReadOnly => "read-only",
            BreakerState::Off => "off",
        }
    }

    pub fn parse(text: &str) -> Option<BreakerState> {
        match text {
            "unconfigured" => Some(BreakerState::Unconfigured),
            "armed" => Some(BreakerState::Armed),
            "read-only" => Some(BreakerState::ReadOnly),
            "off" => Some(BreakerState::Off),
            _ => None,
        }
    }
}

/// The demo's mode, set in `Control` (kill switch L1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Flag {
    /// Everything works.
    Live,
    /// Reads work; commands get 503 `read-only`. Signing in, "Wipe now" and Stripe's webhook
    /// still work. True of every route since 2026-11-10 (roadmap R85); until then only new
    /// sandboxes and demo accounts were refused.
    ReadOnly,
    /// Only the storefront's static pages, `GET /v1/health`, `GET /v1/status` and Stripe's
    /// webhook work; every other route gets 503 `off` (every route since 2026-11-10, roadmap R85).
    Off,
}

impl Flag {
    /// The text stored in `Control`'s `flags` table, the same as on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Flag::Live => "live",
            Flag::ReadOnly => "read-only",
            Flag::Off => "off",
        }
    }

    pub fn parse(text: &str) -> Option<Flag> {
        match text {
            "live" => Some(Flag::Live),
            "read-only" => Some(Flag::ReadOnly),
            "off" => Some(Flag::Off),
            _ => None,
        }
    }
}

/// An error body, `application/problem+json` (RFC 9457).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Problem {
    /// A URI reference naming the problem type; `about:blank` when the status says it all.
    #[serde(rename = "type")]
    pub problem_type: String,
    /// A short summary that does not change between occurrences.
    pub title: String,
    /// The HTTP status code.
    pub status: u16,
    /// What went wrong this time, for a person to read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The request path this occurrence concerns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    /// An extension member (RFC 9457, section 3.2), set only on the `slot-full` and `hold-lost`
    /// problems: the start of the next pickup slot with a place free that day, a business time
    /// such as `2026-11-07T10:15:00-07:00`. Absent when nothing later that day is free, and on
    /// every other problem.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_free: Option<String>,
}

/// Where the problem types' pages live, on the storefront; the pages arrive with the API docs
/// in PR 10.
pub const PROBLEM_BASE: &str = "https://bakery.ihaveasegway.com/problems/";

impl Problem {
    /// A problem with its own type, `https://bakery.ihaveasegway.com/problems/<slug>`. The slug
    /// is a constant in the router (`origin`, `session`, `sandbox-cap` and the rest), and the
    /// title is the same for every occurrence.
    pub fn typed(slug: &str, status: u16, title: &str, detail: impl Into<String>) -> Problem {
        Problem {
            problem_type: format!("{PROBLEM_BASE}{slug}"),
            title: title.to_owned(),
            status,
            detail: Some(detail.into()),
            instance: None,
            next_free: None,
        }
    }

    /// A problem whose type is `about:blank`, so its title is the status's reason phrase.
    pub fn status(status: u16, title: &str) -> Problem {
        Problem {
            problem_type: "about:blank".to_owned(),
            title: title.to_owned(),
            status,
            detail: None,
            instance: None,
            next_free: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Problem {
        self.detail = Some(detail.into());
        self
    }

    pub fn with_instance(mut self, instance: impl Into<String>) -> Problem {
        self.instance = Some(instance.into());
        self
    }
}

/// How a session signed in. A guest has no account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Guest,
    Google,
    Github,
    Demo,
}

/// `GET /v1/session`, and the answer to a demo sign-in: what the cookie says, read without an
/// object call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionResponse {
    pub kind: SessionKind,
    /// The account id, 64 hex characters; `null` for a guest.
    pub account: Option<String>,
    /// The current sandbox's ULID, if any.
    pub sandbox: Option<String>,
    /// When the cookie stops being accepted, a wall time such as `2026-11-05T12:00:00.000Z`.
    pub expires_at: String,
}

/// Whose a sandbox is: a guest's, behind Turnstile, or a signed-in account's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SandboxKind {
    Guest,
    Account,
}

/// A sandbox's lifecycle (docs/domain.md, "Sandbox").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SandboxState {
    Seeding,
    Live,
    /// Every command gets 410 from here on.
    Wiping,
    Wiped,
}

/// The sandbox's fault switches: the Queue Lab's broken subscriber, live. `kitchen` makes the
/// Kitchen refuse every delivery with 503, so a message retries three times and lands in the
/// dead-letter queue (PR 4); `inbox` does the same to the Inbox when it arrives (PR 8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Faults {
    pub inbox: bool,
    pub kitchen: bool,
}

/// The faults a visitor may set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FaultName {
    Inbox,
    Kitchen,
}

impl FaultName {
    /// The name stored in the Sandbox's `faults` table, the same as on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            FaultName::Inbox => "inbox",
            FaultName::Kitchen => "kitchen",
        }
    }
}

/// `POST /v1/sandboxes` (201 or 200) and `GET /v1/sandboxes/{id}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SandboxResponse {
    /// The sandbox's ULID.
    pub id: String,
    pub kind: SandboxKind,
    pub state: SandboxState,
    /// A wall time.
    pub born: String,
    /// The first 10:00 UTC after `born`, a wall time.
    pub wipe_at: String,
    /// The seed the sandbox was generated from. A JSON number: JavaScript reads it exactly only
    /// below 2^53, so the router mints seeds in that range.
    pub seed: u64,
    /// The visitor's customer persona: the seed's first customer's ULID. Orders the visitor
    /// places are this customer's.
    pub persona: String,
    /// The persona's synthetic display name, from the seed: the Payment Element's billing name.
    pub persona_name: String,
    /// The persona's synthetic address, from the seed: the Payment Element's billing address,
    /// so the visitor types none (ADR 0007, decision 6).
    pub persona_address: PersonaAddress,
    /// The persona's delivery zone, `z1` to `z3`: their place's, which a delivery goes to (since
    /// 2026-11-10, roadmap R69). `null` only when the persona's place is not known.
    #[serde(default)]
    pub persona_zone: Option<String>,
    /// Business time minus wall time, in seconds (docs/architecture.md, "Time travel").
    pub clock_offset_s: i64,
    /// Bumped by every clock advance.
    pub clock_v: u32,
    /// Bumped by every API token rotation.
    pub token_v: u32,
    pub faults: Faults,
    /// Registered child objects: the Catalog, the Kitchen and the 12 seeded orders once
    /// seeding is done, then one more for each order placed.
    pub children: u32,
}

/// A made-up address, labelled synthetic in its first line, passed to Stripe's
/// `confirmPayment` as the billing address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PersonaAddress {
    /// `<place label>, unit <n> (synthetic)`, such as `p17, unit 3 (synthetic)`.
    pub line1: String,
    pub city: String,
    /// A two-letter state code.
    pub state: String,
    pub postal_code: String,
    /// An ISO 3166-1 alpha-2 code.
    pub country: String,
}

/// `POST /v1/auth/demo`. The password never reaches an object, a log or this type's `Debug`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DemoSignupRequest {
    /// 12 to 128 characters, no composition rules.
    pub password: String,
    pub turnstile_token: String,
}

impl std::fmt::Debug for DemoSignupRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DemoSignupRequest { .. }")
    }
}

/// `201` from `POST /v1/auth/demo`: the generated username, shown once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DemoSignupResponse {
    /// `baker-` and four characters, such as `baker-7f3k`.
    pub username: String,
}

/// `POST /v1/auth/demo/signin`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DemoSigninRequest {
    pub username: String,
    pub password: String,
}

impl std::fmt::Debug for DemoSigninRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DemoSigninRequest { .. }")
    }
}

/// `POST /v1/sandboxes`. A guest needs `turnstile_token`; an account that already has a live
/// sandbox gets it back unless `replace` is true.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateSandboxRequest {
    #[serde(default)]
    pub turnstile_token: Option<String>,
    #[serde(default)]
    pub replace: bool,
}

/// `POST /v1/sandboxes/{id}/faults`, signed-in sessions only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FaultRequest {
    pub fault: FaultName,
    pub on: bool,
}

/// The answer to a fault change: every switch as it now stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FaultsResponse {
    pub faults: Faults,
}

/// `DELETE /v1/sandboxes/{id}`, "Wipe now": the sandbox is gone when this answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WipedResponse {
    pub id: String,
    /// Always `wiped`.
    pub state: SandboxState,
}

impl WipedResponse {
    pub fn new(id: impl Into<String>) -> WipedResponse {
        WipedResponse {
            id: id.into(),
            state: SandboxState::Wiped,
        }
    }
}

/// Pickup at the counter, or delivery to a zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum OrderKind {
    Pickup,
    Delivery,
}

/// One line of an order as the customer asks for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrderLineRequest {
    /// A variant slug from the menu, such as `croissant/box-6`.
    pub variant: String,
    /// 1 to 24.
    pub qty: u16,
}

/// `POST /v1/sandboxes/{id}/orders`. The customer is the sandbox's persona; the prices come
/// from the menu version the Catalog publishes when the order is placed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrderRequest {
    pub kind: OrderKind,
    /// The pickup slot's or delivery window's start, a business time such as
    /// `2026-11-07T09:45:00-07:00`.
    pub slot: String,
    /// A delivery's zone, which the customer's place decides (since 2026-11-10, roadmap R69): left
    /// out, the server uses the persona's (`persona_zone` on the sandbox); named, it must be that
    /// zone, or the order is 422 `order` with the rule `wrong-zone`. Absent for a pickup.
    #[serde(default)]
    pub zone: Option<String>,
    /// 1 to 20 lines.
    pub lines: Vec<OrderLineRequest>,
    /// At most 140 characters, with no email address, phone number, card number or URL.
    #[serde(default)]
    pub note: Option<String>,
}

/// An order's state (docs/domain.md, "Order", the diagram).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    Placed,
    Confirmed,
    Expired,
    Cancelled,
    RefundPending,
    InProduction,
    Ready,
    PickedUp,
    OutForDelivery,
    Delivered,
    Closed,
}

/// A placed line, priced from the menu version the order names; never repriced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrderLineResponse {
    pub item: String,
    pub variant: String,
    pub qty: u16,
    pub unit_cents: i64,
}

/// `201` from placing an order (`200` with `Idempotent-Replayed: true` for the same key again),
/// `GET /v1/sandboxes/{id}/orders/{oid}`, and the answer to a cancel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrderResponse {
    /// The order's ULID.
    pub id: String,
    pub status: OrderStatus,
    pub kind: OrderKind,
    /// A business time.
    pub slot: String,
    pub zone: Option<String>,
    pub lines: Vec<OrderLineResponse>,
    pub subtotal_cents: i64,
    pub tax_cents: i64,
    pub total_cents: i64,
    /// When the order was placed, a business time.
    pub placed_at: String,
    /// When an unpaid order expires, 15 minutes of business time after `placed_at`.
    pub held_until: String,
    pub note: Option<String>,
    /// The published menu version the prices came from.
    pub menu_version: u32,
    /// The `seq` of the order's latest event.
    pub events_seq: u64,
    /// When each step of the order happened, a business time as `placed_at` is, read from the
    /// order's own events; `null` for a step it has not taken (added 2026-11-10, roadmap R94).
    #[serde(default)]
    pub step_times: OrderStepTimes,
}

/// When each step of an order happened: the business time of the first event that took it there
/// (`OrderPlaced`, `OrderPaid`, `OrderProductionStarted`, `OrderReady`, `OrderPickedUp`,
/// `OrderOutForDelivery`, `OrderDelivered`), the clock `placed_at` reads. A step the order has
/// not taken is `null`; a pickup never has the two delivery steps, and a delivery never has
/// `picked_up`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(transform = require_every_property)]
pub struct OrderStepTimes {
    pub placed: Option<String>,
    pub paid: Option<String>,
    pub in_production: Option<String>,
    pub ready: Option<String>,
    pub picked_up: Option<String>,
    pub out_for_delivery: Option<String>,
    pub delivered: Option<String>,
}

/// What a staff edit may set on a menu item's status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MenuItemStatus {
    Paused,
    Available,
}

/// `PATCH /v1/sandboxes/{id}/menu/items/{slug}`, signed-in sessions only. A price is a draft
/// until `POST .../menu/publish`: with `variant`, that variant's price; without it, every variant
/// of the item gets the one price, as before `variant` was added. A pause or a resume publishes
/// that one item at once.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuItemPatch {
    #[serde(default)]
    pub price_cents: Option<i64>,
    #[serde(default)]
    pub status: Option<MenuItemStatus>,
    /// The one variant `price_cents` is for, by its slug, such as `country-loaf/half` (added
    /// 2026-11-10, roadmap R86). It needs `price_cents` (422 `menu`, rule
    /// `variant-without-price`), and a slug that is not one of this item's variants is refused
    /// (422 `menu`, rule `unknown-variant`).
    #[serde(default)]
    pub variant: Option<String>,
}

/// `PATCH /v1/sandboxes/{id}/menu/tax-rate`, signed-in sessions only: the tax rate every order
/// placed from the next version pays, 0 to 3,000 basis points (8.50% is 850). It is not a draft:
/// the Catalog publishes it at once as a version of its own, and any price drafts keep waiting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaxRateRequest {
    pub tax_bp: u32,
}

/// The demo's rate before staff change it, 1,000 bp or 10.00%: `DEFAULT_TAX_BP` in the domain.
pub const DEFAULT_TAX_BP: u32 = 1_000;

fn default_tax_bp() -> u32 {
    DEFAULT_TAX_BP
}

/// The answer to a staff edit or a publish: the published version and the items with drafts
/// still waiting for a publish.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuEditResponse {
    pub version: u32,
    pub pending: Vec<String>,
}

/// An item's stored lifecycle; the menu lists `available` and `paused` items.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MenuItemState {
    Draft,
    Available,
    Paused,
    Retired,
}

/// A seasonal window, `MM-DD` to `MM-DD` inclusive, wrapping over the new year when `from` is
/// after `to`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuSeason {
    pub from: String,
    pub to: String,
}

/// More than `over_qty` of one variant needs `lead_minutes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuBulkLead {
    pub over_qty: u32,
    pub lead_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuVariant {
    /// `<item slug>/<suffix>`, such as `croissant/box-6`.
    pub slug: String,
    pub label: String,
    pub price_cents: i64,
    pub lead_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuItem {
    pub slug: String,
    pub name: String,
    /// From the nine major US allergens, such as `wheat` and `tree-nuts`.
    pub allergens: Vec<String>,
    pub daily_cap: u32,
    /// `mon` to `sun`.
    pub days_baked: Vec<String>,
    pub season: Option<MenuSeason>,
    pub bulk_lead: Option<MenuBulkLead>,
    pub pickup_only: bool,
    pub status: MenuItemState,
    pub variants: Vec<MenuVariant>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuCategory {
    pub slug: String,
    pub name: String,
    pub items: Vec<MenuItem>,
}

/// `GET /v1/sandboxes/{id}/menu`: the published menu, with `ETag: "v<version>"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuResponse {
    pub version: u32,
    /// The tax rate in basis points that an order placed against this version pays; staff set
    /// it with `PATCH .../menu/tax-rate`. A menu cached before the field existed leaves it out,
    /// which reads as the default, 1,000.
    #[serde(default = "default_tax_bp")]
    pub tax_bp: u32,
    pub categories: Vec<MenuCategory>,
}

/// One item with edits waiting for a publish, as its draft copy stands: the variants carry
/// their draft prices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuDraft {
    pub slug: String,
    pub name: String,
    /// The draft copy's status: `draft` for an item never published, else the published one,
    /// since a pause or a resume is never a draft.
    pub status: MenuItemState,
    pub variants: Vec<MenuVariant>,
}

/// `GET /v1/sandboxes/{id}/menu/drafts`, signed-in sessions only: every item with a draft
/// waiting for `POST .../menu/publish`, in slug order, and the published version. The console's
/// menu editor reads it with `GET .../menu` on load and again after a publish, and shows each
/// item's waiting price under its published one, so a draft made before a reload is still shown.
/// The published prices are in the menu it already holds, so they are not repeated here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuDraftsResponse {
    pub version: u32,
    pub pending: Vec<MenuDraft>,
}

/// `POST /v1/sandboxes/{id}/traffic`, signed-in sessions only: simulated orders a minute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TrafficRequest {
    /// 1 to 6.
    pub rate: u8,
}

/// `GET /v1/sandboxes/{id}/traffic`, and the answer to starting or stopping it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TrafficResponse {
    pub running: bool,
    /// Orders a minute of the current or last run; 0 before the first start.
    pub rate: u8,
    /// Minutes of traffic this sandbox used today, UTC.
    pub minutes_used: u16,
    /// What is left of the day's cap, 30 minutes (docs/cost.md, "Guardrails").
    pub minutes_left: u16,
    /// Orders the simulator placed today.
    pub orders: u16,
}

/// One message the Queue gave up on after 3 retries, from `GET /v1/sandboxes/{id}/dead-letters`
/// (an array of these), and the answer to a redrive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeadLetter {
    /// The event's ULID: the key a redrive sends it again with.
    pub id: String,
    /// The event type, such as `OrderPlaced`.
    #[serde(rename = "type")]
    pub event_type: String,
    /// The producing object's name.
    pub stream: String,
    pub seq: u64,
    /// The last delivery error, as a reason code such as `Kitchen answered 503`.
    pub error: String,
    /// When it was dead-lettered, a wall time.
    pub at: String,
    /// Made while the bakery was `off`, or within two minutes of the flag's last change (added
    /// 2026-11-10): such a letter is kept and not counted on the status page. It says when the
    /// message died, not why: a real fault while `off` is marked too (docs/operations.md, "Breaker
    /// tripped"). A redrive works the same either way.
    pub made_while_off: bool,
}

/// How far one clock advance moves business time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum ClockStep {
    /// 15 minutes.
    #[serde(rename = "15m")]
    Minutes15,
    /// One hour.
    #[serde(rename = "1h")]
    Hour,
    /// One day: 86,400 seconds of business time, so across a clock change the local time moves
    /// by an hour.
    #[serde(rename = "1d")]
    Day,
    /// To the next 07:00 on an open day (Tuesday to Sunday) after business time now.
    #[serde(rename = "next-opening")]
    NextOpening,
}

/// `POST /v1/sandboxes/{id}/clock`, signed-in sessions only: move business time forward. The
/// offset only grows, at most 14 days in total.
///
/// Give exactly one of `step` and `minutes`: `step` is the named step, `minutes` the older form
/// (a positive count). The Worker answers 422 `clock` with rule `not-positive` for no
/// advance or for both fields, and rule `offset-cap` when the 14 days would be passed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClockRequest {
    /// `15m`, `1h`, `1d` or `next-opening`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<ClockStep>,
    /// The compatible older form: minutes to advance, 1 or more.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u32>,
}

/// The business clock after an advance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClockResponse {
    /// Seconds of business time ahead of wall time, 0 to 14 days.
    pub clock_offset_s: i64,
    /// Counts the advances; a child that has not heard of the latest one is retried.
    pub clock_v: u32,
    /// Business time now, such as `2026-11-07T09:42:10-07:00`, shown at America/Denver's offset
    /// at that instant (`-06:00` in summer).
    pub business_now: String,
    /// The step applied, in its wire form: `15m`, `1h`, `1d`, `next-opening`, or `<n>m` for the
    /// older `minutes` form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
}

/// One pickup slot of a day's schedule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SlotView {
    /// The slot's start, a business time such as `2026-07-14T14:45:00-06:00`.
    pub start: String,
    /// Places in the slot.
    pub capacity: u16,
    /// Places held, reserved or fulfilled; released places do not count. Capped at 65,535.
    pub taken: u16,
    /// `capacity` minus `taken`, 0 when over-booked after a capacity cut.
    pub free: u16,
}

/// One delivery zone of a day's schedule. A zone's stops are shared by its three windows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ZoneView {
    /// `z1`, `z2` or `z3`.
    pub zone: String,
    /// Stops in the zone for the day.
    pub capacity: u16,
    /// Stops held, reserved or fulfilled.
    pub taken: u16,
    /// `capacity` minus `taken`, 0 when over-booked.
    pub free: u16,
    /// The zone's window starts, 09:00, 11:00 and 13:00, business times.
    pub windows: Vec<String>,
}

/// One item's daily cap and use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ItemCapView {
    /// The item's slug.
    pub item: String,
    /// The most the kitchen bakes of it in a day; `null` when the item has no cap.
    pub daily_cap: Option<u32>,
    /// Quantity on the day's places that count (held, reserved or fulfilled), variants summed.
    pub used: u32,
}

/// The day's catering capacity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CateringView {
    /// Events the bakery takes in a day.
    pub capacity: u16,
    /// Events held, reserved or fulfilled.
    pub taken: u16,
}

/// One line of the bake list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BakeLineView {
    /// The item's slug.
    pub item: String,
    /// Quantity to bake for this start, variants summed.
    pub qty: u32,
    /// The slot or window start the quantity is for; an item ordered for two starts has two lines.
    pub start: String,
    /// True for a catering event's line: `item` is the package's slug and `qty` the people it
    /// feeds, not a count of items. Absent for an order's line.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub catering: bool,
}

/// The day's production plan, from the reserved and fulfilled places only; a held place waiting
/// for payment is not on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BakeListView {
    /// Counts the plan's changes; 0 before the first reservation.
    pub version: u32,
    pub lines: Vec<BakeLineView>,
}

/// `GET /v1/sandboxes/{id}/schedule/{date}`, and the answer to a capacity change: one bakery
/// day's places, caps and bake list. It mirrors the Schedule aggregate's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScheduleResponse {
    /// The bakery day, `YYYY-MM-DD`.
    pub date: String,
    /// Whether the bakery opens that day (Tuesday to Sunday); a closed day refuses every hold.
    pub open: bool,
    /// The 32 pickup slots, 07:00 to 14:45, in time order.
    pub slots: Vec<SlotView>,
    /// The three delivery zones, `z1` to `z3`.
    pub zones: Vec<ZoneView>,
    /// The items with a cap or a use that day, by slug; an item with no entry is uncapped.
    pub items: Vec<ItemCapView>,
    pub catering: CateringView,
    pub bake_list: BakeListView,
    /// The menu version the item caps came from; 0 before the first refresh.
    pub menu_version: u32,
}

/// `PATCH /v1/sandboxes/{id}/schedule/{date}/capacity`, signed-in sessions only: set one
/// capacity for the day. The answer is the day's `ScheduleResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CapacityRequest {
    /// What to change, in the domain's grammar: `slot:HH:MM` (a slot start on the quarter hour,
    /// such as `slot:14:45`), `zone:z1` (to `z3`), `item:<slug>` (such as `item:croissant`) or
    /// `catering`.
    pub target: String,
    /// The new capacity. Places already taken stay; a cut below them only stops new ones.
    pub capacity: u16,
}

/// Where a payment stands (docs/domain.md, the Billing rows).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PaymentStatus {
    /// Asked for; waiting for the browser.
    Created,
    Succeeded,
    /// The last attempt was declined; the same intent can still be paid.
    Failed,
    Canceled,
}

/// `POST /v1/sandboxes/{id}/orders/{oid}/payment`: what the browser needs to mount Stripe's
/// Payment Element. `client_secret` is a one-time value for the browser: it is not stored, not
/// logged, and left out of this type's `Debug`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PaymentResponse {
    /// Billing's id for the payment, a ULID.
    pub payment: String,
    /// Stripe's `pi_..._secret_...`, for `<Elements options={{ clientSecret }}>`.
    pub client_secret: String,
    /// The sandbox's `pk_test_` key, when the API has one to give; the storefront's own build
    /// value otherwise.
    #[serde(default)]
    pub publishable_key: Option<String>,
    pub amount_cents: i64,
    pub status: PaymentStatus,
}

impl std::fmt::Debug for PaymentResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PaymentResponse")
            .field("payment", &self.payment)
            .field("publishable_key", &self.publishable_key)
            .field("amount_cents", &self.amount_cents)
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

/// Why staff give money back: a choice from a list, never free text (docs/domain.md, "Free
/// text and personal data"). The other two reasons the domain knows, `cancelled` and
/// `payment_late`, are the system's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RefundReason {
    MissingItem,
    Quality,
    Goodwill,
}

/// `POST /v1/sandboxes/{id}/orders/{oid}/refund`, staff only. No `amount_cents` refunds all
/// that is left; refunding all that is left of an order not yet closed cancels it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RefundRequest {
    #[serde(default)]
    pub amount_cents: Option<i64>,
    pub reason: RefundReason,
}

/// The answer to a refund request: accepted, and on its way to Stripe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RefundResponse {
    /// The refund's ULID: the id of the order's `OrderRefundRequested` event, which Billing
    /// keeps the refund under.
    pub refund: String,
    pub amount_cents: i64,
    /// The order's status after the request: unchanged for a part, `refund_pending` for the
    /// whole of an order not yet closed.
    pub status: OrderStatus,
}

/// What a payment pays for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PaymentPurpose {
    Order,
    Deposit,
    Balance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LedgerKind {
    Payment,
    Refund,
}

/// One line of the ledger: a payment's success or a refund issued.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LedgerEntry {
    /// The business time of the event that made it.
    pub at: String,
    pub kind: LedgerKind,
    pub purpose: PaymentPurpose,
    /// The order or catering job's ULID.
    #[serde(rename = "ref")]
    pub reference: String,
    /// Signed: positive for a payment, negative for a refund.
    pub amount_cents: i64,
    /// Stripe's id: the intent's `pi_...` for a payment, the refund's `re_...` for a refund;
    /// `seed:<payment>` for a seeded order's payment, which the seed made and Stripe never saw,
    /// and `seed:<refund>` for its refund, which Billing made alone.
    pub stripe_id: String,
}

/// `GET /v1/sandboxes/{id}/billing/ledger`: every entry in order, and the totals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LedgerResponse {
    pub entries: Vec<LedgerEntry>,
    /// `paid_cents - refunded_cents`.
    pub net_cents: i64,
    pub paid_cents: i64,
    /// A positive amount.
    pub refunded_cents: i64,
}

/// A catering event's state (docs/domain.md, "CateringEvent", the diagram). `paid` is passed
/// through in the same step as `closed`, so a response never shows it today; it is listed
/// because the diagram has it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CateringState {
    Inquiry,
    Quoted,
    /// Accepted, the day held for 15 minutes of business time while the deposit is paid.
    Accepted,
    Confirmed,
    InProduction,
    Delivered,
    Invoiced,
    Paid,
    Closed,
    Declined,
    Expired,
    Cancelled,
}

/// `POST /v1/sandboxes/{id}/catering`, the customer's inquiry; the customer is the sandbox's
/// persona. `201` with the `CateringResponse` (`200` with `Idempotent-Replayed: true` for the
/// same key again). A refused inquiry is `422` problem+json naming its rule: `headcount`,
/// `unknown-package`, `unknown-venue`, `closed-day`, `catering-lead` (its detail names the
/// 7-business-day rule and the earliest date allowed), `catering-too-far` (since 2026-11-10:
/// its detail names the 365-day bound and the latest date allowed), or `brief-too-long`,
/// `brief-email`, `brief-phone`, `brief-card-number` or `brief-url`, which never echo the brief.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CateringInquiryRequest {
    /// The event day, `YYYY-MM-DD`: an open day (Tuesday to Sunday) at least 7 business days
    /// after today and at most 365 days after it.
    pub date: String,
    /// 10 to 200 people.
    pub headcount: u16,
    /// A package slug, such as `breakfast-spread` (`pastry-platter`, `breakfast-spread`,
    /// `lunch-boxes`, `celebration-cake-and-coffee`).
    pub package: String,
    /// A venue, `v1` to `v6`.
    pub venue: String,
    /// At most 500 characters, with no email address, phone number, card number or URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
}

/// `POST /v1/sandboxes/{id}/catering/{cid}/quote`, staff only. `200` with the
/// `CateringResponse`, now `quoted`; `409` problem of type `catering` naming the rule
/// (`out-of-order`) once the inquiry is past `inquiry`; `422` `quote-total` for a total under 1
/// cent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct QuoteRequest {
    /// A staff override of the total, in cents, at least 1. Absent: the package's price per
    /// head times the headcount. The deposit is 25% of the total, rounded half-up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_cents: Option<i64>,
}

/// Why a confirmed catering event is cancelled: a choice from a list, never free text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CateringCancelReason {
    CustomerChange,
    VenueLost,
    Other,
}

/// `POST /v1/sandboxes/{id}/catering/{cid}/cancel`, by the customer or staff, as the session
/// is. Only a `confirmed` event is cancelled: `200` with the `CateringResponse`, `cancelled`,
/// its `refund_deposit` true when the event day is more than 7 days away; `409` problem of type
/// `catering` naming the rule (`out-of-order`) in any other state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CateringCancelRequest {
    pub reason: CateringCancelReason,
}

/// Why staff decline an inquiry: a choice from a list, never free text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeclineReason {
    TooSoon,
    OverCapacity,
    Other,
}

/// `POST /v1/sandboxes/{id}/catering/{cid}/decline`, staff only, while the inquiry is an
/// `inquiry`. `200` with the `CateringResponse`, `declined`; `409` problem of type `catering`
/// naming the rule (`out-of-order`) once it is quoted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeclineRequest {
    pub reason: DeclineReason,
}

/// A catering reminder: what it is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReminderKind {
    /// 3 business days after the quote, while it is still quoted.
    FollowUp,
    /// 2 days before the event, while it is confirmed or in production.
    EventSoon,
    /// When the balance invoice is 7 days old, while it is unpaid.
    InvoiceDue,
}

/// A reminder still to come, and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CateringReminder {
    pub kind: ReminderKind,
    /// A business time, such as `2026-11-19T07:00:00-07:00`.
    pub at: String,
}

/// `GET /v1/sandboxes/{id}/catering/{cid}`, and the answer to every catering command: the
/// inquiry, `quote`, `decline`, `accept`, `cancel`, and staff's `production` and `delivered`.
/// It mirrors the CateringEvent aggregate's state. A refused step is `409` problem of type
/// `catering` naming the rule (`out-of-order`, `quote-expired`); an `accept` when the day's two
/// catering places are taken is `409` `slot-full`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CateringResponse {
    /// The catering event's ULID.
    pub catering: String,
    pub state: CateringState,
    /// The event day, `YYYY-MM-DD`.
    pub date: String,
    pub headcount: u16,
    pub package: String,
    pub venue: String,
    /// The brief, shown back to its own sandbox only, as text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    /// From the quote on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_cents: Option<i64>,
    /// 25% of the total, rounded half-up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deposit_cents: Option<i64>,
    /// `total_cents - deposit_cents`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub balance_cents: Option<i64>,
    /// When the quote stops being accepted, a business time: 07:00 on the 14th business day
    /// after the quote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<String>,
    /// The deposit's payment ULID, once paid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deposit_payment: Option<String>,
    /// The balance invoice's ULID, once issued.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invoice: Option<String>,
    /// The balance invoice's due date, `YYYY-MM-DD`, 7 days after delivery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invoice_due: Option<String>,
    /// The reminders still to come, earliest first; empty once the event ends.
    pub reminders: Vec<CateringReminder>,
    /// Set on a cancellation: whether the deposit goes back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refund_deposit: Option<bool>,
    /// The inquiry's business time.
    pub created_at: String,
    /// The business time of the latest change.
    pub updated_at: String,
}

/// `GET /v1/sandboxes/{id}/catering`: the sandbox's catering events, the seeded eight and any
/// since, by date.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CateringListResponse {
    pub events: Vec<CateringResponse>,
}

// ---------------------------------------------------------------------------------------------
// CRM, campaigns and the inbox (PR 8; docs/domain.md, "Campaign"; docs/architecture.md, "A
// campaign send"). Reads are open to any session of the sandbox; every staff action answers a
// guest 403 `guest-scope`. A path naming a customer, a campaign or a message the sandbox does not
// hold is 404.
// ---------------------------------------------------------------------------------------------

/// `GET /v1/sandboxes/{id}/customers/{cid}`, and the answer to a consent change: one persona as
/// Crm's projection holds it. Every field is synthetic; there is no contact of any kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CustomerResponse {
    /// The customer's ULID.
    pub customer: String,
    /// Two generic words, such as `Drizzle Trowel`.
    pub display_name: String,
    /// One to three item slugs.
    pub preferences: Vec<String>,
    /// `z1` to `z3`.
    pub home_zone: String,
    /// `p1` to `p64`, a map label: the only address there is.
    pub place: String,
    /// Consent to marketing: a campaign goes only to customers for whom it is true at the send.
    pub marketing: bool,
    /// Loyalty points: one per whole dollar paid, less refunds; never below zero.
    pub loyalty_points: i64,
    /// Orders paid, or closed in the seed's history, and not cancelled.
    pub orders: u32,
    /// The latest such order's slot, a business time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_order_at: Option<String>,
    /// Catering inquiries.
    pub catering: u32,
}

/// `GET /v1/sandboxes/{id}/customers`: the 60 personas, by id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CustomerListResponse {
    pub customers: Vec<CustomerResponse>,
}

/// One line of a timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TimelineEntry {
    /// The event's business time.
    pub at: String,
    /// The event's catalog name, such as `OrderPaid`.
    #[serde(rename = "type")]
    pub event_type: String,
    /// The ULID of the order, catering event, message or customer the line is about.
    #[serde(rename = "ref")]
    pub reference: String,
    /// A short fixed sentence with the event's own figures, such as `Paid $22.00`.
    pub label: String,
}

/// `GET /v1/sandboxes/{id}/customers/{cid}/timeline`: the customer's events in business-time
/// order. While a rebuild runs the timeline is partial; `GET .../rebuild` says so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TimelineResponse {
    pub customer: String,
    pub entries: Vec<TimelineEntry>,
}

/// `POST /v1/sandboxes/{id}/customers/{cid}/consent`, by that customer's persona or by staff:
/// `200` with the `CustomerResponse`; the same value again changes nothing and answers `200`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConsentRequest {
    pub marketing: bool,
}

/// A segment: a fixed rule over Crm's projection, evaluated at the business time asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum Segment {
    /// Every persona.
    #[serde(rename = "everyone")]
    Everyone,
    /// An order with a cake line in the last 30 days of business time.
    #[serde(rename = "cake-last-30-days")]
    CakeLast30Days,
    /// Any delivery order.
    #[serde(rename = "delivery-customers")]
    DeliveryCustomers,
    /// No order in the last 60 days of business time.
    #[serde(rename = "lapsed-60-days")]
    Lapsed60Days,
    /// A catering inquiry still open: an inquiry, a quote or an accepted quote.
    #[serde(rename = "catering-leads")]
    CateringLeads,
}

/// `GET /v1/sandboxes/{id}/segments/{segment}`: how many customers the rule holds now, and a
/// few of their ids. Consent is not applied here; a send applies it. An unknown segment is
/// `404`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SegmentResponse {
    pub segment: Segment,
    pub members: u32,
    /// Up to five member ULIDs, smallest first.
    pub sample: Vec<String>,
}

/// `GET /v1/sandboxes/{id}/segments`: every segment, in the fixed order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SegmentListResponse {
    pub segments: Vec<SegmentResponse>,
}

/// A campaign's subject, chosen from a fixed list; staff never type one (Q14).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SubjectTemplate {
    WeekendBake,
    CakeWeek,
    NewSeason,
    WeMissYou,
    CateringSeason,
    ThankYou,
}

/// A campaign's body, chosen from a fixed list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum BodyTemplate {
    Announcement,
    FreshBread,
    CakeOrders,
    SeasonalMenu,
    ComeBack,
    CateringInvite,
}

/// `POST /v1/sandboxes/{id}/campaigns`, staff only: a draft, `201` with the `CampaignResponse`
/// (`200` with `Idempotent-Replayed: true` for the same key again).
/// `PATCH /v1/sandboxes/{id}/campaigns/{cid}` takes the same body and edits a draft: `200`, or
/// `409` problem of type `campaign` naming the rule (`out-of-order`) once it is scheduled, sent
/// or cancelled. A guest gets `403` `guest-scope` on both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignRequest {
    pub subject: SubjectTemplate,
    pub body: BodyTemplate,
    pub segment: Segment,
}

/// `POST /v1/sandboxes/{id}/campaigns/{cid}/schedule`, staff only: `200` with the
/// `CampaignResponse`, now `scheduled`. A `send_at` less than 15 minutes of business time after
/// now is `422` problem naming `schedule-too-soon`, its detail the earliest time allowed; a
/// campaign not in `draft` is `409` `campaign` naming `out-of-order`.
/// `POST .../campaigns/{cid}/cancel` (no body) takes a scheduled campaign back to `draft` and a
/// draft to `cancelled`; a sent one is `409` `campaign` naming `out-of-order`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScheduleRequest {
    /// A business time, such as `2026-11-08T09:00:00-07:00`.
    pub send_at: String,
}

/// Where a campaign is (docs/domain.md, "Campaign", the diagram).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CampaignState {
    Draft,
    Scheduled,
    Sent,
    Cancelled,
}

/// `GET /v1/sandboxes/{id}/campaigns/{cid}`, and the answer to every campaign command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignResponse {
    /// The campaign's ULID.
    pub campaign: String,
    pub state: CampaignState,
    pub subject: SubjectTemplate,
    pub body: BodyTemplate,
    pub segment: Segment,
    /// While scheduled, and after the send: the business time it is due or was sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_at: Option<String>,
    /// The frozen recipients' count: the segment's members with marketing consent at the send.
    pub recipients: u32,
    /// Messages the Inbox delivered, opened and clicked, from its events.
    pub delivered: u32,
    pub opened: u32,
    pub clicked: u32,
}

/// `GET /v1/sandboxes/{id}/campaigns`: every campaign, by id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CampaignListResponse {
    pub campaigns: Vec<CampaignResponse>,
}

/// What a message is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Receipt,
    Ready,
    OnItsWay,
    Refund,
    Declined,
    Acknowledgement,
    Quote,
    Notice,
    Reminder,
    Invoice,
    Campaign,
}

/// One message in the sandbox's inbox, and `GET /v1/sandboxes/{id}/inbox/{mid}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MessageResponse {
    /// The message's ULID.
    pub message: String,
    /// The customer's ULID: the only recipient there is.
    pub to: String,
    pub kind: MessageKind,
    /// The ULID of the order, catering event or campaign it is about.
    #[serde(rename = "ref")]
    pub reference: String,
    /// From a fixed template, filled with the event's own figures; never free text.
    pub subject: String,
    pub body: String,
    /// Business times.
    pub delivered_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clicked_at: Option<String>,
}

/// `GET /v1/sandboxes/{id}/inbox`: the newest messages first, and how many there are in all.
/// `?kind=` keeps one kind, `?to=` one customer's, `?limit=` the newest that many (50 when left
/// out, at most 500). Any session of the sandbox, a guest's included, sees every customer's
/// messages: the persona is not filtered to its own, and `?to=` is how a reader narrows to one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InboxResponse {
    pub messages: Vec<MessageResponse>,
    pub total: u32,
}

/// A catering lead's stage in Crm's pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LeadStage {
    Inquiry,
    Quoted,
    Accepted,
    /// The deposit is paid.
    Won,
    /// Declined, expired or cancelled.
    Lost,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LeadStageView {
    pub stage: LeadStage,
    pub count: u32,
    /// The catering events' ULIDs.
    pub events: Vec<String>,
}

/// `GET /v1/sandboxes/{id}/leads`: every stage, in order, with its catering events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LeadPipelineResponse {
    pub stages: Vec<LeadStageView>,
}

/// One line of the activity log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ActivityEntry {
    pub at: String,
    #[serde(rename = "type")]
    pub event_type: String,
    /// A short fixed sentence from the event's named fields.
    pub summary: String,
}

/// `GET /v1/sandboxes/{id}/activity`: the sandbox's logged events (clock moves, faults,
/// menu and capacity changes, payment intents, orders paid, catering steps, routes, traffic,
/// token rotations, campaigns sent and rebuilds finished), newest first
/// by business time (ties by event id); `?limit=` keeps the newest that many (50 when left out,
/// at most 500). Any session of the sandbox reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ActivityResponse {
    pub entries: Vec<ActivityEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RebuildState {
    Idle,
    Rebuilding,
    Finished,
}

/// `GET /v1/sandboxes/{id}/rebuild`, which any session of the sandbox reads, and `202` from
/// `POST` to it, staff only (a guest gets `403` `guest-scope`): "Rebuild projections" drops
/// Crm's projections and replays its log, 200 events per alarm. A second `POST` (with a new
/// `Idempotency-Key`) while one runs is `409` problem of type `rebuild` and starts nothing; the
/// same key again replays the first `202`. Nothing else is refused during a rebuild: other
/// commands run, reads answer the partial projection with `Projection-State: rebuilding`, and a
/// campaign send that falls due is deferred (logged as `sends_deferred`) until it ends. `GET`
/// says how far the running one is, and `finished` with its `ms` until the next start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RebuildResponse {
    pub state: RebuildState,
    /// Log entries replayed so far.
    pub applied: u32,
    /// The log's length.
    pub total: u32,
    /// Once finished: the wall-clock milliseconds the rebuild took.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms: Option<u32>,
}

/// Where a delivery stop stands (ADR 0012; docs/domain.md, "Ubiquitous language": Stop).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StopStatus {
    /// Placed, not yet paid: shown, in no plan.
    Provisional,
    /// Paid: every plan must carry it.
    Confirmed,
    /// Its order has gone out on its van: still in the plan, not yet delivered.
    OutForDelivery,
    /// Expired or cancelled.
    Removed,
    /// Delivered.
    Completed,
}

/// Who made a plan: the server's savings heuristic or the browser's VROOM solver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanSource {
    Server,
    Browser,
}

/// One stop of the day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StopView {
    /// The order's ULID: what every plan names the stop by.
    pub order: String,
    /// The customer's ULID; the screen shows the persona's made-up address, never the place.
    pub customer: String,
    /// The customer's place, an index into the travel-time matrix, 0 to 63.
    pub place: u8,
    /// The place's label, `p1` to `p64`.
    pub place_label: String,
    /// The delivery window's start, a business time (RFC 3339 with the bakery's offset). The
    /// window is 2 hours long: it closes 120 minutes after this. A plan must reach the stop
    /// between the two, waiting at the door when it is early (rule `window`).
    pub window: String,
    /// `z1`, `z2` or `z3`.
    pub zone: String,
    /// The order's line quantities summed: what the stop takes of a van's capacity.
    pub units: u32,
    pub status: StopStatus,
    /// The stop's number in the published plan, counted from 1 across the vans, van 1's stops
    /// first; `null` when it is in no published plan.
    pub stop: Option<u16>,
    /// The van that carries it in the published plan; `null` when none does.
    pub van: Option<u8>,
}

/// One van of a plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VanPlanView {
    /// 1 to the day's vans.
    pub van: u8,
    /// Order ULIDs, in driving order.
    pub stops: Vec<String>,
    /// The stops' units summed; never over the day's capacity.
    pub units: u32,
    /// The drive, bakery to bakery, from the travel-time matrix.
    pub minutes: u32,
}

/// A plan as the dispatch screen shows it (ADR 0012, decision 5). Its minutes are the server's
/// own arithmetic over the matrix, whoever made the plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PlanView {
    pub source: PlanSource,
    /// A published plan's version. A proposal or submission carries the version it would be
    /// published as when it was made; one at or below the response's `plan_v` is stale.
    pub plan_v: u16,
    /// The vans used, by van; a plan may use fewer than the day has.
    pub vans: Vec<VanPlanView>,
    /// Every van's drive summed.
    pub minutes: u32,
    /// When the last van is back, a business time: the vans leave at 09:00, drive the matrix's
    /// minutes, spend 3 minutes at each door and wait at a door they reach before its window
    /// opens.
    pub last_back: String,
    /// Order ULIDs no van could take. A plan with any cannot be published.
    pub unassigned: Vec<String>,
}

/// The two plans' totals side by side.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ComparisonView {
    pub server_minutes: u32,
    pub browser_minutes: u32,
    /// `(server − browser) / browser × 100`, to one decimal: positive when the heuristic drives
    /// longer. `null` when the browser's plan drives 0 minutes and the server's does not.
    pub gap_percent: Option<f64>,
}

/// `GET /v1/sandboxes/{id}/dispatch/{date}`, which any session of the sandbox reads, and the
/// answer to every dispatch command, which are staff only: one bakery day's stops and plans. It mirrors the Dispatch aggregate's state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DispatchResponse {
    /// The bakery day, `YYYY-MM-DD`.
    pub date: String,
    /// The day's vans, 1 to 4: the last proposal's, 4 before any.
    pub vans: u8,
    /// Units a van carries: the last proposal's, 250 before any.
    pub capacity: u32,
    /// Every stop the day has seen, removed ones included, by order ULID.
    pub stops: Vec<StopView>,
    /// The server's plan from the last `propose`.
    pub proposed: Option<PlanView>,
    /// The browser's plan from the last `plan`, validated.
    pub submitted: Option<PlanView>,
    /// The record: what drivers, the kitchen board and the order status read.
    pub published: Option<PlanView>,
    /// The published plan's version, 0 before the first publish.
    pub plan_v: u16,
    /// Both plans' totals, when there are both; `null` while the browser's solver has not run
    /// or cannot (the page then shows the server's plan alone and says why).
    pub comparison: Option<ComparisonView>,
}

/// `POST /v1/sandboxes/{id}/dispatch/{date}/propose`, staff only: the server's plan for the
/// confirmed stops. The vans and capacity become the day's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProposeRequest {
    /// 1 to 4.
    pub vans: u8,
    /// Units a van carries, at least 1.
    pub capacity: u32,
}

/// One van of the browser's plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PlanRouteRequest {
    /// 1 to the day's vans, each once.
    pub van: u8,
    /// Order ULIDs, in driving order. An empty list is a van left at the bakery.
    pub stops: Vec<String>,
    /// The place the van leaves from, as the solver reports it; it must be the bakery, and is
    /// taken to be when left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<u8>,
    /// The place the van comes back to; the same rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<u8>,
}

/// `POST /v1/sandboxes/{id}/dispatch/{date}/plan`, staff only: the plan VROOM made in the
/// browser. It carries no minutes: the server computes them from the matrix. Refused with 422
/// `stop-missing`, `stop-twice`, `stop-unknown`, `over-capacity`, `route-ends`, `vans`,
/// `window` or `no-stops`. `window`: the vans leave the bakery at 09:00, a van early at a door
/// waits for the stop's window to open and spends 3 minutes there, and each stop must be
/// reached by its window's close (`StopView.window` plus 120 minutes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PlanRequest {
    pub vans: Vec<PlanRouteRequest>,
}

/// Which stored plan to publish.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanChoice {
    /// The server's.
    Proposed,
    /// The browser's.
    Submitted,
}

/// `POST /v1/sandboxes/{id}/dispatch/{date}/publish`, staff only: make a stored plan the record.
/// Checked again against the day's stops; a repeat with the same `Idempotency-Key` publishes
/// nothing more.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PublishRequest {
    pub plan: PlanChoice,
}

/// `POST /v1/sandboxes/{id}/dispatch/{date}/complete`, staff only: a stop of the published plan
/// is delivered. Again for a delivered stop changes nothing. Refused 409 `not-ready` while the
/// stop's order is still confirmed or in production: the kitchen marks it ready first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CompleteStopRequest {
    /// The stop's number in the published plan, from 1.
    pub stop: u16,
}

/// One place of the travel-time matrix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MatrixPlace {
    /// 0 to the places' count less one, in order.
    pub index: u8,
    /// The map label, `p1` to `p64`; no name, coordinate or street.
    pub label: String,
}

/// The travel-time matrix the dispatch screen loads to run VROOM. It is not an API response: it
/// is a static asset of the web Worker, the same JSON as the committed fixture
/// `crates/seed/data/<city>/matrix.json` (ADR 0012, decision 7), and this type only fixes its
/// shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MatrixResponse {
    /// The city the build is for, or `synthetic`.
    pub city: String,
    /// When the build ran, or `seed:<n>` for the synthetic city.
    pub built: String,
    /// Where the travel times come from, with the attribution the data's licence asks for.
    pub source: String,
    /// The bakery's place, where every route starts and ends; 0 when left out.
    #[serde(default)]
    pub depot: u8,
    pub places: Vec<MatrixPlace>,
    /// `minutes[i][j]`: whole minutes driving from place `i` to place `j`, 0 on the diagonal.
    /// Not necessarily symmetric.
    pub minutes: Vec<Vec<u32>>,
}

// ---------------------------------------------------------------------------------------------
// The sandbox's API token (PR 10; docs/security.md, "The API token"). Signed-in sessions only: a
// guest gets 403 `guest-scope`. Issuing and rotating take the cookie, never a token.
// ---------------------------------------------------------------------------------------------

/// `POST /v1/sandboxes/{id}/token` (issue, or issue again at the same version) and
/// `POST /v1/sandboxes/{id}/token/rotate` (the Sandbox's token version goes up, `ApiTokenRotated`
/// is appended, and every token naming an older version stops at once): the token, shown this
/// once. It is never stored, logged, put in an event or printed by this type's `Debug`; the
/// console holds it in memory to copy it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TokenResponse {
    /// For `Authorization: Bearer <token>`: `<payload>.<mac>`, both base64url, signed like the
    /// session cookie. Never in a URL: a token in a query string is refused with 400.
    pub token: String,
    /// The Sandbox's token version the token names.
    pub token_v: u32,
    /// A wall time, such as `2026-11-05T12:00:00.000Z`.
    pub issued_at: String,
    /// 24 h after `issued_at`, a wall time; the sandbox's wipe ends it sooner.
    pub expires_at: String,
}

impl std::fmt::Debug for TokenResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenResponse")
            .field("token_v", &self.token_v)
            .field("issued_at", &self.issued_at)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

/// `GET /v1/sandboxes/{id}/token`: what the console shows about the token without the token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TokenInfoResponse {
    /// The Sandbox's token version: a token naming an older one is refused.
    pub token_v: u32,
    /// When the last token at this version was issued, a wall time; absent before the first
    /// issue and after a rotation until the next.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issued_at: Option<String>,
    /// When that token stops being accepted, a wall time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// That token's first 6 and last 4 characters around `…`, such as `eyJ2Ij…x7Qk`: enough
    /// to tell two tokens apart, never enough to use one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub masked: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// The flight recorder (2026-11-09; ADR 0015): what the Queue's consumer did with each event of a
// sandbox, kept by the sandbox's `Recorder`. Identifiers, type names, sequence numbers and times
// only: never an event's `data`.

/// Where one subscriber stands after one delivery attempt of an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TraceOutcome {
    /// Its delivery is done on this attempt: it answered 2xx, or it answered a 410 the consumer
    /// counts as done and acks, so this outcome does not say the object applied the event. Those
    /// 410s are a Crm or an Inbox not yet seeded (its seed carries what came before it), and a
    /// Schedule day, a Dispatch day or a stop's Order that is gone or was never born, which holds
    /// nothing the event could change. They have no outcome of their own because the message's
    /// fate is the same as a 2xx's: acked, never retried; the consumer logs each one
    /// (`subscriber_unborn`, `schedule_no_day`, `dispatch_no_day`, `stop_order_gone`).
    Delivered,
    /// It did not get the event on this attempt, by its own failure or an earlier subscriber's,
    /// and the message went back to the Queue. A hop never says this attempt was the last: that
    /// is only known once the message is dead.
    Retried,
    /// The message is a dead letter and this class never got it: observed, never inferred. Only
    /// a dead hop carries it, recorded when the dead-letter queue's consumer has kept the message
    /// (the Queue gives up after 3 retries). It marks the classes from the one that had not
    /// answered on the event's last recorded hop. When the recorder held no earlier hop for the
    /// event (they were lost, or every attempt was retried with the flag `off`), which class
    /// failed is not known, and every routed class is `dead_lettered`.
    DeadLettered,
}

/// One subscriber class an event was routed to, and how its delivery went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TraceDelivery {
    /// The subscriber's class, such as `Kitchen`, `Crm` or `Schedule` (one entry a class, however
    /// many of its objects got the event).
    pub to: String,
    pub outcome: TraceOutcome,
}

/// One hop: one envelope through the Queue's consumer, once. It carries the envelope's
/// identifiers, type, sequence number and times, and never its `data`: no note, no name, no
/// amount reaches the recorder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TraceHop {
    /// The event's ULID.
    pub id: String,
    /// The event type, such as `OrderPlaced`.
    #[serde(rename = "type")]
    pub event_type: String,
    /// The producing object's name, such as `order:<sandbox>:<ulid>`.
    pub stream: String,
    pub seq: u64,
    /// The command's `Idempotency-Key`, or for a reaction the id of the event that caused it;
    /// absent when the event has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
    /// The event's business time.
    pub at: String,
    /// When the event was written, a wall time.
    pub recorded_at: String,
    /// When the consumer had decided this attempt's deliveries, a wall time.
    pub delivered_at: String,
    /// `delivered_at` less `recorded_at` in milliseconds, 0 when the clocks disagree.
    pub lag_ms: u64,
    /// The recorder's own count of the hops it recorded for the event, from 1, in the order they
    /// arrived: a lower bound on the Queue's attempts, not the Queue's number. A retry made with
    /// the flag `off` builds no hop, and a hop whose recording was lost is not counted. A dead hop
    /// repeats the event's last count (1 when it held none), since it is no attempt of its own.
    pub attempt: u32,
    /// Each subscriber class the event was routed to, in the routing table's order; empty for an
    /// event no class consumes.
    pub deliveries: Vec<TraceDelivery>,
}

/// `GET /v1/sandboxes/{id}/trace`: the hops recorded after the cursor `after`, oldest first and
/// newest last, at most 50 batches of them; then `cursor` for the next call. Any session of the
/// sandbox reads it, a guest's included. The recorder keeps the last 200 batches the consumer
/// sent it and drops older ones, so a cursor older than that misses hops, and says so. A live
/// sandbox whose recorder was never seeded (one born before the recorder's deploy) answers an
/// empty page; one being wiped answers 410 `wiped`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TraceResponse {
    pub hops: Vec<TraceHop>,
    /// Pass as `after` for the hops after these; the same cursor again when there are none.
    pub cursor: u64,
    /// More batches wait after `cursor`: ask again at once.
    pub more: bool,
    /// Hops were missed: batches after `after` were dropped from the ring before this read, or
    /// `after` was past the ring's newest batch (a cursor kept from another sandbox), so the read
    /// started again from the oldest kept.
    pub missed: bool,
}

/// Why the recorder's socket says goodbye.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TraceByeReason {
    /// The sandbox was wiped: close 1001.
    Wiped,
    /// A limit was passed: close 1008, 1009 or 1003.
    Limit,
}

/// A frame the recorder's socket sends, protocol v1, JSON text: `snapshot` once on open (the
/// hops of the ring's last 50 batches, newest last), `hops` for each batch recorded after it,
/// and `bye` before the server closes. A client sends only `{"t":"ping","v":1}`, answered
/// `{"t":"pong","v":1}` by the platform without waking the object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "t", rename_all = "snake_case", deny_unknown_fields)]
pub enum TraceFrame {
    Snapshot {
        v: u8,
        hops: Vec<TraceHop>,
        /// The cursor of the newest batch in the snapshot, as `GET .../trace` would give it.
        cursor: u64,
    },
    Hops {
        v: u8,
        hops: Vec<TraceHop>,
        /// This batch's cursor.
        cursor: u64,
    },
    Bye {
        v: u8,
        reason: TraceByeReason,
    },
}

/// Every exported schema as `(file name, pretty JSON with a trailing newline)`, in a fixed
/// order. The binary writes these bytes and the test compares them.
pub fn schemas() -> Vec<(&'static str, String)> {
    fn render<T: JsonSchema>() -> String {
        let schema = schemars::schema_for!(T);
        let mut text = serde_json::to_string_pretty(&schema).expect("a schema serializes");
        text.push('\n');
        text
    }
    vec![
        ("HealthResponse.schema.json", render::<HealthResponse>()),
        ("StatusResponse.schema.json", render::<StatusResponse>()),
        ("Problem.schema.json", render::<Problem>()),
        ("SessionResponse.schema.json", render::<SessionResponse>()),
        ("SandboxResponse.schema.json", render::<SandboxResponse>()),
        (
            "DemoSignupRequest.schema.json",
            render::<DemoSignupRequest>(),
        ),
        (
            "DemoSignupResponse.schema.json",
            render::<DemoSignupResponse>(),
        ),
        (
            "DemoSigninRequest.schema.json",
            render::<DemoSigninRequest>(),
        ),
        (
            "CreateSandboxRequest.schema.json",
            render::<CreateSandboxRequest>(),
        ),
        ("FaultRequest.schema.json", render::<FaultRequest>()),
        ("FaultsResponse.schema.json", render::<FaultsResponse>()),
        ("WipedResponse.schema.json", render::<WipedResponse>()),
        ("OrderRequest.schema.json", render::<OrderRequest>()),
        ("OrderResponse.schema.json", render::<OrderResponse>()),
        (
            "OrderLineResponse.schema.json",
            render::<OrderLineResponse>(),
        ),
        ("MenuItemPatch.schema.json", render::<MenuItemPatch>()),
        ("MenuEditResponse.schema.json", render::<MenuEditResponse>()),
        ("TaxRateRequest.schema.json", render::<TaxRateRequest>()),
        ("MenuResponse.schema.json", render::<MenuResponse>()),
        (
            "MenuDraftsResponse.schema.json",
            render::<MenuDraftsResponse>(),
        ),
        ("TrafficRequest.schema.json", render::<TrafficRequest>()),
        ("TrafficResponse.schema.json", render::<TrafficResponse>()),
        ("DeadLetter.schema.json", render::<DeadLetter>()),
        ("ClockRequest.schema.json", render::<ClockRequest>()),
        ("ClockResponse.schema.json", render::<ClockResponse>()),
        ("ScheduleResponse.schema.json", render::<ScheduleResponse>()),
        ("CapacityRequest.schema.json", render::<CapacityRequest>()),
        ("PaymentResponse.schema.json", render::<PaymentResponse>()),
        ("RefundRequest.schema.json", render::<RefundRequest>()),
        ("RefundResponse.schema.json", render::<RefundResponse>()),
        ("LedgerResponse.schema.json", render::<LedgerResponse>()),
        (
            "CateringInquiryRequest.schema.json",
            render::<CateringInquiryRequest>(),
        ),
        ("QuoteRequest.schema.json", render::<QuoteRequest>()),
        (
            "CateringCancelRequest.schema.json",
            render::<CateringCancelRequest>(),
        ),
        ("DeclineRequest.schema.json", render::<DeclineRequest>()),
        ("CateringResponse.schema.json", render::<CateringResponse>()),
        (
            "CateringListResponse.schema.json",
            render::<CateringListResponse>(),
        ),
        ("CustomerResponse.schema.json", render::<CustomerResponse>()),
        (
            "CustomerListResponse.schema.json",
            render::<CustomerListResponse>(),
        ),
        ("TimelineResponse.schema.json", render::<TimelineResponse>()),
        ("ConsentRequest.schema.json", render::<ConsentRequest>()),
        ("SegmentResponse.schema.json", render::<SegmentResponse>()),
        (
            "SegmentListResponse.schema.json",
            render::<SegmentListResponse>(),
        ),
        ("CampaignRequest.schema.json", render::<CampaignRequest>()),
        ("ScheduleRequest.schema.json", render::<ScheduleRequest>()),
        ("CampaignResponse.schema.json", render::<CampaignResponse>()),
        (
            "CampaignListResponse.schema.json",
            render::<CampaignListResponse>(),
        ),
        ("InboxResponse.schema.json", render::<InboxResponse>()),
        (
            "LeadPipelineResponse.schema.json",
            render::<LeadPipelineResponse>(),
        ),
        ("ActivityResponse.schema.json", render::<ActivityResponse>()),
        ("RebuildResponse.schema.json", render::<RebuildResponse>()),
        ("DispatchResponse.schema.json", render::<DispatchResponse>()),
        ("ProposeRequest.schema.json", render::<ProposeRequest>()),
        ("PlanRequest.schema.json", render::<PlanRequest>()),
        ("PublishRequest.schema.json", render::<PublishRequest>()),
        (
            "CompleteStopRequest.schema.json",
            render::<CompleteStopRequest>(),
        ),
        ("MatrixResponse.schema.json", render::<MatrixResponse>()),
        ("MessageResponse.schema.json", render::<MessageResponse>()),
        ("TokenResponse.schema.json", render::<TokenResponse>()),
        (
            "TokenInfoResponse.schema.json",
            render::<TokenInfoResponse>(),
        ),
        ("TraceHop.schema.json", render::<TraceHop>()),
        ("TraceResponse.schema.json", render::<TraceResponse>()),
        ("TraceFrame.schema.json", render::<TraceFrame>()),
    ]
}

/// Where the committed schemas live.
pub fn schema_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("schemas")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn committed_schemas_are_current() {
        for (name, expected) in schemas() {
            let path = schema_dir().join(name);
            let committed = std::fs::read_to_string(&path).unwrap_or_default();
            assert!(
                committed == expected,
                "{} is stale: run `cargo run -p bakery-contracts --bin export-schemas`",
                path.display()
            );
        }
    }

    /// The flight recorder's types carry identifiers, types, sequence numbers and times, and
    /// never an event's `data`: no field of a hop may be named so, and one sent is refused.
    #[test]
    fn a_trace_hop_has_no_data_field_and_refuses_one() {
        let hop = TraceHop {
            id: "01JC8Z6K3W9QF2N4T7XRB5M0HD".into(),
            event_type: "OrderPlaced".into(),
            stream: "order:01JC8YV2D4QK7S1M9E3PZ6W8AN:01JC8Z5R0T2B6Y8C4V1N3K7QXE".into(),
            seq: 1,
            cause: Some("01JC8Z6F0WQ3E5R7T9Y1V3K5P7".into()),
            at: "2026-11-09T09:12:10-07:00".into(),
            recorded_at: "2026-11-09T16:12:10Z".into(),
            delivered_at: "2026-11-09T16:12:11Z".into(),
            lag_ms: 1_000,
            attempt: 1,
            deliveries: vec![TraceDelivery {
                to: "Kitchen".into(),
                outcome: TraceOutcome::Delivered,
            }],
        };
        let value = serde_json::to_value(&hop).unwrap();
        assert!(value.get("data").is_none());
        assert_eq!(value["type"], "OrderPlaced");
        assert_eq!(value["deliveries"][0]["outcome"], "delivered");
        let mut with_data = value.clone();
        with_data["data"] = json!({ "note": "Two boxes, please" });
        assert!(serde_json::from_value::<TraceHop>(with_data).is_err());
        let schema: serde_json::Value = serde_json::from_str(
            &schemas()
                .into_iter()
                .find(|(f, _)| *f == "TraceHop.schema.json")
                .unwrap()
                .1,
        )
        .unwrap();
        assert!(schema["properties"].get("data").is_none());
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            serde_json::to_value(TraceOutcome::DeadLettered).unwrap(),
            json!("dead_lettered")
        );

        let frame = TraceFrame::Hops {
            v: 1,
            hops: vec![hop],
            cursor: 7,
        };
        let value = serde_json::to_value(&frame).unwrap();
        assert_eq!(
            (value["t"].as_str(), value["v"].as_u64()),
            (Some("hops"), Some(1))
        );
        assert_eq!(value["cursor"], 7);
        let bye: TraceFrame =
            serde_json::from_str(r#"{"t":"bye","v":1,"reason":"wiped"}"#).unwrap();
        assert_eq!(
            bye,
            TraceFrame::Bye {
                v: 1,
                reason: TraceByeReason::Wiped
            }
        );
    }

    #[test]
    fn wire_shapes() {
        let health = HealthResponse {
            status: HealthStatus::Ok,
            commit: "dev".into(),
            version: "0.1.0".into(),
        };
        assert_eq!(
            serde_json::to_value(&health).unwrap(),
            json!({ "status": "ok", "commit": "dev", "version": "0.1.0" })
        );

        let status = StatusResponse {
            day: "2026-11-04".into(),
            sandboxes_today: 0,
            sandbox_cap: 300,
            guests_today: 0,
            guest_cap: 100,
            demo_accounts_today: 0,
            demo_account_cap: 100,
            counters: None,
            counters_as_of: None,
            counters_state: CountersState::Unavailable,
            breaker: BreakerStatus {
                state: BreakerState::Unconfigured,
                since: None,
                last_run: None,
                last_usd: None,
                unread: vec![],
            },
            sandboxes_past_wipe: None,
            flag: Flag::ReadOnly,
        };
        assert_eq!(
            serde_json::to_string(&status).unwrap(),
            r#"{"day":"2026-11-04","sandboxes_today":0,"sandbox_cap":300,"guests_today":0,"guest_cap":100,"demo_accounts_today":0,"demo_account_cap":100,"counters":null,"counters_as_of":null,"counters_state":"unavailable","breaker":{"state":"unconfigured","since":null,"last_run":null,"last_usd":null,"unread":[]},"sandboxes_past_wipe":null,"flag":"read-only"}"#
        );
        let live = StatusResponse {
            counters: Some(StatusCounters {
                orders_24h: 12,
                payments_24h: 10,
                payment_failures_24h: 2,
                refunds_24h: 1,
                sandboxes_24h: 7,
                dlq_24h: 0,
                last_wipe: Some(LastWipe {
                    at: "2026-11-04T10:00:04Z".into(),
                    sandboxes: 7,
                    objects: 133,
                    ms: 4210,
                }),
            }),
            counters_as_of: Some("2026-11-04T10:15:02.114Z".into()),
            counters_state: CountersState::Live,
            breaker: BreakerStatus {
                state: BreakerState::ReadOnly,
                since: Some("2026-11-04T10:15:01.204Z".into()),
                last_run: Some("2026-11-04T10:30:01.377Z".into()),
                last_usd: Some("0.1000".into()),
                unread: vec!["rows_written".into(), "do_gb_s".into()],
            },
            sandboxes_past_wipe: Some(3),
            ..status
        };
        let wire = serde_json::to_value(&live).unwrap();
        assert_eq!(wire["counters_state"], "live");
        assert_eq!(
            wire["breaker"],
            json!({
                "state": "read-only",
                "since": "2026-11-04T10:15:01.204Z",
                "last_run": "2026-11-04T10:30:01.377Z",
                "last_usd": "0.1000",
                "unread": ["rows_written", "do_gb_s"]
            })
        );
        assert_eq!(wire["counters"]["last_wipe"]["objects"], 133);
        assert_eq!(wire["sandboxes_past_wipe"], 3);
        assert_eq!(
            serde_json::from_value::<StatusResponse>(wire).unwrap(),
            live
        );
        let schema = serde_json::to_value(schemars::schema_for!(StatusResponse)).unwrap();
        let required = schema["required"].as_array().unwrap();
        for name in [
            "counters",
            "counters_as_of",
            "counters_state",
            "breaker",
            "sandboxes_past_wipe",
        ] {
            assert!(required.iter().any(|r| r == name), "{name} is required");
        }
        let breaker = &schema["$defs"]["BreakerStatus"];
        for name in ["state", "since", "last_run", "last_usd", "unread"] {
            assert!(
                breaker["required"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r == name),
                "breaker.{name} is required"
            );
        }
        for state in [
            BreakerState::Unconfigured,
            BreakerState::Armed,
            BreakerState::ReadOnly,
            BreakerState::Off,
        ] {
            assert_eq!(BreakerState::parse(state.as_str()), Some(state));
            assert_eq!(serde_json::to_value(state).unwrap(), state.as_str());
        }
        assert!(BreakerState::Armed < BreakerState::ReadOnly);
        assert!(BreakerState::ReadOnly < BreakerState::Off);

        let problem = Problem::status(404, "Not Found").with_instance("/v1/nope");
        assert_eq!(
            serde_json::to_value(&problem).unwrap(),
            json!({ "type": "about:blank", "title": "Not Found", "status": 404, "instance": "/v1/nope" })
        );
    }

    #[test]
    fn typed_problems() {
        let problem = Problem::typed(
            "sandbox-cap",
            503,
            "Sandbox cap reached",
            "Try after 00:00 UTC.",
        )
        .with_instance("/v1/sandboxes");
        assert_eq!(
            serde_json::to_value(&problem).unwrap(),
            json!({
                "type": "https://bakery.ihaveasegway.com/problems/sandbox-cap",
                "title": "Sandbox cap reached",
                "status": 503,
                "detail": "Try after 00:00 UTC.",
                "instance": "/v1/sandboxes",
            })
        );
        assert_eq!(
            Problem::status(404, "Not Found").problem_type,
            "about:blank"
        );
    }

    #[test]
    fn session_shapes() {
        let session = SessionResponse {
            kind: SessionKind::Demo,
            account: Some("ab".repeat(32)),
            sandbox: None,
            expires_at: "2026-11-06T12:00:00.000Z".into(),
        };
        assert_eq!(
            serde_json::to_value(&session).unwrap(),
            json!({ "kind": "demo", "account": "ab".repeat(32), "sandbox": null,
                    "expires_at": "2026-11-06T12:00:00.000Z" })
        );
        for (kind, text) in [
            (SessionKind::Guest, "guest"),
            (SessionKind::Google, "google"),
            (SessionKind::Github, "github"),
            (SessionKind::Demo, "demo"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(text));
        }
    }

    #[test]
    fn sandbox_shapes() {
        let sandbox = SandboxResponse {
            id: "01JC8Z6K3W9QF2N4T7XRB5M0HD".into(),
            kind: SandboxKind::Guest,
            state: SandboxState::Live,
            born: "2026-11-05T09:55:00.000Z".into(),
            wipe_at: "2026-11-05T10:00:00.000Z".into(),
            seed: 42,
            persona: "01JC8Z6F0WQ3E5R7T9Y1V3K5P7".into(),
            persona_name: "Drizzle Trowel".into(),
            persona_address: PersonaAddress {
                line1: "p17, unit 1 (synthetic)".into(),
                city: "Salt Lake City".into(),
                state: "UT".into(),
                postal_code: "84101".into(),
                country: "US".into(),
            },
            persona_zone: Some("z2".into()),
            clock_offset_s: 0,
            clock_v: 0,
            token_v: 0,
            faults: Faults::default(),
            children: 0,
        };
        assert_eq!(
            serde_json::to_string(&sandbox).unwrap(),
            r#"{"id":"01JC8Z6K3W9QF2N4T7XRB5M0HD","kind":"guest","state":"live","born":"2026-11-05T09:55:00.000Z","wipe_at":"2026-11-05T10:00:00.000Z","seed":42,"persona":"01JC8Z6F0WQ3E5R7T9Y1V3K5P7","persona_name":"Drizzle Trowel","persona_address":{"line1":"p17, unit 1 (synthetic)","city":"Salt Lake City","state":"UT","postal_code":"84101","country":"US"},"persona_zone":"z2","clock_offset_s":0,"clock_v":0,"token_v":0,"faults":{"inbox":false,"kitchen":false},"children":0}"#
        );
        for (state, text) in [
            (SandboxState::Seeding, "seeding"),
            (SandboxState::Live, "live"),
            (SandboxState::Wiping, "wiping"),
            (SandboxState::Wiped, "wiped"),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), json!(text));
        }
        assert_eq!(
            serde_json::to_value(SandboxKind::Account).unwrap(),
            json!("account")
        );
        assert_eq!(
            serde_json::to_value(WipedResponse::new("01JC8Z6K3W9QF2N4T7XRB5M0HD")).unwrap(),
            json!({ "id": "01JC8Z6K3W9QF2N4T7XRB5M0HD", "state": "wiped" })
        );
        assert_eq!(
            serde_json::to_value(FaultsResponse {
                faults: Faults {
                    inbox: true,
                    kitchen: false
                }
            })
            .unwrap(),
            json!({ "faults": { "inbox": true, "kitchen": false } })
        );
    }

    #[test]
    fn request_shapes() {
        let create: CreateSandboxRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(
            create,
            CreateSandboxRequest {
                turnstile_token: None,
                replace: false
            }
        );
        let create: CreateSandboxRequest =
            serde_json::from_str(r#"{"turnstile_token":"t","replace":true}"#).unwrap();
        assert_eq!(create.turnstile_token.as_deref(), Some("t"));
        assert!(create.replace);
        assert!(serde_json::from_str::<CreateSandboxRequest>(r#"{"sandbox":"x"}"#).is_err());

        let fault: FaultRequest = serde_json::from_str(r#"{"fault":"inbox","on":true}"#).unwrap();
        assert_eq!(
            fault,
            FaultRequest {
                fault: FaultName::Inbox,
                on: true
            }
        );
        let kitchen: FaultRequest =
            serde_json::from_str(r#"{"fault":"kitchen","on":true}"#).unwrap();
        assert_eq!(kitchen.fault, FaultName::Kitchen);
        assert_eq!(kitchen.fault.as_str(), "kitchen");
        assert!(serde_json::from_str::<FaultRequest>(r#"{"fault":"oven","on":true}"#).is_err());

        let signup: DemoSignupRequest = serde_json::from_str(
            r#"{"password":"canary-password-do-not-log","turnstile_token":"t"}"#,
        )
        .unwrap();
        assert_eq!(signup.password, "canary-password-do-not-log");
        assert!(!format!("{signup:?}").contains("canary"));
        assert!(
            serde_json::from_str::<DemoSignupRequest>(
                r#"{"password":"p","turnstile_token":"t","email":"x"}"#
            )
            .is_err()
        );

        let signin: DemoSigninRequest = serde_json::from_str(
            r#"{"username":"baker-7f3k","password":"canary-password-do-not-log"}"#,
        )
        .unwrap();
        assert_eq!(signin.username, "baker-7f3k");
        assert!(!format!("{signin:?}").contains("canary"));
        assert!(!format!("{signin:?}").contains("baker"));

        assert_eq!(
            serde_json::to_value(DemoSignupResponse {
                username: "baker-7f3k".into()
            })
            .unwrap(),
            json!({ "username": "baker-7f3k" })
        );
    }

    #[test]
    fn flags_round_trip_through_storage_text() {
        for flag in [Flag::Live, Flag::ReadOnly, Flag::Off] {
            assert_eq!(Flag::parse(flag.as_str()), Some(flag));
            assert_eq!(serde_json::to_value(flag).unwrap(), json!(flag.as_str()));
        }
        assert_eq!(Flag::parse("Live"), None);
    }

    #[test]
    fn order_and_menu_shapes() {
        let order: OrderRequest = serde_json::from_str(
            r#"{"kind":"pickup","slot":"2026-11-07T09:45:00-07:00","lines":[{"variant":"croissant/single","qty":2}]}"#,
        )
        .unwrap();
        assert_eq!(order.kind, OrderKind::Pickup);
        assert_eq!(order.zone, None);
        assert_eq!(order.note, None);
        assert!(
            serde_json::from_str::<OrderRequest>(
                r#"{"kind":"pickup","slot":"s","lines":[],"customer":"x"}"#
            )
            .is_err(),
            "a client never names the customer"
        );
        let rate: TaxRateRequest = serde_json::from_str(r#"{"tax_bp":850}"#).unwrap();
        assert_eq!(rate.tax_bp, 850);
        assert!(serde_json::from_str::<TaxRateRequest>(r#"{"tax_bp":850,"x":1}"#).is_err());
        assert!(serde_json::from_str::<TaxRateRequest>(r#"{"tax_bp":-1}"#).is_err());
        let menu: MenuResponse = serde_json::from_str(r#"{"version":3,"categories":[]}"#).unwrap();
        assert_eq!(menu.tax_bp, DEFAULT_TAX_BP);
        let patch: MenuItemPatch = serde_json::from_str(r#"{"status":"paused"}"#).unwrap();
        assert_eq!(patch.status, Some(MenuItemStatus::Paused));
        assert_eq!(patch.price_cents, None);
        assert_eq!(
            serde_json::to_value(OrderStatus::RefundPending).unwrap(),
            json!("refund_pending")
        );
        let dead = DeadLetter {
            id: "01JC8Z6K3W9QF2N4T7XRB5M0HD".into(),
            event_type: "OrderPlaced".into(),
            stream: "order:01JC8YV2D4QK7S1M9E3PZ6W8AN:01JC8Z5R0T2B6Y8C4V1N3K7QXE".into(),
            seq: 1,
            error: "Kitchen answered 503".into(),
            at: "2026-11-05T12:00:00.000Z".into(),
            made_while_off: true,
        };
        assert_eq!(serde_json::to_value(&dead).unwrap()["type"], "OrderPlaced");
        assert_eq!(serde_json::to_value(&dead).unwrap()["made_while_off"], true);
    }

    #[test]
    fn scheduling_shapes() {
        let step: ClockRequest = serde_json::from_str(r#"{"step":"next-opening"}"#).unwrap();
        assert_eq!(step.step, Some(ClockStep::NextOpening));
        assert_eq!(step.minutes, None);
        for (text, want) in [
            ("15m", ClockStep::Minutes15),
            ("1h", ClockStep::Hour),
            ("1d", ClockStep::Day),
        ] {
            let r: ClockRequest = serde_json::from_value(json!({ "step": text })).unwrap();
            assert_eq!(r.step, Some(want));
        }
        let old: ClockRequest = serde_json::from_str(r#"{"minutes":90}"#).unwrap();
        assert_eq!((old.step, old.minutes), (None, Some(90)));
        assert!(serde_json::from_str::<ClockRequest>(r#"{"step":"2d"}"#).is_err());
        assert!(serde_json::from_str::<ClockRequest>(r#"{"hours":2}"#).is_err());

        let capacity: CapacityRequest =
            serde_json::from_str(r#"{"target":"slot:14:45","capacity":4}"#).unwrap();
        assert_eq!(capacity.target, "slot:14:45");
        assert_eq!(capacity.capacity, 4);

        let full = Problem::typed("slot-full", 409, "Slot full", "No place left at 10:00.");
        let mut full = full;
        full.next_free = Some("2026-07-14T10:15:00-06:00".into());
        assert_eq!(
            serde_json::to_value(&full).unwrap()["next_free"],
            "2026-07-14T10:15:00-06:00"
        );
        assert!(
            serde_json::to_value(Problem::status(404, "Not Found"))
                .unwrap()
                .get("next_free")
                .is_none()
        );

        let day = ScheduleResponse {
            date: "2026-07-14".into(),
            open: true,
            slots: vec![SlotView {
                start: "2026-07-14T14:45:00-06:00".into(),
                capacity: 6,
                taken: 1,
                free: 5,
            }],
            zones: vec![ZoneView {
                zone: "z1".into(),
                capacity: 20,
                taken: 0,
                free: 20,
                windows: vec!["2026-07-14T09:00:00-06:00".into()],
            }],
            items: vec![ItemCapView {
                item: "croissant".into(),
                daily_cap: None,
                used: 2,
            }],
            catering: CateringView {
                capacity: 2,
                taken: 0,
            },
            bake_list: BakeListView {
                version: 1,
                lines: vec![
                    BakeLineView {
                        item: "croissant".into(),
                        qty: 2,
                        start: "2026-07-14T14:45:00-06:00".into(),
                        catering: false,
                    },
                    BakeLineView {
                        item: "breakfast-spread".into(),
                        qty: 40,
                        start: "2026-07-14T07:00:00-06:00".into(),
                        catering: true,
                    },
                ],
            },
            menu_version: 1,
        };
        let value = serde_json::to_value(&day).unwrap();
        assert_eq!(value["items"][0]["daily_cap"], json!(null));
        // An order's line carries no `catering`; a catering line says it counts people.
        assert!(value["bake_list"]["lines"][0].get("catering").is_none());
        assert_eq!(value["bake_list"]["lines"][1]["catering"], json!(true));
        let back: ScheduleResponse = serde_json::from_value(value).unwrap();
        assert_eq!(back, day);
    }

    #[test]
    fn payment_shapes() {
        let payment = PaymentResponse {
            payment: "01JC8Z6F1A5H3D7K9M2P4R6T8V".into(),
            client_secret: "pi_fake_1_secret_fake".into(),
            publishable_key: Some("pk_test_not_a_key".into()),
            amount_cents: 2_090,
            status: PaymentStatus::Created,
        };
        assert_eq!(
            serde_json::to_value(&payment).unwrap(),
            json!({ "payment": "01JC8Z6F1A5H3D7K9M2P4R6T8V", "client_secret": "pi_fake_1_secret_fake",
                    "publishable_key": "pk_test_not_a_key", "amount_cents": 2090,
                    "status": "created" })
        );
        let printed = format!("{payment:?}");
        assert!(!printed.contains("secret"), "{printed}");

        let full: RefundRequest = serde_json::from_str(r#"{"reason":"quality"}"#).unwrap();
        assert_eq!(full.amount_cents, None);
        let part: RefundRequest =
            serde_json::from_str(r#"{"amount_cents":500,"reason":"missing_item"}"#).unwrap();
        assert_eq!(part.amount_cents, Some(500));
        for bad in [
            r#"{"reason":"requested_by_customer"}"#,
            r#"{"reason":"goodwill","note":"x"}"#,
            r#"{"amount_cents":500}"#,
        ] {
            assert!(serde_json::from_str::<RefundRequest>(bad).is_err(), "{bad}");
        }
        assert_eq!(
            serde_json::to_value(RefundResponse {
                refund: "01JC8Z6F1A5H3D7K9M2P4R6T8V".into(),
                amount_cents: 2_090,
                status: OrderStatus::RefundPending,
            })
            .unwrap(),
            json!({ "refund": "01JC8Z6F1A5H3D7K9M2P4R6T8V", "amount_cents": 2090,
                    "status": "refund_pending" })
        );
        let ledger = LedgerResponse {
            entries: vec![
                LedgerEntry {
                    at: "2026-11-07T09:00:00-07:00".into(),
                    kind: LedgerKind::Payment,
                    purpose: PaymentPurpose::Order,
                    reference: "01JC8Z5R0T2B6Y8C4V1N3K7QXE".into(),
                    amount_cents: 2_090,
                    stripe_id: "pi_fake_1".into(),
                },
                LedgerEntry {
                    at: "2026-11-07T09:05:00-07:00".into(),
                    kind: LedgerKind::Refund,
                    purpose: PaymentPurpose::Order,
                    reference: "01JC8Z5R0T2B6Y8C4V1N3K7QXE".into(),
                    amount_cents: -2_090,
                    stripe_id: "re_fake_1".into(),
                },
            ],
            net_cents: 0,
            paid_cents: 2_090,
            refunded_cents: 2_090,
        };
        let value = serde_json::to_value(&ledger).unwrap();
        assert_eq!(value["entries"][1]["ref"], "01JC8Z5R0T2B6Y8C4V1N3K7QXE");
        assert_eq!(value["entries"][1]["kind"], "refund");
        assert_eq!(value["entries"][1]["amount_cents"], -2090);
        assert_eq!(value["net_cents"], 0);
    }

    #[test]
    fn catering_shapes() {
        let inquiry: CateringInquiryRequest = serde_json::from_str(
            r#"{"date":"2026-11-21","headcount":40,"package":"breakfast-spread","venue":"v3"}"#,
        )
        .unwrap();
        assert_eq!(inquiry.brief, None);
        assert_eq!(inquiry.headcount, 40);
        for bad in [
            r#"{"date":"2026-11-21","headcount":40,"package":"p","venue":"v3","customer":"x"}"#,
            r#"{"date":"2026-11-21","headcount":-1,"package":"p","venue":"v3"}"#,
            r#"{"date":"2026-11-21","package":"p","venue":"v3"}"#,
        ] {
            assert!(
                serde_json::from_str::<CateringInquiryRequest>(bad).is_err(),
                "{bad}"
            );
        }
        let staff: QuoteRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(staff.total_cents, None);
        assert_eq!(serde_json::to_value(&staff).unwrap(), json!({}));
        let cancel: CateringCancelRequest =
            serde_json::from_str(r#"{"reason":"venue_lost"}"#).unwrap();
        assert_eq!(cancel.reason, CateringCancelReason::VenueLost);
        assert!(serde_json::from_str::<CateringCancelRequest>(r#"{"reason":"weather"}"#).is_err());
        let decline: DeclineRequest = serde_json::from_str(r#"{"reason":"too_soon"}"#).unwrap();
        assert_eq!(decline.reason, DeclineReason::TooSoon);
        assert!(
            serde_json::from_str::<DeclineRequest>(r#"{"reason":"too soon, sorry"}"#).is_err(),
            "a reason is a choice, never free text"
        );

        let inquiry_only = CateringResponse {
            catering: "01JC8Z6K3W9QF2N4T7XRB5M0HD".into(),
            state: CateringState::Inquiry,
            date: "2026-11-21".into(),
            headcount: 40,
            package: "breakfast-spread".into(),
            venue: "v3".into(),
            brief: None,
            total_cents: None,
            deposit_cents: None,
            balance_cents: None,
            valid_until: None,
            deposit_payment: None,
            invoice: None,
            invoice_due: None,
            reminders: vec![],
            refund_deposit: None,
            created_at: "2026-11-03T10:00:00-07:00".into(),
            updated_at: "2026-11-03T10:00:00-07:00".into(),
        };
        assert_eq!(
            serde_json::to_value(&inquiry_only).unwrap(),
            json!({ "catering": "01JC8Z6K3W9QF2N4T7XRB5M0HD", "state": "inquiry",
                    "date": "2026-11-21", "headcount": 40, "package": "breakfast-spread",
                    "venue": "v3", "reminders": [],
                    "created_at": "2026-11-03T10:00:00-07:00",
                    "updated_at": "2026-11-03T10:00:00-07:00" })
        );
        let confirmed = CateringResponse {
            state: CateringState::InProduction,
            total_cents: Some(58_000),
            deposit_cents: Some(14_500),
            balance_cents: Some(43_500),
            valid_until: Some("2026-11-19T07:00:00-07:00".into()),
            deposit_payment: Some("01JC8Z6F1A5H3D7K9M2P4R6T8V".into()),
            reminders: vec![CateringReminder {
                kind: ReminderKind::EventSoon,
                at: "2026-11-19T07:00:00-07:00".into(),
            }],
            ..inquiry_only.clone()
        };
        let value = serde_json::to_value(&confirmed).unwrap();
        assert_eq!(value["state"], "in_production");
        assert_eq!(value["reminders"][0]["kind"], "event_soon");
        assert_eq!(
            serde_json::from_value::<CateringResponse>(value).unwrap(),
            confirmed
        );
        let list = CateringListResponse {
            events: vec![inquiry_only, confirmed],
        };
        assert_eq!(
            serde_json::to_value(&list).unwrap()["events"][1]["balance_cents"],
            43_500
        );
    }

    #[test]
    fn crm_shapes() {
        let customer = CustomerResponse {
            customer: "01M6TCX5C0VKKM7M86WYN7SBR2".into(),
            display_name: "Drizzle Trowel".into(),
            preferences: vec!["croissant".into()],
            home_zone: "z2".into(),
            place: "p9".into(),
            marketing: true,
            loyalty_points: 41,
            orders: 12,
            last_order_at: None,
            catering: 0,
        };
        assert_eq!(
            serde_json::to_string(&customer).unwrap(),
            r#"{"customer":"01M6TCX5C0VKKM7M86WYN7SBR2","display_name":"Drizzle Trowel","preferences":["croissant"],"home_zone":"z2","place":"p9","marketing":true,"loyalty_points":41,"orders":12,"catering":0}"#
        );
        let entry = TimelineEntry {
            at: "2026-11-07T09:00:00-07:00".into(),
            event_type: "OrderPaid".into(),
            reference: "01M6TCX5C0VKKM7M86WYN7SBR2".into(),
            label: "Paid $22.00".into(),
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            json!({ "at": "2026-11-07T09:00:00-07:00", "type": "OrderPaid",
                    "ref": "01M6TCX5C0VKKM7M86WYN7SBR2", "label": "Paid $22.00" })
        );
        let request: CampaignRequest = serde_json::from_str(
            r#"{"subject":"cake-week","body":"cake-orders","segment":"cake-last-30-days"}"#,
        )
        .unwrap();
        assert_eq!(request.segment, Segment::CakeLast30Days);
        assert_eq!(request.subject, SubjectTemplate::CakeWeek);
        // Free text is not a template.
        assert!(
            serde_json::from_str::<CampaignRequest>(
                r#"{"subject":"Hello there","body":"cake-orders","segment":"everyone"}"#
            )
            .is_err()
        );
        for (segment, text) in [
            (Segment::Everyone, "everyone"),
            (Segment::CakeLast30Days, "cake-last-30-days"),
            (Segment::DeliveryCustomers, "delivery-customers"),
            (Segment::Lapsed60Days, "lapsed-60-days"),
            (Segment::CateringLeads, "catering-leads"),
        ] {
            assert_eq!(serde_json::to_value(segment).unwrap(), json!(text));
        }
        assert_eq!(
            serde_json::to_value(RebuildResponse {
                state: RebuildState::Rebuilding,
                applied: 200,
                total: 742,
                ms: None
            })
            .unwrap(),
            json!({ "state": "rebuilding", "applied": 200, "total": 742 })
        );
        assert_eq!(
            serde_json::to_value(MessageKind::OnItsWay).unwrap(),
            json!("on_its_way")
        );
        let consent: ConsentRequest = serde_json::from_str(r#"{"marketing":false}"#).unwrap();
        assert!(!consent.marketing);
        assert!(serde_json::from_str::<ConsentRequest>(r#"{"marketing":false,"to":"x"}"#).is_err());
    }

    #[test]
    fn dispatch_shapes() {
        let plan = PlanView {
            source: PlanSource::Browser,
            plan_v: 2,
            vans: vec![VanPlanView {
                van: 1,
                stops: vec!["01JC8Z5R0T2B6Y8C4V1N3K7QXE".into()],
                units: 7,
                minutes: 31,
            }],
            minutes: 31,
            last_back: "2026-11-07T09:31:00-07:00".into(),
            unassigned: vec![],
        };
        assert_eq!(
            serde_json::to_value(&plan).unwrap(),
            json!({ "source": "browser", "plan_v": 2,
                    "vans": [{ "van": 1, "stops": ["01JC8Z5R0T2B6Y8C4V1N3K7QXE"], "units": 7, "minutes": 31 }],
                    "minutes": 31, "last_back": "2026-11-07T09:31:00-07:00", "unassigned": [] })
        );
        let comparison = ComparisonView {
            server_minutes: 118,
            browser_minutes: 104,
            gap_percent: Some(13.5),
        };
        assert_eq!(
            serde_json::to_value(comparison).unwrap(),
            json!({ "server_minutes": 118, "browser_minutes": 104, "gap_percent": 13.5 })
        );
        let request: PlanRequest = serde_json::from_value(json!({
            "vans": [{ "van": 1, "stops": ["01JC8Z5R0T2B6Y8C4V1N3K7QXE"], "start": 0, "end": 0 },
                     { "van": 2, "stops": [] }]
        }))
        .unwrap();
        assert_eq!(request.vans[1].start, None);
        assert!(
            serde_json::from_value::<PlanRequest>(json!({ "vans": [], "minutes": 10 })).is_err(),
            "a client's total is refused, not ignored"
        );
        let publish: PublishRequest = serde_json::from_str(r#"{"plan":"submitted"}"#).unwrap();
        assert_eq!(publish.plan, PlanChoice::Submitted);
        let complete: CompleteStopRequest = serde_json::from_str(r#"{"stop":3}"#).unwrap();
        assert_eq!(complete.stop, 3);
        let matrix: MatrixResponse = serde_json::from_str(
            r#"{"city":"synthetic","built":"seed:7","source":"s",
                "places":[{"index":0,"label":"p1"}],"minutes":[[0]]}"#,
        )
        .unwrap();
        assert_eq!(matrix.depot, 0);
        for (status, text) in [
            (StopStatus::Provisional, "provisional"),
            (StopStatus::Confirmed, "confirmed"),
            (StopStatus::OutForDelivery, "out_for_delivery"),
            (StopStatus::Removed, "removed"),
            (StopStatus::Completed, "completed"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), json!(text));
        }
    }
}
