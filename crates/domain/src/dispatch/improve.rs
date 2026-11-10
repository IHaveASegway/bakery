//! The server's proposal after the savings construction: a bounded, deterministic local search
//! that shortens the plan's drive and never breaks a rule the validator checks (ADR 0012,
//! postscript of 2026-11-10; roadmap R95).
//!
//! [`savings_plan`] builds routes by joining their ends, so a stop placed early stays where the
//! joins put it, and with the day's three windows a van can cross the city once per window. This
//! pass takes that plan and moves stops while a move shortens the total drive:
//!
//! - **relocate**: one, two or three consecutive stops of a route, kept in their order, moved to
//!   another place in the same route, in another route, or onto a van the plan does not use yet;
//! - **swap**: two stops of different routes trade places;
//! - **tail exchange** (2-opt\*): two routes trade everything after a cut in each;
//! - **reverse** (2-opt): a run of stops in one route is driven the other way, which on an
//!   asymmetric matrix is a different drive and is counted as one.
//!
//! Each round scans every such move and makes the one that saves the most minutes, ties going to
//! the first found in a fixed order (routes by index, then positions, then the move kinds in the
//! order above), so the same input gives the same plan. A move is made only when every route it
//! changes stays within the vans' capacity and reaches each stop within its window
//! ([`super::windows::on_time`], the validator's own rule), so the plan stays valid. The rounds
//! stop when no move saves a minute, or after [`MAX_ROUNDS`]; each made move saves at least one
//! minute, so the plan never drives longer than the construction it started from. A stop the
//! construction left unassigned stays unassigned, and no van is added beyond the day's.

use std::collections::BTreeMap;

use super::matrix::{PlaceIndex, TravelMatrix};
use super::savings::savings_plan;
use super::windows::{Door, on_time};
use super::{Plan, Stop, VanRoute};
use crate::Ulid;

/// The most moves one call makes. The seeded busy Saturdays take 0 to 12 (seeds 1, 2, 3, 5, 7,
/// 42, 99 and 1234, births 2026-11-04 to 2026-11-10, measured on 2026-11-10 with
/// `crates/seed/examples/dispatch-problem.rs`); the cap bounds the handler's CPU whatever the
/// input.
pub const MAX_ROUNDS: usize = 64;

/// The longest run of stops one relocation moves.
const SEGMENT: usize = 3;

/// The server's proposal: the savings construction, then the improvement pass.
pub fn propose_plan(stops: &[Stop], vans: u8, capacity: u32, matrix: &TravelMatrix) -> Plan {
    improve_plan(
        savings_plan(stops, vans, capacity, matrix),
        stops,
        vans,
        capacity,
        matrix,
    )
}

/// A stop as the pass sees it.
#[derive(Debug, Clone, Copy)]
struct Node {
    order: Ulid,
    place: PlaceIndex,
    units: u64,
    door: Door,
}

/// One candidate move, as the routes it leaves: (route index, its new stops) for each route the
/// move changes.
type Change = Vec<(usize, Vec<usize>)>;

/// `plan` with its drive shortened by the moves above, on at most `vans` vans of `capacity`
/// units. `stops` are the stops the plan was made for; a route's order the stops do not hold,
/// or a place the matrix does not, leaves the plan as it is.
pub fn improve_plan(
    plan: Plan,
    stops: &[Stop],
    vans: u8,
    capacity: u32,
    matrix: &TravelMatrix,
) -> Plan {
    let mut by_order: BTreeMap<Ulid, &Stop> = BTreeMap::new();
    for s in stops {
        by_order.entry(s.order).or_insert(s);
    }
    let mut nodes: Vec<Node> = Vec::new();
    let mut index: BTreeMap<Ulid, usize> = BTreeMap::new();
    let mut routes: Vec<Vec<usize>> = Vec::with_capacity(plan.routes.len());
    for r in &plan.routes {
        let mut route = Vec::with_capacity(r.stops.len());
        for o in &r.stops {
            let Some(s) = by_order.get(o).filter(|s| matrix.contains(s.place)) else {
                return plan;
            };
            if index.contains_key(o) {
                return plan;
            }
            index.insert(*o, nodes.len());
            route.push(nodes.len());
            nodes.push(Node {
                order: s.order,
                place: s.place,
                units: u64::from(s.units),
                door: Door::of(s),
            });
        }
        routes.push(route);
    }
    // A van the plan does not use yet is an empty route a relocation may fill.
    while routes.len() < usize::from(vans) {
        routes.push(Vec::new());
    }

    let search = Search {
        nodes: &nodes,
        matrix,
        capacity: u64::from(capacity),
    };
    for _ in 0..MAX_ROUNDS {
        let Some(change) = search.best_move(&routes) else {
            break;
        };
        for (k, r) in change {
            routes[k] = r;
        }
    }

    // Vans numbered 1 up by each route's smallest order id, as the construction numbers them,
    // and the minutes the validator's arithmetic.
    let mut built: Vec<Vec<usize>> = routes.into_iter().filter(|r| !r.is_empty()).collect();
    built.sort_by_key(|r| r.iter().map(|&n| nodes[n].order).min());
    let mut minutes = 0u32;
    let routes: Vec<VanRoute> = built
        .iter()
        .enumerate()
        .map(|(k, r)| {
            minutes = minutes.saturating_add(u32::try_from(search.cost(r)).unwrap_or(u32::MAX));
            VanRoute {
                van: u8::try_from(k + 1).unwrap_or(u8::MAX),
                stops: r.iter().map(|&n| nodes[n].order).collect(),
            }
        })
        .collect();
    Plan {
        routes,
        minutes,
        ..plan
    }
}

struct Search<'a> {
    nodes: &'a [Node],
    matrix: &'a TravelMatrix,
    capacity: u64,
}

/// The best move found so far: the minutes it saves (negative) and the routes it leaves.
struct Best {
    delta: i64,
    change: Option<Change>,
}

impl Best {
    /// Takes `change` if it saves more than the best so far and every route it leaves is
    /// valid. `delta` is the saving the caller worked out from the legs the move adds and
    /// removes; debug builds, the tests', check it against the routes' own minutes.
    fn offer(
        &mut self,
        s: &Search,
        delta: i64,
        routes: &[Vec<usize>],
        change: impl FnOnce() -> Change,
    ) {
        if delta >= self.delta {
            return;
        }
        let change = change();
        debug_assert_eq!(
            change.iter().map(|(_, r)| s.cost(r)).sum::<i64>()
                - change.iter().map(|(k, _)| s.cost(&routes[*k])).sum::<i64>(),
            delta,
            "a move's minutes are the matrix's"
        );
        if !change.iter().all(|(_, r)| s.valid(r)) {
            return;
        }
        self.delta = delta;
        self.change = Some(change);
    }
}

impl Search<'_> {
    fn d(&self, a: PlaceIndex, b: PlaceIndex) -> i64 {
        i64::from(self.matrix.minutes(a, b).unwrap_or(0))
    }

    /// The place at padded position `k` of `route`: 0 and `len + 1` are the bakery.
    fn at(&self, route: &[usize], k: usize) -> PlaceIndex {
        if k == 0 || k > route.len() {
            self.matrix.depot()
        } else {
            self.nodes[route[k - 1]].place
        }
    }

    fn cost(&self, route: &[usize]) -> i64 {
        let places: Vec<PlaceIndex> = route.iter().map(|&n| self.nodes[n].place).collect();
        i64::from(self.matrix.route_minutes(&places).unwrap_or(0))
    }

    fn load(&self, route: &[usize]) -> u64 {
        route.iter().map(|&n| self.nodes[n].units).sum()
    }

    /// The validator's rules for one route: the capacity, and every stop within its window.
    fn valid(&self, route: &[usize]) -> bool {
        if self.load(route) > self.capacity {
            return false;
        }
        let doors: Vec<Door> = route.iter().map(|&n| self.nodes[n].door).collect();
        on_time(&doors, self.matrix)
    }

    /// The move that saves the most minutes, or `None` when none saves one.
    fn best_move(&self, routes: &[Vec<usize>]) -> Option<Change> {
        let mut best = Best {
            delta: 0,
            change: None,
        };
        self.relocations(routes, &mut best);
        self.swaps(routes, &mut best);
        self.tail_exchanges(routes, &mut best);
        self.reversals(routes, &mut best);
        best.change
    }

    /// One to [`SEGMENT`] consecutive stops moved, in their order, anywhere else.
    fn relocations(&self, routes: &[Vec<usize>], best: &mut Best) {
        for (r, route) in routes.iter().enumerate() {
            for len in 1..=SEGMENT.min(route.len()) {
                for i in 0..=route.len() - len {
                    let seg = &route[i..i + len];
                    let (first, last) = (self.nodes[seg[0]].place, self.nodes[seg[len - 1]].place);
                    // Padded: the stop before the run is at i, the one after at i + len + 1.
                    let (prev, next) = (self.at(route, i), self.at(route, i + len + 1));
                    let gain = self.d(prev, first) + self.d(last, next) - self.d(prev, next);
                    let rest: Vec<usize> = [&route[..i], &route[i + len..]].concat();
                    for (t, target) in routes.iter().enumerate() {
                        if t == r {
                            for j in 0..=rest.len() {
                                if j == i {
                                    continue;
                                }
                                let (u, v) = (self.at(&rest, j), self.at(&rest, j + 1));
                                let add = self.d(u, first) + self.d(last, v) - self.d(u, v);
                                best.offer(self, add - gain, routes, || {
                                    let mut moved = rest.clone();
                                    moved.splice(j..j, seg.iter().copied());
                                    vec![(r, moved)]
                                });
                            }
                            continue;
                        }
                        // Into an empty route only from a route that keeps a stop, and only the
                        // first empty one: they are all the same van at the bakery.
                        if target.is_empty()
                            && (rest.is_empty() || routes[..t].iter().any(Vec::is_empty))
                        {
                            continue;
                        }
                        for j in 0..=target.len() {
                            let (u, v) = (self.at(target, j), self.at(target, j + 1));
                            let add = self.d(u, first) + self.d(last, v) - self.d(u, v);
                            best.offer(self, add - gain, routes, || {
                                let mut into = target.clone();
                                into.splice(j..j, seg.iter().copied());
                                vec![(r, rest.clone()), (t, into)]
                            });
                        }
                    }
                }
            }
        }
    }

    /// Two stops of different routes trade places.
    fn swaps(&self, routes: &[Vec<usize>], best: &mut Best) {
        for (r, a) in routes.iter().enumerate() {
            for (s, b) in routes.iter().enumerate().skip(r + 1) {
                for i in 0..a.len() {
                    let (pa, xa, na) = (self.at(a, i), self.at(a, i + 1), self.at(a, i + 2));
                    for j in 0..b.len() {
                        let (pb, xb, nb) = (self.at(b, j), self.at(b, j + 1), self.at(b, j + 2));
                        let delta =
                            self.d(pa, xb) + self.d(xb, na) - self.d(pa, xa) - self.d(xa, na)
                                + self.d(pb, xa)
                                + self.d(xa, nb)
                                - self.d(pb, xb)
                                - self.d(xb, nb);
                        best.offer(self, delta, routes, || {
                            let (mut a2, mut b2) = (a.clone(), b.clone());
                            std::mem::swap(&mut a2[i], &mut b2[j]);
                            vec![(r, a2), (s, b2)]
                        });
                    }
                }
            }
        }
    }

    /// Two routes trade what follows a cut in each: `a[..i] + b[j..]` and `b[..j] + a[i..]`.
    fn tail_exchanges(&self, routes: &[Vec<usize>], best: &mut Best) {
        for (r, a) in routes.iter().enumerate() {
            for (s, b) in routes.iter().enumerate().skip(r + 1) {
                for i in 0..=a.len() {
                    for j in 0..=b.len() {
                        if (i == 0 && j == 0) || (i == a.len() && j == b.len()) {
                            continue;
                        }
                        let (ai, ai1) = (self.at(a, i), self.at(a, i + 1));
                        let (bj, bj1) = (self.at(b, j), self.at(b, j + 1));
                        let delta =
                            self.d(ai, bj1) + self.d(bj, ai1) - self.d(ai, ai1) - self.d(bj, bj1);
                        best.offer(self, delta, routes, || {
                            let a2: Vec<usize> = [&a[..i], &b[j..]].concat();
                            let b2: Vec<usize> = [&b[..j], &a[i..]].concat();
                            vec![(r, a2), (s, b2)]
                        });
                    }
                }
            }
        }
    }

    /// A run `route[i..=j]` of two or more stops driven the other way.
    fn reversals(&self, routes: &[Vec<usize>], best: &mut Best) {
        for (r, route) in routes.iter().enumerate() {
            for i in 0..route.len() {
                // The run's own legs, forward and back, grown one stop at a time.
                let (mut forward, mut back) = (0i64, 0i64);
                for j in i + 1..route.len() {
                    let (x, y) = (self.nodes[route[j - 1]].place, self.nodes[route[j]].place);
                    forward += self.d(x, y);
                    back += self.d(y, x);
                    let (p, n) = (self.at(route, i), self.at(route, j + 2));
                    let (xi, xj) = (self.nodes[route[i]].place, self.nodes[route[j]].place);
                    let delta = self.d(p, xj) + self.d(xi, n) - self.d(p, xi) - self.d(xj, n)
                        + back
                        - forward;
                    best.offer(self, delta, routes, || {
                        let mut turned = route.clone();
                        turned[i..=j].reverse();
                        vec![(r, turned)]
                    });
                }
            }
        }
    }
}
