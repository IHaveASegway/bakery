//! The seed and the domain describe one menu and one kind of order. `bakery-domain` cannot read
//! `bakery-seed` (the seed depends on the domain), so this test, in a crate that may depend on
//! both, reads the seed's records through the domain's types and rules.
//!
//! The records cross as JSON, the way the Worker will hand them over, so a field renamed on
//! either side fails here.

use bakery_domain::catalog::{ALLERGENS, Catalog, Category, Item, MenuView, Variant};
use bakery_domain::order::{
    LineInput, Order, OrderCommand, OrderEvent, OrderKind, OrderStatus, PlaceOrder,
};
use bakery_domain::{Aggregate, Cents, DecideContext, Ulid};
use bakery_seed::{BirthDate, Generated, Generator, Seed, TAX_BP};
use serde_json::Value;

fn generated() -> Generated {
    // A Saturday, as the seed's own tests use.
    Generator::new(Seed(42), BirthDate::parse("2026-11-07").unwrap()).generate()
}

fn via_json<T: serde::de::DeserializeOwned>(value: impl serde::Serialize) -> T {
    serde_json::from_value(serde_json::to_value(value).unwrap()).unwrap()
}

/// The seed's menu as the domain's catalog: the seed's items carry no status, and every one is
/// on sale at birth.
fn seeded_menu(g: &Generated) -> MenuView {
    let categories: Vec<Category> = via_json(&g.categories);
    let items: Vec<Item> = g
        .items
        .iter()
        .map(|item| {
            let mut v = serde_json::to_value(item).unwrap();
            v["status"] = Value::from("available");
            serde_json::from_value(v).unwrap()
        })
        .collect();
    let variants: Vec<Variant> = via_json(&g.variants);
    Catalog::seeded(categories, items, variants)
        .expect("the seed's menu holds the catalog's rules")
        .menu_view()
}

#[test]
fn the_seed_menu_is_a_valid_catalog() {
    let g = generated();
    let menu = seeded_menu(&g);
    assert_eq!(menu.version, 1);
    assert_eq!(menu.categories.len(), 5);
    let items: Vec<_> = menu.categories.iter().flat_map(|c| &c.items).collect();
    assert_eq!(items.len(), 24);
    assert_eq!(items.iter().map(|i| i.variants.len()).sum::<usize>(), 48);
    for v in &g.variants {
        assert_eq!(
            menu.variant(&v.slug).unwrap().1.price_cents,
            v.price_cents,
            "{}",
            v.slug
        );
    }
}

#[test]
fn the_allergen_lists_agree() {
    assert_eq!(bakery_seed::ALLERGENS, ALLERGENS);
}

#[test]
fn the_open_order_states_are_order_states() {
    for o in &generated().open_orders {
        let _: OrderStatus = via_json(o.state);
    }
}

/// Every order the seed writes, open or closed, placed again through `Order::decide` against
/// the seed's menu at its own placement time, gets the seed's prices and totals.
#[test]
fn the_seed_orders_pass_the_order_rules_with_the_same_totals() {
    let g = generated();
    let menu = seeded_menu(&g);
    let mut checked = 0;
    let open = g.open_orders.iter().map(|o| {
        (
            o.id,
            o.customer,
            o.kind,
            o.placed_at,
            o.slot_start,
            o.zone,
            &o.lines,
            [o.subtotal_cents, o.tax_cents, o.total_cents],
        )
    });
    let closed = g.history.iter().map(|o| {
        (
            o.id,
            o.customer,
            o.kind,
            o.placed_at,
            o.slot_start,
            o.zone,
            &o.lines,
            [o.subtotal_cents, o.tax_cents, o.total_cents],
        )
    });
    for (id, customer, kind, placed_at, slot, zone, lines, totals) in open.chain(closed) {
        let cmd = OrderCommand::PlaceOrder(Box::new(PlaceOrder {
            order: id,
            customer,
            kind: via_json::<OrderKind>(kind),
            slot,
            zone: zone.map(str::to_owned),
            lines: lines
                .iter()
                .map(|l| LineInput {
                    variant: l.variant.clone(),
                    qty: u16::try_from(l.qty).unwrap(),
                })
                .collect(),
            note: None,
            menu: menu.clone(),
            tax_bp: TAX_BP,
        }));
        let ctx = DecideContext {
            now: placed_at,
            id: Ulid::from_parts(1, 1),
        };
        let events = Order::decide(&Default::default(), &cmd, &ctx)
            .unwrap_or_else(|e| panic!("seed order {id} refused: {e}"));
        let OrderEvent::OrderPlaced {
            lines: placed,
            subtotal_cents,
            tax_cents,
            total_cents,
            ..
        } = &events[0]
        else {
            panic!("{events:?}");
        };
        assert_eq!([*subtotal_cents, *tax_cents, *total_cents], totals, "{id}");
        for (p, l) in placed.iter().zip(lines) {
            assert_eq!(
                (p.variant.as_str(), p.unit_cents),
                (l.variant.as_str(), l.unit_cents)
            );
        }
        assert!(totals[2] > Cents::ZERO);
        checked += 1;
    }
    assert!(checked > 700, "{checked}");
}

/// The seed's week, replayed through `Schedule::decide`: every place holds (and every paid one
/// confirms) under the day's capacities and the menu's caps. Winter and summer birth dates: the
/// seed's times go through the domain's calendar, so a July slot at 14:45 is `-06:00` and a valid
/// slot start for the Schedule.
#[test]
fn the_seed_week_holds_under_the_schedule_rules() {
    use bakery_domain::execute;
    use bakery_domain::schedule::{
        HoldKind, HoldRequest, HoldStatus, ItemCap, ItemQty, Schedule, ScheduleCommand,
        ScheduleState,
    };
    for (seed, born) in [
        (42, "2026-11-07"),
        (21, "2026-11-09"),
        (3, "2027-01-11"),
        (42, "2026-07-14"),
        (8, "2027-06-19"),
    ] {
        let g = Generator::new(Seed(seed), BirthDate::parse(born).unwrap()).generate();
        let mut places = 0;
        for day in &g.schedule {
            let ctx = DecideContext {
                now: day.date.opening().plus_minutes(-120).unwrap(),
                id: Ulid::from_parts(1, 1),
            };
            let caps: Vec<ItemCap> = via_json(&day.item_caps);
            let (mut state, _) = execute::<Schedule>(
                ScheduleState::new(day.date),
                &ScheduleCommand::RefreshCaps {
                    menu_version: 1,
                    caps,
                },
                &ctx,
            )
            .unwrap();
            for p in &day.places {
                let req = HoldRequest {
                    reference: p.reference,
                    kind: p.kind,
                    start: p.start,
                    zone: p.zone.map(str::to_owned),
                    lines: via_json::<Vec<ItemQty>>(&p.lines),
                    expires_at: p.start,
                };
                state = execute::<Schedule>(state, &ScheduleCommand::Hold(Box::new(req)), &ctx)
                    .unwrap_or_else(|e| panic!("{born} {}: {e}", p.reference))
                    .0;
                if p.status == HoldStatus::Reserved {
                    state = execute::<Schedule>(
                        state,
                        &ScheduleCommand::Confirm {
                            reference: p.reference,
                        },
                        &ctx,
                    )
                    .unwrap()
                    .0;
                }
                if p.kind == HoldKind::Slot {
                    assert!(
                        day.date.slot_starts().contains(&p.start),
                        "{born} {}",
                        p.reference
                    );
                }
                places += 1;
            }
            let reserved = day
                .places
                .iter()
                .filter(|p| p.status == HoldStatus::Reserved)
                .count();
            assert_eq!(state.plan().version > 0, reserved > 0);
        }
        assert_eq!(places, g.open_orders.len());
    }
}
