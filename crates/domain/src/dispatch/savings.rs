//! The server's proposal: Clarke and Wright's savings heuristic (1964), parallel version, over a
//! [`TravelMatrix`] (ADR 0012, decision 2). A pure function from stops, vans, a capacity and the
//! matrix to a [`Plan`]; it runs inside the `Dispatch` object's handler, so it reads no clock and
//! draws nothing, and the same input gives the same plan on every machine.
//!
//! 1. Every stop starts as its own route, bakery to stop and back. A stop whose units alone
//!    exceed a van's capacity, or whose place the matrix does not hold, can ride no van: it is
//!    left unassigned from the start.
//! 2. **Savings.** Joining the end of one route, stop `i`, to the start of another, stop `j`,
//!    saves `s(i, j) = d(i, 0) + d(0, j) − d(i, j)` minutes. Every ordered pair is scored and
//!    the list sorted by saving, largest first, ties broken by the two stops' order ids. Then,
//!    in that order, while the saving is positive: if `i` ends one route and `j` starts another,
//!    and their units together fit one van, the routes merge. On a symmetric matrix a route may
//!    be turned around to bring `i` or `j` to the joining end, since that costs nothing; on an
//!    asymmetric one it may not, because the reversed drive is a different drive.
//! 3. **The van count.** More routes than vans: merge the two routes whose joining adds the
//!    fewest minutes, under the capacity, until the count fits. If no two routes fit one van
//!    together, the route with the fewest units is broken up and each of its stops, largest
//!    first, is inserted where it adds the fewest minutes on a van with room for it; a stop no
//!    van has room for is left unassigned, so the plan says so rather than putting more vans on
//!    the road than the bakery has.
//! 4. **The rest.** A stop step 3 could place nowhere is tried once more, on the finished
//!    routes, where it adds the fewest minutes on time, or alone on a van the plan does not use
//!    yet; only then is it left unassigned.
//! 5. Vans are numbered 1 up, in the order of each route's smallest order id, and the plan's
//!    minutes are [`TravelMatrix::route_minutes`] summed: the validator's own arithmetic.
//!
//! **Delivery windows.** Every join, merge and insertion above is made only when the route it
//! makes reaches each of its stops within its window ([`super::windows`]: the vans leave at
//! 09:00, a van early at a door waits for the window to open, and it spends 3 minutes there).
//! So a route serves its stops in window order, and a stop is never planned for after its
//! window has closed. A stop alone on a van is always on time, since every window closes at
//! least 2 hours after the vans leave and the city matrix's longest drive is 35 minutes
//! (`crates/seed/data/salt-lake-city/matrix.json`, built 2026-11-05, read on 2026-11-08).
//!
//! The property tests check that a stop is left unassigned only when every van is in use and no
//! van has the room, or the time, to take it anywhere in its route.
//!
//! The object does not propose this plan as it is: [`super::propose_plan`] runs the improvement
//! pass of `improve.rs` over it first (since 2026-11-10).

use std::collections::BTreeMap;

use super::matrix::{PlaceIndex, TravelMatrix};
use super::windows::{Door, on_time};
use super::{Plan, PlanSource, Stop, VanRoute};
use crate::Ulid;

/// A stop as the heuristic sees it.
#[derive(Debug, Clone, Copy)]
struct Node {
    order: Ulid,
    place: PlaceIndex,
    units: u64,
    door: Door,
}

/// A route being built: node indexes in driving order, and their units.
#[derive(Debug, Clone)]
struct Building {
    nodes: Vec<usize>,
    load: u64,
}

/// The savings plan for `stops`, every one of them (the caller passes the confirmed stops), on
/// at most `vans` vans of `capacity` units each.
pub fn savings_plan(stops: &[Stop], vans: u8, capacity: u32, matrix: &TravelMatrix) -> Plan {
    // One node per order, in order-id order: the tie-break every later step leans on.
    let mut by_order: BTreeMap<Ulid, &Stop> = BTreeMap::new();
    for s in stops {
        by_order.entry(s.order).or_insert(s);
    }
    let mut unassigned: Vec<Ulid> = Vec::new();
    let mut nodes: Vec<Node> = Vec::with_capacity(by_order.len());
    for s in by_order.values() {
        let fits = vans > 0 && s.units <= capacity && matrix.contains(s.place);
        if fits {
            nodes.push(Node {
                order: s.order,
                place: s.place,
                units: u64::from(s.units),
                door: Door::of(s),
            });
        } else {
            unassigned.push(s.order);
        }
    }
    let depot = matrix.depot();
    let d = |a: PlaceIndex, b: PlaceIndex| i64::from(matrix.minutes(a, b).unwrap_or(0));
    let symmetric = matrix.is_symmetric();
    let capacity = u64::from(capacity);
    let timely = |route: &[usize]| -> bool {
        let doors: Vec<Door> = route.iter().map(|&n| nodes[n].door).collect();
        on_time(&doors, matrix)
    };

    let mut routes: Vec<Option<Building>> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| {
            Some(Building {
                nodes: vec![i],
                load: n.units,
            })
        })
        .collect();
    let mut route_of: Vec<usize> = (0..nodes.len()).collect();

    // Step 2: the savings, largest first; ties by the order ids of i, then j.
    let mut savings: Vec<(i64, usize, usize)> = Vec::new();
    for (i, a) in nodes.iter().enumerate() {
        for (j, b) in nodes.iter().enumerate() {
            // On a symmetric matrix s(i, j) = s(j, i), and turning a route around is free, so
            // one of the pair is enough.
            if i == j || (symmetric && j < i) {
                continue;
            }
            let s = d(a.place, depot) + d(depot, b.place) - d(a.place, b.place);
            if s > 0 {
                savings.push((s, i, j));
            }
        }
    }
    savings.sort_by(|x, y| y.0.cmp(&x.0).then(x.1.cmp(&y.1)).then(x.2.cmp(&y.2)));
    for (_, i, j) in savings {
        let (ri, rj) = (route_of[i], route_of[j]);
        if ri == rj {
            continue;
        }
        let (Some(a), Some(b)) = (&routes[ri], &routes[rj]) else {
            continue;
        };
        if a.load + b.load > capacity {
            continue;
        }
        let Some(merged) = join_at(&a.nodes, i, &b.nodes, j, symmetric) else {
            continue;
        };
        if !timely(&merged) {
            continue;
        }
        let load = a.load + b.load;
        for &n in &merged {
            route_of[n] = ri;
        }
        routes[ri] = Some(Building {
            nodes: merged,
            load,
        });
        routes[rj] = None;
    }

    // Step 3: no more routes than vans.
    let cost = |route: &[usize]| -> i64 {
        let places: Vec<PlaceIndex> = route.iter().map(|&n| nodes[n].place).collect();
        i64::from(matrix.route_minutes(&places).unwrap_or(0))
    };
    let live = |routes: &[Option<Building>]| routes.iter().filter(|r| r.is_some()).count();
    // Puts node `n` where it adds the fewest minutes, on time, on a route with room for it;
    // false when there is no such place.
    let insert_cheapest = |routes: &mut Vec<Option<Building>>, n: usize| -> bool {
        // (added minutes, the route's smallest order, position, route)
        let mut best: Option<(i64, Ulid, usize, usize)> = None;
        for (k, r) in routes.iter().enumerate() {
            let Some(r) = r else { continue };
            if r.load + nodes[n].units > capacity {
                continue;
            }
            let base = cost(&r.nodes);
            for at in 0..=r.nodes.len() {
                let mut tried = r.nodes.clone();
                tried.insert(at, n);
                if !timely(&tried) {
                    continue;
                }
                let key = (cost(&tried) - base, first_order(&nodes, &r.nodes), at, k);
                if best.is_none_or(|b| key < b) {
                    best = Some(key);
                }
            }
        }
        let Some((_, _, at, k)) = best else {
            return false;
        };
        if let Some(r) = routes[k].as_mut() {
            r.nodes.insert(at, n);
            r.load += nodes[n].units;
        }
        true
    };
    while live(&routes) > usize::from(vans) {
        // (added minutes, smallest order of the first route, of the second, orientation)
        let mut best: Option<(i64, Ulid, Ulid, usize, usize, Vec<usize>)> = None;
        for (x, a) in routes.iter().enumerate() {
            let Some(a) = a else { continue };
            for (y, b) in routes.iter().enumerate() {
                let Some(b) = b else { continue };
                if x == y || a.load + b.load > capacity {
                    continue;
                }
                let base = cost(&a.nodes) + cost(&b.nodes);
                for merged in orientations(&a.nodes, &b.nodes, symmetric) {
                    if !timely(&merged) {
                        continue;
                    }
                    let key = (
                        cost(&merged) - base,
                        first_order(&nodes, &a.nodes),
                        first_order(&nodes, &b.nodes),
                    );
                    let better = best
                        .as_ref()
                        .is_none_or(|(c, oa, ob, ..)| key < (*c, *oa, *ob));
                    if better {
                        best = Some((key.0, key.1, key.2, x, y, merged));
                    }
                }
            }
        }
        let Some((_, _, _, x, y, merged)) = best else {
            break;
        };
        let load =
            routes[x].as_ref().map_or(0, |r| r.load) + routes[y].as_ref().map_or(0, |r| r.load);
        routes[x] = Some(Building {
            nodes: merged,
            load,
        });
        routes[y] = None;
    }
    // Still too many: the route carrying the fewest units is broken up, and each of its stops,
    // largest first, goes where it adds the fewest minutes, on time, on a van with room for it.
    // A stop with no such van waits for step 4.
    let mut loose_ends: Vec<usize> = Vec::new();
    while live(&routes) > usize::from(vans) {
        let drop = routes
            .iter()
            .enumerate()
            .filter_map(|(k, r)| r.as_ref().map(|r| (k, r)))
            .min_by_key(|(_, r)| (r.load, r.nodes.len(), first_order(&nodes, &r.nodes)))
            .map(|(k, _)| k);
        let Some(dropped) = drop.and_then(|k| routes[k].take()) else {
            break;
        };
        let mut loose = dropped.nodes;
        loose.sort_by_key(|&n| (std::cmp::Reverse(nodes[n].units), nodes[n].order));
        for n in loose {
            if !insert_cheapest(&mut routes, n) {
                loose_ends.push(n);
            }
        }
    }

    // Step 4: what step 3 could not place, tried again on the finished routes, or alone on a
    // van still at the bakery, until a pass places nothing more.
    loose_ends.sort_by_key(|&n| (std::cmp::Reverse(nodes[n].units), nodes[n].order));
    loop {
        let before = loose_ends.len();
        loose_ends.retain(|&n| {
            if insert_cheapest(&mut routes, n) {
                return false;
            }
            if live(&routes) < usize::from(vans) && timely(&[n]) {
                routes.push(Some(Building {
                    nodes: vec![n],
                    load: nodes[n].units,
                }));
                return false;
            }
            true
        });
        if loose_ends.len() == before {
            break;
        }
    }
    unassigned.extend(loose_ends.iter().map(|&n| nodes[n].order));

    // Step 5: number the vans and add up the minutes.
    let mut built: Vec<Vec<usize>> = routes.into_iter().flatten().map(|r| r.nodes).collect();
    built.sort_by_key(|r| first_order(&nodes, r));
    let mut minutes = 0u32;
    let routes: Vec<VanRoute> = built
        .iter()
        .enumerate()
        .map(|(k, r)| {
            minutes = minutes.saturating_add(u32::try_from(cost(r)).unwrap_or(u32::MAX));
            VanRoute {
                van: u8::try_from(k + 1).unwrap_or(u8::MAX),
                stops: r.iter().map(|&n| nodes[n].order).collect(),
            }
        })
        .collect();
    unassigned.sort();
    Plan {
        source: PlanSource::Server,
        plan_v: 0,
        routes,
        minutes,
        unassigned,
    }
}

/// `a` then `b`, joined with `i` last in `a` and `j` first in `b`, turning either around when
/// that is free; `None` when `i` or `j` is inside its route, or would need a turn that is not.
fn join_at(a: &[usize], i: usize, b: &[usize], j: usize, symmetric: bool) -> Option<Vec<usize>> {
    let a_last = a.last() == Some(&i);
    let a_first = a.first() == Some(&i);
    let b_first = b.first() == Some(&j);
    let b_last = b.last() == Some(&j);
    let left: Vec<usize> = if a_last {
        a.to_vec()
    } else if a_first && symmetric {
        a.iter().rev().copied().collect()
    } else {
        return None;
    };
    let right: Vec<usize> = if b_first {
        b.to_vec()
    } else if b_last && symmetric {
        b.iter().rev().copied().collect()
    } else {
        return None;
    };
    Some(left.into_iter().chain(right).collect())
}

/// The ways to drive `a` and then `b` as one route: as they are, and with either turned around
/// when the matrix makes that free.
fn orientations(a: &[usize], b: &[usize], symmetric: bool) -> Vec<Vec<usize>> {
    let forward = |r: &[usize]| r.to_vec();
    let back = |r: &[usize]| r.iter().rev().copied().collect::<Vec<_>>();
    let mut out = vec![[forward(a), forward(b)].concat()];
    if symmetric {
        out.push([forward(a), back(b)].concat());
        out.push([back(a), forward(b)].concat());
    }
    out
}

fn first_order(nodes: &[Node], route: &[usize]) -> Ulid {
    route
        .iter()
        .map(|&n| nodes[n].order)
        .min()
        .unwrap_or(Ulid::from_parts(0, 0))
}
