//! The seed's `Dispatch` days (docs/domain.md, "The seed": today's `Dispatch` exists from the
//! start; ADR 0012). Everything is derived from a [`Generated`] and the travel-time matrix, with
//! no draw of its own, so no pinned value moves.
//!
//! - [`seed_matrix`] is the matrix the seed plans on: spike S7's Salt Lake City fixture,
//!   [`CITY_MATRIX_JSON`] (`crates/seed/data/salt-lake-city/matrix.json`, built 2026-11-05), read
//!   by [`TravelMatrix::from_json`], the same file and reader the Worker's `Dispatch` object
//!   uses, so the seeded proposal's minutes are the ones the object recomputes. Its 64 places
//!   are the seed's `p1` to `p64` by index (`p<n>` is index `n - 1`), the bakery at index 0
//!   (`p1`); their labels are the map's names, for the screen only.
//! - [`seed_dispatch`] is today's day: one stop per open delivery order (its customer's place,
//!   its window, its units), added at its placement, confirmed at its payment for every open
//!   state but `placed`, and the server's proposal from the savings heuristic once the last of
//!   those has happened: four vans on a Saturday, one on any other day (docs/domain.md, "The
//!   story"), at [`DEFAULT_CAPACITY`]. A day with no confirmed delivery has no proposal.
//! - [`busy_saturday`] is the history's busy Saturday, 63 delivery orders, as a day of confirmed
//!   stops and its four-van proposal: the day the Route Lab's comparison is about. It is not one
//!   of the objects a sandbox is born with; the screen and the tests read it.
//!
//! The Worker seeds a `Dispatch` object by running [`DispatchDay::commands`] through the
//! aggregate's own `decide`, as it does a catering event's, so its log is one the aggregate could
//! have written; [`DispatchDay::events`] and [`DispatchDay::state`] are that log and its fold.

use std::sync::{Arc, OnceLock};

use bakery_domain::calendar::local;
use bakery_domain::dispatch::{
    AddStop, DEFAULT_CAPACITY, Dispatch, DispatchCommand, DispatchEvent, DispatchState, PlaceIndex,
    TravelMatrix, place_index,
};
use bakery_domain::{BakeryDate, BusinessTime, DecideContext, Ulid, execute};

use crate::calendar::{SATURDAY, weekday};
use crate::{Customer, Generated, OpenState, OrderKind, OrderLine, PLACE_COUNT};

/// One `Dispatch` day as the seed builds it.
#[derive(Debug, Clone)]
pub struct DispatchDay {
    pub date: BakeryDate,
    /// In business-time order, each with the time it is decided at.
    pub commands: Vec<(BusinessTime, DispatchCommand)>,
    /// What the commands emitted, in order, each at its command's time.
    pub events: Vec<(BusinessTime, DispatchEvent)>,
    /// The fold of `events` over the empty day.
    pub state: DispatchState,
}

/// The Salt Lake City travel-time fixture, whole minutes between the 64 places (spike S7, built
/// 2026-11-05 with a self-hosted openrouteservice; docs/domain.md, "The seed").
pub const CITY_MATRIX_JSON: &str = include_str!("../data/salt-lake-city/matrix.json");

/// The fixture as a [`TravelMatrix`].
pub fn city_matrix() -> TravelMatrix {
    TravelMatrix::from_json(CITY_MATRIX_JSON).expect("the committed fixture is a valid matrix")
}

/// Each of the 64 places' delivery zone, by its drive from the bakery in the city's fixture: the
/// nearest third (21 places) `z1`, the next 21 `z2`, the farthest 22 `z3`, ties by place number.
/// A customer's zone is the zone of their place (roadmap R69, decided 2026-11-09 as R24), so one
/// place is in one zone, and the server derives a delivery's zone from it. The bakery's own place,
/// `p1`, is the nearest.
fn zones() -> &'static [&'static str] {
    static ZONES_BY_PLACE: OnceLock<Vec<&'static str>> = OnceLock::new();
    ZONES_BY_PLACE.get_or_init(|| {
        let m = city_matrix();
        let depot = m.depot();
        let n = m.len();
        let mut by_drive: Vec<(u32, usize)> = (0..n)
            .map(|i| {
                let place = PlaceIndex::try_from(i).unwrap_or(depot);
                (m.minutes(depot, place).unwrap_or(0), i)
            })
            .collect();
        by_drive.sort_unstable();
        let mut zones = vec![crate::ZONES[0]; n];
        let third = n / 3;
        for (rank, &(_, i)) in by_drive.iter().enumerate() {
            zones[i] = crate::ZONES[(rank / third).min(crate::ZONES.len() - 1)];
        }
        zones
    })
}

/// A place's delivery zone, from its seed label (`p1` to `p64`): `None` for a label that is not
/// one of the city's places.
pub fn zone_of_place(label: &str) -> Option<&'static str> {
    let i = place_index(label)?;
    zones().get(usize::from(i)).copied()
}

/// The matrix the seed's days are planned on: the city's fixture, the same for every seed.
pub fn seed_matrix(_g: &Generated) -> TravelMatrix {
    city_matrix()
}

/// Vans on the road: four on a Saturday, one on the other open days.
pub fn vans_for(date: BakeryDate) -> u8 {
    if weekday(date.days()) == SATURDAY {
        4
    } else {
        1
    }
}

fn place_of(customers: &[Customer], customer: Ulid) -> u8 {
    customers
        .iter()
        .find(|c| c.id == customer)
        .and_then(|c| place_index(&c.place))
        .filter(|&i| usize::from(i) < PLACE_COUNT)
        .expect("every order's customer is a seeded persona with a place p1 to p64")
}

fn units(lines: &[OrderLine]) -> u32 {
    lines.iter().map(|l| l.qty).sum()
}

fn at_ms(ms: u64) -> BusinessTime {
    local(i64::try_from(ms).expect("seed times fit"))
        .expect("seed times are far inside the year range")
}

/// Today's `Dispatch`: the open delivery orders' stops and the server's proposal.
pub fn seed_dispatch(g: &Generated) -> DispatchDay {
    let mut date = BakeryDate::from_days(g.born.days());
    if !date.is_open() {
        date = date.plus_days(1);
    }
    let mut commands: Vec<(BusinessTime, DispatchCommand)> = Vec::new();
    for o in g
        .open_orders
        .iter()
        .filter(|o| o.kind == OrderKind::Delivery)
    {
        commands.push((
            o.placed_at,
            DispatchCommand::AddStop(AddStop {
                order: o.id,
                customer: o.customer,
                place: place_of(&g.customers, o.customer),
                window: o.slot_start,
                zone: o.zone.unwrap_or_default().to_owned(),
                units: units(&o.lines),
            }),
        ));
        if let (Some(payment), false) = (o.payment_id, o.state == OpenState::Placed) {
            commands.push((
                at_ms(payment.unix_ms()),
                DispatchCommand::ConfirmStop { order: o.id },
            ));
        }
    }
    commands.sort_by_key(|(t, _)| *t);
    let confirmed = commands
        .iter()
        .any(|(_, c)| matches!(c, DispatchCommand::ConfirmStop { .. }));
    if let (true, Some(&(last, _))) = (confirmed, commands.last()) {
        commands.push((
            last,
            DispatchCommand::Propose {
                vans: vans_for(date),
                capacity: DEFAULT_CAPACITY,
                matrix: Arc::new(seed_matrix(g)),
            },
        ));
    }
    run(date, commands)
}

/// The history's busy Saturday: its 63 delivery orders as confirmed stops, and the four-van
/// proposal.
pub fn busy_saturday(g: &Generated) -> DispatchDay {
    let mut by_day: std::collections::BTreeMap<BakeryDate, usize> = Default::default();
    for o in g.history.iter().filter(|o| o.kind == OrderKind::Delivery) {
        *by_day.entry(BakeryDate::of(o.slot_start)).or_default() += 1;
    }
    let date = by_day
        .iter()
        .filter(|(d, _)| weekday(d.days()) == SATURDAY)
        .max_by_key(|(d, n)| (**n, **d))
        .map(|(d, _)| *d)
        .expect("the history has a busy Saturday");
    let mut commands: Vec<(BusinessTime, DispatchCommand)> = Vec::new();
    for o in g
        .history
        .iter()
        .filter(|o| o.kind == OrderKind::Delivery && BakeryDate::of(o.slot_start) == date)
    {
        commands.push((
            o.placed_at,
            DispatchCommand::AddStop(AddStop {
                order: o.id,
                customer: o.customer,
                place: place_of(&g.customers, o.customer),
                window: o.slot_start,
                zone: o.zone.unwrap_or_default().to_owned(),
                units: units(&o.lines),
            }),
        ));
        commands.push((
            at_ms(o.payment_id.unix_ms()),
            DispatchCommand::ConfirmStop { order: o.id },
        ));
    }
    commands.sort_by_key(|(t, _)| *t);
    let last = commands.last().map(|(t, _)| *t).unwrap_or(date.opening());
    commands.push((
        last,
        DispatchCommand::Propose {
            vans: vans_for(date),
            capacity: DEFAULT_CAPACITY,
            matrix: Arc::new(seed_matrix(g)),
        },
    ));
    run(date, commands)
}

fn run(date: BakeryDate, commands: Vec<(BusinessTime, DispatchCommand)>) -> DispatchDay {
    let mut state = DispatchState::new(date);
    let mut events = Vec::new();
    for (t, cmd) in &commands {
        let ctx = DecideContext {
            now: *t,
            id: Ulid::from_parts(u64::try_from(t.unix_ms()).expect("after 1970"), 0),
        };
        let (next, emitted) = execute::<Dispatch>(state, cmd, &ctx)
            .expect("the seed's dispatch commands hold the rules");
        state = next;
        events.extend(emitted.into_iter().map(|e| (*t, e)));
    }
    DispatchDay {
        date,
        commands,
        events,
        state,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_place_has_one_zone_by_its_drive_from_the_bakery() {
        let m = city_matrix();
        let labels: Vec<String> = (1..=PLACE_COUNT).map(|n| format!("p{n}")).collect();
        let zone = |l: &str| zone_of_place(l).unwrap();
        let count = |z: &str| labels.iter().filter(|l| zone(l) == z).count();
        assert_eq!((count("z1"), count("z2"), count("z3")), (21, 21, 22));
        assert_eq!(zone("p1"), "z1", "the bakery's own place is the nearest");
        let drive = |l: &str| m.minutes(m.depot(), place_index(l).unwrap()).unwrap();
        let farthest = |z: &str| {
            labels
                .iter()
                .filter(|l| zone(l) == z)
                .map(|l| drive(l))
                .max()
        };
        let nearest = |z: &str| {
            labels
                .iter()
                .filter(|l| zone(l) == z)
                .map(|l| drive(l))
                .min()
        };
        assert!(farthest("z1") <= nearest("z2") && farthest("z2") <= nearest("z3"));
        assert_eq!(zone_of_place("p0"), None);
        assert_eq!(zone_of_place("p65"), None);
        assert_eq!(zone_of_place("bakery"), None);
    }
    use crate::{BirthDate, Generator, Seed};
    use bakery_domain::dispatch::{PlanChoice, StopStatus};
    use bakery_domain::{Aggregate, DomainEvent};

    fn generated(seed: u64, born: &str) -> Generated {
        Generator::new(Seed(seed), BirthDate::parse(born).unwrap()).generate()
    }

    #[test]
    fn today_has_a_stop_per_open_delivery_and_the_servers_proposal() {
        let g = generated(42, "2026-11-07");
        let day = seed_dispatch(&g);
        assert_eq!(day.date.to_string(), "2026-11-07");
        let deliveries: Vec<_> = g
            .open_orders
            .iter()
            .filter(|o| o.kind == OrderKind::Delivery)
            .collect();
        assert_eq!(day.state.stops().count(), deliveries.len());
        for o in &deliveries {
            let stop = day.state.stop(o.id).unwrap();
            assert_eq!(stop.window, o.slot_start);
            assert_eq!(
                stop.status == StopStatus::Provisional,
                o.state == OpenState::Placed
            );
        }
        // Seed 42 on 2026-11-07: two deliveries, both paid, on one Saturday of four vans.
        assert_eq!(deliveries.len(), 2);
        let plan = day
            .state
            .proposed()
            .expect("a confirmed delivery is planned");
        assert_eq!(day.state.vans(), 4);
        assert!(plan.unassigned.is_empty());
        let names: Vec<&str> = day.events.iter().map(|(_, e)| e.name()).collect();
        assert_eq!(
            names,
            [
                "StopAdded",
                "StopConfirmed",
                "StopAdded",
                "StopConfirmed",
                "RouteProposed"
            ]
        );
        // The proposal can be published as it stands.
        let ctx = DecideContext {
            now: day.events[4].0,
            id: Ulid::from_parts(1, 1),
        };
        let publish = DispatchCommand::Publish {
            plan: PlanChoice::Proposed,
            departed: false,
            matrix: Arc::new(city_matrix()),
        };
        assert!(Dispatch::decide(&day.state, &publish, &ctx).is_ok());
    }

    #[test]
    fn the_city_fixture_reads_the_seeds_place_names_by_index() {
        let m = city_matrix();
        assert_eq!(
            (m.len(), m.depot(), m.city()),
            (PLACE_COUNT, 0, "salt-lake-city")
        );
        // The seed's names are indexes; the fixture's labels are the map's names.
        assert_eq!(m.place_index("p1"), Some(0));
        assert_eq!(m.label(0), Some("The bakery"));
        assert_eq!(m.place_index("p64"), Some(63));
        assert_eq!(m.place_index("p65"), None);
        for i in 0..64u8 {
            let label = m.label(i).unwrap();
            assert!(!label.is_empty());
            assert_eq!(m.place_index(&format!("p{}", u16::from(i) + 1)), Some(i));
        }
        // No label is itself a seed name, so a screen never shows `p<n>` for the fixture.
        assert!((0..64u8).all(|i| place_index(m.label(i).unwrap()).is_none()));
        // Every persona's place is one of the fixture's.
        let g = generated(42, "2026-11-07");
        assert!(
            g.customers
                .iter()
                .all(|c| m.place_index(&c.place).is_some())
        );
    }

    #[test]
    fn the_time_at_each_door_is_the_route_datas() {
        let data: serde_json::Value =
            serde_json::from_str(include_str!("../data/salt-lake-city/route-data.json")).unwrap();
        assert_eq!(
            data["serviceSeconds"].as_u64(),
            Some(u64::from(bakery_domain::dispatch::SERVICE_MINUTES) * 60)
        );
    }

    #[test]
    fn the_same_seed_gives_the_same_day() {
        let a = seed_dispatch(&generated(42, "2026-11-07"));
        let b = seed_dispatch(&generated(42, "2026-11-07"));
        assert_eq!(a.events, b.events);
        assert_eq!(a.state, b.state);
        assert_eq!(seed_matrix(&generated(42, "2026-11-07")).to_json(), {
            seed_matrix(&generated(42, "2026-11-07")).to_json()
        });
    }

    #[test]
    fn every_seed_and_weekday_builds_its_day_and_plans_the_busy_saturday() {
        for seed in [1, 2, 3, 5, 7, 42, 99, 777, 1_234, 31_337] {
            for born in ["2026-11-03", "2026-11-07", "2026-11-09"] {
                let g = generated(seed, born);
                let day = seed_dispatch(&g);
                assert!(day.date.is_open());
                if let Some(plan) = day.state.proposed() {
                    assert!(plan.unassigned.is_empty(), "{seed} {born}");
                    assert!(plan.routes.len() <= usize::from(vans_for(day.date)));
                }
                let busy = busy_saturday(&g);
                assert_eq!(busy.state.plannable().len(), 63, "{seed} {born}");
                let plan = busy.state.proposed().unwrap();
                assert!(plan.unassigned.is_empty(), "{seed} {born}");
                // The savings may need fewer than the four.
                assert!((1..=4).contains(&plan.routes.len()), "{seed} {born}");
            }
        }
    }
}
