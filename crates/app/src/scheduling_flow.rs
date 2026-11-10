//! The roadmap's PR 6 "Done when", at the domain level, with the `Clock` port faked: the Order,
//! the Schedule and the Kitchen board decided in the order the router and the consumer will call
//! them, on the seed's menu. The Worker stream proves the same over HTTP.

use bakery_domain::catalog::{Catalog, Category, Item, MenuView, Variant};
use bakery_domain::kitchen::Board;
use bakery_domain::order::{
    LineInput, Order, OrderCommand, OrderError, OrderEvent, OrderKind, OrderState, PlaceOrder,
};
use bakery_domain::schedule::{
    HoldKind, HoldRequest, ItemCap, ItemQty, PlanLine, ReleaseReason, Schedule, ScheduleCommand,
    ScheduleEvent, ScheduleState,
};
use bakery_domain::{
    Aggregate, BakeryDate, BusinessTime, Cents, DecideContext, DomainEvent, Envelope, Ulid, execute,
};
use bakery_seed::{BirthDate, Generated, Generator, Seed, TAX_BP};
use serde_json::Value;

use crate::Clock;
use crate::test_support::{FixedClock, SequentialIds};

const DAY_MS: i64 = 86_400_000;

fn generated() -> Generated {
    Generator::new(Seed(42), BirthDate::parse("2026-11-04").unwrap()).generate()
}

fn menu(g: &Generated) -> MenuView {
    let categories: Vec<Category> =
        serde_json::from_value(serde_json::to_value(&g.categories).unwrap()).unwrap();
    let items: Vec<Item> = g
        .items
        .iter()
        .map(|item| {
            let mut v = serde_json::to_value(item).unwrap();
            v["status"] = Value::from("available");
            serde_json::from_value(v).unwrap()
        })
        .collect();
    let variants: Vec<Variant> =
        serde_json::from_value(serde_json::to_value(&g.variants).unwrap()).unwrap();
    Catalog::seeded(categories, items, variants)
        .unwrap()
        .menu_view()
}

/// The world one test drives: a faked clock, ids, the menu and the objects' states.
struct World {
    clock: FixedClock,
    ids: SequentialIds,
    menu: MenuView,
    customer: Ulid,
}

impl World {
    fn new() -> World {
        let g = generated();
        // Wednesday 2026-11-04, 09:00 Mountain standard time.
        World {
            clock: FixedClock::at("2026-11-04T16:00:00.000Z", -420),
            ids: SequentialIds::starting_at(1_793_800_000_000),
            menu: menu(&g),
            customer: g.customers[0].id,
        }
    }

    fn ctx(&self) -> DecideContext {
        DecideContext {
            now: self.clock.now_business(),
            id: self.ids.ulid(),
        }
    }

    fn place(&self, slot: &str, lines: &[(&str, u16)]) -> Result<OrderState, OrderError> {
        let cmd = OrderCommand::PlaceOrder(Box::new(PlaceOrder {
            order: self.ids.ulid(),
            customer: self.customer,
            kind: OrderKind::Pickup,
            slot: slot.parse().unwrap(),
            zone: None,
            lines: lines
                .iter()
                .map(|&(variant, qty)| LineInput {
                    variant: variant.into(),
                    qty,
                })
                .collect(),
            note: None,
            menu: self.menu.clone(),
            tax_bp: TAX_BP,
        }));
        execute::<Order>(OrderState::default(), &cmd, &self.ctx()).map(|(s, _)| s)
    }

    /// A day's Schedule with the menu's caps, as the seed and `MenuPublished` give it.
    fn day(&self, date: &str) -> ScheduleState {
        let caps = self
            .menu
            .categories
            .iter()
            .flat_map(|c| &c.items)
            .map(|i| ItemCap {
                item: i.slug.clone(),
                daily_cap: i.daily_cap,
            })
            .collect();
        let cmd = ScheduleCommand::RefreshCaps {
            menu_version: self.menu.version,
            caps,
        };
        execute::<Schedule>(ScheduleState::new(date.parse().unwrap()), &cmd, &self.ctx())
            .unwrap()
            .0
    }

    /// The router's synchronous hold for a placed order.
    fn hold(&self, day: ScheduleState, order: &OrderState) -> (ScheduleState, Vec<ScheduleEvent>) {
        let r = order.record().unwrap();
        let req = HoldRequest {
            reference: r.id,
            kind: HoldKind::for_order(r.kind),
            start: r.slot,
            zone: r.zone.clone(),
            lines: ItemQty::from_order_lines(&r.lines),
            expires_at: r.held_until,
        };
        execute::<Schedule>(day, &ScheduleCommand::Hold(Box::new(req)), &self.ctx()).unwrap()
    }

    fn schedule(
        &self,
        day: ScheduleState,
        cmd: ScheduleCommand,
    ) -> (ScheduleState, Vec<ScheduleEvent>) {
        execute::<Schedule>(day, &cmd, &self.ctx()).unwrap()
    }

    fn order(
        &self,
        state: OrderState,
        cmd: OrderCommand,
    ) -> Result<(OrderState, Vec<OrderEvent>), OrderError> {
        execute::<Order>(state, &cmd, &self.ctx())
    }

    fn pay(&self, state: OrderState) -> OrderState {
        let total = state.record().unwrap().total_cents;
        let cmd = OrderCommand::RecordPayment {
            payment: self.ids.ulid(),
            amount: total,
        };
        let (state, events) = self.order(state, cmd).unwrap();
        assert_eq!(events[0].name(), "OrderPaid");
        state
    }

    /// An event as the consumer hands it to the Kitchen.
    fn envelope(&self, date: BakeryDate, seq: u64, event: &ScheduleEvent) -> Envelope {
        Envelope {
            v: 1,
            id: self.ids.ulid(),
            sandbox: self.customer,
            stream: format!("schedule:{}:{date}", self.customer),
            seq,
            event_type: event.name().to_owned(),
            at: self.clock.now_business(),
            recorded_at: self.clock.now_wall(),
            data: event.to_data(),
            cause: None,
        }
    }
}

fn at(text: &str) -> BusinessTime {
    text.parse().unwrap()
}

fn names(events: &[ScheduleEvent]) -> Vec<&'static str> {
    events.iter().map(|e| e.name()).collect()
}

#[test]
fn advancing_the_clock_a_day_expires_an_unpaid_order_and_changes_the_bake_list() {
    let w = World::new();

    // An unpaid pickup for Thursday, held on Thursday's Schedule.
    let a = w
        .place("2026-11-05T10:00:00-07:00", &[("croissant/single", 2)])
        .unwrap();
    let thursday = w.day("2026-11-05");
    let (thursday, events) = w.hold(thursday, &a);
    assert_eq!(names(&events), ["SlotHeld"]);
    assert_eq!(
        a.record().unwrap().held_until.to_string(),
        "2026-11-04T09:15:00-07:00"
    );

    // Not due yet.
    assert_eq!(
        w.order(a.clone(), OrderCommand::Expire).unwrap_err().rule(),
        "not-due"
    );

    // The visitor advances the clock a day: wall time stands still, business time moves.
    let wall_before = w.clock.now_wall();
    w.clock.advance_business_ms(DAY_MS);
    assert_eq!(w.clock.now_wall(), wall_before);
    assert_eq!(
        w.clock.now_business().to_string(),
        "2026-11-05T09:00:00-07:00"
    );

    // The Order's expiry timer is due and expires it.
    let (a, events) = w.order(a, OrderCommand::Expire).unwrap();
    assert_eq!(
        events,
        [OrderEvent::OrderExpired {
            held_until: at("2026-11-04T09:15:00-07:00")
        }]
    );
    // OrderExpired reaches the Schedule, which releases the hold.
    let id_a = a.record().unwrap().id;
    let (thursday, events) = w.schedule(
        thursday,
        ScheduleCommand::Release {
            reference: id_a,
            reason: ReleaseReason::Expired,
        },
    );
    assert_eq!(names(&events), ["SlotReleased"]);
    assert_eq!(thursday.slots()[12].taken, 0);
    // The hold's own timer, firing after, changes nothing.
    let (_, events) = w.schedule(
        thursday,
        ScheduleCommand::Release {
            reference: id_a,
            reason: ReleaseReason::HoldExpired,
        },
    );
    assert!(events.is_empty());

    // A second order, for Friday, is paid: Friday's bake list changes.
    let b = w
        .place(
            "2026-11-06T10:00:00-07:00",
            &[("croissant/single", 2), ("croissant/box-6", 1)],
        )
        .unwrap();
    let (friday, _) = w.hold(w.day("2026-11-06"), &b);
    let b = w.pay(b);
    let (friday, events) = w.schedule(
        friday,
        ScheduleCommand::Confirm {
            reference: b.record().unwrap().id,
        },
    );
    assert_eq!(names(&events), ["SlotReserved", "BakeListChanged"]);
    let ScheduleEvent::BakeListChanged {
        date,
        version,
        lines,
    } = &events[1]
    else {
        panic!("{events:?}");
    };
    assert_eq!((date.to_string(), *version), ("2026-11-06".to_owned(), 1));
    assert_eq!(
        lines,
        &[PlanLine {
            item: "croissant".into(),
            qty: 3,
            start: at("2026-11-06T10:00:00-07:00"),
            catering: false,
        }]
    );
    assert_eq!(friday.plan().lines, *lines);

    // The Kitchen board draws it.
    let mut board = Board::default();
    for (seq, e) in events.iter().enumerate() {
        board.apply(&w.envelope(*date, seq as u64 + 10, e)).unwrap();
    }
    let lists = board.bake_lists();
    assert_eq!(lists.len(), 1);
    assert_eq!((lists[0].version, lists[0].reserved), (1, 1));
    assert_eq!(lists[0].lines, *lines);
}

#[test]
fn a_cake_for_tomorrow_is_refused_by_the_48_hour_rule_and_the_day_after_is_baked() {
    let w = World::new();
    // Thursday 09:00. The chocolate layer cake is baked Wednesday to Sunday.
    w.clock.advance_business_ms(DAY_MS);

    let tomorrow = w
        .place(
            "2026-11-06T10:00:00-07:00",
            &[("chocolate-layer-cake/6-inch", 1)],
        )
        .unwrap_err();
    assert_eq!(tomorrow.rule(), "lead-time");
    assert_eq!(
        tomorrow.to_string(),
        "Chocolate layer cake needs 48 h; the slot is 25 h away"
    );
    assert!(matches!(
        tomorrow,
        OrderError::LeadTimeNotMet {
            needed_minutes: 2_880,
            ..
        }
    ));

    let cake = w
        .place(
            "2026-11-07T10:00:00-07:00",
            &[("chocolate-layer-cake/6-inch", 1)],
        )
        .unwrap();
    let (saturday, events) = w.hold(w.day("2026-11-07"), &cake);
    assert_eq!(names(&events), ["SlotHeld"]);
    let cake = w.pay(cake);
    let (saturday, events) = w.schedule(
        saturday,
        ScheduleCommand::Confirm {
            reference: cake.record().unwrap().id,
        },
    );
    assert_eq!(names(&events), ["SlotReserved", "BakeListChanged"]);
    assert_eq!(
        saturday.plan().lines,
        [PlanLine {
            item: "chocolate-layer-cake".into(),
            qty: 1,
            start: at("2026-11-07T10:00:00-07:00"),
            catering: false,
        }]
    );
    assert_eq!(saturday.item_used("chocolate-layer-cake"), 1);
    assert_eq!(cake.record().unwrap().total_cents, Cents(4_180));
}

#[test]
fn two_orders_race_for_the_last_place_and_the_second_hears_the_next_free_slot() {
    let w = World::new();
    let mut friday = w.day("2026-11-06");
    // Five of the 10:00 slot's six places are taken.
    for _ in 0..5 {
        let o = w
            .place("2026-11-06T10:00:00-07:00", &[("scone/single", 1)])
            .unwrap();
        friday = w.hold(friday, &o).0;
    }
    let first = w
        .place("2026-11-06T10:00:00-07:00", &[("scone/single", 1)])
        .unwrap();
    let second = w
        .place("2026-11-06T10:00:00-07:00", &[("scone/single", 1)])
        .unwrap();
    // One writer per day: the two are decided one after the other.
    let (friday, events) = w.hold(friday, &first);
    assert_eq!(names(&events), ["SlotHeld"]);
    let r = second.record().unwrap();
    let refused = Schedule::decide(
        &friday,
        &ScheduleCommand::Hold(Box::new(HoldRequest {
            reference: r.id,
            kind: HoldKind::Slot,
            start: r.slot,
            zone: None,
            lines: ItemQty::from_order_lines(&r.lines),
            expires_at: r.held_until,
        })),
        &w.ctx(),
    )
    .unwrap_err();
    assert_eq!(refused.rule(), "slot-full");
    assert_eq!(
        refused.to_string(),
        "that time is full; the next free one is 2026-11-06T10:15:00-07:00"
    );
}
