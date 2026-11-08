//! The Dispatch aggregate, hosted by `Dispatch`, one object per sandbox and bakery day
//! (`dispatch:<sandbox>:<YYYY-MM-DD>`; ADR 0012; docs/domain.md, "Ubiquitous language": Route,
//! Stop). It holds the day's stops, the server's proposed plan, the browser's submitted plan and
//! the published plan, and it is the one place a plan becomes the record: whoever made a plan,
//! only one that passes [`Dispatch`]'s validator is published.
//!
//! - **Stops** come from the Order's events: `AddStop` from `OrderPlaced` for a delivery
//!   (provisional), `ConfirmStop` from `OrderPaid`, `RemoveStop` from `OrderExpired` and
//!   `OrderCancelled`, each idempotent by order. A stop's size is its **units**, the order's line
//!   quantities summed, which is also what a van's capacity counts.
//! - **Plans** cover the day's confirmed stops, the ones not yet delivered ([`DispatchState::plannable`]).
//!   `Propose` runs the savings heuristic ([`savings_plan`]) and `SubmitPlan` takes the browser's
//!   VROOM plan; `Publish` makes either the record, as plan version `plan_v`, one more than the
//!   last, superseding it. A published plan is what drivers, the kitchen board and the order
//!   status read, through `RoutePublished`.
//! - **The validator** (ADR 0012, decision 4) holds for every plan before it is stored and again
//!   when it is published, since stops may have come and gone in between: every plannable stop
//!   exactly once (`stop-missing`, `stop-twice`), nothing that is not a confirmed stop of this
//!   day (`stop-unknown`), no van over capacity (`over-capacity`), each route from the bakery
//!   and back to it (`route-ends`), no more vans than the day has (`vans`), and every stop
//!   reached within its delivery window (`window`, [`windows`]: the vans leave at 09:00 and a
//!   van early at a door waits for the window to open). The minutes are recomputed from the
//!   matrix; a client's totals are never read.
//! - **A stop's number** is its position in the published plan, counted from 1 across the vans
//!   in van order: van 1's stops first. It is the `stop` of `OrderOutForDelivery` (with the route
//!   `van-<n>`), of `StopCompleted` and of the complete-stop request, and [`deliveries`] reads it
//!   off a `RoutePublished` alone. A later publish numbers its own plan.
//!
//! Choices this module makes where the docs are silent, each written at its rule:
//!
//! - **The state starts from the date**, as the Schedule's does: [`DispatchState::new`] holds
//!   the day and the default vans, and the object folds its log over it.
//! - **Out-of-order deliveries are remembered.** A `ConfirmStop` or `RemoveStop` for an order
//!   whose `AddStop` has not arrived records the fact (`StopConfirmed`, `StopRemoved`), so the
//!   stop is added confirmed, or not at all, when it does. A removed stop is never added again.
//! - **Events carry what the fold needs.** Four events the Dispatch keeps for itself (`StopAdded`,
//!   `StopConfirmed`, `StopRemoved`, `PlanSubmitted`, subscribers none, like the Schedule's
//!   `SlotHeld`) and three optional additions in envelope v1: `RouteProposed.capacity`,
//!   `.routes` and `.unassigned`, so the proposal folds; and `RoutePublished.publish`, the
//!   publishing command's id, so a second publish with one key is a no-op.
//! - **The matrix rides in the command.** `Propose` and `SubmitPlan` carry the day's
//!   [`TravelMatrix`], a static fixture the object loads; it is never stored in the log.
//! - **A plan is not replaced once a van has left** (Joseph's decision of 2026-11-05 on the
//!   domain stream's question 4). Whether any order of the published plan is out for delivery
//!   (or delivered) is the Orders' to know, not this log's, so the object reads it from them and
//!   hands it to `Publish` as `departed`, as it hands `Propose` the matrix: a fresh publish with
//!   `departed` is refused `published`. `CompleteStop` still works.
//! - **A stop is completed only once its order is ready** (the order's lifecycle in
//!   docs/domain.md: ready, out for delivery on `RoutePublished`, delivered on `StopCompleted`;
//!   the console audit of 2026-11-08, finding 7). The object reads the order's status from the
//!   Order, as it reads `departed`, and hands `CompleteStop` whether it is ready, out for
//!   delivery or already delivered; an order still confirmed or in production is refused
//!   `not-ready`. `StopCompleted` carries the stop's route, `van-<n>`, so an order that became
//!   ready after the plan was published goes out for delivery and is delivered in one step.
//! - **An order made ready after its stop was published goes out when it is ready** (since
//!   2026-11-08). The Dispatch hears `OrderReady`, as it hears `OrderPaid`, and `ReadyStop`
//!   emits `StopReady` with the stop's route and number when the order is a confirmed stop of the
//!   published plan, once per order; the Order hears it and runs `MarkOutForDelivery`. The edge
//!   lives here because this log is the one that knows the published plan: an Order cannot tell
//!   whether a later publish moved or renumbered its stop. A `StopReady` counts as a van that
//!   has left, so the plan it was sent on is not replaced (`published`) even before the Order
//!   has heard it. An order ready before the publish needs nothing: `RoutePublished` finds it
//!   ready.
//! - **A stop says when its order has left** (the UI audit of 2026-11-08, second pass, N3). The
//!   Dispatch hears `OrderOutForDelivery`, as it hears `OrderReady`, and `DepartStop` emits
//!   `StopDeparted` for a confirmed stop, once, which makes it out for delivery: still a stop of
//!   the day's plan, completed as a confirmed one is. The mark follows the Order's event, not
//!   this log's `RoutePublished` or `StopReady`, because the Order is the one that decides
//!   whether it goes out (it refuses an order not yet ready), and an order ready before the
//!   publish leaves on `RoutePublished` with no `StopReady` at all. A stop out for delivery also
//!   counts as a van that has left (`published`).
//! - **The time the last van is back counts the doors and the waits**: each stop adds
//!   [`SERVICE_MINUTES`] (the route data's `serviceSeconds`, 180 s) to its van's drive (the same
//!   decision, question 5), and a van early at a door waits there for the window to open. A
//!   van's `minutes` stay drive minutes, which the validator and the comparison use.

mod matrix;
mod savings;
pub mod windows;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::aggregate::{Aggregate, DecideContext, DomainEvent};
use crate::calendar::{BakeryDate, WINDOW_STARTS};
use crate::order::{OrderEvent, OrderKind};
use crate::{BusinessTime, Ulid};

pub use matrix::{
    MAX_PLACES, MatrixError, MatrixPlace, PlaceIndex, SYNTHETIC_MINUTES, TravelMatrix, place_index,
    place_label,
};
pub use savings::savings_plan;
pub use windows::{Door, RouteTimes, route_times};

/// The most vans the bakery has (docs/domain.md, "The story": four on Saturdays).
pub const MAX_VANS: u8 = 4;
/// Vans a day starts with: the busy Saturday's four.
pub const DEFAULT_VANS: u8 = 4;
/// Units a van carries by default. The seed's busy Saturday is 63 orders of 400 to about 790
/// units (seeds 0 to 299, births 2026-11-04 and 2026-11-07, measured 2026-11-05 with
/// `bakery-seed`), one order up to 74. Four vans of 250 carry the largest with a fifth to spare,
/// which the heuristic needs to pack them; at 200 two of those 600 days left stops behind.
pub const DEFAULT_CAPACITY: u32 = 250;
/// When the vans leave, local minutes after midnight: the first delivery window, 09:00. The time
/// the last van is back is this plus the longest route's day: its drive, its doors and its
/// waits for windows to open ([`windows`]).
pub const DEPARTURE_MINUTES: u16 = WINDOW_STARTS[0];
/// Minutes a van spends at each door: `serviceSeconds`, 180, in the Salt Lake City route data
/// (`crates/seed/data/salt-lake-city/route-data.json`, built 2026-11-05; a test in `bakery-seed`
/// reads it). Counted in [`PlanSummary::last_back`], never in a plan's drive minutes.
pub const SERVICE_MINUTES: u32 = 3;

/// Where a stop stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopStatus {
    /// Placed, not yet paid: on the screen, in no plan.
    Provisional,
    /// Paid: every plan must carry it.
    Confirmed,
    /// Its order has gone out on its van (`OrderOutForDelivery`, heard as `DepartStop`): still a
    /// stop of the day's plan, not yet delivered.
    OutForDelivery,
    /// Expired or cancelled.
    Removed,
    /// Delivered.
    Completed,
}

impl StopStatus {
    /// Paid and not yet delivered or removed: confirmed, or out for delivery.
    pub fn is_open(self) -> bool {
        matches!(self, StopStatus::Confirmed | StopStatus::OutForDelivery)
    }
}

/// Why a stop left the day.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoveReason {
    Expired,
    Cancelled,
}

/// Who made a plan: the server's heuristic or the browser's solver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanSource {
    Server,
    Browser,
}

/// Which stored plan `Publish` makes the record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanChoice {
    /// The server's, from the last `Propose`.
    Proposed,
    /// The browser's, from the last `SubmitPlan`.
    Submitted,
}

/// One delivery: an order and a place (docs/domain.md, "Ubiquitous language": Stop).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stop {
    pub order: Ulid,
    pub customer: Ulid,
    /// The customer's place, an index into the matrix.
    pub place: PlaceIndex,
    /// The delivery window's start.
    pub window: BusinessTime,
    pub zone: String,
    /// The order's line quantities summed: what the stop takes of a van.
    pub units: u32,
    pub status: StopStatus,
}

/// One van's ordered stops (docs/domain.md, "Ubiquitous language": Route), as `RoutePublished`
/// carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VanRoute {
    /// 1 to the day's vans.
    pub van: u8,
    /// Order ids, in driving order.
    pub stops: Vec<Ulid>,
}

/// A plan: routes for some vans, their drive in minutes, and any stop no van could take.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub source: PlanSource,
    /// A published plan's version. A proposal or submission carries the version it would be
    /// published as when it was made, so one older than the published plan is stale.
    pub plan_v: u16,
    pub routes: Vec<VanRoute>,
    /// Every route's drive, bakery to bakery, summed.
    pub minutes: u32,
    /// Confirmed stops the plan leaves at the bakery; a plan with any cannot be published.
    pub unassigned: Vec<Ulid>,
}

impl Plan {
    /// The stop's number in this plan: its position counted from 1 across the vans, van 1's
    /// stops first.
    pub fn stop_number(&self, order: Ulid) -> Option<u16> {
        self.routes
            .iter()
            .flat_map(|r| &r.stops)
            .position(|&o| o == order)
            .and_then(|p| u16::try_from(p + 1).ok())
    }

    /// The order at stop number `stop`.
    pub fn stop_at(&self, stop: u16) -> Option<Ulid> {
        let k = usize::from(stop.checked_sub(1)?);
        self.routes.iter().flat_map(|r| &r.stops).nth(k).copied()
    }

    /// The plan with each van's units and minutes, and when the last van is back, for the
    /// screen. The minutes come from `matrix`, as the validator's do.
    pub fn summary(&self, state: &DispatchState, matrix: &TravelMatrix) -> PlanSummary {
        let vans: Vec<VanSummary> = self
            .routes
            .iter()
            .map(|r| {
                let places: Vec<PlaceIndex> = r
                    .stops
                    .iter()
                    .filter_map(|o| state.stops.get(o).map(|s| s.place))
                    .collect();
                VanSummary {
                    van: r.van,
                    stops: r.stops.clone(),
                    units: r
                        .stops
                        .iter()
                        .filter_map(|o| state.stops.get(o).map(|s| s.units))
                        .fold(0u32, u32::saturating_add),
                    minutes: matrix.route_minutes(&places).unwrap_or(0),
                }
            })
            .collect();
        let departure = windows::departure(state.date);
        // Each van's day: its drive, its time at the doors and its waits for windows to open;
        // the longest is back last.
        let longest = self
            .routes
            .iter()
            .map(|r| route_times(&state.doors(&r.stops), matrix).back)
            .max()
            .unwrap_or(0);
        PlanSummary {
            source: self.source,
            plan_v: self.plan_v,
            minutes: self.minutes,
            last_back: departure.plus_minutes(longest).unwrap_or(departure),
            unassigned: self.unassigned.clone(),
            vans,
        }
    }
}

/// One van of a [`PlanSummary`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VanSummary {
    pub van: u8,
    pub stops: Vec<Ulid>,
    pub units: u32,
    /// Bakery to bakery.
    pub minutes: u32,
}

/// A plan as the dispatch screen shows it (ADR 0012, decision 5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanSummary {
    pub source: PlanSource,
    pub plan_v: u16,
    pub vans: Vec<VanSummary>,
    pub minutes: u32,
    /// The vans leave at [`DEPARTURE_MINUTES`]; this is when the last is back: the longest of
    /// each van's drive, [`SERVICE_MINUTES`] at each of its doors and its waits for windows to
    /// open.
    pub last_back: BusinessTime,
    pub unassigned: Vec<Ulid>,
}

/// The server's and the browser's plans side by side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Comparison {
    pub server_minutes: u32,
    pub browser_minutes: u32,
    /// `(server − browser) / browser`, in tenths of a percent, rounded half away from zero:
    /// positive when the heuristic drives longer. `None` when the browser's plan drives 0
    /// minutes and the server's does not.
    pub gap_tenths_percent: Option<i64>,
}

/// The two plans' totals, when there are two; `None` without a browser plan, so the screen
/// shows the server's alone and says why.
pub fn compare(state: &DispatchState) -> Option<Comparison> {
    let (server, browser) = (state.proposed.as_ref()?, state.submitted.as_ref()?);
    let (s, b) = (i64::from(server.minutes), i64::from(browser.minutes));
    let gap = match (s, b) {
        (0, 0) => Some(0),
        (_, 0) => None,
        _ => {
            let scaled = (s - b) * 1_000;
            // Half away from zero.
            Some((scaled + scaled.signum() * b / 2) / b)
        }
    };
    Some(Comparison {
        server_minutes: server.minutes,
        browser_minutes: browser.minutes,
        gap_tenths_percent: gap,
    })
}

/// The route label an order's `OrderOutForDelivery` names: `van-2`.
pub fn route_label(van: u8) -> String {
    format!("van-{van}")
}

/// What a `RoutePublished` asks of each order, in stop order: the order, its route label and its
/// stop number. The consumer's `MarkOutForDelivery` for `Order (each stop)` is built from this.
pub fn deliveries(vans: &[VanRoute]) -> Vec<(Ulid, String, u16)> {
    vans.iter()
        .flat_map(|r| r.stops.iter().map(move |&o| (o, route_label(r.van))))
        .enumerate()
        .map(|(k, (o, route))| (o, route, u16::try_from(k + 1).unwrap_or(u16::MAX)))
        .collect()
}

/// A route as the browser submits it. `start` and `end` are the places its van leaves from and
/// comes back to, as VROOM reports them; left out, they are the bakery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubmittedRoute {
    pub van: u8,
    pub stops: Vec<Ulid>,
    #[serde(default)]
    pub start: Option<PlaceIndex>,
    #[serde(default)]
    pub end: Option<PlaceIndex>,
}

/// A provisional stop, from `OrderPlaced` for a delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddStop {
    pub order: Ulid,
    pub customer: Ulid,
    /// The customer's place. `OrderPlaced` does not carry it; the consumer reads it from the
    /// persona (the seed's `p<n>` through [`place_index`]).
    pub place: PlaceIndex,
    pub window: BusinessTime,
    pub zone: String,
    pub units: u32,
}

impl AddStop {
    /// The stop an `OrderPlaced` adds, given the customer's place: `None` for a pickup, or for an
    /// event that is not `OrderPlaced`.
    pub fn from_order_placed(event: &OrderEvent, place: PlaceIndex) -> Option<AddStop> {
        let OrderEvent::OrderPlaced {
            order,
            customer,
            kind: OrderKind::Delivery,
            slot,
            zone,
            lines,
            ..
        } = event
        else {
            return None;
        };
        Some(AddStop {
            order: *order,
            customer: *customer,
            place,
            window: *slot,
            zone: zone.clone().unwrap_or_default(),
            units: lines
                .iter()
                .map(|l| u32::from(l.qty))
                .fold(0, u32::saturating_add),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchCommand {
    /// From `OrderPlaced` with `kind: delivery`.
    AddStop(AddStop),
    /// From `OrderPaid`.
    ConfirmStop { order: Ulid },
    /// From `OrderExpired` or `OrderCancelled`.
    RemoveStop { order: Ulid, reason: RemoveReason },
    /// Staff: the server's plan for the confirmed stops, on `vans` vans of `capacity` units,
    /// which become the day's vans and capacity.
    Propose {
        vans: u8,
        capacity: u32,
        matrix: Arc<TravelMatrix>,
    },
    /// Staff, from the browser: a plan the browser's solver made.
    SubmitPlan {
        routes: Vec<SubmittedRoute>,
        matrix: Arc<TravelMatrix>,
    },
    /// Staff: make a stored plan the record. Keyed by the command's id. `departed` says whether
    /// any order of the published plan has gone out for delivery, which the object reads from
    /// the Orders before deciding: then the plan stands, and a new publish is refused. The
    /// matrix checks the plan's windows again.
    Publish {
        plan: PlanChoice,
        departed: bool,
        matrix: Arc<TravelMatrix>,
    },
    /// A driver, or staff: stop number `stop` of the published plan is delivered. `ready` says
    /// whether the stop's order is ready, out for delivery or delivered, which the object reads
    /// from the Order before deciding: an order not yet ready is refused `not-ready`.
    CompleteStop { stop: u16, ready: bool },
    /// From `OrderReady`: the order is made. When it is a confirmed stop of the published plan,
    /// it goes out on its route now; otherwise nothing.
    ReadyStop { order: Ulid },
    /// From `OrderOutForDelivery`: the order has gone out on `route` as stop number `stop`, which
    /// the Order's event names. A confirmed stop becomes out for delivery; otherwise nothing.
    DepartStop {
        order: Ulid,
        route: String,
        stop: u16,
    },
}

/// The Dispatch's rows in docs/domain.md, "The event catalog".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum DispatchEvent {
    StopAdded {
        date: BakeryDate,
        order: Ulid,
        customer: Ulid,
        place: PlaceIndex,
        window: BusinessTime,
        zone: String,
        units: u32,
    },
    StopConfirmed {
        date: BakeryDate,
        order: Ulid,
    },
    StopRemoved {
        date: BakeryDate,
        order: Ulid,
        reason: RemoveReason,
    },
    RouteProposed {
        date: BakeryDate,
        /// The version the proposal would be published as.
        plan_v: u16,
        /// The vans asked for, which the routes may not all use.
        vans: u8,
        minutes: u32,
        capacity: u32,
        routes: Vec<VanRoute>,
        unassigned: Vec<Ulid>,
    },
    PlanSubmitted {
        date: BakeryDate,
        plan_v: u16,
        vans: Vec<VanRoute>,
        minutes: u32,
    },
    RoutePublished {
        date: BakeryDate,
        plan_v: u16,
        source: PlanSource,
        vans: Vec<VanRoute>,
        minutes: u32,
        /// The publishing command's id.
        publish: Ulid,
    },
    StopCompleted {
        date: BakeryDate,
        stop: u16,
        order: Ulid,
        /// The stop's route in the published plan, `van-<n>`: an addition within envelope v1,
        /// so an order that was not ready when the plan was published goes out for delivery
        /// on its way to delivered. Absent in events written before it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        route: Option<String>,
    },
    /// A stop of the published plan whose order became ready after the plan was published: the
    /// Order goes out for delivery on `route`, as stop number `stop` of plan `plan_v`.
    StopReady {
        date: BakeryDate,
        plan_v: u16,
        stop: u16,
        order: Ulid,
        route: String,
    },
    /// A stop whose order has gone out for delivery, as its `OrderOutForDelivery` said: on
    /// `route`, as stop number `stop`. The Dispatch's own log, for the stop's status.
    StopDeparted {
        date: BakeryDate,
        order: Ulid,
        route: String,
        stop: u16,
    },
}

impl DomainEvent for DispatchEvent {
    const NAMES: &'static [&'static str] = &[
        "StopAdded",
        "StopConfirmed",
        "StopRemoved",
        "RouteProposed",
        "PlanSubmitted",
        "RoutePublished",
        "StopCompleted",
        "StopReady",
        "StopDeparted",
    ];

    fn name(&self) -> &'static str {
        match self {
            DispatchEvent::StopAdded { .. } => "StopAdded",
            DispatchEvent::StopConfirmed { .. } => "StopConfirmed",
            DispatchEvent::StopRemoved { .. } => "StopRemoved",
            DispatchEvent::RouteProposed { .. } => "RouteProposed",
            DispatchEvent::PlanSubmitted { .. } => "PlanSubmitted",
            DispatchEvent::RoutePublished { .. } => "RoutePublished",
            DispatchEvent::StopCompleted { .. } => "StopCompleted",
            DispatchEvent::StopReady { .. } => "StopReady",
            DispatchEvent::StopDeparted { .. } => "StopDeparted",
        }
    }
}

/// The rule a dispatch command broke. [`DispatchError::rule`] names it for the 422 problem.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DispatchError {
    #[error("the plan leaves out stop {order}")]
    StopMissing { order: Ulid },
    #[error("stop {order} is in the plan twice")]
    StopTwice { order: Ulid },
    #[error("{order} is not a confirmed stop of this day")]
    StopUnknown { order: Ulid },
    #[error("the published plan has no stop {stop}")]
    NoSuchStop { stop: u16 },
    #[error("van {van} carries {units} units, over its capacity of {capacity}")]
    OverCapacity { van: u8, units: u64, capacity: u32 },
    #[error("van {van} does not start and end at the bakery")]
    RouteEnds { van: u8 },
    #[error("there is no such plan to publish, or no published plan")]
    NoPlan,
    #[error("the day has no confirmed stops to plan")]
    NoStops,
    #[error("van {van} is not one of the day's 1 to {vans}")]
    Vans { van: u8, vans: u8 },
    #[error("a van carries at least one unit")]
    Capacity,
    #[error("the stop's window is not on this day")]
    WrongDay,
    #[error("stop {order}'s place {place} is not in the travel-time matrix")]
    PlaceUnknown { order: Ulid, place: PlaceIndex },
    #[error("a van has left on the published plan, so it is not replaced")]
    Published,
    #[error("van {van} reaches stop {order} after its delivery window closes")]
    Late { van: u8, order: Ulid },
    #[error("stop {stop}'s order is not ready yet")]
    NotReady { stop: u16 },
}

impl DispatchError {
    /// The slug a problem document names the rule by.
    pub fn rule(&self) -> &'static str {
        match self {
            DispatchError::StopMissing { .. } => "stop-missing",
            DispatchError::StopTwice { .. } => "stop-twice",
            DispatchError::StopUnknown { .. } | DispatchError::NoSuchStop { .. } => "stop-unknown",
            DispatchError::OverCapacity { .. } => "over-capacity",
            DispatchError::RouteEnds { .. } => "route-ends",
            DispatchError::NoPlan => "no-plan",
            DispatchError::NoStops => "no-stops",
            DispatchError::Vans { .. } => "vans",
            DispatchError::Capacity => "capacity",
            DispatchError::WrongDay => "wrong-day",
            DispatchError::PlaceUnknown { .. } => "place-unknown",
            DispatchError::Published => "published",
            DispatchError::Late { .. } => "window",
            DispatchError::NotReady { .. } => "not-ready",
        }
    }
}

/// One day's stops and plans.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchState {
    date: BakeryDate,
    stops: BTreeMap<Ulid, Stop>,
    /// Orders confirmed before their stop arrived.
    early_confirmed: BTreeSet<Ulid>,
    /// Orders removed before their stop arrived; never added after.
    tombstones: BTreeSet<Ulid>,
    vans: u8,
    capacity: u32,
    proposed: Option<Plan>,
    submitted: Option<Plan>,
    published: Option<Plan>,
    /// The published plan's version; 0 before the first publish.
    plan_v: u16,
    publish_keys: BTreeSet<Ulid>,
    /// Orders sent out on the published plan by `StopReady`, each once. Any one means a van has
    /// left on that plan.
    #[serde(default)]
    sent_out: BTreeSet<Ulid>,
}

impl DispatchState {
    /// An empty day with the default vans and capacity.
    pub fn new(date: BakeryDate) -> DispatchState {
        DispatchState {
            date,
            stops: BTreeMap::new(),
            early_confirmed: BTreeSet::new(),
            tombstones: BTreeSet::new(),
            vans: DEFAULT_VANS,
            capacity: DEFAULT_CAPACITY,
            proposed: None,
            submitted: None,
            published: None,
            plan_v: 0,
            publish_keys: BTreeSet::new(),
            sent_out: BTreeSet::new(),
        }
    }

    pub fn date(&self) -> BakeryDate {
        self.date
    }

    /// Every stop the day has seen, removed ones included, by order id.
    pub fn stops(&self) -> impl Iterator<Item = &Stop> {
        self.stops.values()
    }

    pub fn stop(&self, order: Ulid) -> Option<&Stop> {
        self.stops.get(&order)
    }

    /// The stops every plan must carry: confirmed and not yet delivered, by order id. A stop out
    /// for delivery is one of them.
    pub fn plannable(&self) -> Vec<&Stop> {
        self.stops.values().filter(|s| s.status.is_open()).collect()
    }

    pub fn vans(&self) -> u8 {
        self.vans
    }

    pub fn capacity(&self) -> u32 {
        self.capacity
    }

    pub fn plan_v(&self) -> u16 {
        self.plan_v
    }

    pub fn proposed(&self) -> Option<&Plan> {
        self.proposed.as_ref()
    }

    pub fn submitted(&self) -> Option<&Plan> {
        self.submitted.as_ref()
    }

    pub fn published(&self) -> Option<&Plan> {
        self.published.as_ref()
    }

    fn next_plan_v(&self) -> u16 {
        self.plan_v.saturating_add(1)
    }

    /// The doors of `orders`, in their order; an order the day does not hold is left out.
    pub fn doors(&self, orders: &[Ulid]) -> Vec<Door> {
        orders
            .iter()
            .filter_map(|o| self.stops.get(o).map(Door::of))
            .collect()
    }

    /// The validator's window rule: each van reaches every stop by its window's close, waiting
    /// at a door it reaches before the window opens.
    fn check_windows(
        &self,
        routes: &[VanRoute],
        matrix: &TravelMatrix,
    ) -> Result<(), DispatchError> {
        for r in routes {
            if let Some(k) = route_times(&self.doors(&r.stops), matrix).late {
                return Err(DispatchError::Late {
                    van: r.van,
                    order: r.stops[k],
                });
            }
        }
        Ok(())
    }

    /// The validator's rules that need no matrix: the vans, every plannable stop exactly once
    /// and nothing else, and each van under the capacity.
    fn check_routes(&self, routes: &[VanRoute]) -> Result<(), DispatchError> {
        let mut vans = BTreeSet::new();
        for r in routes {
            if r.van == 0 || r.van > self.vans || !vans.insert(r.van) {
                return Err(DispatchError::Vans {
                    van: r.van,
                    vans: self.vans,
                });
            }
        }
        let mut seen = BTreeSet::new();
        for r in routes {
            let mut units = 0u64;
            for &order in &r.stops {
                let stop = self
                    .stops
                    .get(&order)
                    .filter(|s| s.status.is_open())
                    .ok_or(DispatchError::StopUnknown { order })?;
                if !seen.insert(order) {
                    return Err(DispatchError::StopTwice { order });
                }
                units += u64::from(stop.units);
            }
            if units > u64::from(self.capacity) {
                return Err(DispatchError::OverCapacity {
                    van: r.van,
                    units,
                    capacity: self.capacity,
                });
            }
        }
        if let Some(missing) = self
            .plannable()
            .into_iter()
            .find(|s| !seen.contains(&s.order))
        {
            return Err(DispatchError::StopMissing {
                order: missing.order,
            });
        }
        Ok(())
    }

    /// A browser plan, validated: its routes by van, without the empty ones, and its minutes
    /// from the matrix.
    pub fn validate_submission(
        &self,
        routes: &[SubmittedRoute],
        matrix: &TravelMatrix,
    ) -> Result<(Vec<VanRoute>, u32), DispatchError> {
        let depot = matrix.depot();
        for r in routes {
            if r.start.unwrap_or(depot) != depot || r.end.unwrap_or(depot) != depot {
                return Err(DispatchError::RouteEnds { van: r.van });
            }
        }
        let mut kept: Vec<VanRoute> = routes
            .iter()
            .filter(|r| !r.stops.is_empty())
            .map(|r| VanRoute {
                van: r.van,
                stops: r.stops.clone(),
            })
            .collect();
        kept.sort_by_key(|r| r.van);
        self.check_routes(&kept)?;
        let minutes = self.drive_minutes(&kept, matrix)?;
        self.check_windows(&kept, matrix)?;
        Ok((kept, minutes))
    }

    /// Every route's drive from the matrix, summed.
    fn drive_minutes(
        &self,
        routes: &[VanRoute],
        matrix: &TravelMatrix,
    ) -> Result<u32, DispatchError> {
        let mut total = 0u32;
        for r in routes {
            let mut places = Vec::with_capacity(r.stops.len());
            for order in &r.stops {
                let stop = self
                    .stops
                    .get(order)
                    .ok_or(DispatchError::StopUnknown { order: *order })?;
                if !matrix.contains(stop.place) {
                    return Err(DispatchError::PlaceUnknown {
                        order: stop.order,
                        place: stop.place,
                    });
                }
                places.push(stop.place);
            }
            total = total.saturating_add(matrix.route_minutes(&places).unwrap_or(0));
        }
        Ok(total)
    }
}

/// The aggregate hosted by `Dispatch`.
pub struct Dispatch;

impl Aggregate for Dispatch {
    type State = DispatchState;
    type Command = DispatchCommand;
    type Event = DispatchEvent;
    type Error = DispatchError;

    fn decide(
        state: &DispatchState,
        cmd: &DispatchCommand,
        ctx: &DecideContext,
    ) -> Result<Vec<DispatchEvent>, DispatchError> {
        let date = state.date;
        match cmd {
            DispatchCommand::AddStop(a) => {
                if BakeryDate::of(a.window) != date {
                    return Err(DispatchError::WrongDay);
                }
                if state.stops.contains_key(&a.order) || state.tombstones.contains(&a.order) {
                    return Ok(vec![]);
                }
                Ok(vec![DispatchEvent::StopAdded {
                    date,
                    order: a.order,
                    customer: a.customer,
                    place: a.place,
                    window: a.window,
                    zone: a.zone.clone(),
                    units: a.units,
                }])
            }
            DispatchCommand::ConfirmStop { order } => {
                let confirm = || {
                    Ok(vec![DispatchEvent::StopConfirmed {
                        date,
                        order: *order,
                    }])
                };
                match state.stops.get(order).map(|s| s.status) {
                    Some(StopStatus::Provisional) => confirm(),
                    Some(_) => Ok(vec![]),
                    None if state.early_confirmed.contains(order)
                        || state.tombstones.contains(order) =>
                    {
                        Ok(vec![])
                    }
                    None => confirm(),
                }
            }
            DispatchCommand::RemoveStop { order, reason } => {
                let remove = || {
                    Ok(vec![DispatchEvent::StopRemoved {
                        date,
                        order: *order,
                        reason: *reason,
                    }])
                };
                match state.stops.get(order).map(|s| s.status) {
                    Some(
                        StopStatus::Provisional
                        | StopStatus::Confirmed
                        | StopStatus::OutForDelivery,
                    ) => remove(),
                    // Already gone, or delivered: nothing to take back.
                    Some(StopStatus::Removed | StopStatus::Completed) => Ok(vec![]),
                    None if state.tombstones.contains(order) => Ok(vec![]),
                    None => remove(),
                }
            }
            DispatchCommand::Propose {
                vans,
                capacity,
                matrix,
            } => {
                if !(1..=MAX_VANS).contains(vans) {
                    return Err(DispatchError::Vans {
                        van: *vans,
                        vans: MAX_VANS,
                    });
                }
                if *capacity == 0 {
                    return Err(DispatchError::Capacity);
                }
                let stops: Vec<Stop> = state.plannable().into_iter().cloned().collect();
                if stops.is_empty() {
                    return Err(DispatchError::NoStops);
                }
                if let Some(s) = stops.iter().find(|s| !matrix.contains(s.place)) {
                    return Err(DispatchError::PlaceUnknown {
                        order: s.order,
                        place: s.place,
                    });
                }
                let plan = savings_plan(&stops, *vans, *capacity, matrix);
                Ok(vec![DispatchEvent::RouteProposed {
                    date,
                    plan_v: state.next_plan_v(),
                    vans: *vans,
                    minutes: plan.minutes,
                    capacity: *capacity,
                    routes: plan.routes,
                    unassigned: plan.unassigned,
                }])
            }
            DispatchCommand::SubmitPlan { routes, matrix } => {
                if state.plannable().is_empty() {
                    return Err(DispatchError::NoStops);
                }
                let (vans, minutes) = state.validate_submission(routes, matrix)?;
                Ok(vec![DispatchEvent::PlanSubmitted {
                    date,
                    plan_v: state.next_plan_v(),
                    vans,
                    minutes,
                }])
            }
            DispatchCommand::Publish {
                plan,
                departed,
                matrix,
            } => {
                if state.publish_keys.contains(&ctx.id) {
                    return Ok(vec![]);
                }
                // A `StopReady` is a van that has left, whether or not its Order has heard it, and
                // so is a stop out for delivery.
                let left = !state.sent_out.is_empty()
                    || state
                        .stops
                        .values()
                        .any(|s| s.status == StopStatus::OutForDelivery);
                if (*departed || left) && state.published.is_some() {
                    return Err(DispatchError::Published);
                }
                let chosen = match plan {
                    PlanChoice::Proposed => state.proposed.as_ref(),
                    PlanChoice::Submitted => state.submitted.as_ref(),
                }
                .ok_or(DispatchError::NoPlan)?;
                if let Some(&order) = chosen.unassigned.first() {
                    return Err(DispatchError::StopMissing { order });
                }
                if state.plannable().is_empty() {
                    return Err(DispatchError::NoStops);
                }
                // Stops may have come or gone since the plan was stored.
                state.check_routes(&chosen.routes)?;
                state.drive_minutes(&chosen.routes, matrix)?;
                state.check_windows(&chosen.routes, matrix)?;
                Ok(vec![DispatchEvent::RoutePublished {
                    date,
                    plan_v: state.next_plan_v(),
                    source: chosen.source,
                    vans: chosen.routes.clone(),
                    minutes: chosen.minutes,
                    publish: ctx.id,
                }])
            }
            DispatchCommand::CompleteStop { stop, ready } => {
                let published = state.published.as_ref().ok_or(DispatchError::NoPlan)?;
                let order = published
                    .stop_at(*stop)
                    .ok_or(DispatchError::NoSuchStop { stop: *stop })?;
                match state.stops.get(&order).map(|s| s.status) {
                    Some(StopStatus::Completed) => Ok(vec![]),
                    Some(StopStatus::Confirmed) if !*ready => {
                        Err(DispatchError::NotReady { stop: *stop })
                    }
                    Some(StopStatus::Confirmed | StopStatus::OutForDelivery) => {
                        Ok(vec![DispatchEvent::StopCompleted {
                            date,
                            stop: *stop,
                            order,
                            route: published
                                .routes
                                .iter()
                                .find(|r| r.stops.contains(&order))
                                .map(|r| route_label(r.van)),
                        }])
                    }
                    _ => Err(DispatchError::StopUnknown { order }),
                }
            }
            DispatchCommand::ReadyStop { order } => {
                let Some(published) = state.published.as_ref() else {
                    // No plan yet: `RoutePublished` will find the order ready.
                    return Ok(vec![]);
                };
                let confirmed = state
                    .stops
                    .get(order)
                    .is_some_and(|s| s.status == StopStatus::Confirmed);
                if !confirmed || state.sent_out.contains(order) {
                    return Ok(vec![]);
                }
                let (Some(stop), Some(route)) = (
                    published.stop_number(*order),
                    published.routes.iter().find(|r| r.stops.contains(order)),
                ) else {
                    // Confirmed after the publish: on no plan yet, so the next one carries it.
                    return Ok(vec![]);
                };
                Ok(vec![DispatchEvent::StopReady {
                    date,
                    plan_v: published.plan_v,
                    stop,
                    order: *order,
                    route: route_label(route.van),
                }])
            }
            DispatchCommand::DepartStop { order, route, stop } => {
                // Only a confirmed stop leaves: one already out, delivered or removed stays as it
                // is, so a redelivery, or the out-for-delivery a completion causes, changes
                // nothing.
                match state.stops.get(order).map(|s| s.status) {
                    Some(StopStatus::Confirmed) => Ok(vec![DispatchEvent::StopDeparted {
                        date,
                        order: *order,
                        route: route.clone(),
                        stop: *stop,
                    }]),
                    _ => Ok(vec![]),
                }
            }
        }
    }

    fn evolve(mut state: DispatchState, event: &DispatchEvent) -> DispatchState {
        match event {
            DispatchEvent::StopAdded {
                order,
                customer,
                place,
                window,
                zone,
                units,
                ..
            } => {
                if !state.stops.contains_key(order) && !state.tombstones.contains(order) {
                    let status = if state.early_confirmed.remove(order) {
                        StopStatus::Confirmed
                    } else {
                        StopStatus::Provisional
                    };
                    state.stops.insert(
                        *order,
                        Stop {
                            order: *order,
                            customer: *customer,
                            place: *place,
                            window: *window,
                            zone: zone.clone(),
                            units: *units,
                            status,
                        },
                    );
                }
            }
            DispatchEvent::StopConfirmed { order, .. } => match state.stops.get_mut(order) {
                Some(s) if s.status == StopStatus::Provisional => s.status = StopStatus::Confirmed,
                Some(_) => {}
                None => {
                    if !state.tombstones.contains(order) {
                        state.early_confirmed.insert(*order);
                    }
                }
            },
            DispatchEvent::StopRemoved { order, .. } => match state.stops.get_mut(order) {
                Some(s) if s.status == StopStatus::Provisional || s.status.is_open() => {
                    s.status = StopStatus::Removed;
                }
                Some(_) => {}
                None => {
                    state.early_confirmed.remove(order);
                    state.tombstones.insert(*order);
                }
            },
            DispatchEvent::RouteProposed {
                plan_v,
                vans,
                minutes,
                capacity,
                routes,
                unassigned,
                ..
            } => {
                state.vans = *vans;
                state.capacity = *capacity;
                state.proposed = Some(Plan {
                    source: PlanSource::Server,
                    plan_v: *plan_v,
                    routes: routes.clone(),
                    minutes: *minutes,
                    unassigned: unassigned.clone(),
                });
            }
            DispatchEvent::PlanSubmitted {
                plan_v,
                vans,
                minutes,
                ..
            } => {
                state.submitted = Some(Plan {
                    source: PlanSource::Browser,
                    plan_v: *plan_v,
                    routes: vans.clone(),
                    minutes: *minutes,
                    unassigned: Vec::new(),
                });
            }
            DispatchEvent::RoutePublished {
                plan_v,
                source,
                vans,
                minutes,
                publish,
                ..
            } => {
                state.plan_v = *plan_v;
                state.publish_keys.insert(*publish);
                state.published = Some(Plan {
                    source: *source,
                    plan_v: *plan_v,
                    routes: vans.clone(),
                    minutes: *minutes,
                    unassigned: Vec::new(),
                });
            }
            DispatchEvent::StopCompleted { order, .. } => {
                if let Some(s) = state.stops.get_mut(order) {
                    s.status = StopStatus::Completed;
                }
            }
            DispatchEvent::StopReady { order, .. } => {
                state.sent_out.insert(*order);
            }
            DispatchEvent::StopDeparted { order, .. } => {
                if let Some(s) = state.stops.get_mut(order)
                    && s.status == StopStatus::Confirmed
                {
                    s.status = StopStatus::OutForDelivery;
                }
            }
        }
        state
    }
}

#[cfg(test)]
mod tests;
