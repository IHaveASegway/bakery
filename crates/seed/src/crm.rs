//! The seed's history and messages as Crm and the Inbox take them (docs/domain.md, "The seed":
//! 90 days of history as `OrderClosed` events into Crm's log, 240 Inbox messages; "Seed history
//! versus `OrderClosed`", which this module resolves).
//!
//! Everything here is derived from a [`Generated`] with no draw of its own, so no pinned value
//! moves: event ids come from the order ids, message ids from the Inbox's own rule, and opens and
//! clicks from [`engagement`] over the seed and the message id.

use bakery_domain::calendar::{local, plus_elapsed_minutes};
use bakery_domain::crm::{Directory, Persona};
use bakery_domain::customer::{CustomerCommand, Profile};
use bakery_domain::inbox::{Message, MessageKind, engagement, message_id, receipt};
use bakery_domain::order::{Line, OrderEvent, OrderKind as Kind};
use bakery_domain::{BusinessTime, DomainEvent, ENVELOPE_VERSION, Envelope, Ulid, WallTime};

use crate::calendar::business_time;
use crate::{Customer, Generated, ITEMS, OrderClosed, OrderKind, item_of};

/// The Inbox's seeded messages: the receipts of this many of the most recent history orders.
pub const SEED_MESSAGES: usize = 240;

/// One message the Inbox is seeded with: a receipt, as the Inbox would have written it.
pub type SeedMessage = Message;

/// The minutes from a history order's slot start to its end: a pickup slot is 15, a delivery
/// window 120.
fn slot_minutes(kind: OrderKind) -> i64 {
    match kind {
        OrderKind::Pickup => i64::from(bakery_domain::calendar::SLOT_MINUTES),
        OrderKind::Delivery => i64::from(bakery_domain::calendar::WINDOW_MINUTES),
    }
}

fn kind(kind: OrderKind) -> Kind {
    match kind {
        OrderKind::Pickup => Kind::Pickup,
        OrderKind::Delivery => Kind::Delivery,
    }
}

/// When a history order closed: its slot's end. An order closes after it is fulfilled, never
/// at its placement, and the end of the slot is the earliest it can have been.
pub fn closed_at(order: &OrderClosed) -> BusinessTime {
    plus_elapsed_minutes(order.slot_start, slot_minutes(order.kind))
        .expect("seed times are far inside the year range")
}

/// The `OrderClosed` event's id for a history order: the close's time part and the order id's
/// random part plus one, so it is drawn from nothing.
pub fn history_event_id(order: &OrderClosed) -> Ulid {
    Ulid::from_parts(
        u64::try_from(closed_at(order).unix_ms()).expect("after 1970"),
        order.id.as_u128().wrapping_add(1),
    )
}

/// The history as Crm's log starts: one `OrderClosed` envelope per history order, oldest id
/// first, in the catalog's shape with the history-only fields (docs/domain.md, "The event
/// catalog").
pub fn history_envelopes(g: &Generated, sandbox: Ulid) -> Vec<Envelope> {
    g.history
        .iter()
        .map(|o| {
            let at = closed_at(o);
            let event = OrderEvent::OrderClosed {
                total_cents: o.total_cents,
                refunded_cents: bakery_domain::Cents::ZERO,
                lines: Some(
                    o.lines
                        .iter()
                        .map(|l| Line {
                            item: item_of(&l.variant).to_owned(),
                            variant: l.variant.clone(),
                            qty: u16::try_from(l.qty).expect("1 to 24"),
                            unit_cents: l.unit_cents,
                        })
                        .collect(),
                ),
                customer: Some(o.customer),
                kind: Some(kind(o.kind)),
                slot: Some(o.slot_start),
                zone: o.zone.map(str::to_owned),
            };
            Envelope {
                v: ENVELOPE_VERSION,
                id: history_event_id(o),
                sandbox,
                stream: format!("order:{sandbox}:{}", o.id),
                seq: 1,
                event_type: event.name().to_owned(),
                at,
                recorded_at: WallTime::from_unix_ms(at.unix_ms()).expect("after 1970"),
                data: event.to_data(),
                cause: Some(format!("seed:{}", g.seed.0)),
            }
        })
        .collect()
}

/// What Crm is born knowing besides its log: the 60 personas and the cake items.
pub fn directory(g: &Generated) -> Directory {
    Directory {
        personas: g
            .customers
            .iter()
            .map(|c| Persona {
                customer: c.id,
                display_name: c.display_name.clone(),
                home_zone: c.home_zone.to_owned(),
                marketing: c.marketing,
                opening_points: c.loyalty_points,
            })
            .collect(),
        cake_items: ITEMS
            .iter()
            .filter(|i| i.category == "cakes")
            .map(|i| i.slug.to_owned())
            .collect(),
    }
}

/// A `Customer` object's first command, from its persona.
pub fn register(c: &Customer) -> CustomerCommand {
    CustomerCommand::Register {
        customer: c.id,
        profile: Profile {
            display_name: c.display_name.clone(),
            preferences: c.preferences.iter().map(|&p| p.to_owned()).collect(),
            home_zone: c.home_zone.to_owned(),
            place: c.place.clone(),
            billing_line: c.address.line1.clone(),
        },
        marketing: c.marketing,
        opening_points: c.loyalty_points,
    }
}

/// The Inbox's 240 seeded messages: a receipt for each of the 240 most recent history orders
/// (latest slot first, ties by id), delivered when the order was paid (its payment id's time),
/// with the id the Inbox gives a message for that order's `OrderClosed` event and its
/// customer. Opens and clicks are the seed's [`engagement`], kept only when they fall before the
/// sandbox's birth; the Worker arms timers for the rest.
pub fn seed_messages(g: &Generated) -> Vec<SeedMessage> {
    let birth = business_time(g.born.days(), 0);
    let mut recent: Vec<&OrderClosed> = g.history.iter().collect();
    recent.sort_by_key(|o| std::cmp::Reverse((o.slot_start, o.id)));
    recent
        .into_iter()
        .take(SEED_MESSAGES)
        .map(|o| {
            let id = message_id(history_event_id(o), o.customer);
            let delivered_at = local(i64::try_from(o.payment_id.unix_ms()).expect("small"))
                .expect("seed times are far inside the year range");
            let items: u32 = o.lines.iter().map(|l| l.qty).sum();
            let (subject, body) = receipt(kind(o.kind), items, o.total_cents);
            let e = engagement(g.seed.0, id);
            let after = |m: Option<u32>| {
                m.map(|m| {
                    plus_elapsed_minutes(delivered_at, i64::from(m))
                        .expect("seed times are far inside the year range")
                })
                .filter(|t| *t <= birth)
            };
            let opened_at = after(e.opens_after);
            let clicked_at = opened_at.and(after(e.clicks_after));
            Message {
                id,
                to: o.customer,
                kind: MessageKind::Receipt,
                reference: o.id,
                subject,
                body,
                delivered_at,
                opened_at,
                clicked_at,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BirthDate, Generator, Seed};
    use bakery_domain::crm::{CrmProjection, Outcome, Segment, segment_members};
    use bakery_domain::customer::Customer as CustomerAggregate;
    use bakery_domain::{DecideContext, check_free_text, execute};
    use std::collections::BTreeSet;

    fn generate(seed: u64) -> Generated {
        Generator::new(Seed(seed), BirthDate::parse("2026-11-07").unwrap()).generate()
    }

    fn sandbox() -> Ulid {
        Ulid::from_parts(1_793_000_000_000, 7)
    }

    #[test]
    fn the_history_is_one_close_per_order_in_the_catalog_shape() {
        let g = generate(42);
        let log = history_envelopes(&g, sandbox());
        assert_eq!(log.len(), g.history.len());
        assert_eq!(log.len(), 722, "about 720, as docs/domain.md says");
        let ids: BTreeSet<Ulid> = log.iter().map(|e| e.id).collect();
        assert_eq!(ids.len(), log.len());
        for (e, o) in log.iter().zip(&g.history) {
            assert_eq!(e.stream, format!("order:{}:{}", sandbox(), o.id));
            assert_eq!((e.seq, e.event_type.as_str()), (1, "OrderClosed"));
            assert!(e.at > o.slot_start && e.at < business_time(g.born.days(), 0));
            assert_eq!(e.recorded_at.unix_ms(), e.at.unix_ms());
            assert_eq!(e.cause.as_deref(), Some("seed:42"));
            assert_eq!(e.data["refunded_cents"], 0);
            assert_eq!(e.data["slot"], o.slot_start.to_string());
            assert!(e.data.get("slot_start").is_none());
            // Through the envelope and back.
            let text = serde_json::to_string(e).unwrap();
            let back: Envelope = serde_json::from_str(&text).unwrap();
            let OrderEvent::OrderClosed {
                total_cents,
                lines,
                customer,
                ..
            } = OrderEvent::from_envelope(&back).unwrap()
            else {
                panic!("{text}");
            };
            assert_eq!(total_cents, o.total_cents);
            assert_eq!(customer, Some(o.customer));
            let lines = lines.unwrap();
            assert_eq!(lines.len(), o.lines.len());
            assert!(
                lines
                    .iter()
                    .all(|l| l.variant.starts_with(&format!("{}/", l.item)))
            );
        }
        // Twice, the same bytes.
        assert_eq!(
            serde_json::to_string(&log).unwrap(),
            serde_json::to_string(&history_envelopes(&generate(42), sandbox())).unwrap()
        );
    }

    #[test]
    fn crm_folds_the_history_and_rebuilds_it_byte_for_byte() {
        let g = generate(42);
        let directory = directory(&g);
        assert_eq!(directory.personas.len(), 60);
        assert_eq!(directory.cake_items.len(), 4);
        let log = history_envelopes(&g, sandbox());
        let mut live = CrmProjection::new(&directory);
        for e in &log {
            assert_eq!(live.apply(e), Ok(Outcome::Applied));
        }
        let orders: u32 = live.customers().map(|c| c.orders).sum();
        assert_eq!(orders as usize, g.history.len());
        for c in &g.customers {
            let row = live.customer(c.id).unwrap();
            assert_eq!(row.loyalty_balance, i64::from(c.loyalty_points));
            assert_eq!(
                row.orders as usize,
                g.history.iter().filter(|o| o.customer == c.id).count()
            );
        }
        let rebuilt = CrmProjection::from_log(&directory, &log).unwrap();
        assert_eq!(rebuilt.to_json(), live.to_json());
        // The segments have members on the birth day.
        let born = business_time(g.born.days(), 9 * 60);
        assert_eq!(segment_members(&live, Segment::Everyone, born).len(), 60);
        assert!(!segment_members(&live, Segment::DeliveryCustomers, born).is_empty());
        assert!(!segment_members(&live, Segment::CakeLast30Days, born).is_empty());
    }

    #[test]
    fn every_persona_registers_as_a_customer() {
        let g = generate(42);
        let ctx = DecideContext {
            now: business_time(g.born.days(), 9 * 60),
            id: sandbox(),
        };
        for c in &g.customers {
            let (state, events) =
                execute::<CustomerAggregate>(Default::default(), &register(c), &ctx).unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(state.balance(), i64::from(c.loyalty_points));
            assert_eq!(state.marketing(), c.marketing);
        }
    }

    #[test]
    fn the_inbox_is_seeded_with_240_receipts() {
        let g = generate(42);
        let messages = seed_messages(&g);
        assert_eq!(messages.len(), SEED_MESSAGES);
        let ids: BTreeSet<Ulid> = messages.iter().map(|m| m.id).collect();
        assert_eq!(ids.len(), SEED_MESSAGES);
        let birth = business_time(g.born.days(), 0);
        let oldest_kept = messages.last().unwrap();
        for m in &messages {
            let o = g.history.iter().find(|o| o.id == m.reference).unwrap();
            assert_eq!(m.to, o.customer);
            assert_eq!(m.id, message_id(history_event_id(o), o.customer));
            assert!(
                o.slot_start
                    >= g.history
                        .iter()
                        .find(|h| h.id == oldest_kept.reference)
                        .unwrap()
                        .slot_start
            );
            assert!(m.delivered_at < birth);
            assert_eq!(check_free_text(&m.subject), Ok(()));
            assert_eq!(check_free_text(&m.body), Ok(()), "{}", m.body);
            if let Some(c) = m.clicked_at {
                assert!(m.opened_at.is_some_and(|o| o < c));
            }
            assert!(m.opened_at.is_none_or(|t| t <= birth));
        }
        // About 45% opened, and a third of those clicked; the same every run.
        let opened = messages.iter().filter(|m| m.opened_at.is_some()).count();
        let clicked = messages.iter().filter(|m| m.clicked_at.is_some()).count();
        assert!((80..=140).contains(&opened), "{opened}");
        assert!((15..=60).contains(&clicked), "{clicked}");
        assert_eq!(
            serde_json::to_string(&messages).unwrap(),
            serde_json::to_string(&seed_messages(&generate(42))).unwrap()
        );
    }

    #[test]
    fn every_seed_and_date_gives_240_messages_and_a_foldable_history() {
        for seed in [0u64, 1, 7, 42, 2_026, u64::MAX] {
            let g = generate(seed);
            assert_eq!(seed_messages(&g).len(), SEED_MESSAGES, "seed {seed}");
            let log = history_envelopes(&g, sandbox());
            let p = CrmProjection::from_log(&directory(&g), &log).unwrap();
            assert_eq!(p.cursor().events_applied as usize, log.len());
        }
    }
}
