//! The Schedule aggregate, hosted by `Schedule`, one object per sandbox and bakery day
//! (`schedule:<sandbox>:<YYYY-MM-DD>`; docs/domain.md, "Schedule reservation"). It protects
//! capacity: orders per pickup slot, stops per delivery zone, units per item, catering events per
//! day (Q10 · Q-slots, Q11 · Q-production). One writer per day makes capacity a reservation
//! problem with no race: two holds for the last place are decided one after the other.
//!
//! A place moves `held → reserved → fulfilled`, or to `released` from `held` or `reserved`, as
//! the doc's diagram draws it. Held, reserved and fulfilled places count against capacity
//! (a fulfilled one is in the past, and its oven time was spent); released ones do not. The
//! production plan counts only reserved and fulfilled places, the confirmed orders Q11 names,
//! and is recomputed in the same `decide` as every change to that set, so it is emitted as
//! `BakeListChanged` in the same commit as the change that moved it.
//!
//! Choices this module makes where the doc is silent, each written at its rule:
//!
//! - **The state starts from the date.** [`ScheduleState::new`] holds the day's defaults; the
//!   object knows its date from its name and folds its log over that state.
//! - **A late payment wins.** `Confirm` of a released hold (the hold timer won the race with
//!   the payment) reserves it again even past capacity, because the money moved; the event says
//!   `revived: true`. It is the one way a count passes its capacity.
//! - **An item with no cap is uncapped.** Caps arrive by `RefreshCaps`; before the first, or for
//!   an item the menu does not list, nothing is refused on items. The Order checks the menu.
//! - **Events carry what the fold needs.** `SlotHeld` carries the zone and lines and
//!   `CapsRefreshed` the caps, so the state is the fold of its events.
//!
//! **The catering place (PR 7).** A catering event takes one of the day's
//! [`DEFAULT_CATERING_CAPACITY`] places. Its [`HoldRequest`] is built by
//! `catering::hold_request`: `kind: Catering`, `ref` the catering id, `start` the event day's
//! opening (07:00 local), `lines` one line of the package's slug with the headcount as its
//! quantity (the bake list shows "breakfast-spread × 40" at 07:00), and `expires_at` the
//! moment the deposit hold lapses, 15 minutes of business time after the quote was accepted.
//! The package's slug is not a menu item, so no item cap counts it. The routing table drives the
//! rest: `Confirm` on `CateringDepositPaid`, `Release` on `CateringCancelled` (`cancelled`) and
//! on `CateringDepositLapsed` (`deposit_lapsed`, which releases only a place still held), and
//! `Fulfil` on `CateringClosed`. A catering place that was released may be held again by the
//! same catering id, since an accepted quote whose deposit hold lapsed can be accepted again;
//! an order's released place cannot, as an order is held once.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

use crate::aggregate::{Aggregate, DecideContext, DomainEvent};
use crate::calendar::{self, BakeryDate, local_minutes, slot_minutes};
use crate::order::{Line, OrderKind};
use crate::{BusinessTime, Ulid};

/// Orders a pickup slot takes by default: six in a quarter hour is one every two and a half
/// minutes at the counter, about what one person serving can hand over.
pub const DEFAULT_SLOT_CAPACITY: u16 = 6;
/// Stops a delivery zone takes in a day by default, shared by its three windows: 60 stops
/// across the three zones, about the busy Saturday's 63 (docs/domain.md, "The seed").
pub const DEFAULT_ZONE_CAPACITY: u16 = 20;
/// Catering events a day by default; PR 7 books against it.
pub const DEFAULT_CATERING_CAPACITY: u16 = 2;
/// The three delivery zones, as the seed names them.
pub const ZONES: [&str; 3] = ["z1", "z2", "z3"];

/// What a hold is for: a pickup slot, a delivery window or a catering event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HoldKind {
    Slot,
    Window,
    Catering,
}

impl HoldKind {
    /// A pickup holds a slot, a delivery a window.
    pub fn for_order(kind: OrderKind) -> HoldKind {
        match kind {
            OrderKind::Pickup => HoldKind::Slot,
            OrderKind::Delivery => HoldKind::Window,
        }
    }
}

/// Where a place is in the diagram of docs/domain.md, "Schedule reservation".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HoldStatus {
    Held,
    Reserved,
    Released,
    Fulfilled,
}

impl HoldStatus {
    /// Whether the place counts against capacity.
    pub fn counts(self) -> bool {
        !matches!(self, HoldStatus::Released)
    }

    /// Whether the place is on the production plan.
    pub fn planned(self) -> bool {
        matches!(self, HoldStatus::Reserved | HoldStatus::Fulfilled)
    }
}

/// Why a place was given back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseReason {
    /// `OrderExpired`.
    Expired,
    /// `OrderCancelled` (later `CateringCancelled`).
    Cancelled,
    /// The hold's own timer, at `expires_at`.
    HoldExpired,
    /// `CateringDepositLapsed`: no deposit 15 minutes after the quote was accepted. Releases a
    /// place still held, never a reserved one.
    DepositLapsed,
}

/// One item's quantity in a hold: variant quantities summed per item.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ItemQty {
    pub item: String,
    pub qty: u32,
}

impl ItemQty {
    /// An order's lines as a hold's: summed per item, sorted by item.
    pub fn from_order_lines(lines: &[Line]) -> Vec<ItemQty> {
        normalize_lines(lines.iter().map(|l| ItemQty {
            item: l.item.clone(),
            qty: u32::from(l.qty),
        }))
    }
}

/// Lines summed per item, sorted by item, with empty quantities dropped: the one form a hold
/// stores and compares.
pub fn normalize_lines(lines: impl IntoIterator<Item = ItemQty>) -> Vec<ItemQty> {
    let mut by_item: BTreeMap<String, u32> = BTreeMap::new();
    for line in lines {
        let qty = by_item.entry(line.item).or_default();
        *qty = qty.saturating_add(line.qty);
    }
    by_item
        .into_iter()
        .filter(|(_, qty)| *qty > 0)
        .map(|(item, qty)| ItemQty { item, qty })
        .collect()
}

/// One item's daily cap, from the published menu's `daily_cap`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ItemCap {
    pub item: String,
    pub daily_cap: u32,
}

/// What a staff member's `SetCapacity` sets: `slot:<HH:MM>`, `zone:<z>`, `item:<slug>` or
/// `catering`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Target {
    /// A pickup slot, by its local start in minutes after midnight.
    Slot(u16),
    Zone(String),
    Item(String),
    Catering,
}

impl Target {
    /// Reads the grammar; refuses a slot that is not one of the day's 32 starts, a zone not in
    /// [`ZONES`] and an item slug that is not lower-case letters, digits and hyphens.
    pub fn parse(text: &str) -> Result<Target, ScheduleError> {
        let bad = || ScheduleError::BadTarget(text.chars().take(40).collect());
        if text == "catering" {
            return Ok(Target::Catering);
        }
        let (kind, rest) = text.split_once(':').ok_or_else(bad)?;
        match kind {
            "slot" => {
                let b = rest.as_bytes();
                if b.len() != 5
                    || b[2] != b':'
                    || !b[..2].iter().chain(&b[3..]).all(u8::is_ascii_digit)
                {
                    return Err(bad());
                }
                let hh = u16::from(b[0] - b'0') * 10 + u16::from(b[1] - b'0');
                let mm = u16::from(b[3] - b'0') * 10 + u16::from(b[4] - b'0');
                let minutes = hh * 60 + mm;
                if mm > 59 || !slot_minutes().any(|m| m == minutes) {
                    return Err(bad());
                }
                Ok(Target::Slot(minutes))
            }
            "zone" if ZONES.contains(&rest) => Ok(Target::Zone(rest.to_owned())),
            "item"
                if !rest.is_empty()
                    && rest.len() <= 64
                    && rest
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') =>
            {
                Ok(Target::Item(rest.to_owned()))
            }
            _ => Err(bad()),
        }
    }
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Target::Slot(m) => write!(f, "slot:{:02}:{:02}", m / 60, m % 60),
            Target::Zone(z) => write!(f, "zone:{z}"),
            Target::Item(i) => write!(f, "item:{i}"),
            Target::Catering => f.write_str("catering"),
        }
    }
}

impl FromStr for Target {
    type Err = ScheduleError;

    fn from_str(s: &str) -> Result<Target, ScheduleError> {
        Target::parse(s)
    }
}

impl Serialize for Target {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Target {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Target, D::Error> {
        let text = String::deserialize(deserializer)?;
        Target::parse(&text).map_err(serde::de::Error::custom)
    }
}

/// A place asked for: an order's slot or window, or a catering event's day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HoldRequest {
    /// The order or catering id.
    #[serde(rename = "ref")]
    pub reference: Ulid,
    pub kind: HoldKind,
    /// A slot start (pickup), a window start (delivery), or any time on the day (catering).
    pub start: BusinessTime,
    /// The delivery zone; ignored for a slot or catering.
    pub zone: Option<String>,
    pub lines: Vec<ItemQty>,
    /// The Order's `held_until`: 15 minutes of business time after placement.
    pub expires_at: BusinessTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleCommand {
    /// Synchronous, from the router at order placement; keyed by the order id.
    Hold(Box<HoldRequest>),
    /// From `OrderPaid` (later `CateringDepositPaid`).
    Confirm { reference: Ulid },
    /// From `OrderExpired`, `OrderCancelled`, `CateringCancelled`, `CateringDepositLapsed`, or
    /// the hold's own timer.
    Release {
        reference: Ulid,
        reason: ReleaseReason,
    },
    /// From `OrderClosed` (later `CateringClosed`).
    Fulfil { reference: Ulid },
    /// Staff.
    SetCapacity { target: Target, capacity: u16 },
    /// From `MenuPublished`, with the caps the Worker reads from the Catalog, and at seed.
    RefreshCaps {
        menu_version: u32,
        caps: Vec<ItemCap>,
    },
}

/// One row of the production plan: how many of an item for one start.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PlanLine {
    pub item: String,
    pub qty: u32,
    pub start: BusinessTime,
}

/// The production plan as last emitted: `version` counts the times its lines changed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub version: u32,
    pub lines: Vec<PlanLine>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// The Schedule's rows in docs/domain.md, "The event catalog".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum ScheduleEvent {
    SlotHeld {
        kind: HoldKind,
        date: BakeryDate,
        start: BusinessTime,
        #[serde(rename = "ref")]
        reference: Ulid,
        zone: Option<String>,
        lines: Vec<ItemQty>,
        expires_at: BusinessTime,
    },
    SlotReserved {
        kind: HoldKind,
        date: BakeryDate,
        start: BusinessTime,
        #[serde(rename = "ref")]
        reference: Ulid,
        /// True when a payment revived a released hold, past capacity if need be.
        #[serde(default, skip_serializing_if = "is_false")]
        revived: bool,
    },
    SlotReleased {
        kind: HoldKind,
        date: BakeryDate,
        start: BusinessTime,
        #[serde(rename = "ref")]
        reference: Ulid,
        reason: ReleaseReason,
    },
    SlotFulfilled {
        kind: HoldKind,
        date: BakeryDate,
        start: BusinessTime,
        #[serde(rename = "ref")]
        reference: Ulid,
    },
    CapacityChanged {
        target: Target,
        capacity: u16,
    },
    CapsRefreshed {
        menu_version: u32,
        caps: Vec<ItemCap>,
    },
    BakeListChanged {
        date: BakeryDate,
        version: u32,
        lines: Vec<PlanLine>,
    },
}

impl DomainEvent for ScheduleEvent {
    const NAMES: &'static [&'static str] = &[
        "SlotHeld",
        "SlotReserved",
        "SlotReleased",
        "SlotFulfilled",
        "CapacityChanged",
        "CapsRefreshed",
        "BakeListChanged",
    ];

    fn name(&self) -> &'static str {
        match self {
            ScheduleEvent::SlotHeld { .. } => "SlotHeld",
            ScheduleEvent::SlotReserved { .. } => "SlotReserved",
            ScheduleEvent::SlotReleased { .. } => "SlotReleased",
            ScheduleEvent::SlotFulfilled { .. } => "SlotFulfilled",
            ScheduleEvent::CapacityChanged { .. } => "CapacityChanged",
            ScheduleEvent::CapsRefreshed { .. } => "CapsRefreshed",
            ScheduleEvent::BakeListChanged { .. } => "BakeListChanged",
        }
    }
}

/// The rule a schedule command broke. [`ScheduleError::rule`] names it for the problem
/// document; a full slot is a 409 that names the next free one.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ScheduleError {
    #[error("the bakery is closed that day")]
    ClosedDay,
    #[error("that is not one of the day's pickup slots or delivery windows")]
    NoSuchSlot,
    #[error("a delivery window needs a zone")]
    ZoneRequired,
    #[error("{zone} is not a delivery zone")]
    UnknownZone { zone: String },
    #[error("{}", slot_full_text(.next_free))]
    SlotFull { next_free: Option<BusinessTime> },
    #[error("{item} has {free} left today")]
    ItemCapExceeded { item: String, free: u32 },
    #[error("this order already holds a different place")]
    RefHeld,
    #[error("no hold for that order or event on this day")]
    UnknownRef,
    #[error("not a capacity target: {0}")]
    BadTarget(String),
}

fn slot_full_text(next_free: &Option<BusinessTime>) -> String {
    match next_free {
        Some(t) => format!("that time is full; the next free one is {t}"),
        None => "that time is full, and nothing later that day is free".to_owned(),
    }
}

impl ScheduleError {
    /// The slug a problem document names the rule by.
    pub fn rule(&self) -> &'static str {
        match self {
            ScheduleError::ClosedDay => "closed-day",
            ScheduleError::NoSuchSlot => "no-such-slot",
            ScheduleError::ZoneRequired => "zone-required",
            ScheduleError::UnknownZone { .. } => "unknown-zone",
            ScheduleError::SlotFull { .. } => "slot-full",
            ScheduleError::ItemCapExceeded { .. } => "item-cap",
            ScheduleError::RefHeld => "ref-held",
            ScheduleError::UnknownRef => "unknown-ref",
            ScheduleError::BadTarget(_) => "bad-target",
        }
    }
}

/// One place: a hold, then perhaps a reservation, keyed by the order or catering id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hold {
    #[serde(rename = "ref")]
    pub reference: Ulid,
    pub kind: HoldKind,
    pub start: BusinessTime,
    pub zone: Option<String>,
    pub lines: Vec<ItemQty>,
    pub expires_at: BusinessTime,
    pub status: HoldStatus,
    /// Reserved by a payment after it was released.
    pub revived: bool,
}

/// A pickup slot as the storefront reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotView {
    pub start: BusinessTime,
    pub capacity: u16,
    pub taken: u32,
}

/// A delivery zone's day as the storefront reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZoneView {
    pub zone: String,
    pub capacity: u16,
    pub taken: u32,
}

/// One day's capacities, places and plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleState {
    date: BakeryDate,
    open: bool,
    /// By local start, minutes after midnight; all 32 present.
    slot_capacity: BTreeMap<u16, u16>,
    zone_capacity: BTreeMap<String, u16>,
    item_caps: BTreeMap<String, u32>,
    catering_capacity: u16,
    /// The menu version the item caps came from; 0 before the first refresh.
    menu_version: u32,
    holds: BTreeMap<Ulid, Hold>,
    plan: Plan,
}

impl ScheduleState {
    /// A day with the default capacities, no item caps and no places. Open Tuesday to Sunday.
    pub fn new(date: BakeryDate) -> ScheduleState {
        ScheduleState {
            date,
            open: date.is_open(),
            slot_capacity: slot_minutes().map(|m| (m, DEFAULT_SLOT_CAPACITY)).collect(),
            zone_capacity: ZONES
                .iter()
                .map(|z| ((*z).to_owned(), DEFAULT_ZONE_CAPACITY))
                .collect(),
            item_caps: BTreeMap::new(),
            catering_capacity: DEFAULT_CATERING_CAPACITY,
            menu_version: 0,
            holds: BTreeMap::new(),
            plan: Plan::default(),
        }
    }

    pub fn date(&self) -> BakeryDate {
        self.date
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn menu_version(&self) -> u32 {
        self.menu_version
    }

    pub fn hold(&self, reference: Ulid) -> Option<&Hold> {
        self.holds.get(&reference)
    }

    /// Every place ever held this day, released ones included, by ref.
    pub fn holds(&self) -> impl Iterator<Item = &Hold> {
        self.holds.values()
    }

    pub fn plan(&self) -> &Plan {
        &self.plan
    }

    pub fn item_cap(&self, item: &str) -> Option<u32> {
        self.item_caps.get(item).copied()
    }

    /// Every item cap, by slug: the menu's, or a staff member's since.
    pub fn item_caps(&self) -> impl Iterator<Item = (&str, u32)> {
        self.item_caps
            .iter()
            .map(|(item, cap)| (item.as_str(), *cap))
    }

    pub fn catering_capacity(&self) -> u16 {
        self.catering_capacity
    }

    /// The 32 slots with their capacity and the places that count against it.
    pub fn slots(&self) -> Vec<SlotView> {
        self.date
            .slot_starts()
            .into_iter()
            .map(|start| {
                let m = local_minutes(start);
                SlotView {
                    start,
                    capacity: self.slot_cap(m),
                    taken: self.slot_taken(m),
                }
            })
            .collect()
    }

    pub fn zones(&self) -> Vec<ZoneView> {
        self.zone_capacity
            .iter()
            .map(|(zone, &capacity)| ZoneView {
                zone: zone.clone(),
                capacity,
                taken: self.zone_taken(zone),
            })
            .collect()
    }

    /// Units of `item` held, reserved or fulfilled today.
    pub fn item_used(&self, item: &str) -> u32 {
        self.counting()
            .flat_map(|h| &h.lines)
            .filter(|l| l.item == item)
            .map(|l| l.qty)
            .fold(0u32, u32::saturating_add)
    }

    /// Catering events held, reserved or fulfilled today.
    pub fn catering_taken(&self) -> u32 {
        self.count(|h| h.kind == HoldKind::Catering)
    }

    /// The holds still waiting for payment, with when each expires: the timers the object arms.
    pub fn held_expiries(&self) -> Vec<(Ulid, BusinessTime)> {
        let mut out: Vec<(Ulid, BusinessTime)> = self
            .holds
            .values()
            .filter(|h| h.status == HoldStatus::Held)
            .map(|h| (h.reference, h.expires_at))
            .collect();
        out.sort_by_key(|&(r, t)| (t, r));
        out
    }

    /// The plan a fresh projection of the reserved and fulfilled places gives: grouped by item
    /// and start, sorted by start then item.
    pub fn projected_plan(&self) -> Vec<PlanLine> {
        project(self.holds.values().map(|h| (h, h.status)))
    }

    fn counting(&self) -> impl Iterator<Item = &Hold> {
        self.holds.values().filter(|h| h.status.counts())
    }

    fn count(&self, f: impl Fn(&Hold) -> bool) -> u32 {
        // A day holds far fewer than 4 billion places.
        self.counting().filter(|h| f(h)).count() as u32
    }

    fn slot_cap(&self, minute: u16) -> u16 {
        self.slot_capacity.get(&minute).copied().unwrap_or(0)
    }

    fn slot_taken(&self, minute: u16) -> u32 {
        self.count(|h| h.kind == HoldKind::Slot && local_minutes(h.start) == minute)
    }

    fn zone_cap(&self, zone: &str) -> u16 {
        self.zone_capacity.get(zone).copied().unwrap_or(0)
    }

    fn zone_taken(&self, zone: &str) -> u32 {
        self.count(|h| h.kind == HoldKind::Window && h.zone.as_deref() == Some(zone))
    }
}

/// The plan from places and the status each is taken at.
fn project<'a>(places: impl Iterator<Item = (&'a Hold, HoldStatus)>) -> Vec<PlanLine> {
    let mut sums: BTreeMap<(i64, &str), (BusinessTime, u32)> = BTreeMap::new();
    for (hold, status) in places {
        if !status.planned() {
            continue;
        }
        for line in &hold.lines {
            let entry = sums
                .entry((hold.start.unix_ms(), line.item.as_str()))
                .or_insert((hold.start, 0));
            entry.1 = entry.1.saturating_add(line.qty);
        }
    }
    sums.into_iter()
        .map(|((_, item), (start, qty))| PlanLine {
            item: item.to_owned(),
            qty,
            start,
        })
        .collect()
}

/// The aggregate hosted by `Schedule`.
pub struct Schedule;

impl Aggregate for Schedule {
    type State = ScheduleState;
    type Command = ScheduleCommand;
    type Event = ScheduleEvent;
    type Error = ScheduleError;

    fn decide(
        state: &ScheduleState,
        cmd: &ScheduleCommand,
        ctx: &DecideContext,
    ) -> Result<Vec<ScheduleEvent>, ScheduleError> {
        match cmd {
            ScheduleCommand::Hold(req) => hold(state, req),
            ScheduleCommand::Confirm { reference } => {
                let h = state
                    .holds
                    .get(reference)
                    .ok_or(ScheduleError::UnknownRef)?;
                let revived = match h.status {
                    HoldStatus::Held => false,
                    // The hold's timer won the race with a late payment: the money moved, so
                    // the place comes back, past capacity if need be.
                    HoldStatus::Released => true,
                    HoldStatus::Reserved | HoldStatus::Fulfilled => return Ok(Vec::new()),
                };
                let mut events = vec![ScheduleEvent::SlotReserved {
                    kind: h.kind,
                    date: state.date,
                    start: h.start,
                    reference: h.reference,
                    revived,
                }];
                events.extend(replan(state, h.reference, HoldStatus::Reserved));
                Ok(events)
            }
            ScheduleCommand::Release { reference, reason } => {
                let Some(h) = state.holds.get(reference) else {
                    return Ok(Vec::new());
                };
                let releases = match (h.status, reason) {
                    (HoldStatus::Released | HoldStatus::Fulfilled, _) => false,
                    // The timer releases only an unpaid hold whose time is up.
                    (HoldStatus::Held, ReleaseReason::HoldExpired) => h.expires_at <= ctx.now,
                    (
                        HoldStatus::Reserved,
                        ReleaseReason::HoldExpired | ReleaseReason::DepositLapsed,
                    ) => false,
                    (HoldStatus::Held | HoldStatus::Reserved, _) => true,
                };
                if !releases {
                    return Ok(Vec::new());
                }
                let mut events = vec![ScheduleEvent::SlotReleased {
                    kind: h.kind,
                    date: state.date,
                    start: h.start,
                    reference: h.reference,
                    reason: *reason,
                }];
                events.extend(replan(state, h.reference, HoldStatus::Released));
                Ok(events)
            }
            ScheduleCommand::Fulfil { reference } => match state.holds.get(reference) {
                Some(h) if h.status == HoldStatus::Reserved => {
                    // Reserved and fulfilled are both planned, so the plan keeps its lines.
                    Ok(vec![ScheduleEvent::SlotFulfilled {
                        kind: h.kind,
                        date: state.date,
                        start: h.start,
                        reference: h.reference,
                    }])
                }
                _ => Ok(Vec::new()),
            },
            ScheduleCommand::SetCapacity { target, capacity } => {
                let current = match target {
                    Target::Slot(m) => Some(u32::from(state.slot_cap(*m))),
                    Target::Zone(z) => Some(u32::from(state.zone_cap(z))),
                    Target::Item(i) => state.item_cap(i),
                    Target::Catering => Some(u32::from(state.catering_capacity)),
                };
                if current == Some(u32::from(*capacity)) {
                    return Ok(Vec::new());
                }
                // A lowered capacity releases nothing: it only stops new holds.
                Ok(vec![ScheduleEvent::CapacityChanged {
                    target: target.clone(),
                    capacity: *capacity,
                }])
            }
            ScheduleCommand::RefreshCaps { menu_version, caps } => {
                if *menu_version <= state.menu_version {
                    return Ok(Vec::new());
                }
                let new: BTreeMap<String, u32> =
                    caps.iter().map(|c| (c.item.clone(), c.daily_cap)).collect();
                if new == state.item_caps {
                    return Ok(Vec::new());
                }
                Ok(vec![ScheduleEvent::CapsRefreshed {
                    menu_version: *menu_version,
                    caps: new
                        .into_iter()
                        .map(|(item, daily_cap)| ItemCap { item, daily_cap })
                        .collect(),
                }])
            }
        }
    }

    fn evolve(mut state: ScheduleState, event: &ScheduleEvent) -> ScheduleState {
        match event {
            ScheduleEvent::SlotHeld {
                kind,
                start,
                reference,
                zone,
                lines,
                expires_at,
                ..
            } => {
                let fresh = Hold {
                    reference: *reference,
                    kind: *kind,
                    start: *start,
                    zone: zone.clone(),
                    lines: lines.clone(),
                    expires_at: *expires_at,
                    status: HoldStatus::Held,
                    revived: false,
                };
                match state.holds.get(reference) {
                    None => {
                        state.holds.insert(*reference, fresh);
                    }
                    // A catering place given back is taken again (see the module doc).
                    Some(h) if rehold_allowed(h) => {
                        state.holds.insert(*reference, fresh);
                    }
                    Some(_) => {}
                }
            }
            ScheduleEvent::SlotReserved {
                reference, revived, ..
            } => {
                if let Some(h) = state.holds.get_mut(reference) {
                    h.status = HoldStatus::Reserved;
                    h.revived |= *revived;
                }
            }
            ScheduleEvent::SlotReleased { reference, .. } => {
                if let Some(h) = state.holds.get_mut(reference) {
                    h.status = HoldStatus::Released;
                }
            }
            ScheduleEvent::SlotFulfilled { reference, .. } => {
                if let Some(h) = state.holds.get_mut(reference) {
                    h.status = HoldStatus::Fulfilled;
                }
            }
            ScheduleEvent::CapacityChanged { target, capacity } => match target {
                Target::Slot(m) => {
                    state.slot_capacity.insert(*m, *capacity);
                }
                Target::Zone(z) => {
                    state.zone_capacity.insert(z.clone(), *capacity);
                }
                Target::Item(i) => {
                    state.item_caps.insert(i.clone(), u32::from(*capacity));
                }
                Target::Catering => state.catering_capacity = *capacity,
            },
            ScheduleEvent::CapsRefreshed { menu_version, caps } => {
                state.menu_version = *menu_version;
                state.item_caps = caps.iter().map(|c| (c.item.clone(), c.daily_cap)).collect();
            }
            ScheduleEvent::BakeListChanged { version, lines, .. } => {
                state.plan = Plan {
                    version: *version,
                    lines: lines.clone(),
                };
            }
        }
        state
    }
}

/// Whether a place may be held again under its ref: a catering place that was released.
fn rehold_allowed(h: &Hold) -> bool {
    h.kind == HoldKind::Catering && h.status == HoldStatus::Released
}

/// `BakeListChanged` if moving `reference` to `status` changes the plan's lines.
fn replan(state: &ScheduleState, reference: Ulid, status: HoldStatus) -> Option<ScheduleEvent> {
    let lines = project(state.holds.values().map(|h| {
        let s = if h.reference == reference {
            status
        } else {
            h.status
        };
        (h, s)
    }));
    (lines != state.plan.lines).then(|| ScheduleEvent::BakeListChanged {
        date: state.date,
        version: state.plan.version + 1,
        lines,
    })
}

fn hold(state: &ScheduleState, req: &HoldRequest) -> Result<Vec<ScheduleEvent>, ScheduleError> {
    if !state.open {
        return Err(ScheduleError::ClosedDay);
    }
    let date = state.date;
    let at = |starts: Vec<BusinessTime>| {
        starts
            .into_iter()
            .find(|s| s.unix_ms() == req.start.unix_ms())
            .ok_or(ScheduleError::NoSuchSlot)
    };
    // The start as the calendar writes it, at Denver's offset that day, and the zone kept.
    let (start, zone) = match req.kind {
        HoldKind::Slot => (at(date.slot_starts())?, None),
        HoldKind::Window => {
            let zone = req.zone.as_deref().ok_or(ScheduleError::ZoneRequired)?;
            if zone.is_empty() {
                return Err(ScheduleError::ZoneRequired);
            }
            if !ZONES.contains(&zone) {
                return Err(ScheduleError::UnknownZone {
                    zone: zone.chars().take(20).collect(),
                });
            }
            (at(date.window_starts())?, Some(zone.to_owned()))
        }
        HoldKind::Catering => {
            if BakeryDate::of(req.start) != date {
                return Err(ScheduleError::NoSuchSlot);
            }
            let start =
                calendar::local(req.start.unix_ms()).map_err(|_| ScheduleError::NoSuchSlot)?;
            (start, None)
        }
    };
    let lines = normalize_lines(req.lines.iter().cloned());
    if let Some(existing) = state
        .holds
        .get(&req.reference)
        .filter(|h| !(rehold_allowed(h) && req.kind == HoldKind::Catering))
    {
        let same = existing.kind == req.kind
            && existing.start.unix_ms() == start.unix_ms()
            && existing.zone == zone
            && existing.lines == lines
            && existing.expires_at.unix_ms() == req.expires_at.unix_ms();
        return if same {
            Ok(Vec::new())
        } else {
            Err(ScheduleError::RefHeld)
        };
    }
    match req.kind {
        HoldKind::Slot => {
            let m = local_minutes(start);
            if state.slot_taken(m) >= u32::from(state.slot_cap(m)) {
                let next_free = date
                    .slot_starts()
                    .into_iter()
                    .filter(|s| s.unix_ms() > start.unix_ms())
                    .find(|s| {
                        let m = local_minutes(*s);
                        state.slot_taken(m) < u32::from(state.slot_cap(m))
                    });
                return Err(ScheduleError::SlotFull { next_free });
            }
        }
        HoldKind::Window => {
            let zone = zone.as_deref().unwrap_or_default();
            if state.zone_taken(zone) >= u32::from(state.zone_cap(zone)) {
                // The zone's stops are shared by its three windows, so when one is full every
                // window in the zone is: there is no next free one that day.
                return Err(ScheduleError::SlotFull { next_free: None });
            }
        }
        HoldKind::Catering => {
            if state.catering_taken() >= u32::from(state.catering_capacity) {
                return Err(ScheduleError::SlotFull { next_free: None });
            }
        }
    }
    for line in &lines {
        if let Some(cap) = state.item_cap(&line.item) {
            let used = state.item_used(&line.item);
            if used.saturating_add(line.qty) > cap {
                return Err(ScheduleError::ItemCapExceeded {
                    item: line.item.clone(),
                    free: cap.saturating_sub(used),
                });
            }
        }
    }
    Ok(vec![ScheduleEvent::SlotHeld {
        kind: req.kind,
        date,
        start,
        reference: req.reference,
        zone,
        lines,
        expires_at: req.expires_at,
    }])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aggregate::{execute, replay_from};
    use crate::{Envelope, WallTime};
    use proptest::prelude::*;

    const DATE: &str = "2026-11-07";
    const NOW: &str = "2026-11-07T06:00:00-07:00";

    fn at(text: &str) -> BusinessTime {
        text.parse().unwrap()
    }

    fn date() -> BakeryDate {
        DATE.parse().unwrap()
    }

    fn id(n: u128) -> Ulid {
        Ulid::from_parts(1_793_000_000_000, n)
    }

    fn ctx_at(now: &str) -> DecideContext {
        DecideContext {
            now: at(now),
            id: id(9_999),
        }
    }

    fn lines(items: &[(&str, u32)]) -> Vec<ItemQty> {
        items
            .iter()
            .map(|&(item, qty)| ItemQty {
                item: item.into(),
                qty,
            })
            .collect()
    }

    fn pickup(r: u128, time: &str, items: &[(&str, u32)]) -> ScheduleCommand {
        ScheduleCommand::Hold(Box::new(HoldRequest {
            reference: id(r),
            kind: HoldKind::Slot,
            start: at(&format!("{DATE}T{time}:00-07:00")),
            zone: None,
            lines: lines(items),
            expires_at: at("2026-11-07T06:15:00-07:00"),
        }))
    }

    fn delivery(r: u128, time: &str, zone: Option<&str>) -> ScheduleCommand {
        ScheduleCommand::Hold(Box::new(HoldRequest {
            reference: id(r),
            kind: HoldKind::Window,
            start: at(&format!("{DATE}T{time}:00-07:00")),
            zone: zone.map(str::to_owned),
            lines: lines(&[("baguette", 1)]),
            expires_at: at("2026-11-07T06:15:00-07:00"),
        }))
    }

    fn run(
        state: ScheduleState,
        cmd: &ScheduleCommand,
    ) -> Result<(ScheduleState, Vec<ScheduleEvent>), ScheduleError> {
        execute::<Schedule>(state, cmd, &ctx_at(NOW))
    }

    fn ok(state: ScheduleState, cmd: ScheduleCommand) -> ScheduleState {
        run(state, &cmd).unwrap().0
    }

    fn fresh() -> ScheduleState {
        ScheduleState::new(date())
    }

    #[test]
    fn a_new_day_has_the_defaults() {
        let s = fresh();
        assert!(s.is_open());
        assert_eq!(s.slots().len(), 32);
        assert!(s.slots().iter().all(|v| v.capacity == 6 && v.taken == 0));
        let zones: Vec<(String, u16)> = s
            .zones()
            .into_iter()
            .map(|z| (z.zone, z.capacity))
            .collect();
        assert_eq!(
            zones,
            [("z1".into(), 20), ("z2".into(), 20), ("z3".into(), 20)]
        );
        assert_eq!(s.catering_capacity(), 2);
        assert_eq!(s.plan(), &Plan::default());
        assert!(!ScheduleState::new("2026-11-09".parse().unwrap()).is_open());
    }

    #[test]
    fn a_hold_takes_a_place_and_sums_lines_per_item() {
        let (s, events) = run(
            fresh(),
            &pickup(
                1,
                "09:15",
                &[("croissant", 2), ("baguette", 1), ("croissant", 3)],
            ),
        )
        .unwrap();
        assert_eq!(
            events,
            [ScheduleEvent::SlotHeld {
                kind: HoldKind::Slot,
                date: date(),
                start: at("2026-11-07T09:15:00-07:00"),
                reference: id(1),
                zone: None,
                lines: lines(&[("baguette", 1), ("croissant", 5)]),
                expires_at: at("2026-11-07T06:15:00-07:00"),
            }]
        );
        assert_eq!(s.slots()[9].taken, 1);
        assert_eq!(s.item_used("croissant"), 5);
        assert_eq!(
            s.held_expiries(),
            [(id(1), at("2026-11-07T06:15:00-07:00"))]
        );
        // Held is not on the plan.
        assert!(s.plan().lines.is_empty());
    }

    #[test]
    fn holds_are_refused_by_rule() {
        let s = fresh();
        let err = |cmd: ScheduleCommand| run(s.clone(), &cmd).unwrap_err();
        assert_eq!(err(pickup(1, "09:05", &[])).rule(), "no-such-slot");
        assert_eq!(err(pickup(1, "15:00", &[])).rule(), "no-such-slot");
        assert_eq!(err(pickup(1, "06:45", &[])).rule(), "no-such-slot");
        assert_eq!(err(delivery(1, "10:00", Some("z1"))).rule(), "no-such-slot");
        assert_eq!(err(delivery(1, "09:00", None)), ScheduleError::ZoneRequired);
        assert_eq!(err(delivery(1, "09:00", Some(""))).rule(), "zone-required");
        assert_eq!(
            err(delivery(1, "09:00", Some("z9"))),
            ScheduleError::UnknownZone { zone: "z9".into() }
        );
        let monday = ScheduleState::new("2026-11-09".parse().unwrap());
        let mut hold = pickup(1, "09:00", &[]);
        if let ScheduleCommand::Hold(r) = &mut hold {
            r.start = at("2026-11-09T09:00:00-07:00");
        }
        assert_eq!(run(monday, &hold).unwrap_err().rule(), "closed-day");
        // A start on another day is not one of this day's slots.
        let mut other_day = pickup(1, "09:00", &[]);
        if let ScheduleCommand::Hold(r) = &mut other_day {
            r.start = at("2026-11-08T09:00:00-07:00");
        }
        assert_eq!(err(other_day).rule(), "no-such-slot");
    }

    #[test]
    fn the_last_place_goes_to_one_and_the_other_hears_the_next_free_slot() {
        let mut s = fresh();
        for r in 0..6 {
            s = ok(s, pickup(r, "10:00", &[]));
        }
        // 10:15 is full too, so the next free one is 10:30.
        for r in 10..16 {
            s = ok(s, pickup(r, "10:15", &[]));
        }
        let e = run(s.clone(), &pickup(99, "10:00", &[])).unwrap_err();
        assert_eq!(
            e,
            ScheduleError::SlotFull {
                next_free: Some(at("2026-11-07T10:30:00-07:00"))
            }
        );
        assert_eq!(e.rule(), "slot-full");
        assert_eq!(
            e.to_string(),
            "that time is full; the next free one is 2026-11-07T10:30:00-07:00"
        );
        // The last slot of the day, full, has nothing after it.
        for r in 20..26 {
            s = ok(s, pickup(r, "14:45", &[]));
        }
        assert_eq!(
            run(s, &pickup(99, "14:45", &[])).unwrap_err(),
            ScheduleError::SlotFull { next_free: None }
        );
    }

    #[test]
    fn a_zone_shares_its_stops_across_its_windows() {
        let set = ScheduleCommand::SetCapacity {
            target: Target::Zone("z2".into()),
            capacity: 2,
        };
        let mut s = ok(fresh(), set);
        s = ok(s, delivery(1, "09:00", Some("z2")));
        s = ok(s, delivery(2, "13:00", Some("z2")));
        assert_eq!(
            run(s.clone(), &delivery(3, "11:00", Some("z2"))).unwrap_err(),
            ScheduleError::SlotFull { next_free: None }
        );
        // Another zone is unaffected.
        assert!(run(s, &delivery(3, "11:00", Some("z1"))).is_ok());
    }

    #[test]
    fn item_caps_count_held_reserved_and_fulfilled_units() {
        let refresh = ScheduleCommand::RefreshCaps {
            menu_version: 1,
            caps: vec![ItemCap {
                item: "croissant".into(),
                daily_cap: 10,
            }],
        };
        let mut s = ok(fresh(), refresh);
        s = ok(s, pickup(1, "09:00", &[("croissant", 6)]));
        s = ok(s, ScheduleCommand::Confirm { reference: id(1) });
        s = ok(s, ScheduleCommand::Fulfil { reference: id(1) });
        s = ok(s, pickup(2, "09:00", &[("croissant", 3)]));
        assert_eq!(
            run(s.clone(), &pickup(3, "09:15", &[("croissant", 2)])).unwrap_err(),
            ScheduleError::ItemCapExceeded {
                item: "croissant".into(),
                free: 1
            }
        );
        assert_eq!(
            run(s.clone(), &pickup(3, "09:15", &[("croissant", 2)]))
                .unwrap_err()
                .rule(),
            "item-cap"
        );
        // An uncapped item is not refused, and a release frees its units.
        assert!(run(s.clone(), &pickup(3, "09:15", &[("baguette", 99)])).is_ok());
        s = ok(
            s,
            ScheduleCommand::Release {
                reference: id(2),
                reason: ReleaseReason::Cancelled,
            },
        );
        assert!(run(s, &pickup(3, "09:15", &[("croissant", 4)])).is_ok());
    }

    #[test]
    fn a_repeated_hold_is_a_no_op_and_a_different_one_is_refused() {
        let s = ok(fresh(), pickup(1, "09:00", &[("croissant", 1)]));
        assert_eq!(
            run(s.clone(), &pickup(1, "09:00", &[("croissant", 1)]))
                .unwrap()
                .1,
            []
        );
        let e = run(s, &pickup(1, "09:15", &[("croissant", 1)])).unwrap_err();
        assert_eq!(e, ScheduleError::RefHeld);
        assert_eq!(e.rule(), "ref-held");
    }

    #[test]
    fn confirm_reserves_and_puts_the_order_on_the_plan() {
        let s = ok(
            fresh(),
            pickup(1, "09:00", &[("croissant", 2), ("baguette", 1)]),
        );
        let (s, events) = run(s, &ScheduleCommand::Confirm { reference: id(1) }).unwrap();
        let start = at("2026-11-07T09:00:00-07:00");
        assert_eq!(
            events,
            [
                ScheduleEvent::SlotReserved {
                    kind: HoldKind::Slot,
                    date: date(),
                    start,
                    reference: id(1),
                    revived: false
                },
                ScheduleEvent::BakeListChanged {
                    date: date(),
                    version: 1,
                    lines: vec![
                        PlanLine {
                            item: "baguette".into(),
                            qty: 1,
                            start
                        },
                        PlanLine {
                            item: "croissant".into(),
                            qty: 2,
                            start
                        },
                    ]
                }
            ]
        );
        assert_eq!(s.hold(id(1)).unwrap().status, HoldStatus::Reserved);
        assert!(s.held_expiries().is_empty());
        // A redelivered OrderPaid changes nothing.
        assert_eq!(
            run(s.clone(), &ScheduleCommand::Confirm { reference: id(1) })
                .unwrap()
                .1,
            []
        );
        let e = run(s, &ScheduleCommand::Confirm { reference: id(7) }).unwrap_err();
        assert_eq!(
            (e.clone(), e.rule()),
            (ScheduleError::UnknownRef, "unknown-ref")
        );
    }

    #[test]
    fn the_plan_groups_by_start_and_item_and_counts_versions() {
        let mut s = fresh();
        s = ok(s, pickup(1, "09:00", &[("croissant", 2)]));
        s = ok(s, pickup(2, "09:00", &[("croissant", 3)]));
        s = ok(s, pickup(3, "08:00", &[("scone", 1)]));
        s = ok(s, delivery(4, "09:00", Some("z1")));
        for r in 1..=4 {
            s = ok(s, ScheduleCommand::Confirm { reference: id(r) });
        }
        let plan = s.plan();
        assert_eq!(plan.version, 4);
        let rows: Vec<(String, u32, String)> = plan
            .lines
            .iter()
            .map(|l| {
                (
                    l.start.to_string()[11..16].to_owned(),
                    l.qty,
                    l.item.clone(),
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                ("08:00".into(), 1, "scone".into()),
                ("09:00".into(), 1, "baguette".into()),
                ("09:00".into(), 5, "croissant".into()),
            ]
        );
        // Fulfilment keeps the lines and emits no new plan.
        let (s, events) = run(s, &ScheduleCommand::Fulfil { reference: id(1) }).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].name(), "SlotFulfilled");
        assert_eq!(s.plan().version, 4);
        // Releasing a reservation takes its lines off.
        let (s, events) = run(
            s,
            &ScheduleCommand::Release {
                reference: id(2),
                reason: ReleaseReason::Cancelled,
            },
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(s.plan().version, 5);
        assert!(
            s.plan()
                .lines
                .iter()
                .any(|l| l.item == "croissant" && l.qty == 2)
        );
        assert_eq!(s.projected_plan(), s.plan().lines);
    }

    #[test]
    fn release_rules() {
        let held = ok(fresh(), pickup(1, "09:00", &[("croissant", 1)]));
        let release = |reason| ScheduleCommand::Release {
            reference: id(1),
            reason,
        };
        // The timer releases a hold only once it is due, and the Order's events at any time.
        let early = execute::<Schedule>(
            held.clone(),
            &release(ReleaseReason::HoldExpired),
            &ctx_at("2026-11-07T06:14:59-07:00"),
        )
        .unwrap();
        assert_eq!(early.1, []);
        let due = execute::<Schedule>(
            held.clone(),
            &release(ReleaseReason::HoldExpired),
            &ctx_at("2026-11-07T06:15:00-07:00"),
        )
        .unwrap();
        assert_eq!(due.1.len(), 1);
        assert_eq!(due.0.hold(id(1)).unwrap().status, HoldStatus::Released);
        let (released, events) = run(held.clone(), &release(ReleaseReason::Expired)).unwrap();
        assert_eq!(
            events,
            [ScheduleEvent::SlotReleased {
                kind: HoldKind::Slot,
                date: date(),
                start: at("2026-11-07T09:00:00-07:00"),
                reference: id(1),
                reason: ReleaseReason::Expired,
            }]
        );
        // Released, unknown and fulfilled are no-ops.
        assert_eq!(
            run(released, &release(ReleaseReason::Cancelled)).unwrap().1,
            []
        );
        assert_eq!(
            run(
                fresh(),
                &ScheduleCommand::Release {
                    reference: id(5),
                    reason: ReleaseReason::Cancelled
                }
            )
            .unwrap()
            .1,
            []
        );
        // The timer never releases a reservation, even past its time.
        let reserved = ok(held, ScheduleCommand::Confirm { reference: id(1) });
        let late = execute::<Schedule>(
            reserved.clone(),
            &release(ReleaseReason::HoldExpired),
            &ctx_at("2026-11-07T08:00:00-07:00"),
        )
        .unwrap();
        assert_eq!(late.1, []);
        let fulfilled = ok(reserved, ScheduleCommand::Fulfil { reference: id(1) });
        assert_eq!(
            run(fulfilled, &release(ReleaseReason::Cancelled))
                .unwrap()
                .1,
            []
        );
    }

    #[test]
    fn a_late_payment_revives_a_released_hold_past_capacity() {
        let set = ScheduleCommand::SetCapacity {
            target: Target::Slot(9 * 60),
            capacity: 1,
        };
        let mut s = ok(fresh(), set);
        s = ok(s, pickup(1, "09:00", &[("croissant", 1)]));
        // The hold's timer fires at its expiry, before the payment lands.
        s = execute::<Schedule>(
            s,
            &ScheduleCommand::Release {
                reference: id(1),
                reason: ReleaseReason::HoldExpired,
            },
            &ctx_at("2026-11-07T06:15:00-07:00"),
        )
        .unwrap()
        .0;
        assert_eq!(s.hold(id(1)).unwrap().status, HoldStatus::Released);
        s = ok(s, pickup(2, "09:00", &[("croissant", 1)]));
        let (s, events) = run(s, &ScheduleCommand::Confirm { reference: id(1) }).unwrap();
        assert!(matches!(
            events[0],
            ScheduleEvent::SlotReserved { revived: true, .. }
        ));
        assert_eq!(events[0].to_data()["revived"], true);
        assert!(s.hold(id(1)).unwrap().revived);
        assert_eq!(s.slots()[8].taken, 2);
        assert_eq!(s.slots()[8].capacity, 1);
    }

    #[test]
    fn capacity_changes() {
        let s = ok(fresh(), pickup(1, "09:00", &[]));
        let s = ok(s, pickup(2, "09:00", &[]));
        let lower = ScheduleCommand::SetCapacity {
            target: "slot:09:00".parse().unwrap(),
            capacity: 1,
        };
        let (s, events) = run(s, &lower).unwrap();
        assert_eq!(
            events,
            [ScheduleEvent::CapacityChanged {
                target: Target::Slot(540),
                capacity: 1
            }]
        );
        // Nothing is released; only new holds stop.
        assert_eq!(s.slots()[8].taken, 2);
        assert!(s.holds().all(|h| h.status == HoldStatus::Held));
        assert_eq!(
            run(s.clone(), &pickup(3, "09:00", &[])).unwrap_err().rule(),
            "slot-full"
        );
        // The same capacity again is a no-op.
        assert_eq!(run(s.clone(), &lower).unwrap().1, []);
        let cat = ok(
            s,
            ScheduleCommand::SetCapacity {
                target: Target::Catering,
                capacity: 3,
            },
        );
        assert_eq!(cat.catering_capacity(), 3);
        let item = ok(
            cat,
            ScheduleCommand::SetCapacity {
                target: Target::Item("scone".into()),
                capacity: 4,
            },
        );
        assert_eq!(item.item_cap("scone"), Some(4));
    }

    #[test]
    fn targets_parse_one_grammar() {
        for (text, target) in [
            ("slot:07:00", Target::Slot(420)),
            ("slot:14:45", Target::Slot(885)),
            ("zone:z3", Target::Zone("z3".into())),
            (
                "item:chocolate-layer-cake",
                Target::Item("chocolate-layer-cake".into()),
            ),
            ("catering", Target::Catering),
        ] {
            assert_eq!(Target::parse(text), Ok(target.clone()));
            assert_eq!(target.to_string(), text);
            assert_eq!(serde_json::to_value(&target).unwrap(), text);
        }
        for bad in [
            "",
            "slot:15:00",
            "slot:06:45",
            "slot:09:10",
            "slot:9:00",
            "slot:09:60",
            "zone:z4",
            "item:",
            "item:Croissant",
            "item:a b",
            "catering:1",
            "oven",
        ] {
            let e = Target::parse(bad).unwrap_err();
            assert_eq!(e.rule(), "bad-target", "{bad:?}");
        }
    }

    #[test]
    fn caps_refresh_only_forward_and_only_on_change() {
        let caps = |n| {
            vec![ItemCap {
                item: "scone".into(),
                daily_cap: n,
            }]
        };
        let (s, events) = run(
            fresh(),
            &ScheduleCommand::RefreshCaps {
                menu_version: 2,
                caps: caps(40),
            },
        )
        .unwrap();
        assert_eq!(
            events,
            [ScheduleEvent::CapsRefreshed {
                menu_version: 2,
                caps: caps(40)
            }]
        );
        assert_eq!(s.menu_version(), 2);
        // Older or equal versions are no-ops; a newer one with the same caps emits nothing.
        for v in [1, 2] {
            let cmd = ScheduleCommand::RefreshCaps {
                menu_version: v,
                caps: caps(10),
            };
            assert_eq!(run(s.clone(), &cmd).unwrap().1, []);
        }
        let same = ScheduleCommand::RefreshCaps {
            menu_version: 3,
            caps: caps(40),
        };
        assert_eq!(run(s.clone(), &same).unwrap().1, []);
        let changed = ScheduleCommand::RefreshCaps {
            menu_version: 3,
            caps: caps(30),
        };
        assert_eq!(ok(s, changed).item_cap("scone"), Some(30));
    }

    #[test]
    fn catering_holds_the_day() {
        let cater = |r: u128, time: &str| {
            ScheduleCommand::Hold(Box::new(HoldRequest {
                reference: id(r),
                kind: HoldKind::Catering,
                start: at(&format!("{DATE}T{time}:00-07:00")),
                zone: None,
                lines: vec![],
                expires_at: at("2026-11-07T06:15:00-07:00"),
            }))
        };
        let mut s = ok(fresh(), cater(1, "18:30"));
        s = ok(s, cater(2, "11:00"));
        assert_eq!(
            run(s.clone(), &cater(3, "12:00")).unwrap_err(),
            ScheduleError::SlotFull { next_free: None }
        );
        assert_eq!(s.catering_taken(), 2);
        let mut next_day = cater(4, "12:00");
        if let ScheduleCommand::Hold(r) = &mut next_day {
            r.start = at("2026-11-08T12:00:00-07:00");
        }
        assert_eq!(run(s, &next_day).unwrap_err().rule(), "no-such-slot");
    }

    #[test]
    fn a_catering_place_puts_the_package_on_the_bake_list_and_can_be_held_again() {
        // As catering::hold_request builds it: the day's opening, the package × the headcount.
        let opening = date().opening();
        assert_eq!(opening.to_string(), "2026-11-07T07:00:00-07:00");
        let cater = |expires: &str| {
            ScheduleCommand::Hold(Box::new(HoldRequest {
                reference: id(1),
                kind: HoldKind::Catering,
                start: opening,
                zone: None,
                lines: lines(&[("breakfast-spread", 40)]),
                expires_at: at(expires),
            }))
        };
        let held = ok(fresh(), cater("2026-11-07T06:15:00-07:00"));
        assert_eq!(held.catering_taken(), 1);
        // The deposit hold lapses: the place goes back, and the plan never had it.
        let (lapsed, events) = run(
            held,
            &ScheduleCommand::Release {
                reference: id(1),
                reason: ReleaseReason::DepositLapsed,
            },
        )
        .unwrap();
        assert!(matches!(
            events.as_slice(),
            [ScheduleEvent::SlotReleased {
                reason: ReleaseReason::DepositLapsed,
                ..
            }]
        ));
        assert_eq!(lapsed.catering_taken(), 0);
        // Accepted again: the same catering id holds the place again, with its new expiry.
        let (again, events) = run(lapsed, &cater("2026-11-07T06:40:00-07:00")).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(again.hold(id(1)).unwrap().status, HoldStatus::Held);
        assert_eq!(
            again.hold(id(1)).unwrap().expires_at.to_string(),
            "2026-11-07T06:40:00-07:00"
        );
        assert_eq!(
            run(again.clone(), &cater("2026-11-07T06:40:00-07:00"))
                .unwrap()
                .1,
            []
        );
        // The deposit is paid: the package is on the bake list at the opening.
        let paid = ok(again, ScheduleCommand::Confirm { reference: id(1) });
        assert_eq!(
            paid.plan().lines,
            [PlanLine {
                item: "breakfast-spread".into(),
                qty: 40,
                start: opening
            }]
        );
        // A lapse never releases a reserved place.
        assert_eq!(
            run(
                paid,
                &ScheduleCommand::Release {
                    reference: id(1),
                    reason: ReleaseReason::DepositLapsed
                }
            )
            .unwrap()
            .1,
            []
        );
        // An order's released place is not held again under its id.
        let order = ok(fresh(), pickup(2, "09:00", &[]));
        let order = ok(
            order,
            ScheduleCommand::Release {
                reference: id(2),
                reason: ReleaseReason::Expired,
            },
        );
        assert_eq!(
            run(order, &pickup(2, "09:15", &[])).unwrap_err(),
            ScheduleError::RefHeld
        );
    }

    #[test]
    fn a_start_shown_at_another_offset_is_stored_at_denvers() {
        // The same instant as 09:00 MST, written in UTC.
        let mut hold = pickup(1, "09:00", &[]);
        if let ScheduleCommand::Hold(r) = &mut hold {
            r.start = at("2026-11-07T16:00:00+00:00");
        }
        let (s, _) = run(fresh(), &hold).unwrap();
        assert_eq!(
            s.hold(id(1)).unwrap().start.to_string(),
            "2026-11-07T09:00:00-07:00"
        );
        // The same body, written either way, is the same hold.
        assert_eq!(run(s, &pickup(1, "09:00", &[])).unwrap().1, []);
    }

    #[test]
    fn a_summer_day_uses_daylight_time() {
        let summer: BakeryDate = "2026-07-04".parse().unwrap();
        let s = ScheduleState::new(summer);
        let hold = ScheduleCommand::Hold(Box::new(HoldRequest {
            reference: id(1),
            kind: HoldKind::Slot,
            start: at("2026-07-04T07:00:00-06:00"),
            zone: None,
            lines: vec![],
            expires_at: at("2026-07-04T06:15:00-06:00"),
        }));
        assert!(run(s.clone(), &hold).is_ok());
        // 07:00 at the standard offset is 08:00 in Denver that day: a slot, but not the first.
        let shifted = ScheduleCommand::Hold(Box::new(HoldRequest {
            reference: id(2),
            kind: HoldKind::Slot,
            start: at("2026-07-04T07:00:00-07:00"),
            zone: None,
            lines: vec![],
            expires_at: at("2026-07-04T06:15:00-06:00"),
        }));
        let (s, _) = run(s, &shifted).unwrap();
        assert_eq!(
            s.hold(id(2)).unwrap().start.to_string(),
            "2026-07-04T08:00:00-06:00"
        );
    }

    fn envelope(seq: u64, event: &ScheduleEvent) -> Envelope {
        Envelope {
            v: 1,
            id: id(50_000 + u128::from(seq)),
            sandbox: id(7),
            stream: format!("schedule:{}:{DATE}", id(7)),
            seq,
            event_type: event.name().to_owned(),
            at: at(NOW),
            recorded_at: WallTime::from_unix_ms(1_793_000_000_000).unwrap(),
            data: event.to_data(),
            cause: None,
        }
    }

    #[test]
    fn every_event_round_trips_through_an_envelope() {
        let start = at("2026-11-07T09:00:00-07:00");
        let events = [
            ScheduleEvent::SlotHeld {
                kind: HoldKind::Window,
                date: date(),
                start,
                reference: id(1),
                zone: Some("z1".into()),
                lines: lines(&[("baguette", 2)]),
                expires_at: at(NOW),
            },
            ScheduleEvent::SlotReserved {
                kind: HoldKind::Slot,
                date: date(),
                start,
                reference: id(1),
                revived: false,
            },
            ScheduleEvent::SlotReserved {
                kind: HoldKind::Slot,
                date: date(),
                start,
                reference: id(1),
                revived: true,
            },
            ScheduleEvent::SlotReleased {
                kind: HoldKind::Catering,
                date: date(),
                start,
                reference: id(1),
                reason: ReleaseReason::HoldExpired,
            },
            ScheduleEvent::SlotFulfilled {
                kind: HoldKind::Slot,
                date: date(),
                start,
                reference: id(1),
            },
            ScheduleEvent::CapacityChanged {
                target: Target::Slot(540),
                capacity: 4,
            },
            ScheduleEvent::CapsRefreshed {
                menu_version: 3,
                caps: vec![ItemCap {
                    item: "scone".into(),
                    daily_cap: 50,
                }],
            },
            ScheduleEvent::BakeListChanged {
                date: date(),
                version: 2,
                lines: vec![PlanLine {
                    item: "scone".into(),
                    qty: 3,
                    start,
                }],
            },
        ];
        for (i, e) in events.iter().enumerate() {
            let env = envelope(i as u64 + 1, e);
            let text = serde_json::to_string(&env).unwrap();
            let back: Envelope = serde_json::from_str(&text).unwrap();
            assert_eq!(&ScheduleEvent::from_envelope(&back).unwrap(), e);
            assert!(ScheduleEvent::NAMES.contains(&e.name()));
        }
        // The wire names the catalog uses.
        let data = events[0].to_data();
        assert_eq!(data["ref"], id(1).to_string());
        assert_eq!(data["kind"], "window");
        assert_eq!(data["date"], DATE);
        assert!(events[1].to_data().get("revived").is_none());
        assert_eq!(events[3].to_data()["reason"], "hold_expired");
        assert_eq!(events[5].to_data()["target"], "slot:09:00");
        // A reader tolerates a missing `revived`.
        let mut d = events[2].to_data();
        d.as_object_mut().unwrap().remove("revived");
        assert!(matches!(
            ScheduleEvent::from_parts("SlotReserved", &d).unwrap(),
            ScheduleEvent::SlotReserved { revived: false, .. }
        ));
    }

    // Properties over random command sequences.

    const ITEMS: [&str; 2] = ["scone", "baguette"];
    const SLOT_TIMES: [&str; 4] = ["07:00", "07:15", "14:45", "07:05"];
    const WINDOW_TIMES: [&str; 3] = ["09:00", "13:00", "10:00"];

    fn command() -> impl Strategy<Value = ScheduleCommand> {
        let reference = (0u128..8).prop_map(id);
        let item_lines = proptest::collection::vec((0usize..2, 0u32..5), 0..3).prop_map(|v| {
            v.into_iter()
                .map(|(i, qty)| ItemQty {
                    item: ITEMS[i].into(),
                    qty,
                })
                .collect::<Vec<_>>()
        });
        let hold = (
            reference.clone(),
            0u8..3,
            0usize..4,
            prop::option::of(0usize..4),
            item_lines,
            0i64..60,
        )
            .prop_map(|(reference, kind, t, zone, lines, expires)| {
                let (kind, time) = match kind {
                    0 => (HoldKind::Slot, SLOT_TIMES[t]),
                    1 => (HoldKind::Window, WINDOW_TIMES[t % 3]),
                    _ => (HoldKind::Catering, "18:00"),
                };
                ScheduleCommand::Hold(Box::new(HoldRequest {
                    reference,
                    kind,
                    start: at(&format!("{DATE}T{time}:00-07:00")),
                    zone: zone.map(|z| ["z1", "z2", "z3", "zx"][z].to_owned()),
                    lines,
                    expires_at: at(NOW).plus_minutes(expires).unwrap(),
                }))
            });
        let reason = prop_oneof![
            Just(ReleaseReason::Expired),
            Just(ReleaseReason::Cancelled),
            Just(ReleaseReason::HoldExpired),
            Just(ReleaseReason::DepositLapsed),
        ];
        let target = prop_oneof![
            (0usize..3).prop_map(|i| Target::Slot([420, 435, 885][i])),
            (0usize..2).prop_map(|i| Target::Zone(["z1", "z2"][i].into())),
            (0usize..2).prop_map(|i| Target::Item(ITEMS[i].into())),
            Just(Target::Catering),
        ];
        prop_oneof![
            4 => hold,
            2 => reference.clone().prop_map(|reference| ScheduleCommand::Confirm { reference }),
            2 => (reference.clone(), reason)
                .prop_map(|(reference, reason)| ScheduleCommand::Release { reference, reason }),
            1 => reference.prop_map(|reference| ScheduleCommand::Fulfil { reference }),
            1 => (target, 0u16..4)
                .prop_map(|(target, capacity)| ScheduleCommand::SetCapacity { target, capacity }),
            1 => (0u32..4, 0u32..8).prop_map(|(menu_version, n)| ScheduleCommand::RefreshCaps {
                menu_version,
                caps: vec![
                    ItemCap { item: "scone".into(), daily_cap: n },
                    ItemCap { item: "baguette".into(), daily_cap: n + 2 },
                ],
            }),
        ]
    }

    /// The highest capacity each target has had in a run, `None` once an item went uncapped.
    #[derive(Default)]
    struct Highs {
        slot: BTreeMap<u16, u32>,
        zone: BTreeMap<String, u32>,
        item: BTreeMap<String, Option<u32>>,
        catering: u32,
    }

    impl Highs {
        fn note(&mut self, s: &ScheduleState) {
            for v in s.slots() {
                let m = local_minutes(v.start);
                let e = self.slot.entry(m).or_default();
                *e = (*e).max(u32::from(v.capacity));
            }
            for z in s.zones() {
                let e = self.zone.entry(z.zone).or_default();
                *e = (*e).max(u32::from(z.capacity));
            }
            for item in ITEMS {
                let e = self.item.entry(item.into()).or_insert(Some(0));
                *e = match (*e, s.item_cap(item)) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    _ => None,
                };
            }
            self.catering = self.catering.max(u32::from(s.catering_capacity()));
        }

        fn holds_for(&self, s: &ScheduleState) -> Result<(), TestCaseError> {
            for v in s.slots() {
                prop_assert!(v.taken <= self.slot[&local_minutes(v.start)], "slot {v:?}");
            }
            for z in s.zones() {
                prop_assert!(z.taken <= self.zone[&z.zone], "zone {z:?}");
            }
            for item in ITEMS {
                if let Some(high) = self.item[item] {
                    prop_assert!(s.item_used(item) <= high, "{item}");
                }
            }
            prop_assert!(s.catering_taken() <= self.catering);
            Ok(())
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        #[test]
        fn the_schedule_keeps_its_invariants(
            cmds in proptest::collection::vec(command(), 1..40),
            minutes in proptest::collection::vec(0i64..10, 40),
        ) {
            // Both items capped from the start, as a seeded day is.
            let start = ScheduleState::new(date());
            let (mut state, mut log) = execute::<Schedule>(
                start.clone(),
                &ScheduleCommand::RefreshCaps {
                    menu_version: 1,
                    caps: vec![
                        ItemCap { item: "scone".into(), daily_cap: 3 },
                        ItemCap { item: "baguette".into(), daily_cap: 5 },
                    ],
                },
                &ctx_at(NOW),
            )
            .unwrap();
            let mut now = at(NOW);
            let mut revived = false;
            let mut highs = Highs::default();
            highs.note(&state);
            for (cmd, step) in cmds.iter().zip(&minutes) {
                now = now.plus_minutes(*step).unwrap();
                let ctx = DecideContext { now, id: id(1) };
                let before = state.clone();
                match Schedule::decide(&state, cmd, &ctx) {
                    Ok(events) => {
                        revived |= events
                            .iter()
                            .any(|e| matches!(e, ScheduleEvent::SlotReserved { revived: true, .. }));
                        state = replay_from::<Schedule>(state, &events);
                        log.extend(events);
                        // A repeated command changes nothing.
                        prop_assert_eq!(Schedule::decide(&state, cmd, &ctx), Ok(vec![]));
                    }
                    Err(ScheduleError::SlotFull { next_free }) => {
                        let ScheduleCommand::Hold(req) = cmd else {
                            return Err(TestCaseError::fail("only a hold is full"));
                        };
                        // `next_free` is a later start with a free place, or none exists.
                        let later: Vec<SlotView> = state
                            .slots()
                            .into_iter()
                            .filter(|v| v.start > req.start && v.taken < u32::from(v.capacity))
                            .collect();
                        match (req.kind, next_free) {
                            (HoldKind::Slot, Some(t)) => {
                                prop_assert_eq!(Some(t), later.first().map(|v| v.start));
                            }
                            (HoldKind::Slot, None) => prop_assert!(later.is_empty()),
                            (_, n) => prop_assert_eq!(n, None),
                        }
                    }
                    Err(_) => {}
                }
                // A lowered capacity, or any command, drops no hold or reservation: only an
                // explicit release does.
                if !matches!(cmd, ScheduleCommand::Release { .. }) {
                    for h in before.holds() {
                        let after = state.hold(h.reference).unwrap();
                        prop_assert!(
                            !(h.status.counts() && after.status == HoldStatus::Released),
                            "{:?} released by {:?}", h.reference, cmd
                        );
                    }
                }
                // Held plus reserved stays within the highest capacity the run has set, unless a
                // late payment revived a place.
                highs.note(&state);
                if !revived {
                    highs.holds_for(&state)?;
                }
                // Every accepted hold fitted the capacity in force when it was taken.
                if let (ScheduleCommand::Hold(req), true) = (cmd, state.holds.len() > before.holds.len()) {
                    let h = state.hold(req.reference).unwrap();
                    match h.kind {
                        HoldKind::Slot => {
                            let m = local_minutes(h.start);
                            prop_assert!(state.slot_taken(m) <= u32::from(state.slot_cap(m)));
                        }
                        HoldKind::Window => {
                            let z = h.zone.as_deref().unwrap();
                            prop_assert!(state.zone_taken(z) <= u32::from(state.zone_cap(z)));
                        }
                        HoldKind::Catering => {
                            prop_assert!(state.catering_taken() <= u32::from(state.catering_capacity));
                        }
                    }
                    for line in &h.lines {
                        if let Some(cap) = state.item_cap(&line.item) {
                            prop_assert!(state.item_used(&line.item) <= cap);
                        }
                    }
                }
                // The state is the fold of its events, and the plan a fresh projection.
                prop_assert_eq!(&replay_from::<Schedule>(start.clone(), &log), &state);
                prop_assert_eq!(state.projected_plan(), state.plan().lines.clone());
            }
            // Plan versions count up by one with each emitted plan.
            let versions: Vec<u32> = log
                .iter()
                .filter_map(|e| match e {
                    ScheduleEvent::BakeListChanged { version, .. } => Some(*version),
                    _ => None,
                })
                .collect();
            prop_assert!(versions.iter().enumerate().all(|(i, v)| *v == i as u32 + 1));
        }
    }
}
