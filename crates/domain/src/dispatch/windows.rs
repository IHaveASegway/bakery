//! A van's day against its stops' delivery windows (docs/domain.md, "Dispatch", the `window`
//! rule). The vans leave the bakery at [`DEPARTURE_MINUTES`]; at each door the van starts
//! serving when it arrives or when the window opens, whichever is later, so a van that is early
//! waits; it spends [`SERVICE_MINUTES`] there and drives on. A stop is late when the van starts
//! serving it after its window has closed, and a plan with a late stop is refused.
//!
//! Times here are whole minutes after the vans leave, so the arithmetic is the matrix's own and
//! needs no clock. A window is [`WINDOW_MINUTES`] long from the stop's `window`, its start.

use super::matrix::{PlaceIndex, TravelMatrix};
use super::{DEPARTURE_MINUTES, SERVICE_MINUTES, Stop};
use crate::BusinessTime;
use crate::calendar::{BakeryDate, WINDOW_MINUTES};

/// One door: its place and its window, in minutes after the vans leave.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Door {
    pub place: PlaceIndex,
    /// When the window opens.
    pub open: i64,
    /// When it closes: the last minute the van may start serving.
    pub close: i64,
}

impl Door {
    /// The door of `stop`, its window measured from its own day's departure.
    pub fn of(stop: &Stop) -> Door {
        let departure = departure(BakeryDate::of(stop.window));
        let open = (stop.window.unix_ms() - departure.unix_ms()).div_euclid(60_000);
        Door {
            place: stop.place,
            open,
            close: open + i64::from(WINDOW_MINUTES),
        }
    }
}

/// When the vans leave on `date`.
pub fn departure(date: BakeryDate) -> BusinessTime {
    date.at_local(DEPARTURE_MINUTES)
}

/// One van's day, in minutes after it leaves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteTimes {
    /// When the van starts serving each door, in driving order.
    pub serve: Vec<i64>,
    /// When it is back at the bakery: 0 for a van with no doors.
    pub back: i64,
    /// The first door served after its window closed, by its position in the route.
    pub late: Option<usize>,
}

/// The day of a van driving `doors` in order from the bakery and back. A place the matrix does
/// not hold counts 0 minutes; the validator refuses such a stop before it asks.
pub fn route_times(doors: &[Door], matrix: &TravelMatrix) -> RouteTimes {
    let depot = matrix.depot();
    let d = |a: PlaceIndex, b: PlaceIndex| i64::from(matrix.minutes(a, b).unwrap_or(0));
    let mut serve = Vec::with_capacity(doors.len());
    let mut late = None;
    let (mut t, mut at) = (0i64, depot);
    for (k, door) in doors.iter().enumerate() {
        let start = (t + d(at, door.place)).max(door.open);
        if start > door.close && late.is_none() {
            late = Some(k);
        }
        serve.push(start);
        t = start + i64::from(SERVICE_MINUTES);
        at = door.place;
    }
    let back = if doors.is_empty() {
        0
    } else {
        t + d(at, depot)
    };
    RouteTimes { serve, back, late }
}

/// Whether a van can drive `doors` in this order and reach each within its window.
pub fn on_time(doors: &[Door], matrix: &TravelMatrix) -> bool {
    route_times(doors, matrix).late.is_none()
}
