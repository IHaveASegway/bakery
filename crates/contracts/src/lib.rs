//! The API's types, written once (docs/architecture.md, "The published language").
//!
//! Each type derives `serde` for the wire and `schemars::JsonSchema` for the web app: the
//! `export-schemas` binary writes one JSON Schema per type into `schemas/`, the web build turns
//! those into TypeScript, and a test fails when the committed schemas are stale.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

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
/// (PR 2), then the guest and demo-account counts and caps (PR 3), then the flag. Readers go
/// by name, so PR 2's smoke check still passes; a new field is added before `flag`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
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
    /// The demo's flag.
    pub flag: Flag,
}

/// The demo's mode, set in `Control` (kill switch L1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Flag {
    /// Everything works.
    Live,
    /// Reads work; commands get 503.
    ReadOnly,
    /// Only the storefront's static pages work.
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
    /// An extension member (RFC 9457, section 3.2), set only on the `slot-full` problem: the
    /// start of the next pickup slot with a place free that day, a business time such as
    /// `2026-11-07T10:15:00-07:00`. Absent when nothing later that day is free, and on every
    /// other problem.
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
    /// `z1`, `z2` or `z3` for a delivery; absent for a pickup.
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
}

/// What a staff edit may set on a menu item's status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MenuItemStatus {
    Paused,
    Available,
}

/// `PATCH /v1/sandboxes/{id}/menu/items/{slug}`, signed-in sessions only. A price is a draft,
/// set on every variant of the item, until `POST .../menu/publish`; a pause or a resume
/// publishes that one item at once.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MenuItemPatch {
    #[serde(default)]
    pub price_cents: Option<i64>,
    #[serde(default)]
    pub status: Option<MenuItemStatus>,
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
    pub categories: Vec<MenuCategory>,
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
    /// Stripe's id: the intent's `pi_...` for a payment, the refund's `re_...` for a refund.
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
        ("MenuResponse.schema.json", render::<MenuResponse>()),
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
            flag: Flag::ReadOnly,
        };
        assert_eq!(
            serde_json::to_string(&status).unwrap(),
            r#"{"day":"2026-11-04","sandboxes_today":0,"sandbox_cap":300,"guests_today":0,"guest_cap":100,"demo_accounts_today":0,"demo_account_cap":100,"flag":"read-only"}"#
        );

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
            clock_offset_s: 0,
            clock_v: 0,
            token_v: 0,
            faults: Faults::default(),
            children: 0,
        };
        assert_eq!(
            serde_json::to_string(&sandbox).unwrap(),
            r#"{"id":"01JC8Z6K3W9QF2N4T7XRB5M0HD","kind":"guest","state":"live","born":"2026-11-05T09:55:00.000Z","wipe_at":"2026-11-05T10:00:00.000Z","seed":42,"persona":"01JC8Z6F0WQ3E5R7T9Y1V3K5P7","persona_name":"Drizzle Trowel","persona_address":{"line1":"p17, unit 1 (synthetic)","city":"Salt Lake City","state":"UT","postal_code":"84101","country":"US"},"clock_offset_s":0,"clock_v":0,"token_v":0,"faults":{"inbox":false,"kitchen":false},"children":0}"#
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
        };
        assert_eq!(serde_json::to_value(&dead).unwrap()["type"], "OrderPlaced");
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
                lines: vec![BakeLineView {
                    item: "croissant".into(),
                    qty: 2,
                    start: "2026-07-14T14:45:00-06:00".into(),
                }],
            },
            menu_version: 1,
        };
        let value = serde_json::to_value(&day).unwrap();
        assert_eq!(value["items"][0]["daily_cap"], json!(null));
        let back: ScheduleResponse = serde_json::from_value(value).unwrap();
        assert_eq!(back, day);
    }

    #[test]
    fn payment_shapes() {
        let payment = PaymentResponse {
            payment: "01JC8Z6F1A5H3D7K9M2P4R6T8V".into(),
            client_secret: "pi_fake_1_secret_fake".into(),
            publishable_key: Some("pk_test_fake000000000000000000000000".into()),
            amount_cents: 2_090,
            status: PaymentStatus::Created,
        };
        assert_eq!(
            serde_json::to_value(&payment).unwrap(),
            json!({ "payment": "01JC8Z6F1A5H3D7K9M2P4R6T8V", "client_secret": "pi_fake_1_secret_fake",
                    "publishable_key": "pk_test_fake000000000000000000000000", "amount_cents": 2090,
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
}
