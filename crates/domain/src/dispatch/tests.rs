use super::*;
use crate::order::Line;
use crate::{Cents, execute, replay_from};
use proptest::prelude::*;
use std::collections::BTreeSet;

const DATE: &str = "2026-11-07";

fn date() -> BakeryDate {
    DATE.parse().unwrap()
}

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(1_793_000_000_000, n)
}

fn ctx(id: u128) -> DecideContext {
    DecideContext {
        now: "2026-11-07T08:00:00-07:00".parse().unwrap(),
        id: ulid(1_000_000 + id),
    }
}

fn window() -> BusinessTime {
    date().at_local(9 * 60)
}

fn add(order: u128, place: PlaceIndex, units: u32) -> DispatchCommand {
    DispatchCommand::AddStop(AddStop {
        order: ulid(order),
        customer: ulid(500 + order),
        place,
        window: window(),
        zone: "z1".into(),
        units,
    })
}

fn confirm(order: u128) -> DispatchCommand {
    DispatchCommand::ConfirmStop { order: ulid(order) }
}

fn run(
    state: DispatchState,
    cmd: &DispatchCommand,
    id: u128,
) -> (DispatchState, Vec<DispatchEvent>) {
    execute::<Dispatch>(state, cmd, &ctx(id)).unwrap()
}

fn step(state: DispatchState, cmd: DispatchCommand) -> DispatchState {
    run(state, &cmd, 0).0
}

fn refused(state: &DispatchState, cmd: DispatchCommand) -> &'static str {
    Dispatch::decide(state, &cmd, &ctx(0)).unwrap_err().rule()
}

/// A four-place line: the bakery at 0, then places 1, 2 and 3, each 10 minutes from the next
/// and the bakery 10 minutes from each.
fn line_city() -> Arc<TravelMatrix> {
    Arc::new(
        TravelMatrix::new(
            vec![
                vec![0, 10, 10, 10],
                vec![10, 0, 4, 8],
                vec![10, 4, 0, 4],
                vec![10, 8, 4, 0],
            ],
            0,
        )
        .unwrap(),
    )
}

/// Three confirmed stops at places 1, 2 and 3 of [`line_city`], 5 units each, and one
/// provisional at place 1.
fn day() -> DispatchState {
    let mut s = DispatchState::new(date());
    for (order, place) in [(1, 1), (2, 2), (3, 3), (4, 1)] {
        s = step(s, add(order, place, 5));
    }
    for order in [1, 2, 3] {
        s = step(s, confirm(order));
    }
    s
}

fn propose(vans: u8, capacity: u32) -> DispatchCommand {
    DispatchCommand::Propose {
        vans,
        capacity,
        matrix: line_city(),
    }
}

fn submit(routes: &[(u8, &[u128])]) -> DispatchCommand {
    DispatchCommand::SubmitPlan {
        routes: routes
            .iter()
            .map(|(van, stops)| SubmittedRoute {
                van: *van,
                stops: stops.iter().map(|&o| ulid(o)).collect(),
                start: None,
                end: None,
            })
            .collect(),
        matrix: line_city(),
    }
}

/// A stop's completion, its order ready.
fn complete(stop: u16) -> DispatchCommand {
    DispatchCommand::CompleteStop { stop, ready: true }
}

fn publish(plan: PlanChoice) -> DispatchCommand {
    DispatchCommand::Publish {
        plan,
        departed: false,
        matrix: line_city(),
    }
}

// -------------------------------------------------------------------------------------------
// Stops
// -------------------------------------------------------------------------------------------

#[test]
fn a_delivery_adds_a_provisional_stop_once_and_payment_confirms_it() {
    let s = DispatchState::new(date());
    let (s, events) = run(s, &add(1, 7, 3), 0);
    assert_eq!(
        events,
        vec![DispatchEvent::StopAdded {
            date: date(),
            order: ulid(1),
            customer: ulid(501),
            place: 7,
            window: window(),
            zone: "z1".into(),
            units: 3,
        }]
    );
    assert_eq!(s.stop(ulid(1)).unwrap().status, StopStatus::Provisional);
    assert!(s.plannable().is_empty());
    // The same order again, even with other figures, changes nothing.
    assert_eq!(Dispatch::decide(&s, &add(1, 9, 9), &ctx(1)), Ok(vec![]));
    let (s, events) = run(s, &confirm(1), 2);
    assert_eq!(events.len(), 1);
    assert_eq!(s.stop(ulid(1)).unwrap().status, StopStatus::Confirmed);
    assert_eq!(Dispatch::decide(&s, &confirm(1), &ctx(3)), Ok(vec![]));
    assert_eq!(s.plannable().len(), 1);
}

#[test]
fn expiry_and_cancellation_remove_a_stop_for_good() {
    let s = step(DispatchState::new(date()), add(1, 7, 3));
    let remove = DispatchCommand::RemoveStop {
        order: ulid(1),
        reason: RemoveReason::Expired,
    };
    let (s, events) = run(s, &remove, 0);
    assert_eq!(events.len(), 1);
    assert_eq!(s.stop(ulid(1)).unwrap().status, StopStatus::Removed);
    assert_eq!(Dispatch::decide(&s, &remove, &ctx(1)), Ok(vec![]));
    assert_eq!(Dispatch::decide(&s, &confirm(1), &ctx(2)), Ok(vec![]));
    assert_eq!(Dispatch::decide(&s, &add(1, 7, 3), &ctx(3)), Ok(vec![]));
}

#[test]
fn a_confirmation_or_removal_that_arrives_first_is_remembered() {
    // OrderPaid before OrderPlaced: the stop arrives confirmed.
    let s = step(DispatchState::new(date()), confirm(1));
    assert!(s.stop(ulid(1)).is_none());
    assert_eq!(Dispatch::decide(&s, &confirm(1), &ctx(1)), Ok(vec![]));
    let s = step(s, add(1, 7, 3));
    assert_eq!(s.stop(ulid(1)).unwrap().status, StopStatus::Confirmed);

    // OrderCancelled before OrderPlaced: the stop never arrives.
    let cancel = DispatchCommand::RemoveStop {
        order: ulid(2),
        reason: RemoveReason::Cancelled,
    };
    let s = step(s, cancel.clone());
    assert_eq!(Dispatch::decide(&s, &cancel, &ctx(2)), Ok(vec![]));
    assert_eq!(Dispatch::decide(&s, &add(2, 7, 3), &ctx(3)), Ok(vec![]));
    assert_eq!(Dispatch::decide(&s, &confirm(2), &ctx(4)), Ok(vec![]));
    assert!(s.stop(ulid(2)).is_none());
}

#[test]
fn a_stop_belongs_to_its_day() {
    let s = DispatchState::new(date());
    let other = DispatchCommand::AddStop(AddStop {
        order: ulid(1),
        customer: ulid(2),
        place: 1,
        window: date().plus_days(1).at_local(9 * 60),
        zone: "z1".into(),
        units: 1,
    });
    assert_eq!(refused(&s, other), "wrong-day");
}

#[test]
fn an_order_placed_for_delivery_becomes_a_stop_with_its_units() {
    let line = |qty| Line {
        item: "croissant".into(),
        variant: "croissant/single".into(),
        qty,
        unit_cents: Cents(450),
    };
    let placed = |kind| OrderEvent::OrderPlaced {
        order: ulid(1),
        customer: ulid(2),
        kind,
        slot: window(),
        zone: (kind == OrderKind::Delivery).then(|| "z2".to_owned()),
        lines: vec![line(3), line(4)],
        subtotal_cents: Cents(3150),
        tax_cents: Cents(315),
        total_cents: Cents(3465),
        note: None,
        menu_version: 1,
        held_until: window(),
    };
    assert_eq!(
        AddStop::from_order_placed(&placed(OrderKind::Delivery), 16),
        Some(AddStop {
            order: ulid(1),
            customer: ulid(2),
            place: 16,
            window: window(),
            zone: "z2".into(),
            units: 7,
        })
    );
    assert_eq!(
        AddStop::from_order_placed(&placed(OrderKind::Pickup), 16),
        None
    );
}

// -------------------------------------------------------------------------------------------
// The proposal
// -------------------------------------------------------------------------------------------

#[test]
fn the_proposal_covers_the_confirmed_stops_only() {
    let (s, events) = run(day(), &propose(2, 20), 0);
    let [
        DispatchEvent::RouteProposed {
            plan_v,
            vans,
            minutes,
            capacity,
            routes,
            unassigned,
            ..
        },
    ] = events.as_slice()
    else {
        panic!("{events:?}")
    };
    assert_eq!((*plan_v, *vans, *capacity), (1, 2, 20));
    // One van along the line: 10 + 4 + 4 + 10.
    assert_eq!(*minutes, 28);
    assert_eq!(routes.len(), 1);
    assert!(unassigned.is_empty());
    let planned: BTreeSet<Ulid> = routes.iter().flat_map(|r| r.stops.clone()).collect();
    assert_eq!(planned, [ulid(1), ulid(2), ulid(3)].into());
    assert_eq!((s.vans(), s.capacity()), (2, 20));
    assert_eq!(s.proposed().unwrap().minutes, 28);
}

#[test]
fn a_proposal_needs_vans_a_capacity_and_stops() {
    assert_eq!(refused(&day(), propose(0, 20)), "vans");
    assert_eq!(refused(&day(), propose(5, 20)), "vans");
    assert_eq!(refused(&day(), propose(2, 0)), "capacity");
    assert_eq!(
        refused(&DispatchState::new(date()), propose(2, 20)),
        "no-stops"
    );
    let far = step(step(DispatchState::new(date()), add(9, 40, 1)), confirm(9));
    assert_eq!(refused(&far, propose(1, 20)), "place-unknown");
}

#[test]
fn what_no_van_can_carry_is_left_unassigned_and_cannot_be_published() {
    // Capacity 5 and one van: one stop rides, two stay at the bakery.
    let (s, _) = run(day(), &propose(1, 5), 0);
    let plan = s.proposed().unwrap();
    assert_eq!(plan.routes.len(), 1);
    assert_eq!(plan.unassigned.len(), 2);
    assert_eq!(refused(&s, publish(PlanChoice::Proposed)), "stop-missing");
}

// -------------------------------------------------------------------------------------------
// The validator
// -------------------------------------------------------------------------------------------

#[test]
fn a_browser_plan_is_validated_and_its_minutes_recomputed() {
    let s = day();
    let (s, events) = run(s, &submit(&[(2, &[3]), (1, &[1, 2])]), 0);
    assert_eq!(
        events,
        vec![DispatchEvent::PlanSubmitted {
            date: date(),
            plan_v: 1,
            // Sorted by van; the minutes are the matrix's: (10 + 4 + 10) + (10 + 10).
            vans: vec![
                VanRoute {
                    van: 1,
                    stops: vec![ulid(1), ulid(2)]
                },
                VanRoute {
                    van: 2,
                    stops: vec![ulid(3)]
                },
            ],
            minutes: 44,
        }]
    );
    assert_eq!(s.submitted().unwrap().source, PlanSource::Browser);
}

#[test]
fn the_four_invariants_each_have_their_refusal() {
    let s = day();
    assert_eq!(refused(&s, submit(&[(1, &[1, 2])])), "stop-missing");
    assert_eq!(refused(&s, submit(&[(1, &[1, 2, 3, 1])])), "stop-twice");
    assert_eq!(
        refused(&s, submit(&[(1, &[1, 2]), (2, &[3, 2])])),
        "stop-twice"
    );
    // Not of this day, and provisional.
    assert_eq!(refused(&s, submit(&[(1, &[1, 2, 3, 77])])), "stop-unknown");
    assert_eq!(refused(&s, submit(&[(1, &[1, 2, 3, 4])])), "stop-unknown");
    let small = step(s.clone(), propose(4, 10));
    assert_eq!(refused(&small, submit(&[(1, &[1, 2, 3])])), "over-capacity");
    assert_eq!(refused(&s, submit(&[(0, &[1, 2, 3])])), "vans");
    assert_eq!(refused(&s, submit(&[(5, &[1, 2, 3])])), "vans");
    assert_eq!(refused(&s, submit(&[(1, &[1]), (1, &[2, 3])])), "vans");
    let away = DispatchCommand::SubmitPlan {
        routes: vec![SubmittedRoute {
            van: 1,
            stops: vec![ulid(1), ulid(2), ulid(3)],
            start: Some(0),
            end: Some(2),
        }],
        matrix: line_city(),
    };
    assert_eq!(refused(&s, away), "route-ends");
    assert_eq!(
        refused(&DispatchState::new(date()), submit(&[])),
        "no-stops"
    );
    // Empty routes are vans left at the bakery, not an error.
    assert!(Dispatch::decide(&s, &submit(&[(1, &[1, 2, 3]), (2, &[])]), &ctx(0)).is_ok());
}

// -------------------------------------------------------------------------------------------
// Publishing
// -------------------------------------------------------------------------------------------

#[test]
fn publishing_twice_with_one_key_stores_one_plan_and_appends_one_route_published() {
    let s = step(day(), propose(2, 20));
    let mut log: Vec<DispatchEvent> = Vec::new();
    let (s, events) = run(s, &publish(PlanChoice::Proposed), 7);
    log.extend(events);
    let after_first = s.clone();
    // The same key again: nothing to append, nothing changed.
    let (s, events) = run(s, &publish(PlanChoice::Proposed), 7);
    log.extend(events);
    assert_eq!(s, after_first);
    assert_eq!(log.len(), 1);
    let DispatchEvent::RoutePublished {
        plan_v,
        source,
        publish: key,
        ..
    } = &log[0]
    else {
        panic!()
    };
    assert_eq!((*plan_v, *source, *key), (1, PlanSource::Server, ctx(7).id));
    assert_eq!(s.plan_v(), 1);
    // Even after another plan was published, the first key stays spent.
    let s = step(s, submit(&[(1, &[1, 2, 3])]));
    let (s, events) = run(s, &publish(PlanChoice::Submitted), 8);
    assert_eq!(events.len(), 1);
    assert_eq!(s.plan_v(), 2);
    assert_eq!(s.published().unwrap().source, PlanSource::Browser);
    assert_eq!(
        Dispatch::decide(&s, &publish(PlanChoice::Proposed), &ctx(7)),
        Ok(vec![])
    );
    // A new key publishes again, superseding.
    let (s, _) = run(s, &publish(PlanChoice::Proposed), 9);
    assert_eq!(s.plan_v(), 3);
    assert_eq!(s.published().unwrap().source, PlanSource::Server);
}

#[test]
fn a_plan_is_not_replaced_once_a_van_has_left() {
    let gone = |plan| DispatchCommand::Publish {
        plan,
        departed: true,
        matrix: line_city(),
    };
    // Nothing published yet: `departed` cannot hold, and the first publish goes through.
    let s = step(day(), propose(2, 20));
    let (s, events) = run(s, &gone(PlanChoice::Proposed), 1);
    assert_eq!(events.len(), 1);
    // A van left: a new key is refused, the plan stands, and completing a stop still works.
    let s = step(s, submit(&[(1, &[1, 2, 3])]));
    assert_eq!(refused(&s, gone(PlanChoice::Submitted)), "published");
    assert_eq!(s.published().unwrap().source, PlanSource::Server);
    // The first publish's key replays as nothing, departed or not.
    assert_eq!(
        Dispatch::decide(&s, &gone(PlanChoice::Proposed), &ctx(1)),
        Ok(vec![])
    );
    let (_, events) = run(s, &complete(1), 2);
    assert_eq!(events.len(), 1);
}

#[test]
fn a_plan_is_checked_again_when_it_is_published() {
    assert_eq!(refused(&day(), publish(PlanChoice::Proposed)), "no-plan");
    assert_eq!(refused(&day(), publish(PlanChoice::Submitted)), "no-plan");
    let s = step(day(), propose(2, 20));
    // A stop confirmed after the proposal is missing from it.
    let late = step(s.clone(), confirm(4));
    assert_eq!(
        refused(&late, publish(PlanChoice::Proposed)),
        "stop-missing"
    );
    // A stop cancelled after the proposal is no longer the day's.
    let gone = step(
        s,
        DispatchCommand::RemoveStop {
            order: ulid(2),
            reason: RemoveReason::Cancelled,
        },
    );
    assert_eq!(
        refused(&gone, publish(PlanChoice::Proposed)),
        "stop-unknown"
    );
}

#[test]
fn stops_are_numbered_across_the_vans_and_completed_once() {
    let s = step(day(), submit(&[(1, &[2, 1]), (2, &[3])]));
    assert_eq!(refused(&s, complete(1)), "no-plan");
    let (s, events) = run(s, &publish(PlanChoice::Submitted), 1);
    let DispatchEvent::RoutePublished { vans, .. } = &events[0] else {
        panic!()
    };
    assert_eq!(
        deliveries(vans),
        vec![
            (ulid(2), "van-1".to_owned(), 1),
            (ulid(1), "van-1".to_owned(), 2),
            (ulid(3), "van-2".to_owned(), 3),
        ]
    );
    let plan = s.published().unwrap();
    assert_eq!(plan.stop_number(ulid(3)), Some(3));
    assert_eq!(plan.stop_at(2), Some(ulid(1)));
    assert_eq!(plan.stop_at(0), None);
    let (s, events) = run(s, &complete(2), 2);
    assert_eq!(
        events,
        vec![DispatchEvent::StopCompleted {
            date: date(),
            stop: 2,
            order: ulid(1),
            route: Some("van-1".into()),
        }]
    );
    assert_eq!(s.stop(ulid(1)).unwrap().status, StopStatus::Completed);
    assert_eq!(Dispatch::decide(&s, &complete(2), &ctx(3)), Ok(vec![]));
    assert_eq!(refused(&s, complete(4)), "stop-unknown");
    // A delivered stop leaves the plannable set, so the next plan is the rest.
    assert_eq!(s.plannable().len(), 2);
    assert_eq!(refused(&s, submit(&[(1, &[1, 2, 3])])), "stop-unknown");
}

// -------------------------------------------------------------------------------------------
// The screen's figures
// -------------------------------------------------------------------------------------------

#[test]
fn the_summary_and_the_comparison() {
    let s = step(day(), propose(2, 20));
    let s = step(s, submit(&[(1, &[1, 2]), (2, &[3])]));
    let m = line_city();
    let server = s.proposed().unwrap().summary(&s, &m);
    assert_eq!(server.vans.len(), 1);
    assert_eq!((server.vans[0].units, server.vans[0].minutes), (15, 28));
    // 28 minutes of driving and 3 doors of 3 minutes.
    assert_eq!(server.last_back, date().at_local(9 * 60 + 28 + 9));
    let browser = s.submitted().unwrap().summary(&s, &m);
    assert_eq!(
        browser.vans.iter().map(|v| v.minutes).collect::<Vec<_>>(),
        [24, 20]
    );
    // Van 1: 24 minutes and 2 doors; van 2: 20 and 1. Van 1 is back last.
    assert_eq!(browser.last_back, date().at_local(9 * 60 + 24 + 6));
    // (28 − 44) / 44 = −36.36%.
    assert_eq!(
        compare(&s),
        Some(Comparison {
            server_minutes: 28,
            browser_minutes: 44,
            gap_tenths_percent: Some(-364),
        })
    );
    assert_eq!(compare(&step(day(), propose(2, 20))), None);
}

// -------------------------------------------------------------------------------------------
// Events
// -------------------------------------------------------------------------------------------

#[test]
fn every_event_round_trips_through_its_envelope_parts_and_the_log_folds() {
    let mut s = day();
    let mut log = Vec::new();
    for (k, cmd) in [
        propose(2, 20),
        submit(&[(1, &[1, 2]), (2, &[3])]),
        publish(PlanChoice::Submitted),
        complete(3),
        DispatchCommand::RemoveStop {
            order: ulid(4),
            reason: RemoveReason::Expired,
        },
    ]
    .into_iter()
    .enumerate()
    {
        let (next, events) = run(s, &cmd, k as u128);
        s = next;
        log.extend(events);
    }
    let names: BTreeSet<&str> = log.iter().map(DomainEvent::name).collect();
    assert_eq!(names.len(), 5);
    for e in &log {
        assert!(DispatchEvent::NAMES.contains(&e.name()));
        assert_eq!(
            DispatchEvent::from_parts(e.name(), &e.to_data()).as_ref(),
            Ok(e)
        );
    }
    let published = log
        .iter()
        .find(|e| e.name() == "RoutePublished")
        .unwrap()
        .to_data();
    assert_eq!(published["source"], "browser");
    assert_eq!(published["date"], DATE);
    assert_eq!(published["vans"][0]["van"], 1);
    let folded = replay_from::<Dispatch>(day(), &log);
    assert_eq!(folded, s);
}

#[test]
fn every_refusal_has_a_slug() {
    let o = ulid(1);
    let slugs: Vec<&str> = [
        DispatchError::StopMissing { order: o },
        DispatchError::StopTwice { order: o },
        DispatchError::StopUnknown { order: o },
        DispatchError::NoSuchStop { stop: 1 },
        DispatchError::OverCapacity {
            van: 1,
            units: 9,
            capacity: 8,
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
        DispatchError::Late { van: 1, order: o },
        DispatchError::NotReady { stop: 1 },
    ]
    .iter()
    .map(DispatchError::rule)
    .collect();
    assert_eq!(
        slugs,
        [
            "stop-missing",
            "stop-twice",
            "stop-unknown",
            "stop-unknown",
            "over-capacity",
            "route-ends",
            "no-plan",
            "no-stops",
            "vans",
            "capacity",
            "wrong-day",
            "place-unknown",
            "window",
            "not-ready",
        ]
    );
}

// -------------------------------------------------------------------------------------------
// The savings heuristic
// -------------------------------------------------------------------------------------------

fn confirmed(order: u128, place: PlaceIndex, units: u32) -> Stop {
    confirmed_at(order, place, units, 9 * 60)
}

/// A confirmed stop whose window starts `start` local minutes after midnight.
fn confirmed_at(order: u128, place: PlaceIndex, units: u32, start: u16) -> Stop {
    Stop {
        order: ulid(order),
        customer: ulid(500 + order),
        place,
        window: date().at_local(start),
        zone: "z1".into(),
        units,
        status: StopStatus::Confirmed,
    }
}

#[test]
fn savings_join_neighbours_and_number_the_vans() {
    // Places 1 and 2 sit together east, 3 and 4 west: two vans, one each way.
    let m = TravelMatrix::new(
        vec![
            vec![0, 10, 11, 10, 11],
            vec![10, 0, 2, 20, 21],
            vec![11, 2, 0, 21, 20],
            vec![10, 20, 21, 0, 2],
            vec![11, 21, 20, 2, 0],
        ],
        0,
    )
    .unwrap();
    let stops: Vec<Stop> = (1..=4).map(|k| confirmed(k, k as u8, 1)).collect();
    // With room for all four, the two pairs would join too (s(2, 4) = 11 + 11 - 20 = 2), so a
    // van holds two.
    let plan = savings_plan(&stops, 2, 2, &m);
    assert_eq!(
        plan.routes,
        vec![
            VanRoute {
                van: 1,
                stops: vec![ulid(1), ulid(2)]
            },
            VanRoute {
                van: 2,
                stops: vec![ulid(3), ulid(4)]
            },
        ]
    );
    assert_eq!(plan.minutes, (10 + 2 + 11) * 2);
    // One van: the two pairs are joined at the cheapest seam.
    let one = savings_plan(&stops, 1, 10, &m);
    assert_eq!(one.routes.len(), 1);
    assert_eq!(one.routes[0].stops.len(), 4);
    assert!(one.unassigned.is_empty());
    // Capacity 1 and two vans: only two stops can ride.
    let tight = savings_plan(&stops, 2, 1, &m);
    assert_eq!(tight.routes.len(), 2);
    assert_eq!(tight.unassigned.len(), 2);
    // Each stop alone is never better than the plan when nothing was forced.
    let star: u32 = (1..=4).map(|k| m.route_minutes(&[k]).unwrap()).sum();
    assert!(savings_plan(&stops, 4, 10, &m).minutes <= star);
}

#[test]
fn an_asymmetric_matrix_is_never_driven_backwards() {
    // 1 -> 2 is quick, 2 -> 1 slow: the route must be 1 then 2.
    let m = TravelMatrix::new(
        vec![
            vec![0, 5, 9, 9],
            vec![9, 0, 1, 9],
            vec![5, 30, 0, 9],
            vec![9, 9, 9, 0],
        ],
        0,
    )
    .unwrap();
    assert!(!m.is_symmetric());
    let plan = savings_plan(&[confirmed(2, 2, 1), confirmed(1, 1, 1)], 1, 10, &m);
    assert_eq!(plan.routes[0].stops, vec![ulid(1), ulid(2)]);
    assert_eq!(plan.minutes, 5 + 1 + 5);
}

/// One generated instance: stops at random places with random units in random windows of the
/// day's three, and a random matrix whose triangle inequality is not enforced.
#[derive(Debug, Clone)]
struct Instance {
    stops: Vec<Stop>,
    vans: u8,
    capacity: u32,
    matrix: Arc<TravelMatrix>,
}

fn instance(symmetric: bool) -> impl Strategy<Value = Instance> {
    (5usize..=63, 1u8..=4, 2usize..=64, 20u32..=300).prop_flat_map(
        move |(n, vans, places, capacity)| {
            (
                proptest::collection::vec(1u32..=30, n),
                proptest::collection::vec(0..places as u8, n),
                proptest::collection::vec(proptest::collection::vec(1u32..=60, places), places),
                proptest::collection::vec(0usize..3, n),
            )
                .prop_map(move |(units, at, raw, windows)| {
                    let rows: Vec<Vec<u32>> = (0..places)
                        .map(|i| {
                            (0..places)
                                .map(|j| match (i == j, symmetric) {
                                    (true, _) => 0,
                                    (false, true) => raw[i.min(j)][i.max(j)],
                                    (false, false) => raw[i][j],
                                })
                                .collect()
                        })
                        .collect();
                    Instance {
                        stops: (0..n)
                            .map(|k| {
                                let start = crate::calendar::WINDOW_STARTS[windows[k]];
                                confirmed_at(k as u128 + 1, at[k], units[k], start)
                            })
                            .collect(),
                        vans,
                        capacity,
                        matrix: Arc::new(TravelMatrix::new(rows, 0).unwrap()),
                    }
                })
        },
    )
}

fn check_plan(i: &Instance) -> Result<(), TestCaseError> {
    let plan = savings_plan(&i.stops, i.vans, i.capacity, &i.matrix);
    // Every stop exactly once, on a van or unassigned.
    let mut seen: Vec<Ulid> = plan.routes.iter().flat_map(|r| r.stops.clone()).collect();
    seen.extend(plan.unassigned.iter().copied());
    seen.sort();
    let mut all: Vec<Ulid> = i.stops.iter().map(|s| s.order).collect();
    all.sort();
    prop_assert_eq!(&seen, &all);
    // No more vans than there are, numbered 1 up, none empty, none over capacity.
    prop_assert!(plan.routes.len() <= usize::from(i.vans));
    let units = |o: &Ulid| i.stops.iter().find(|s| s.order == *o).unwrap().units;
    for (k, r) in plan.routes.iter().enumerate() {
        prop_assert_eq!(usize::from(r.van), k + 1);
        prop_assert!(!r.stops.is_empty());
        prop_assert!(r.stops.iter().map(units).sum::<u32>() <= i.capacity);
    }
    // The plan's minutes are the matrix's, bakery to bakery for each van.
    let place = |o: &Ulid| i.stops.iter().find(|s| s.order == *o).unwrap().place;
    let recomputed: u32 = plan
        .routes
        .iter()
        .map(|r| {
            let places: Vec<u8> = r.stops.iter().map(place).collect();
            i.matrix.route_minutes(&places).unwrap()
        })
        .sum();
    prop_assert_eq!(plan.minutes, recomputed);
    // Every van reaches each of its stops within its window, waiting when early.
    let stop = |o: &Ulid| i.stops.iter().find(|s| s.order == *o).unwrap();
    let doors =
        |orders: &[Ulid]| -> Vec<Door> { orders.iter().map(|o| Door::of(stop(o))).collect() };
    for r in &plan.routes {
        let times = route_times(&doors(&r.stops), &i.matrix);
        prop_assert_eq!(times.late, None, "van {} is late", r.van);
        for (k, o) in r.stops.iter().enumerate() {
            let door = Door::of(stop(o));
            prop_assert!(door.open <= times.serve[k] && times.serve[k] <= door.close);
        }
    }
    // A stop is left behind only when it is too big for any van, or every van is out and none
    // has the room or the time to take it anywhere in its route.
    for o in &plan.unassigned {
        let s = stop(o);
        if s.units > i.capacity {
            continue;
        }
        prop_assert_eq!(
            plan.routes.len(),
            usize::from(i.vans),
            "{} left with a van free",
            o
        );
        for r in &plan.routes {
            let load: u32 = r.stops.iter().map(units).sum();
            if load + s.units > i.capacity {
                continue;
            }
            for at in 0..=r.stops.len() {
                let mut tried = r.stops.clone();
                tried.insert(at, *o);
                prop_assert!(
                    route_times(&doors(&tried), &i.matrix).late.is_some(),
                    "{} fits van {} at {}",
                    o,
                    r.van,
                    at
                );
            }
        }
    }
    // The same stops in another order give the same plan.
    let mut reversed = i.stops.clone();
    reversed.reverse();
    prop_assert_eq!(
        &savings_plan(&reversed, i.vans, i.capacity, &i.matrix),
        &plan
    );

    // Through the aggregate: the proposal, then the same routes submitted as the browser's,
    // with the bakery as each route's ends, pass the validator with the same minutes.
    let mut s = DispatchState::new(date());
    for stop in &i.stops {
        let add = DispatchCommand::AddStop(AddStop {
            order: stop.order,
            customer: stop.customer,
            place: stop.place,
            window: stop.window,
            zone: stop.zone.clone(),
            units: stop.units,
        });
        s = execute::<Dispatch>(s, &add, &ctx(0)).unwrap().0;
        let confirm = DispatchCommand::ConfirmStop { order: stop.order };
        s = execute::<Dispatch>(s, &confirm, &ctx(0)).unwrap().0;
    }
    let propose = DispatchCommand::Propose {
        vans: i.vans,
        capacity: i.capacity,
        matrix: i.matrix.clone(),
    };
    let s = execute::<Dispatch>(s, &propose, &ctx(1)).unwrap().0;
    prop_assert_eq!(s.proposed().unwrap().routes.clone(), plan.routes.clone());
    let depot = Some(i.matrix.depot());
    let browser = DispatchCommand::SubmitPlan {
        routes: plan
            .routes
            .iter()
            .map(|r| SubmittedRoute {
                van: r.van,
                stops: r.stops.clone(),
                start: depot,
                end: depot,
            })
            .collect(),
        matrix: i.matrix.clone(),
    };
    let publish_proposed = DispatchCommand::Publish {
        plan: PlanChoice::Proposed,
        departed: false,
        matrix: i.matrix.clone(),
    };
    let published = execute::<Dispatch>(s.clone(), &publish_proposed, &ctx(2));
    if plan.unassigned.is_empty() {
        let s = execute::<Dispatch>(s, &browser, &ctx(3)).unwrap().0;
        prop_assert_eq!(s.submitted().unwrap().minutes, plan.minutes);
        prop_assert!(published.is_ok());
    } else {
        prop_assert_eq!(published.unwrap_err().rule(), "stop-missing");
        prop_assert_eq!(
            Dispatch::decide(&s, &browser, &ctx(3)).unwrap_err().rule(),
            "stop-missing"
        );
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    #[test]
    fn the_savings_plan_holds_the_invariants_on_a_symmetric_matrix(i in instance(true)) {
        check_plan(&i)?;
    }

    #[test]
    fn the_savings_plan_holds_the_invariants_on_an_asymmetric_matrix(i in instance(false)) {
        check_plan(&i)?;
    }
}

// -------------------------------------------------------------------------------------------
// Delivery windows (the console audit of 2026-11-08, finding 6)
// -------------------------------------------------------------------------------------------

/// The audit's day on [`line_city`]: stop 1 at place 1 in the 13:00 to 15:00 window, stop 2 at
/// place 2 in the 11:00 to 13:00 window, both confirmed, 5 units each.
fn two_windows() -> DispatchState {
    let mut s = DispatchState::new(date());
    for (order, place, start) in [(1, 1, 13 * 60), (2, 2, 11 * 60)] {
        s = step(
            s,
            DispatchCommand::AddStop(AddStop {
                order: ulid(order),
                customer: ulid(500 + order),
                place,
                window: date().at_local(start),
                zone: "z1".into(),
                units: 5,
            }),
        );
        s = step(s, confirm(order));
    }
    s
}

#[test]
fn the_server_serves_the_earlier_window_first_and_waits_for_each_to_open() {
    let s = step(two_windows(), propose(1, 20));
    let plan = s.proposed().unwrap();
    // Without windows the savings join 1 then 2 (the smaller order id first, the drive the same
    // both ways); with them, the 11:00 stop comes first.
    assert_eq!(plan.routes[0].stops, vec![ulid(2), ulid(1)]);
    assert!(plan.unassigned.is_empty());
    // The drive is 10 + 4 + 10 minutes; the van waits for 11:00 at place 2 and for 13:00 at
    // place 1, so it is back at 13:00 plus 3 minutes at the door and 10 back, not at 9:30.
    assert_eq!(plan.minutes, 24);
    let summary = plan.summary(&s, &line_city());
    assert_eq!(summary.last_back, date().at_local(13 * 60 + 3 + 10));
    let times = route_times(&s.doors(&plan.routes[0].stops), &line_city());
    assert_eq!(times.serve, [2 * 60, 4 * 60]);
    assert_eq!(times.late, None);
    // And it publishes.
    assert!(Dispatch::decide(&s, &publish(PlanChoice::Proposed), &ctx(1)).is_ok());
}

#[test]
fn a_plan_that_reaches_a_stop_after_its_window_is_refused() {
    let s = two_windows();
    // The browser's plan in the wrong order: place 1 at 13:00, then place 2 at 13:07, after its
    // window closed at 13:00.
    assert_eq!(refused(&s, submit(&[(1, &[1, 2])])), "window");
    assert_eq!(
        Dispatch::decide(&s, &submit(&[(1, &[1, 2])]), &ctx(0)),
        Err(DispatchError::Late {
            van: 1,
            order: ulid(2)
        })
    );
    // On two vans, or in window order, it is on time.
    let (_, events) = run(s.clone(), &submit(&[(1, &[1]), (2, &[2])]), 1);
    assert_eq!(events.len(), 1);
    let (s, _) = run(s, &submit(&[(1, &[2, 1])]), 2);
    let (_, events) = run(s, &publish(PlanChoice::Submitted), 3);
    assert_eq!(events.len(), 1);
}

#[test]
fn a_route_without_one_of_its_stops_is_checked_on_its_own_drives() {
    // On a matrix without the triangle inequality, taking a stop out can make the next one later:
    // 1 -> 2 -> 3 is 1 + 1 minutes, 1 -> 3 is 200.
    let m = Arc::new(
        TravelMatrix::new(
            vec![
                vec![0, 1, 1, 1],
                vec![1, 0, 1, 200],
                vec![1, 1, 0, 1],
                vec![1, 200, 1, 0],
            ],
            0,
        )
        .unwrap(),
    );
    let mut s = DispatchState::new(date());
    for order in 1..=3 {
        s = step(s, add(order, order as u8, 1));
        s = step(s, confirm(order));
    }
    let routes = vec![SubmittedRoute {
        van: 1,
        stops: vec![ulid(1), ulid(2), ulid(3)],
        start: None,
        end: None,
    }];
    let s = step(
        s,
        DispatchCommand::SubmitPlan {
            routes,
            matrix: m.clone(),
        },
    );
    let s = step(
        s,
        DispatchCommand::RemoveStop {
            order: ulid(2),
            reason: RemoveReason::Cancelled,
        },
    );
    // The plan names a removed stop, which is refused first; with stop 2 delivered instead
    // the rest would be 1 then 3, 200 minutes apart.
    let publish = DispatchCommand::Publish {
        plan: PlanChoice::Submitted,
        departed: false,
        matrix: m.clone(),
    };
    assert_eq!(refused(&s, publish), "stop-unknown");
    let late = vec![VanRoute {
        van: 1,
        stops: vec![ulid(1), ulid(3)],
    }];
    assert_eq!(
        s.check_windows(&late, &m),
        Err(DispatchError::Late {
            van: 1,
            order: ulid(3)
        })
    );
}

#[test]
fn a_stop_is_completed_only_once_its_order_is_ready() {
    let s = step(day(), submit(&[(1, &[2, 1]), (2, &[3])]));
    let (s, _) = run(s, &publish(PlanChoice::Submitted), 1);
    let not_ready = DispatchCommand::CompleteStop {
        stop: 3,
        ready: false,
    };
    assert_eq!(refused(&s, not_ready.clone()), "not-ready");
    assert_eq!(s.stop(ulid(3)).unwrap().status, StopStatus::Confirmed);
    // Ready, it is completed, and the event names its van for the order.
    let (s, events) = run(s, &complete(3), 2);
    assert_eq!(
        events,
        vec![DispatchEvent::StopCompleted {
            date: date(),
            stop: 3,
            order: ulid(3),
            route: Some("van-2".into()),
        }]
    );
    // Once completed, a second completion is nothing, ready or not.
    assert_eq!(Dispatch::decide(&s, &not_ready, &ctx(3)), Ok(vec![]));
}

#[test]
fn a_stop_completed_before_the_route_was_recorded_still_folds() {
    // A `StopCompleted` written before the route was added reads with no route.
    let data = serde_json::json!({
        "date": DATE,
        "stop": 1,
        "order": ulid(1).to_string(),
    });
    assert_eq!(
        DispatchEvent::from_parts("StopCompleted", &data),
        Ok(DispatchEvent::StopCompleted {
            date: date(),
            stop: 1,
            order: ulid(1),
            route: None,
        })
    );
}
