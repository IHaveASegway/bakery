//! Deterministic synthetic data for a sandbox (docs/domain.md, "The seed").
//!
//! A [`Seed`] and a birth business date drive a ChaCha20 PRNG, and the [`Generator`] draws from
//! it in a fixed order, so one seed and date give the same output byte for byte on every
//! machine. The output is the sandbox's whole starting state: the menu, 60 customers, 6 venues,
//! about 90 days of closed orders, 12 open orders, 8 catering events and the coming week's seven
//! `Schedule` days, the last derived from the rest with no draw of its own. Every name is made up
//! from generic words; none is a real person, business or address, and no free text is seeded.
//!
//! Every money value is [`Cents`]; every time is a [`BusinessTime`] at the Mountain standard
//! offset, `-07:00`. Identifiers are ULIDs whose time part is the record's business time and whose
//! random part is drawn from the PRNG.

mod calendar;
mod catering;
mod crm;
mod dispatch;
mod menu;
mod words;

use bakery_domain::schedule::{
    DEFAULT_CATERING_CAPACITY, DEFAULT_SLOT_CAPACITY, DEFAULT_ZONE_CAPACITY, HoldKind, HoldStatus,
    ItemCap, ItemQty, normalize_lines,
};
use bakery_domain::{BakeryDate, BusinessTime, Cents, Ulid};
use rand_chacha::ChaCha20Rng;
use rand_core::{Rng, SeedableRng};
use serde::Serialize;

pub use calendar::{BirthDate, BirthDateError};
pub use catering::seed_commands;
pub use crm::{
    SEED_MESSAGES, SeedMessage, closed_at, directory, history_envelopes, history_event_id,
    register, seed_messages,
};
pub use dispatch::{
    CITY_MATRIX_JSON, DispatchDay, busy_saturday, city_matrix, seed_dispatch, seed_matrix, vans_for,
};
pub use menu::{ALLERGENS, CATEGORIES, ITEMS, ItemSpec, PACKAGES, PackageSpec, VariantSpec};

use calendar::{
    MONDAY, SATURDAY, SUNDAY, WEEKDAY_NAMES, business_time, civil_from_days, date_string, weekday,
};

/// The bakery's 60 regular customers.
pub const CUSTOMER_COUNT: usize = 60;
/// The six catering venues, `v1` to `v6`.
pub const VENUE_COUNT: usize = 6;
/// The 64 delivery places, `p1` to `p64`.
pub const PLACE_COUNT: usize = 64;
/// Days of closed-order history before the birth date.
pub const HISTORY_DAYS: i64 = 90;
/// Orders on the most recent Saturday, the Route Lab's busy Saturday.
pub const BUSY_SATURDAY_ORDERS: usize = 63;
/// Open orders on the birth day.
pub const OPEN_ORDER_COUNT: usize = 12;
/// The demo tax rate, 10.00%, in basis points (docs/domain.md, "Money and time").
pub const TAX_BP: u32 = 1_000;
/// The catering deposit, 25%, in basis points (docs/domain.md, "Money and time").
pub const DEPOSIT_BP: u32 = 2_500;
/// The three delivery zones; the Schedule's own list, so the two cannot drift.
pub const ZONES: [&str; 3] = bakery_domain::schedule::ZONES;
/// The `Schedule` days that exist from the start: the coming week's open days.
pub const SCHEDULE_DAYS: usize = 7;

/// A sandbox's seed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Seed(pub u64);

impl Seed {
    /// The PRNG for this seed. The 32-byte ChaCha key is the seed's little-endian bytes followed
    /// by zeros, written out here rather than left to `seed_from_u64`, so the stream cannot change
    /// under a `rand_core` upgrade.
    pub fn rng(self) -> ChaCha20Rng {
        let mut key = [0u8; 32];
        key[..8].copy_from_slice(&self.0.to_le_bytes());
        ChaCha20Rng::from_seed(key)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Category {
    pub slug: &'static str,
    pub name: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BulkLead {
    /// More than this many of one variant...
    pub over_qty: u32,
    /// ...needs this long (docs/domain.md, "The seed": 12 h for more than 4 of one loaf).
    pub lead_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Season {
    /// `MM-DD`, inclusive.
    pub from: &'static str,
    /// `MM-DD`, inclusive; before `from` when the window wraps over the new year.
    pub to: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    pub slug: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub allergens: Vec<&'static str>,
    pub daily_cap: u32,
    /// Weekday names, `tue` to `sun`; the bakery is closed on Mondays.
    pub days_baked: Vec<&'static str>,
    pub season: Option<Season>,
    pub bulk_lead: Option<BulkLead>,
    pub pickup_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Variant {
    /// `<item slug>/<suffix>`, such as `croissant/box-6`.
    pub slug: String,
    pub item: &'static str,
    pub label: &'static str,
    pub price_cents: Cents,
    pub lead_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Package {
    pub slug: &'static str,
    pub name: &'static str,
    pub per_head_cents: Cents,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Customer {
    pub id: Ulid,
    pub display_name: String,
    /// One to three item slugs.
    pub preferences: Vec<&'static str>,
    /// Consent to marketing; about 70% are true.
    pub marketing: bool,
    /// `z1` to `z3`.
    pub home_zone: &'static str,
    /// `p1` to `p64`: the delivery address, a map label and nothing more.
    pub place: String,
    /// The billing address the Payment Element is given for this customer (ADR 0007, decision
    /// 6): made from the place label and the customer's position, labelled synthetic.
    pub address: Address,
    /// One point per whole dollar of subtotal across the customer's closed orders.
    pub loyalty_points: u32,
}

/// The city, state, ZIP code and country of every synthetic address: the bakery's own city
/// (docs/domain.md, "Money and time"), with a first line that is a map label and says it is
/// made up.
pub const ADDRESS_CITY: &str = "Salt Lake City";
pub const ADDRESS_STATE: &str = "UT";
pub const ADDRESS_POSTAL_CODE: &str = "84101";
pub const ADDRESS_COUNTRY: &str = "US";

/// A synthetic billing address. Only `line1` varies, and it names no street.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Address {
    /// `<place>, unit <n> (synthetic)`, `n` being the customer's position from 1.
    pub line1: String,
    pub city: &'static str,
    pub state: &'static str,
    pub postal_code: &'static str,
    pub country: &'static str,
}

impl Address {
    /// Computed, not drawn, so adding it moved no draw and no seed's stream changed.
    pub fn synthetic(place: &str, unit: usize) -> Address {
        Address {
            line1: format!("{place}, unit {unit} (synthetic)"),
            city: ADDRESS_CITY,
            state: ADDRESS_STATE,
            postal_code: ADDRESS_POSTAL_CODE,
            country: ADDRESS_COUNTRY,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Venue {
    /// `v1` to `v6`.
    pub id: String,
    pub name: String,
    /// `p1` to `p64`.
    pub place: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderKind {
    Pickup,
    Delivery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OrderLine {
    /// A variant slug.
    pub variant: String,
    /// 1 to 24.
    pub qty: u32,
    /// The price copied from the menu at placement.
    pub unit_cents: Cents,
}

/// One closed order, the payload of its `OrderClosed` event in Crm's history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OrderClosed {
    /// Its time part is `placed_at`.
    pub id: Ulid,
    pub customer: Ulid,
    pub kind: OrderKind,
    pub placed_at: BusinessTime,
    /// The pickup slot's start, or the delivery window's start (09:00, 11:00 or 13:00).
    pub slot_start: BusinessTime,
    /// The delivery zone, `null` for a pickup.
    pub zone: Option<&'static str>,
    /// 1 to 20 lines.
    pub lines: Vec<OrderLine>,
    pub subtotal_cents: Cents,
    /// 10.00% of the subtotal, rounded half-up.
    pub tax_cents: Cents,
    pub total_cents: Cents,
    pub payment_id: Ulid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenState {
    Placed,
    Confirmed,
    InProduction,
    Ready,
}

/// A live order on the service day, not yet picked up or delivered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenOrder {
    pub id: Ulid,
    pub customer: Ulid,
    pub state: OpenState,
    pub kind: OrderKind,
    pub placed_at: BusinessTime,
    pub slot_start: BusinessTime,
    pub zone: Option<&'static str>,
    pub lines: Vec<OrderLine>,
    pub subtotal_cents: Cents,
    pub tax_cents: Cents,
    pub total_cents: Cents,
    /// `null` while the order is only placed.
    pub payment_id: Option<Ulid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CateringState {
    Inquiry,
    Quoted,
    Accepted,
    Confirmed,
    /// Delivered and invoiced.
    Invoiced,
    /// Paid and closed.
    Closed,
    Declined,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CateringEvent {
    /// Its time part is `created_at`.
    pub id: Ulid,
    pub state: CateringState,
    pub created_at: BusinessTime,
    /// `YYYY-MM-DD`.
    pub date: String,
    /// 10 to 200.
    pub headcount: u32,
    pub package: &'static str,
    pub venue: String,
    /// `null` before a quote exists (an inquiry) and on a declined inquiry.
    pub quote_total_cents: Option<Cents>,
    /// 25% of the quote, rounded half-up.
    pub deposit_cents: Option<Cents>,
    /// The quote minus the deposit.
    pub balance_cents: Option<Cents>,
    /// Always `null` in the seed: free text is never seeded.
    pub brief: Option<String>,
    /// The persona who asked: one of the 60, picked from the event id's random part, so no
    /// draw is added and every pinned value stands.
    pub customer: Ulid,
    /// Two hours after `created_at`, for every state but an inquiry and a declined one.
    pub quoted_at: Option<BusinessTime>,
    /// An hour after `quoted_at`, from `accepted` on.
    pub accepted_at: Option<BusinessTime>,
    /// The deposit's payment, paid five minutes after `accepted_at`, from `confirmed` on. Its
    /// time part is that moment, its random part the event id's plus one.
    pub deposit_payment: Option<Ulid>,
    /// 11:00 on the event day, for `invoiced` and `closed`.
    pub delivered_at: Option<BusinessTime>,
    /// The balance invoice, an hour after `delivered_at`; its random part is the event id's
    /// plus two. It is also the balance's payment id, as `Billing` keys it.
    pub invoice: Option<Ulid>,
    /// Seven days after the event day.
    pub invoice_due: Option<BakeryDate>,
}

impl CateringState {
    /// The aggregate's state this lifecycle position is.
    pub fn status(self) -> bakery_domain::catering::CateringStatus {
        use bakery_domain::catering::CateringStatus as S;
        match self {
            CateringState::Inquiry => S::Inquiry,
            CateringState::Quoted => S::Quoted,
            CateringState::Accepted => S::Accepted,
            CateringState::Confirmed => S::Confirmed,
            CateringState::Invoiced => S::Invoiced,
            CateringState::Closed => S::Closed,
            CateringState::Declined => S::Declined,
        }
    }

    fn reached(self, at_least: CateringState) -> bool {
        let rank = |s: CateringState| match s {
            CateringState::Inquiry | CateringState::Declined => 0,
            CateringState::Quoted => 1,
            CateringState::Accepted => 2,
            CateringState::Confirmed => 3,
            CateringState::Invoiced => 4,
            CateringState::Closed => 5,
        };
        self != CateringState::Declined && rank(self) >= rank(at_least)
    }
}

/// One open order's place on its day: a hold while it is only placed, a reservation once paid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SchedulePlace {
    /// The order's id.
    #[serde(rename = "ref")]
    pub reference: Ulid,
    /// `slot` for a pickup, `window` for a delivery.
    pub kind: HoldKind,
    /// `held` for a placed order, `reserved` for every other open state.
    pub status: HoldStatus,
    pub start: BusinessTime,
    pub zone: Option<&'static str>,
    /// Item slugs, the order's variant quantities summed per item.
    pub lines: Vec<ItemQty>,
}

/// One `Schedule` day as it exists at birth: the default capacities, the menu's item caps, and
/// the open orders on it. A hold's `expires_at` is the Order's `held_until`, which the Worker
/// sets when it seeds the Order, so it is not here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScheduleDay {
    pub date: BakeryDate,
    /// Orders per pickup slot, each of the 32.
    pub slot_capacity: u16,
    /// Stops per delivery zone for the day, each of the 3.
    pub zone_capacity: u16,
    pub catering_capacity: u16,
    /// Every item's `daily_cap`, by slug.
    pub item_caps: Vec<ItemCap>,
    /// The open orders on this day, by ref.
    pub places: Vec<SchedulePlace>,
}

/// How many records each section holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Rows {
    pub categories: usize,
    pub items: usize,
    pub variants: usize,
    pub packages: usize,
    pub customers: usize,
    pub venues: usize,
    pub history_orders: usize,
    pub history_lines: usize,
    pub open_orders: usize,
    pub open_order_lines: usize,
    pub catering_events: usize,
    pub schedule_days: usize,
}

/// Everything the seed generates. The field order is the JSON order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Generated {
    pub seed: Seed,
    pub born: BirthDate,
    pub rows: Rows,
    pub categories: Vec<Category>,
    pub items: Vec<Item>,
    pub variants: Vec<Variant>,
    pub packages: Vec<Package>,
    pub customers: Vec<Customer>,
    pub venues: Vec<Venue>,
    pub history: Vec<OrderClosed>,
    pub open_orders: Vec<OpenOrder>,
    pub catering: Vec<CateringEvent>,
    pub schedule: Vec<ScheduleDay>,
}

impl Generated {
    /// Pretty JSON with a trailing newline: the bytes the determinism check compares.
    pub fn to_json(&self) -> String {
        let mut out = serde_json::to_string_pretty(self).expect("plain data serializes");
        out.push('\n');
        out
    }
}

/// Draws a sandbox's synthetic things from one seed, always in the same order.
pub struct Generator {
    seed: Seed,
    born: BirthDate,
    rng: ChaCha20Rng,
}

/// One line chosen for an order: indexes into [`ITEMS`] and the item's variants, and a quantity.
type Pick = (usize, usize, u32);

impl Generator {
    pub fn new(seed: Seed, born: BirthDate) -> Generator {
        Generator {
            seed,
            born,
            rng: seed.rng(),
        }
    }

    /// Generates everything, consuming the generator so its draws cannot be reordered.
    pub fn generate(mut self) -> Generated {
        let born_days = self.born.days();
        let birth_ms = u64::try_from(business_time(born_days, 0).unix_ms())
            .expect("birth dates are after 1970");

        // The order of draws is part of the output: customers, venues, history, open orders,
        // catering. Inside each, the order of the draws is the order of the code below. Moving a
        // draw changes every sandbox born from every seed, so the pinned test must change with it.
        let mut customers = self.customers(birth_ms);
        let venues = self.venues();
        let history = self.history(&customers);
        let open_orders = self.open_orders(&customers);
        let catering = self.catering(&venues, &customers, birth_ms);
        // Derived, not drawn: every value above stands.
        let schedule = schedule_days(born_days, &open_orders);

        // Loyalty is a function of the history just drawn, so it is computed, not drawn.
        for customer in &mut customers {
            let dollars: i64 = history
                .iter()
                .filter(|o| o.customer == customer.id)
                .map(|o| o.subtotal_cents.0 / 100)
                .sum();
            customer.loyalty_points = u32::try_from(dollars).expect("a few thousand dollars");
        }

        let variants: Vec<Variant> = ITEMS
            .iter()
            .flat_map(|item| {
                item.variants.iter().map(|v| Variant {
                    slug: format!("{}/{}", item.slug, v.suffix),
                    item: item.slug,
                    label: v.label,
                    price_cents: Cents(v.price_cents),
                    lead_minutes: v.lead_minutes,
                })
            })
            .collect();
        let rows = Rows {
            categories: CATEGORIES.len(),
            items: ITEMS.len(),
            variants: variants.len(),
            packages: PACKAGES.len(),
            customers: customers.len(),
            venues: venues.len(),
            history_orders: history.len(),
            history_lines: history.iter().map(|o| o.lines.len()).sum(),
            open_orders: open_orders.len(),
            open_order_lines: open_orders.iter().map(|o| o.lines.len()).sum(),
            catering_events: catering.len(),
            schedule_days: schedule.len(),
        };
        Generated {
            seed: self.seed,
            born: self.born,
            rows,
            categories: CATEGORIES
                .iter()
                .map(|&(slug, name)| Category { slug, name })
                .collect(),
            items: ITEMS.iter().map(item_view).collect(),
            variants,
            packages: PACKAGES
                .iter()
                .map(|p| Package {
                    slug: p.slug,
                    name: p.name,
                    per_head_cents: Cents(p.per_head_cents),
                })
                .collect(),
            customers,
            venues,
            history,
            open_orders,
            catering,
            schedule,
        }
    }

    fn customers(&mut self, birth_ms: u64) -> Vec<Customer> {
        let names = self.distinct_pairs(words::GIVEN, words::FAMILY, CUSTOMER_COUNT);
        names
            .into_iter()
            .enumerate()
            .map(|(i, display_name)| {
                let id = Ulid::from_parts(birth_ms, self.random_u128());
                let count = 1 + self.below(3);
                let mut pool: Vec<usize> = (0..ITEMS.len()).collect();
                let mut preferences = Vec::with_capacity(count);
                for i in 0..count {
                    let j = i + self.below(pool.len() - i);
                    pool.swap(i, j);
                    preferences.push(ITEMS[pool[i]].slug);
                }
                let marketing = self.below(100) < 70;
                let home_zone = ZONES[self.below(ZONES.len())];
                let place = format!("p{}", 1 + self.below(PLACE_COUNT));
                let address = Address::synthetic(&place, i + 1);
                Customer {
                    id,
                    display_name,
                    preferences,
                    marketing,
                    home_zone,
                    place,
                    address,
                    loyalty_points: 0,
                }
            })
            .collect()
    }

    fn venues(&mut self) -> Vec<Venue> {
        let names = self.distinct_pairs(words::VENUE_FIRST, words::VENUE_SECOND, VENUE_COUNT);
        // Each venue gets its own place: a partial shuffle of 1..=64.
        let mut places: Vec<usize> = (1..=PLACE_COUNT).collect();
        names
            .into_iter()
            .enumerate()
            .map(|(i, name)| {
                let j = i + self.below(places.len() - i);
                places.swap(i, j);
                Venue {
                    id: format!("v{}", i + 1),
                    name,
                    place: format!("p{}", places[i]),
                }
            })
            .collect()
    }

    /// About 90 days of closed orders ending the day before birth, oldest first by id.
    fn history(&mut self, customers: &[Customer]) -> Vec<OrderClosed> {
        let born_days = self.born.days();
        // The most recent Saturday before the birth day: the busy one.
        let busy_saturday = (1..=7)
            .map(|back| born_days - back)
            .find(|&d| weekday(d) == SATURDAY)
            .expect("one day in seven is a Saturday");
        let mut orders = Vec::new();
        for day in (born_days - HISTORY_DAYS)..born_days {
            let wd = weekday(day);
            if wd == MONDAY {
                continue;
            }
            let all_delivery = day == busy_saturday;
            let count = match wd {
                _ if all_delivery => BUSY_SATURDAY_ORDERS,
                SATURDAY => 18 + self.below(2),
                SUNDAY => 10 + self.below(2),
                _ => 5 + self.below(3),
            };
            let mut sold = [0u32; ITEMS.len()];
            for _ in 0..count {
                let c = self.below(customers.len());
                let delivery = all_delivery || self.below(100) < 30;
                let (slot_minutes, zone) = self.slot(delivery, customers[c].home_zone);
                let count = self.line_count();
                let picks = self.pick_lines(count, day, delivery, &mut sold, u32::MAX, 24);
                let lines = lines_of(&picks);
                let lead = required_lead(&picks) + 30 + self.below(300) as i64;
                let placed_at = business_time(day, slot_minutes - lead);
                let (subtotal, tax, total) = totals(&lines);
                let id = self.order_id(placed_at);
                let paid_at = u64::try_from(placed_at.unix_ms()).expect("after 1970")
                    + (1 + self.below(10) as u64) * 60_000;
                let payment_id = Ulid::from_parts(paid_at, self.random_u128());
                orders.push(OrderClosed {
                    id,
                    customer: customers[c].id,
                    kind: kind_of(delivery),
                    placed_at,
                    slot_start: business_time(day, slot_minutes),
                    zone,
                    lines,
                    subtotal_cents: subtotal,
                    tax_cents: tax,
                    total_cents: total,
                    payment_id,
                });
            }
        }
        orders.sort_by_key(|o| o.id);
        orders
    }

    /// 12 open orders for the birth day (the next open day when the bakery is closed on it).
    /// They are small: lines of at most 4 units whose lead is 2 hours or less, so no lead rule
    /// is in question.
    fn open_orders(&mut self, customers: &[Customer]) -> Vec<OpenOrder> {
        const STATES: [OpenState; OPEN_ORDER_COUNT] = [
            OpenState::Placed,
            OpenState::Placed,
            OpenState::Confirmed,
            OpenState::Confirmed,
            OpenState::Confirmed,
            OpenState::Confirmed,
            OpenState::InProduction,
            OpenState::InProduction,
            OpenState::InProduction,
            OpenState::Ready,
            OpenState::Ready,
            OpenState::Ready,
        ];
        let mut day = self.born.days();
        if weekday(day) == MONDAY {
            day += 1;
        }
        let mut sold = [0u32; ITEMS.len()];
        STATES
            .into_iter()
            .map(|state| {
                let c = self.below(customers.len());
                let delivery = self.below(100) < 25;
                let (slot_minutes, zone) = self.slot(delivery, customers[c].home_zone);
                let count = 1 + self.below(4);
                let picks = self.pick_lines(count, day, delivery, &mut sold, 120, 4);
                let lines = lines_of(&picks);
                let lead = required_lead(&picks) + 30 + self.below(300) as i64;
                let placed_at = business_time(day, slot_minutes - lead);
                let (subtotal, tax, total) = totals(&lines);
                let id = self.order_id(placed_at);
                let payment_id = (state != OpenState::Placed).then(|| {
                    let paid_at = u64::try_from(placed_at.unix_ms()).expect("after 1970") + 60_000;
                    Ulid::from_parts(paid_at, self.random_u128())
                });
                OpenOrder {
                    id,
                    customer: customers[c].id,
                    state,
                    kind: kind_of(delivery),
                    placed_at,
                    slot_start: business_time(day, slot_minutes),
                    zone,
                    lines,
                    subtotal_cents: subtotal,
                    tax_cents: tax,
                    total_cents: total,
                    payment_id,
                }
            })
            .collect()
    }

    /// Eight events, one per lifecycle position docs/domain.md lists. Dates are open days (not
    /// Mondays), all different, so no day holds more than the 2 confirmed events the rule allows.
    /// Future events fall 14 to 45 days after birth; past ones 3 to 40 days before.
    fn catering(
        &mut self,
        venues: &[Venue],
        customers: &[Customer],
        birth_ms: u64,
    ) -> Vec<CateringEvent> {
        const STATES: [CateringState; 8] = [
            CateringState::Inquiry,
            CateringState::Quoted,
            CateringState::Accepted,
            CateringState::Confirmed,
            CateringState::Confirmed,
            CateringState::Invoiced,
            CateringState::Closed,
            CateringState::Declined,
        ];
        let born_days = self.born.days();
        let mut used: Vec<i64> = Vec::new();
        let mut events = Vec::new();
        for state in STATES {
            let offset = match state {
                CateringState::Invoiced => -(3 + self.below(8) as i64),
                CateringState::Closed => -(20 + self.below(21) as i64),
                _ => 14 + self.below(32) as i64,
            };
            let mut day = born_days + offset;
            while weekday(day) == MONDAY || used.contains(&day) {
                day += 1;
            }
            used.push(day);
            // The inquiry came in at least 14 days before the event, and not after the birth day.
            let ahead = 14 + self.below(8) as i64;
            let created_day = match state {
                CateringState::Invoiced | CateringState::Closed => day - ahead,
                _ => born_days - 1 - self.below(6) as i64,
            };
            let created_at = business_time(created_day, 10 * 60 + self.below(240) as i64);
            let id = Ulid::from_parts(
                u64::try_from(created_at.unix_ms()).unwrap_or(birth_ms),
                self.random_u128(),
            );
            let headcount = 10 + self.below(191) as u32;
            let package = PACKAGES[self.below(PACKAGES.len())];
            let venue = venues[self.below(venues.len())].id.clone();
            let (quote, deposit, balance) =
                if matches!(state, CateringState::Inquiry | CateringState::Declined) {
                    (None, None, None)
                } else {
                    let total = Cents(package.per_head_cents * i64::from(headcount));
                    let (deposit, balance) = total.split(DEPOSIT_BP).expect("25% is a valid split");
                    (Some(total), Some(deposit), Some(balance))
                };
            // Everything below is derived from the draws above; nothing more is drawn.
            let after = |t: BusinessTime, minutes: i64| {
                bakery_domain::calendar::plus_elapsed_minutes(t, minutes)
                    .expect("seed times are far inside the year range")
            };
            let ulid_at = |t: BusinessTime, plus: u128| {
                Ulid::from_parts(
                    u64::try_from(t.unix_ms()).expect("after 1970"),
                    id.as_u128().wrapping_add(plus),
                )
            };
            let random = id.as_u128() & ((1u128 << 80) - 1);
            let customer = customers[(random % customers.len() as u128) as usize].id;
            let quoted_at = state
                .reached(CateringState::Quoted)
                .then(|| after(created_at, 120));
            let accepted_at = quoted_at
                .filter(|_| state.reached(CateringState::Accepted))
                .map(|t| after(t, 60));
            let deposit_payment = accepted_at
                .filter(|_| state.reached(CateringState::Confirmed))
                .map(|t| ulid_at(after(t, 5), 1));
            let event_day = BakeryDate::from_days(day);
            let delivered_at = state
                .reached(CateringState::Invoiced)
                .then(|| event_day.at_local(11 * 60));
            let invoice = delivered_at.map(|t| ulid_at(after(t, 60), 2));
            let invoice_due = delivered_at
                .map(|_| event_day.plus_days(bakery_domain::catering::INVOICE_DUE_DAYS));
            events.push(CateringEvent {
                id,
                state,
                created_at,
                date: date_string(day),
                headcount,
                package: package.slug,
                venue,
                quote_total_cents: quote,
                deposit_cents: deposit,
                balance_cents: balance,
                brief: None,
                customer,
                quoted_at,
                accepted_at,
                deposit_payment,
                delivered_at,
                invoice,
                invoice_due,
            });
        }
        events
    }

    /// A pickup slot on the quarter hour from 07:00 to 14:45, or a delivery window start
    /// (09:00, 11:00 or 13:00) in the customer's zone. Minutes after midnight.
    fn slot(&mut self, delivery: bool, home_zone: &'static str) -> (i64, Option<&'static str>) {
        if delivery {
            (540 + 120 * self.below(3) as i64, Some(home_zone))
        } else {
            (420 + 15 * self.below(32) as i64, None)
        }
    }

    /// 1 to 20 lines, mostly few (docs/domain.md, Order invariants).
    fn line_count(&mut self) -> usize {
        match self.below(100) {
            0..=59 => 1 + self.below(2),
            60..=89 => 3 + self.below(3),
            90..=97 => 6 + self.below(5),
            _ => 11 + self.below(10),
        }
    }

    /// Chooses `count` different variants that the bakery can sell on `day`: baked that weekday,
    /// in season, deliverable if the order is a delivery, with a lead time of at most `max_lead`
    /// minutes, and under the day's cap. If the cap rules everything out the cap is ignored,
    /// which keeps the order count exact. Quantities run 1 to `max_qty`, mostly 1 or 2, and a
    /// whole cake is at most 2.
    fn pick_lines(
        &mut self,
        count: usize,
        day: i64,
        delivery: bool,
        sold: &mut [u32; ITEMS.len()],
        max_lead: u32,
        max_qty: u32,
    ) -> Vec<Pick> {
        let (_, month, dom) = civil_from_days(day);
        let wd = weekday(day);
        let mut picks: Vec<Pick> = Vec::new();
        for _ in 0..count {
            let eligible = |respect_cap: bool| -> Vec<(usize, usize)> {
                let mut out = Vec::new();
                for (i, item) in ITEMS.iter().enumerate() {
                    let sellable = item.days.contains(&wd)
                        && menu::in_season(item, month, dom)
                        && !(delivery && item.pickup_only)
                        && (!respect_cap || sold[i] < item.daily_cap);
                    if !sellable {
                        continue;
                    }
                    for (j, variant) in item.variants.iter().enumerate() {
                        if variant.lead_minutes <= max_lead
                            && !picks.iter().any(|&(pi, pj, _)| pi == i && pj == j)
                        {
                            out.push((i, j));
                        }
                    }
                }
                out
            };
            let mut candidates = eligible(true);
            if candidates.is_empty() {
                candidates = eligible(false);
            }
            if candidates.is_empty() {
                break;
            }
            let (i, j) = candidates[self.below(candidates.len())];
            let variant = &ITEMS[i].variants[j];
            let mut qty = match self.below(100) {
                0..=69 => 1 + self.below(2),
                70..=94 => 3 + self.below(4),
                _ => 7 + self.below(18),
            } as u32;
            if variant.lead_minutes >= 2_880 {
                qty = qty.min(2);
            }
            qty = qty.min(max_qty);
            sold[i] += qty;
            picks.push((i, j, qty));
        }
        picks
    }

    fn order_id(&mut self, placed_at: BusinessTime) -> Ulid {
        Ulid::from_parts(
            u64::try_from(placed_at.unix_ms()).expect("after 1970"),
            self.random_u128(),
        )
    }

    /// `count` distinct "first second" names: a partial Fisher-Yates shuffle of every pair.
    fn distinct_pairs(&mut self, first: &[&str], second: &[&str], count: usize) -> Vec<String> {
        let mut pairs: Vec<(usize, usize)> = (0..first.len())
            .flat_map(|a| (0..second.len()).map(move |b| (a, b)))
            .collect();
        assert!(
            count <= pairs.len(),
            "word lists too short for {count} names"
        );
        for i in 0..count {
            let j = i + self.below(pairs.len() - i);
            pairs.swap(i, j);
        }
        pairs[..count]
            .iter()
            .map(|&(a, b)| format!("{} {}", first[a], second[b]))
            .collect()
    }

    /// 128 random bits: the high half is drawn first.
    fn random_u128(&mut self) -> u128 {
        let hi = u128::from(self.rng.next_u64());
        let lo = u128::from(self.rng.next_u64());
        (hi << 64) | lo
    }

    /// A uniform draw from `0..n`, by rejection, so no value is favoured.
    fn below(&mut self, n: usize) -> usize {
        let n = n as u64;
        let zone = u64::MAX - u64::MAX % n;
        loop {
            let x = self.rng.next_u64();
            if x < zone {
                return (x % n) as usize;
            }
        }
    }
}

/// The seven open days from `born_days` on (the birth day itself when open; a Monday is
/// skipped, so the week spans eight calendar days when one falls in it), each with the default
/// capacities, every item's cap, and the open orders whose slot falls on it.
fn schedule_days(born_days: i64, open_orders: &[OpenOrder]) -> Vec<ScheduleDay> {
    let item_caps: Vec<ItemCap> = ITEMS
        .iter()
        .map(|i| ItemCap {
            item: i.slug.to_owned(),
            daily_cap: i.daily_cap,
        })
        .collect();
    (born_days..)
        .filter(|&d| weekday(d) != MONDAY)
        .take(SCHEDULE_DAYS)
        .map(|day| {
            let mut places: Vec<SchedulePlace> = open_orders
                .iter()
                .filter(|o| local_day(o.slot_start) == day)
                .map(|o| SchedulePlace {
                    reference: o.id,
                    kind: match o.kind {
                        OrderKind::Pickup => HoldKind::Slot,
                        OrderKind::Delivery => HoldKind::Window,
                    },
                    status: if o.state == OpenState::Placed {
                        HoldStatus::Held
                    } else {
                        HoldStatus::Reserved
                    },
                    start: o.slot_start,
                    zone: o.zone,
                    lines: normalize_lines(o.lines.iter().map(|l| ItemQty {
                        item: item_of(&l.variant).to_owned(),
                        qty: l.qty,
                    })),
                })
                .collect();
            places.sort_by_key(|p| p.reference);
            ScheduleDay {
                date: BakeryDate::from_days(day),
                slot_capacity: DEFAULT_SLOT_CAPACITY,
                zone_capacity: DEFAULT_ZONE_CAPACITY,
                catering_capacity: DEFAULT_CATERING_CAPACITY,
                item_caps: item_caps.clone(),
                places,
            }
        })
        .collect()
}

/// The civil day of one of the seed's business times, under Denver's rule.
fn local_day(t: BusinessTime) -> i64 {
    BakeryDate::of(t).days()
}

/// The item slug of a variant slug, `<item>/<suffix>`.
pub(crate) fn item_of(variant: &str) -> &str {
    variant.split_once('/').map_or(variant, |(item, _)| item)
}

fn kind_of(delivery: bool) -> OrderKind {
    if delivery {
        OrderKind::Delivery
    } else {
        OrderKind::Pickup
    }
}

fn item_view(item: &ItemSpec) -> Item {
    Item {
        slug: item.slug,
        name: item.name,
        category: item.category,
        allergens: item.allergens.to_vec(),
        daily_cap: item.daily_cap,
        days_baked: item
            .days
            .iter()
            .map(|&d| WEEKDAY_NAMES[usize::from(d)])
            .collect(),
        season: item.season.map(|(from, to)| Season { from, to }),
        bulk_lead: item.bulk_lead.map(|(over_qty, lead_minutes)| BulkLead {
            over_qty,
            lead_minutes,
        }),
        pickup_only: item.pickup_only,
    }
}

fn lines_of(picks: &[Pick]) -> Vec<OrderLine> {
    picks
        .iter()
        .map(|&(i, j, qty)| OrderLine {
            variant: format!("{}/{}", ITEMS[i].slug, ITEMS[i].variants[j].suffix),
            qty,
            unit_cents: Cents(ITEMS[i].variants[j].price_cents),
        })
        .collect()
}

/// The longest lead among the lines, in minutes, counting the bulk rule.
fn required_lead(picks: &[Pick]) -> i64 {
    picks
        .iter()
        .map(|&(i, j, qty)| {
            let base = ITEMS[i].variants[j].lead_minutes;
            let bulk = match ITEMS[i].bulk_lead {
                Some((over, lead)) if qty > over => lead,
                _ => 0,
            };
            i64::from(base.max(bulk))
        })
        .max()
        .unwrap_or(0)
}

/// Subtotal, tax (computed once, on the subtotal) and total.
fn totals(lines: &[OrderLine]) -> (Cents, Cents, Cents) {
    let subtotal = Cents(
        lines
            .iter()
            .map(|l| l.unit_cents.0 * i64::from(l.qty))
            .sum(),
    );
    let tax = subtotal.apply_bp(TAX_BP).expect("small amounts");
    let total = subtotal.checked_add(tax).expect("small amounts");
    (subtotal, tax, total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use calendar::days_from_civil;
    use std::collections::HashSet;

    fn born(text: &str) -> BirthDate {
        BirthDate::parse(text).unwrap()
    }

    fn generate(seed: u64, date: &str) -> Generated {
        Generator::new(Seed(seed), born(date)).generate()
    }

    /// A Saturday, so the busy-Saturday rule is exercised on the usual case.
    const DATE: &str = "2026-11-07";

    #[test]
    fn one_seed_gives_identical_bytes() {
        let a = generate(42, DATE).to_json();
        let b = generate(42, DATE).to_json();
        assert_eq!(a.as_bytes(), b.as_bytes());
        assert!(a.ends_with("}\n"));
    }

    #[test]
    fn the_stream_for_a_seed_never_changes() {
        // Pinned output: a change here means a dependency or the draw order moved the stream,
        // and every sandbox born from a seed would change with it.
        let g = generate(42, DATE);
        let first: Vec<&str> = g
            .customers
            .iter()
            .take(3)
            .map(|c| c.display_name.as_str())
            .collect();
        assert_eq!(first, ["Drizzle Trowel", "Cirrus Tombolo", "Sleet Anvil"]);
        assert_eq!(g.customers[0].id.to_string(), PINNED_FIRST_CUSTOMER);
        assert_eq!(g.history.len(), PINNED_HISTORY_LEN);
        assert_eq!(g.history[0].id.to_string(), PINNED_FIRST_ORDER);
    }

    #[test]
    fn every_customer_has_a_synthetic_address_from_their_place() {
        let g = generate(42, DATE);
        for (i, c) in g.customers.iter().enumerate() {
            assert_eq!(
                c.address.line1,
                format!("{}, unit {} (synthetic)", c.place, i + 1)
            );
            assert_eq!(
                (
                    c.address.city,
                    c.address.state,
                    c.address.postal_code,
                    c.address.country
                ),
                ("Salt Lake City", "UT", "84101", "US")
            );
        }
        // Pinned with the stream: the persona's, the first customer's.
        assert_eq!(g.customers[0].address.line1, PINNED_FIRST_ADDRESS);
        assert_eq!(
            generate(42, DATE).customers[0].address,
            g.customers[0].address
        );
    }

    const PINNED_FIRST_ADDRESS: &str = "p9, unit 1 (synthetic)";
    const PINNED_FIRST_CUSTOMER: &str = "01M6TCX5C0VKKM7M86WYN7SBR2";
    const PINNED_HISTORY_LEN: usize = 722;
    const PINNED_FIRST_ORDER: &str = "01KZDX3BS0AHWTMASY3YGTFWD7";

    #[test]
    fn another_seed_gives_other_people() {
        let a = generate(1, DATE);
        let b = generate(2, DATE);
        assert_ne!(a.customers, b.customers);
        assert_eq!(a.items, b.items);
        assert_ne!(
            generate(1, DATE).to_json(),
            generate(1, "2026-11-08").to_json()
        );
    }

    #[test]
    fn counts_match_the_domain() {
        let g = generate(7, DATE);
        assert_eq!(g.categories.len(), 5);
        assert_eq!(g.items.len(), 24);
        assert_eq!(g.variants.len(), 48);
        assert_eq!(g.customers.len(), 60);
        assert_eq!(g.venues.len(), 6);
        assert_eq!(g.catering.len(), 8);
        assert_eq!(g.open_orders.len(), 12);
        assert_eq!(g.packages.len(), 4);
        let ids: Vec<&str> = g.venues.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, ["v1", "v2", "v3", "v4", "v5", "v6"]);
        assert_eq!(g.rows.variants, 48);
        assert_eq!(g.rows.history_orders, g.history.len());
        assert_eq!(
            g.rows.history_lines,
            g.history.iter().map(|o| o.lines.len()).sum::<usize>()
        );
    }

    #[test]
    fn the_variant_table_sums_to_48_by_category() {
        let per_category = |category: &str| -> usize {
            ITEMS
                .iter()
                .filter(|i| i.category == category)
                .map(|i| i.variants.len())
                .sum()
        };
        assert_eq!(per_category("breads"), 12);
        assert_eq!(per_category("pastries"), 14);
        assert_eq!(per_category("cakes"), 12);
        assert_eq!(per_category("savory"), 4);
        assert_eq!(per_category("drinks"), 6);
        assert_eq!(ITEMS.iter().map(|i| i.variants.len()).sum::<usize>(), 48);
        let per_items = |category: &str| ITEMS.iter().filter(|i| i.category == category).count();
        assert_eq!(
            [
                per_items("breads"),
                per_items("pastries"),
                per_items("cakes"),
                per_items("savory"),
                per_items("drinks")
            ],
            [6, 7, 4, 4, 3]
        );
    }

    #[test]
    fn the_menu_follows_the_rules_in_the_domain_doc() {
        let g = generate(7, DATE);
        let categories: HashSet<&str> = CATEGORIES.iter().map(|c| c.0).collect();
        let slugs: HashSet<&str> = ITEMS.iter().map(|i| i.slug).collect();
        assert_eq!(slugs.len(), ITEMS.len());
        for item in ITEMS {
            assert!(categories.contains(item.category), "{}", item.slug);
            assert!(
                item.slug
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'-'),
                "{}",
                item.slug
            );
            assert!(item.allergens.iter().all(|a| ALLERGENS.contains(a)));
            assert!(item.daily_cap > 0);
            assert!(!item.days.contains(&MONDAY), "closed Mondays");
            assert_eq!(
                item.bulk_lead.is_some(),
                item.category == "breads",
                "{}",
                item.slug
            );
            assert_eq!(item.pickup_only, item.category == "drinks");
            let expected_lead: &[u32] = match item.category {
                "cakes" => &[2_880, 2_880, 120],
                "drinks" => &[0, 0],
                _ => &[120, 120][..item.variants.len()],
            };
            let leads: Vec<u32> = item.variants.iter().map(|v| v.lead_minutes).collect();
            assert_eq!(leads, expected_lead, "{}", item.slug);
        }
        let seasonal: Vec<&str> = ITEMS
            .iter()
            .filter(|i| i.season.is_some())
            .map(|i| i.slug)
            .collect();
        assert_eq!(seasonal, ["cardamom-knot", "seasonal-fruit-tart"]);
        let nine: HashSet<&str> = ALLERGENS.into_iter().collect();
        assert_eq!(nine.len(), 9);
        // Every variant's item exists, prices are positive and slugs are unique.
        let mut variant_slugs = HashSet::new();
        for v in &g.variants {
            assert!(slugs.contains(v.item), "{}", v.slug);
            assert!(v.slug.starts_with(&format!("{}/", v.item)));
            assert!(v.price_cents > Cents::ZERO, "{}", v.slug);
            assert!(variant_slugs.insert(v.slug.as_str()), "{}", v.slug);
        }
        assert!(variant_slugs.contains("croissant/box-6"));
        for p in &g.packages {
            assert!(p.per_head_cents > Cents::ZERO);
        }
    }

    #[test]
    fn seasons_wrap_over_the_new_year() {
        let cardamom = ITEMS.iter().find(|i| i.slug == "cardamom-knot").unwrap();
        assert!(menu::in_season(cardamom, 12, 25));
        assert!(menu::in_season(cardamom, 1, 2));
        assert!(menu::in_season(cardamom, 3, 15));
        assert!(!menu::in_season(cardamom, 3, 16));
        assert!(!menu::in_season(cardamom, 7, 4));
        let tart = ITEMS
            .iter()
            .find(|i| i.slug == "seasonal-fruit-tart")
            .unwrap();
        assert!(menu::in_season(tart, 5, 1));
        assert!(menu::in_season(tart, 9, 30));
        assert!(!menu::in_season(tart, 10, 1));
        assert!(menu::in_season(&ITEMS[0], 2, 2));
    }

    #[test]
    fn customers_are_complete_and_distinct() {
        for seed in 0..50 {
            let g = generate(seed, DATE);
            let names: HashSet<&str> = g
                .customers
                .iter()
                .map(|c| c.display_name.as_str())
                .collect();
            assert_eq!(names.len(), CUSTOMER_COUNT);
            let ids: HashSet<Ulid> = g.customers.iter().map(|c| c.id).collect();
            assert_eq!(ids.len(), CUSTOMER_COUNT);
            let venues: HashSet<&str> = g.venues.iter().map(|v| v.name.as_str()).collect();
            assert_eq!(venues.len(), VENUE_COUNT);
            let venue_places: HashSet<&str> = g.venues.iter().map(|v| v.place.as_str()).collect();
            assert_eq!(venue_places.len(), VENUE_COUNT);
        }
    }

    fn is_place(p: &str) -> bool {
        p.strip_prefix('p')
            .and_then(|n| n.parse::<usize>().ok())
            .is_some_and(|n| (1..=PLACE_COUNT).contains(&n))
            && !p[1..].starts_with('0')
    }

    #[test]
    fn customers_and_venues_use_real_labels() {
        let g = generate(9, DATE);
        let slugs: HashSet<&str> = ITEMS.iter().map(|i| i.slug).collect();
        let birth_ms = u64::try_from(business_time(g.born.days(), 0).unix_ms()).unwrap();
        for c in &g.customers {
            assert!(is_place(&c.place), "{}", c.place);
            assert!(ZONES.contains(&c.home_zone));
            assert!((1..=3).contains(&c.preferences.len()));
            let distinct: HashSet<&str> = c.preferences.iter().copied().collect();
            assert_eq!(distinct.len(), c.preferences.len());
            assert!(c.preferences.iter().all(|p| slugs.contains(p)));
            assert_eq!(c.id.unix_ms(), birth_ms);
        }
        for v in &g.venues {
            assert!(is_place(&v.place), "{}", v.place);
        }
    }

    #[test]
    fn marketing_consent_is_about_seventy_percent() {
        let mut yes = 0;
        for seed in 0..20 {
            yes += generate(seed, DATE)
                .customers
                .iter()
                .filter(|c| c.marketing)
                .count();
        }
        let share = yes * 100 / (20 * CUSTOMER_COUNT);
        assert!((65..=75).contains(&share), "{share}%");
    }

    fn weekday_of(o: &OrderClosed) -> u8 {
        weekday(BakeryDate::of(o.slot_start).days())
    }

    #[test]
    fn history_has_the_weekly_rhythm() {
        for (seed, date) in [(42, DATE), (7, "2026-11-04"), (3, "2027-01-11")] {
            let g = generate(seed, date);
            let born_days = g.born.days();
            let mut per_day = std::collections::BTreeMap::new();
            for o in &g.history {
                *per_day
                    .entry(BakeryDate::of(o.slot_start).days())
                    .or_insert(0usize) += 1;
            }
            assert!(
                (700..=760).contains(&g.history.len()),
                "{} orders for {seed}, {date}",
                g.history.len()
            );
            assert!(
                per_day
                    .keys()
                    .all(|&d| d >= born_days - HISTORY_DAYS && d < born_days)
            );
            let busy = (1..=7)
                .map(|back| born_days - back)
                .find(|&d| weekday(d) == SATURDAY)
                .unwrap();
            for (&day, &n) in &per_day {
                let wd = weekday(day);
                assert_ne!(wd, MONDAY, "closed Mondays");
                match wd {
                    _ if day == busy => assert_eq!(n, BUSY_SATURDAY_ORDERS),
                    SATURDAY => assert!((18..=19).contains(&n), "{n}"),
                    SUNDAY => assert!((10..=11).contains(&n), "{n}"),
                    _ => assert!((5..=7).contains(&n), "{n}"),
                }
            }
            let busy_orders: Vec<&OrderClosed> = g
                .history
                .iter()
                .filter(|o| BakeryDate::of(o.slot_start).days() == busy)
                .collect();
            assert_eq!(busy_orders.len(), 63);
            assert!(busy_orders.iter().all(|o| o.kind == OrderKind::Delivery));
            assert!(g.history.iter().all(|o| weekday_of(o) != MONDAY));
        }
    }

    #[test]
    fn history_orders_are_well_formed() {
        let g = generate(11, DATE);
        let customers: HashSet<Ulid> = g.customers.iter().map(|c| c.id).collect();
        let variants: std::collections::HashMap<&str, Cents> = g
            .variants
            .iter()
            .map(|v| (v.slug.as_str(), v.price_cents))
            .collect();
        let mut ids = HashSet::new();
        for o in &g.history {
            assert!(ids.insert(o.id));
            assert!(customers.contains(&o.customer));
            assert_eq!(o.id.unix_ms() as i64, o.placed_at.unix_ms());
            assert!(o.placed_at < o.slot_start);
            assert!(o.payment_id.unix_ms() > o.id.unix_ms());
            assert!((1..=20).contains(&o.lines.len()), "{}", o.lines.len());
            assert_eq!(o.kind == OrderKind::Delivery, o.zone.is_some());
            if let Some(zone) = o.zone {
                assert!(ZONES.contains(&zone));
            }
            let mut seen = HashSet::new();
            let mut subtotal = 0;
            for line in &o.lines {
                assert!((1..=24).contains(&line.qty));
                assert!(seen.insert(line.variant.as_str()));
                assert_eq!(variants[line.variant.as_str()], line.unit_cents);
                assert!(line.unit_cents > Cents::ZERO);
                subtotal += line.unit_cents.0 * i64::from(line.qty);
            }
            assert_eq!(o.subtotal_cents, Cents(subtotal));
            assert_eq!(o.tax_cents, o.subtotal_cents.apply_bp(1_000).unwrap());
            assert_eq!(
                o.total_cents,
                o.subtotal_cents.checked_add(o.tax_cents).unwrap()
            );
            assert!(o.total_cents > Cents::ZERO);
            let minutes = bakery_domain::calendar::local_minutes(o.slot_start);
            match o.kind {
                OrderKind::Pickup => {
                    assert!(
                        (420..=885).contains(&minutes) && minutes.is_multiple_of(15),
                        "{minutes}"
                    );
                }
                OrderKind::Delivery => assert!([540, 660, 780].contains(&minutes), "{minutes}"),
            }
        }
        // IDs sort by placement.
        assert!(g.history.windows(2).all(|w| w[0].id <= w[1].id));
    }

    #[test]
    fn history_respects_the_menu() {
        let g = generate(13, DATE);
        let by_slug: std::collections::HashMap<String, (usize, usize)> = ITEMS
            .iter()
            .enumerate()
            .flat_map(|(i, item)| {
                item.variants
                    .iter()
                    .enumerate()
                    .map(move |(j, v)| (format!("{}/{}", item.slug, v.suffix), (i, j)))
            })
            .collect();
        for o in &g.history {
            let day = BakeryDate::of(o.slot_start).days();
            let (_, month, dom) = civil_from_days(day);
            let lead_minutes = (o.slot_start.unix_ms() - o.placed_at.unix_ms()) / 60_000;
            for line in &o.lines {
                let (i, j) = by_slug[&line.variant];
                let item = &ITEMS[i];
                assert!(item.days.contains(&weekday(day)), "{}", line.variant);
                assert!(menu::in_season(item, month, dom), "{}", line.variant);
                assert!(!(o.kind == OrderKind::Delivery && item.pickup_only));
                assert!(lead_minutes >= i64::from(item.variants[j].lead_minutes));
                if let Some((over, lead)) = item.bulk_lead
                    && line.qty > over
                {
                    assert!(lead_minutes >= i64::from(lead), "{}", line.variant);
                }
            }
        }
    }

    #[test]
    fn loyalty_matches_the_history() {
        let g = generate(5, DATE);
        for c in &g.customers {
            let dollars: i64 = g
                .history
                .iter()
                .filter(|o| o.customer == c.id)
                .map(|o| o.subtotal_cents.0 / 100)
                .sum();
            assert_eq!(i64::from(c.loyalty_points), dollars);
        }
        assert!(g.customers.iter().any(|c| c.loyalty_points > 0));
    }

    #[test]
    fn open_orders_cover_the_states_and_the_lead_rules() {
        let g = generate(21, DATE);
        let count = |s: OpenState| g.open_orders.iter().filter(|o| o.state == s).count();
        assert_eq!(count(OpenState::Placed), 2);
        assert_eq!(count(OpenState::Confirmed), 4);
        assert_eq!(count(OpenState::InProduction), 3);
        assert_eq!(count(OpenState::Ready), 3);
        for o in &g.open_orders {
            assert_eq!(o.payment_id.is_none(), o.state == OpenState::Placed);
            assert!((1..=4).contains(&o.lines.len()));
            assert!(o.lines.iter().all(|l| (1..=4).contains(&l.qty)));
            assert!(
                (o.slot_start.unix_ms() - o.placed_at.unix_ms()) / 60_000 >= 150,
                "lead"
            );
            assert_eq!(
                o.total_cents,
                o.subtotal_cents.checked_add(o.tax_cents).unwrap()
            );
            assert_eq!(o.kind == OrderKind::Delivery, o.zone.is_some());
        }
    }

    #[test]
    fn open_orders_on_a_monday_move_to_tuesday() {
        // 2026-11-09 is a Monday.
        let g = generate(21, "2026-11-09");
        let tuesday = days_from_civil(2026, 11, 10);
        for o in &g.open_orders {
            assert_eq!(BakeryDate::of(o.slot_start).days(), tuesday);
        }
    }

    #[test]
    fn catering_walks_the_lifecycle() {
        for seed in 0..30 {
            let g = generate(seed, DATE);
            let states: Vec<CateringState> = g.catering.iter().map(|e| e.state).collect();
            assert_eq!(
                states,
                [
                    CateringState::Inquiry,
                    CateringState::Quoted,
                    CateringState::Accepted,
                    CateringState::Confirmed,
                    CateringState::Confirmed,
                    CateringState::Invoiced,
                    CateringState::Closed,
                    CateringState::Declined,
                ]
            );
            let packages: std::collections::HashMap<&str, i64> = PACKAGES
                .iter()
                .map(|p| (p.slug, p.per_head_cents))
                .collect();
            let venues: HashSet<&str> = g.venues.iter().map(|v| v.id.as_str()).collect();
            let mut dates = HashSet::new();
            for e in &g.catering {
                assert!(dates.insert(e.date.clone()), "one event a day");
                assert!((10..=200).contains(&e.headcount));
                assert!(venues.contains(e.venue.as_str()));
                assert!(e.brief.is_none());
                assert_eq!(e.id.unix_ms() as i64, e.created_at.unix_ms());
                let day = {
                    let b = BirthDate::parse(&e.date).unwrap();
                    b.days()
                };
                assert_ne!(weekday(day), MONDAY);
                let created_day =
                    (e.created_at.unix_ms() - 7 * 3_600_000).div_euclid(bakery_domain::MS_PER_DAY);
                assert!(
                    created_day <= g.born.days(),
                    "inquiries are not in the future"
                );
                // The date is at least 7 business days, so at least 9 calendar days, after it.
                assert!(day - created_day >= 9, "{} {}", e.date, e.created_at);
                match e.state {
                    CateringState::Inquiry | CateringState::Declined => {
                        assert!(e.quote_total_cents.is_none());
                        assert!(e.deposit_cents.is_none() && e.balance_cents.is_none());
                    }
                    _ => {
                        let total = e.quote_total_cents.unwrap();
                        assert_eq!(total, Cents(packages[e.package] * i64::from(e.headcount)));
                        assert_eq!(e.deposit_cents.unwrap(), total.apply_bp(2_500).unwrap());
                        assert_eq!(
                            e.deposit_cents
                                .unwrap()
                                .checked_add(e.balance_cents.unwrap()),
                            Ok(total)
                        );
                    }
                }
            }
            for e in &g.catering[5..7] {
                assert!(BirthDate::parse(&e.date).unwrap().days() < g.born.days());
            }
            for e in &g.catering[..5] {
                assert!(BirthDate::parse(&e.date).unwrap().days() > g.born.days());
            }
            let confirmed_dates: HashSet<&str> =
                g.catering[3..5].iter().map(|e| e.date.as_str()).collect();
            assert_eq!(confirmed_dates.len(), 2);
        }
    }

    #[test]
    fn every_seeded_catering_event_replays_to_its_state() {
        use bakery_domain::catering::{Catering, CateringCommand, CateringState as Saga};
        use bakery_domain::{DecideContext, execute};
        for (seed, date) in (0..30).map(|s| (s, DATE)).chain([
            (42, "2026-07-14"),
            (7, "2027-03-09"),
            (9, "2026-11-02"),
        ]) {
            let g = generate(seed, date);
            for (n, e) in g.catering.iter().enumerate() {
                let steps = seed_commands(e);
                assert!(steps.windows(2).all(|w| w[0].0 <= w[1].0), "in time order");
                let mut state = Saga::default();
                for (i, (t, cmd)) in steps.iter().enumerate() {
                    let ctx = DecideContext {
                        now: *t,
                        id: Ulid::from_parts(1, i as u128),
                    };
                    let (next, events) = execute::<Catering>(state, cmd, &ctx)
                        .unwrap_or_else(|err| panic!("seed {seed} {date} #{n} {cmd:?}: {err}"));
                    assert!(!events.is_empty(), "seed {seed} #{n}: {cmd:?} did nothing");
                    state = next;
                }
                let r = state.record().unwrap();
                assert_eq!(r.status, e.state.status(), "seed {seed} {date} #{n}");
                assert_eq!(r.id, e.id);
                assert_eq!(r.customer, e.customer);
                assert_eq!(r.date.to_string(), e.date);
                assert_eq!(u32::from(r.headcount), e.headcount);
                assert_eq!(r.package, e.package);
                assert_eq!(r.venue, e.venue);
                assert_eq!(r.brief, None);
                assert_eq!(r.quote.map(|q| q.total), e.quote_total_cents);
                assert_eq!(r.quote.map(|q| q.deposit), e.deposit_cents);
                assert_eq!(r.quote.map(|q| q.balance), e.balance_cents);
                assert_eq!(r.deposit.map(|d| d.payment), e.deposit_payment);
                assert_eq!(r.invoice.map(|i| i.invoice), e.invoice);
                assert_eq!(r.invoice.map(|i| i.due), e.invoice_due);
                // Past reminders on the way were recorded; a closed job has none left.
                if e.state == CateringState::Closed {
                    assert!(bakery_domain::catering::reminders(&state).is_empty());
                    assert!(matches!(
                        steps.last(),
                        Some((_, CateringCommand::RecordBalance { .. }))
                    ));
                }
            }
        }
    }

    #[test]
    fn the_seeds_catering_fields_follow_the_state() {
        let g = generate(42, DATE);
        let customers: HashSet<Ulid> = g.customers.iter().map(|c| c.id).collect();
        for e in &g.catering {
            assert!(customers.contains(&e.customer));
            let quoted = !matches!(e.state, CateringState::Inquiry | CateringState::Declined);
            assert_eq!(e.quoted_at.is_some(), quoted);
            assert_eq!(
                e.accepted_at.is_some(),
                quoted && e.state != CateringState::Quoted
            );
            let paid = matches!(
                e.state,
                CateringState::Confirmed | CateringState::Invoiced | CateringState::Closed
            );
            assert_eq!(e.deposit_payment.is_some(), paid);
            let delivered = matches!(e.state, CateringState::Invoiced | CateringState::Closed);
            assert_eq!(e.delivered_at.is_some(), delivered);
            assert_eq!(e.invoice.is_some(), delivered);
            assert_eq!(e.invoice_due.is_some(), delivered);
            if let (Some(q), Some(a)) = (e.quoted_at, e.accepted_at) {
                assert!(e.created_at < q && q < a);
            }
            if let Some(p) = e.deposit_payment {
                assert_ne!(p, e.id);
                assert_eq!(
                    p.unix_ms() as i64,
                    e.accepted_at.unwrap().unix_ms() + 5 * 60_000
                );
            }
        }
    }

    #[test]
    fn the_domain_prices_the_seeds_packages() {
        let domain: Vec<(&str, Cents)> = bakery_domain::catering::PACKAGES
            .iter()
            .map(|p| (p.slug, p.per_head_cents))
            .collect();
        let seed: Vec<(&str, Cents)> = PACKAGES
            .iter()
            .map(|p| (p.slug, Cents(p.per_head_cents)))
            .collect();
        assert_eq!(domain, seed);
        let g = generate(42, DATE);
        let venues: Vec<&str> = g.venues.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(venues, bakery_domain::catering::VENUES);
    }

    #[test]
    fn the_week_is_seven_open_days_from_birth() {
        // Saturday: Sat, Sun, (Mon skipped), Tue to Sat: eight calendar days.
        let g = generate(42, DATE);
        let dates: Vec<String> = g.schedule.iter().map(|d| d.date.to_string()).collect();
        assert_eq!(
            dates,
            [
                "2026-11-07",
                "2026-11-08",
                "2026-11-10",
                "2026-11-11",
                "2026-11-12",
                "2026-11-13",
                "2026-11-14"
            ]
        );
        assert_eq!(g.rows.schedule_days, 7);
        // Born on a Monday or a Tuesday: the week starts on Tuesday, and since Tuesday to Sunday
        // is six days, the seventh is the next Tuesday.
        for born in ["2026-11-09", "2026-11-10"] {
            let g = generate(42, born);
            assert_eq!(g.schedule[0].date.to_string(), "2026-11-10");
            assert_eq!(g.schedule[5].date.to_string(), "2026-11-15");
            assert_eq!(g.schedule[6].date.to_string(), "2026-11-17");
        }
        for day in &g.schedule {
            assert!(day.date.is_open());
            assert_eq!(
                (day.slot_capacity, day.zone_capacity, day.catering_capacity),
                (6, 20, 2)
            );
            assert_eq!(day.item_caps.len(), ITEMS.len());
        }
    }

    #[test]
    fn every_open_order_is_on_exactly_one_day_and_no_day_is_over_capacity() {
        for (seed, date) in [
            (42, DATE),
            (21, "2026-11-09"),
            (7, "2026-11-04"),
            (3, "2027-01-11"),
        ] {
            for seed in [seed, seed + 100, seed + 1_000] {
                let g = generate(seed, date);
                for o in &g.open_orders {
                    let on: Vec<&ScheduleDay> = g
                        .schedule
                        .iter()
                        .filter(|d| d.places.iter().any(|p| p.reference == o.id))
                        .collect();
                    assert_eq!(on.len(), 1, "{}", o.id);
                    let place = on[0].places.iter().find(|p| p.reference == o.id).unwrap();
                    assert_eq!(place.start, o.slot_start);
                    assert_eq!(place.zone, o.zone);
                    assert_eq!(
                        place.status == HoldStatus::Held,
                        o.state == OpenState::Placed
                    );
                    let units: u32 = o.lines.iter().map(|l| l.qty).sum();
                    assert_eq!(place.lines.iter().map(|l| l.qty).sum::<u32>(), units);
                }
                let places: usize = g.schedule.iter().map(|d| d.places.len()).sum();
                assert_eq!(places, OPEN_ORDER_COUNT);
                for day in &g.schedule {
                    let mut per_slot = std::collections::HashMap::new();
                    let mut per_zone = std::collections::HashMap::new();
                    let mut per_item = std::collections::HashMap::new();
                    for p in &day.places {
                        match p.kind {
                            HoldKind::Slot => *per_slot.entry(p.start).or_insert(0u16) += 1,
                            _ => *per_zone.entry(p.zone.unwrap()).or_insert(0u16) += 1,
                        }
                        for l in &p.lines {
                            *per_item.entry(l.item.as_str()).or_insert(0u32) += l.qty;
                        }
                    }
                    assert!(per_slot.values().all(|&n| n <= day.slot_capacity));
                    assert!(per_zone.values().all(|&n| n <= day.zone_capacity));
                    for cap in &day.item_caps {
                        assert!(
                            per_item.get(cap.item.as_str()).copied().unwrap_or(0) <= cap.daily_cap
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn word_lists_have_no_repeats_and_are_plain_words() {
        let lists = [
            words::GIVEN,
            words::FAMILY,
            words::VENUE_FIRST,
            words::VENUE_SECOND,
        ];
        let mut all = HashSet::new();
        for list in lists {
            let set: HashSet<&str> = list.iter().copied().collect();
            assert_eq!(set.len(), list.len());
            for word in list {
                assert!(
                    word.chars().all(|c| c.is_ascii_alphabetic())
                        && word.chars().next().unwrap().is_ascii_uppercase(),
                    "{word}"
                );
                // A word in two lists would make a name read the same either way round.
                assert!(all.insert(*word), "{word} is in two lists");
            }
        }
        assert!(words::GIVEN.len() * words::FAMILY.len() >= 60 * 2);
    }

    /// Strings the pattern checker should not see: identifiers and timestamps are not free text
    /// (a ULID holds seven digits in a row now and then, and a date looks like a phone number).
    fn is_identifier_or_time(s: &str) -> bool {
        s.parse::<Ulid>().is_ok()
            || s.parse::<BusinessTime>().is_ok()
            || BirthDate::parse(s).is_ok()
    }

    fn scan(value: &serde_json::Value, path: &str, found: &mut Vec<String>) {
        match value {
            serde_json::Value::String(s) => {
                if !is_identifier_or_time(s)
                    && let Err(class) = bakery_domain::check_free_text(s)
                {
                    found.push(format!("{path}: {}", class.slug()));
                }
            }
            serde_json::Value::Array(a) => {
                for (i, v) in a.iter().enumerate() {
                    scan(v, &format!("{path}[{i}]"), found);
                }
            }
            serde_json::Value::Object(o) => {
                for (k, v) in o {
                    scan(v, &format!("{path}.{k}"), found);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn no_string_in_the_seed_looks_like_personal_data() {
        for (seed, date) in [(42, DATE), (0, "2026-11-04"), (u64::MAX, "2027-03-01")] {
            let json: serde_json::Value =
                serde_json::from_str(&generate(seed, date).to_json()).unwrap();
            let mut found = Vec::new();
            scan(&json, "$", &mut found);
            assert!(found.is_empty(), "{found:?}");
        }
    }

    #[test]
    fn the_scan_would_catch_a_leak() {
        let json = serde_json::json!({"a": ["fern@example.com"], "b": {"c": "call 555 0100"}});
        let mut found = Vec::new();
        scan(&json, "$", &mut found);
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn every_date_and_seed_gives_the_exact_counts() {
        // Every weekday of birth, a spread of seeds: the shape never depends on either.
        for day in 0..7 {
            let date = date_string(days_from_civil(2026, 11, 2) + day);
            for seed in [0, 1, 99, 1 << 40] {
                let g = generate(seed, &date);
                assert_eq!(g.customers.len(), 60, "{date}");
                assert_eq!(g.open_orders.len(), 12);
                assert_eq!(g.catering.len(), 8);
                assert!(
                    (700..=760).contains(&g.history.len()),
                    "{}",
                    g.history.len()
                );
            }
        }
    }
}
