//! The kitchen board, a projection of order events (docs/architecture.md, "Durable Object
//! topology": the `Kitchen` holds the board and fans out). It is never written by a command:
//! it copies state from the events the routing table sends it, so it can be dropped and rebuilt
//! from the orders' logs (ADR 0003, decision 4).
//!
//! Two rules keep it right under at-least-once delivery in any order (docs/architecture.md,
//! "Events and the outbox"):
//!
//! - **Idempotent.** A `seen` set of event ids makes a redelivery a no-op (ADR 0004, decision 3).
//! - **Ordered per stream, by `seq`.** The board keeps the highest `seq` it applied for each
//!   order, even after the card is gone, and ignores anything not newer. The Kitchen receives
//!   only some of an order's events, so a gap in `seq` is normal and is not waited for. The one
//!   exception is an order the board has never seen: until its `OrderPlaced` arrives there is no
//!   card to move, so a later event is refused with [`BoardError::UnknownOrder`] and the consumer
//!   retries it.
//!
//! The board also draws each day's bake list from the Schedule's events (docs/domain.md,
//! "Ubiquitous language": the production plan as the kitchen board shows it). Those need no
//! `seq` wait either: `BakeListChanged` carries the plan's `version`, and a higher one replaces
//! a lower; `SlotReserved` and `SlotReleased` keep, per day, which orders are reserved, each
//! ref's latest `seq` winning.
//!
//! Since PR 9 a delivery's card carries its van and stop number: `RoutePublished` from the
//! day's `Dispatch` labels every card of its plan (the highest `plan_v` a day has seen wins, so
//! a redelivered older plan changes nothing), and the order's own `OrderOutForDelivery {route,
//! stop}` sets the same pair when the van leaves.
//!
//! Protocol v1, the socket's frames, arrives with the Worker; [`Board::snapshot`] and
//! [`Board::bake_lists`] are what a joining socket is sent.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::aggregate::{DomainEvent, EventCodecError};
use crate::dispatch::{DispatchEvent, deliveries};
use crate::order::{Line, OrderEvent, OrderKind};
use crate::schedule::{PlanLine, ScheduleEvent};
use crate::{BakeryDate, BusinessTime, Envelope, Ulid};

/// Where a card sits on the board. A card leaves the board when its order is picked up,
/// delivered, cancelled or expired.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardState {
    /// Placed, not yet paid: shown so the kitchen sees what may be coming.
    Pending,
    Confirmed,
    InProduction,
    Ready,
    OutForDelivery,
}

/// One line as the kitchen reads it: what and how many, no prices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardLine {
    pub variant: String,
    pub qty: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Card {
    pub order: Ulid,
    pub state: CardState,
    pub lines: Vec<CardLine>,
    /// The order note. The Kitchen is the one subscriber that receives and stores it
    /// (docs/domain.md, "Free text and personal data").
    pub note: Option<String>,
    pub slot: BusinessTime,
    pub kind: OrderKind,
    /// The `seq` of the last event applied to this card.
    pub updated_seq: u64,
    /// The published plan's route for a delivery, `van-2`: from `RoutePublished`, then the
    /// order's `OrderOutForDelivery`. Absent before either, and for a pickup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub van: Option<String>,
    /// The delivery's stop number in that plan, counted from 1 across the vans.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<u16>,
}

/// One day's bake list as the board shows it: the Schedule's latest plan, and how many orders
/// are reserved that day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BakeList {
    pub date: BakeryDate,
    /// The plan's version; 0 until the day's first `BakeListChanged` arrives.
    pub version: u32,
    pub lines: Vec<PlanLine>,
    pub reserved: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Plan {
    version: u32,
    lines: Vec<PlanLine>,
}

/// Whether one ref is reserved on its day, as of the Schedule stream's `seq`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct SlotMark {
    seq: u64,
    reserved: bool,
}

/// What [`Board::apply`] did, so the Kitchen knows what to fan out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoardChange {
    /// A card was added or moved; send it.
    Upserted(Card),
    /// A card left the board; send its order id.
    Removed(Ulid),
    /// A day's bake list or reserved count changed; send it.
    BakeList(BakeList),
    /// A published plan labelled these cards with their vans and stops; send the event.
    Labelled(Vec<Card>),
    /// Nothing changed; send nothing.
    Unchanged(Ignored),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ignored {
    /// This event id was applied before.
    Duplicate,
    /// The board already holds a newer `seq` for this order.
    Stale,
    /// An event the board does not draw.
    NotForBoard,
}

/// Why an event could not be applied. The consumer retries, and after three tries the message
/// goes to the dead-letter queue (ADR 0004, decision 4).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum BoardError {
    /// A later event for an order whose `OrderPlaced` has not arrived yet; retry.
    #[error("no card for order {0} yet")]
    UnknownOrder(Ulid),
    /// An order event from a stream not named `order:...:<ulid>`.
    #[error("not an order stream: {0}")]
    BadStream(String),
    #[error(transparent)]
    Codec(#[from] EventCodecError),
}

/// The board: cards by order id, the highest `seq` per order, the event ids seen, and each
/// day's plan and reserved refs. The last two are new in PR 6, so a board stored before them
/// reads with both empty.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Board {
    cards: BTreeMap<Ulid, Card>,
    heads: BTreeMap<Ulid, u64>,
    seen: BTreeSet<Ulid>,
    #[serde(default)]
    plans: BTreeMap<BakeryDate, Plan>,
    #[serde(default)]
    slots: BTreeMap<BakeryDate, BTreeMap<Ulid, SlotMark>>,
    /// Each day's highest published `plan_v` the board has labelled its cards from (PR 9).
    #[serde(default)]
    routes: BTreeMap<BakeryDate, u16>,
}

impl Board {
    /// Applies one delivered envelope. An `Err` changes nothing and records nothing, so the
    /// retry is applied as if it were the first delivery.
    pub fn apply(&mut self, envelope: &Envelope) -> Result<BoardChange, BoardError> {
        if self.seen.contains(&envelope.id) {
            return Ok(BoardChange::Unchanged(Ignored::Duplicate));
        }
        if ScheduleEvent::NAMES.contains(&envelope.event_type.as_str()) {
            let change = self.apply_schedule(envelope)?;
            self.seen.insert(envelope.id);
            return Ok(change);
        }
        if envelope.event_type == "RoutePublished" {
            let change = self.apply_route(envelope)?;
            self.seen.insert(envelope.id);
            return Ok(change);
        }
        if !OrderEvent::NAMES.contains(&envelope.event_type.as_str()) {
            self.seen.insert(envelope.id);
            return Ok(BoardChange::Unchanged(Ignored::NotForBoard));
        }
        let event = OrderEvent::from_envelope(envelope)?;
        let order = order_of(&envelope.stream)?;
        let head = self.heads.get(&order).copied();
        if head.is_some_and(|h| envelope.seq <= h) {
            self.seen.insert(envelope.id);
            return Ok(BoardChange::Unchanged(Ignored::Stale));
        }
        let change = match event {
            OrderEvent::OrderPlaced {
                kind,
                slot,
                lines,
                note,
                ..
            } => {
                let card = Card {
                    order,
                    state: CardState::Pending,
                    lines: lines.iter().map(card_line).collect(),
                    note,
                    slot,
                    kind,
                    updated_seq: envelope.seq,
                    van: None,
                    stop: None,
                };
                self.cards.insert(order, card.clone());
                BoardChange::Upserted(card)
            }
            OrderEvent::OrderPaid { .. } => {
                self.move_card(order, head, envelope.seq, CardState::Confirmed)?
            }
            OrderEvent::OrderProductionStarted {} => {
                self.move_card(order, head, envelope.seq, CardState::InProduction)?
            }
            OrderEvent::OrderReady {} => {
                self.move_card(order, head, envelope.seq, CardState::Ready)?
            }
            OrderEvent::OrderOutForDelivery { route, stop } => {
                let change =
                    self.move_card(order, head, envelope.seq, CardState::OutForDelivery)?;
                match (change, self.cards.get_mut(&order)) {
                    (BoardChange::Upserted(_), Some(card)) => {
                        card.van = Some(route);
                        card.stop = Some(stop);
                        BoardChange::Upserted(card.clone())
                    }
                    (change, _) => change,
                }
            }
            OrderEvent::OrderPickedUp { .. }
            | OrderEvent::OrderDelivered { .. }
            | OrderEvent::OrderExpired { .. }
            | OrderEvent::OrderCancelled { .. } => {
                if head.is_none() {
                    return Err(BoardError::UnknownOrder(order));
                }
                match self.cards.remove(&order) {
                    Some(_) => BoardChange::Removed(order),
                    None => BoardChange::Unchanged(Ignored::Stale),
                }
            }
            // Money events: the catalog routes none of them to the Kitchen.
            OrderEvent::OrderPaymentLate { .. }
            | OrderEvent::OrderRefundRequested { .. }
            | OrderEvent::OrderRefunded { .. }
            | OrderEvent::OrderClosed { .. } => {
                self.seen.insert(envelope.id);
                return Ok(BoardChange::Unchanged(Ignored::NotForBoard));
            }
        };
        self.heads.insert(order, envelope.seq);
        self.seen.insert(envelope.id);
        Ok(change)
    }

    /// Every card, by slot and then order id: what a joining socket is sent.
    pub fn snapshot(&self) -> Vec<Card> {
        let mut cards: Vec<Card> = self.cards.values().cloned().collect();
        cards.sort_by_key(|c| (c.slot, c.order));
        cards
    }

    pub fn card(&self, order: Ulid) -> Option<&Card> {
        self.cards.get(&order)
    }

    /// Every day the board has heard of, by date: its plan and its reserved count. The Worker
    /// prunes days before today.
    pub fn bake_lists(&self) -> Vec<BakeList> {
        let dates: BTreeSet<BakeryDate> = self
            .plans
            .keys()
            .chain(self.slots.keys())
            .copied()
            .collect();
        dates.into_iter().map(|d| self.bake_list(d)).collect()
    }

    /// One day's bake list; empty, version 0, for a day the board has not heard of.
    pub fn bake_list(&self, date: BakeryDate) -> BakeList {
        let plan = self.plans.get(&date).cloned().unwrap_or_default();
        let reserved = self
            .slots
            .get(&date)
            .map_or(0, |refs| refs.values().filter(|m| m.reserved).count());
        BakeList {
            date,
            version: plan.version,
            lines: plan.lines,
            // A day holds far fewer than 4 billion orders.
            reserved: reserved as u32,
        }
    }

    /// Drops the bake lists, and the published plans' versions, of days before `today`.
    pub fn prune_before(&mut self, today: BakeryDate) {
        self.plans.retain(|d, _| *d >= today);
        self.slots.retain(|d, _| *d >= today);
        self.routes.retain(|d, _| *d >= today);
    }

    /// `RoutePublished`: each card of the plan gets its van and stop number. A plan no newer
    /// than the day's last one changes nothing; an order with no card (not yet placed here, or
    /// already gone) is skipped.
    fn apply_route(&mut self, envelope: &Envelope) -> Result<BoardChange, BoardError> {
        let DispatchEvent::RoutePublished {
            date, plan_v, vans, ..
        } = DispatchEvent::from_envelope(envelope)?
        else {
            return Ok(BoardChange::Unchanged(Ignored::NotForBoard));
        };
        if self.routes.get(&date).is_some_and(|v| plan_v <= *v) {
            return Ok(BoardChange::Unchanged(Ignored::Stale));
        }
        self.routes.insert(date, plan_v);
        let mut labelled = Vec::new();
        for (order, route, stop) in deliveries(&vans) {
            if let Some(card) = self.cards.get_mut(&order) {
                card.van = Some(route);
                card.stop = Some(stop);
                labelled.push(card.clone());
            }
        }
        if labelled.is_empty() {
            return Ok(BoardChange::Unchanged(Ignored::Stale));
        }
        Ok(BoardChange::Labelled(labelled))
    }

    fn apply_schedule(&mut self, envelope: &Envelope) -> Result<BoardChange, BoardError> {
        let stale = Ok(BoardChange::Unchanged(Ignored::Stale));
        match ScheduleEvent::from_envelope(envelope)? {
            ScheduleEvent::BakeListChanged {
                date,
                version,
                lines,
            } => {
                let plan = self.plans.entry(date).or_default();
                if version <= plan.version {
                    return stale;
                }
                *plan = Plan { version, lines };
                Ok(BoardChange::BakeList(self.bake_list(date)))
            }
            ScheduleEvent::SlotReserved {
                date, reference, ..
            } => self.mark(date, reference, envelope.seq, true),
            ScheduleEvent::SlotReleased {
                date, reference, ..
            } => self.mark(date, reference, envelope.seq, false),
            ScheduleEvent::SlotHeld { .. }
            | ScheduleEvent::SlotFulfilled { .. }
            | ScheduleEvent::CapacityChanged { .. }
            | ScheduleEvent::CapsRefreshed { .. } => {
                Ok(BoardChange::Unchanged(Ignored::NotForBoard))
            }
        }
    }

    fn mark(
        &mut self,
        date: BakeryDate,
        reference: Ulid,
        seq: u64,
        reserved: bool,
    ) -> Result<BoardChange, BoardError> {
        let refs = self.slots.entry(date).or_default();
        if refs.get(&reference).is_some_and(|m| seq <= m.seq) {
            return Ok(BoardChange::Unchanged(Ignored::Stale));
        }
        let was = refs.insert(reference, SlotMark { seq, reserved });
        if was.is_some_and(|m| m.reserved) == reserved {
            return Ok(BoardChange::Unchanged(Ignored::Stale));
        }
        Ok(BoardChange::BakeList(self.bake_list(date)))
    }

    fn move_card(
        &mut self,
        order: Ulid,
        head: Option<u64>,
        seq: u64,
        state: CardState,
    ) -> Result<BoardChange, BoardError> {
        if head.is_none() {
            return Err(BoardError::UnknownOrder(order));
        }
        Ok(match self.cards.get_mut(&order) {
            Some(card) => {
                card.state = state;
                card.updated_seq = seq;
                BoardChange::Upserted(card.clone())
            }
            // The card already left the board; a later event cannot bring it back.
            None => BoardChange::Unchanged(Ignored::Stale),
        })
    }
}

fn card_line(line: &Line) -> CardLine {
    CardLine {
        variant: line.variant.clone(),
        qty: line.qty,
    }
}

/// The order id is the stream name's last part: `order:<sandbox>:<ulid>` (docs/domain.md,
/// "Identifiers"), or `order:<ulid>` as the envelope example writes it.
fn order_of(stream: &str) -> Result<Ulid, BoardError> {
    let bad = || BoardError::BadStream(stream.chars().take(80).collect());
    if !stream.starts_with("order:") {
        return Err(bad());
    }
    stream
        .rsplit(':')
        .next()
        .ok_or_else(bad)?
        .parse()
        .map_err(|_| bad())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::order::CancelledBy;
    use crate::{Cents, WallTime};
    use proptest::prelude::*;

    fn ulid(n: u128) -> Ulid {
        Ulid::from_parts(1_793_000_000_000, n)
    }

    fn envelope(order: u128, seq: u64, event: &OrderEvent) -> Envelope {
        Envelope {
            v: 1,
            id: ulid(1_000 * order + u128::from(seq)),
            sandbox: ulid(7),
            stream: format!("order:{}:{}", ulid(7), ulid(order)),
            seq,
            event_type: event.name().to_owned(),
            at: "2026-11-07T08:00:00-07:00".parse().unwrap(),
            recorded_at: WallTime::from_unix_ms(1_793_000_000_000).unwrap(),
            data: event.to_data(),
            cause: None,
        }
    }

    fn placed(order: u128) -> OrderEvent {
        OrderEvent::OrderPlaced {
            order: ulid(order),
            customer: ulid(2),
            kind: OrderKind::Pickup,
            slot: format!("2026-11-07T{:02}:00:00-07:00", 8 + order % 6)
                .parse()
                .unwrap(),
            zone: None,
            lines: vec![Line {
                item: "fern-loaf".into(),
                variant: "fern-loaf/whole".into(),
                qty: 2,
                unit_cents: Cents(950),
            }],
            subtotal_cents: Cents(1_900),
            tax_cents: Cents(190),
            total_cents: Cents(2_090),
            note: Some("Slice it, please".into()),
            menu_version: 1,
            held_until: "2026-11-07T08:15:00-07:00".parse().unwrap(),
        }
    }

    fn paid() -> OrderEvent {
        OrderEvent::OrderPaid {
            payment: ulid(10),
            amount_cents: Cents(2_090),
        }
    }

    /// A pickup's whole stream as the Order writes it, with the money events the Kitchen does
    /// not draw.
    fn stream(order: u128) -> Vec<Envelope> {
        [
            placed(order),
            paid(),
            OrderEvent::OrderProductionStarted {},
            OrderEvent::OrderReady {},
            OrderEvent::OrderPickedUp { at_stop: None },
            OrderEvent::OrderClosed {
                total_cents: Cents(2_090),
                refunded_cents: Cents::ZERO,
                lines: None,
                customer: None,
                kind: None,
                slot: None,
                zone: None,
            },
        ]
        .iter()
        .enumerate()
        .map(|(i, e)| envelope(order, i as u64 + 1, e))
        .collect()
    }

    #[test]
    fn a_placed_order_is_a_pending_card_with_its_note() {
        let mut board = Board::default();
        let change = board.apply(&envelope(1, 1, &placed(1))).unwrap();
        let BoardChange::Upserted(card) = change else {
            panic!("{change:?}");
        };
        assert_eq!(card.state, CardState::Pending);
        assert_eq!(card.note.as_deref(), Some("Slice it, please"));
        assert_eq!(
            card.lines,
            [CardLine {
                variant: "fern-loaf/whole".into(),
                qty: 2
            }]
        );
        assert_eq!(board.snapshot(), [card]);
    }

    #[test]
    fn the_card_moves_then_clears() {
        let mut board = Board::default();
        let events = stream(1);
        let states: Vec<BoardChange> = events.iter().map(|e| board.apply(e).unwrap()).collect();
        assert!(matches!(&states[1], BoardChange::Upserted(c) if c.state == CardState::Confirmed));
        assert!(
            matches!(&states[3], BoardChange::Upserted(c) if c.state == CardState::Ready && c.updated_seq == 4)
        );
        assert_eq!(states[4], BoardChange::Removed(ulid(1)));
        assert_eq!(states[5], BoardChange::Unchanged(Ignored::NotForBoard));
        assert!(board.snapshot().is_empty());
    }

    #[test]
    fn a_redelivery_changes_nothing() {
        let mut board = Board::default();
        let e = envelope(1, 1, &placed(1));
        board.apply(&e).unwrap();
        assert_eq!(
            board.apply(&e).unwrap(),
            BoardChange::Unchanged(Ignored::Duplicate)
        );
    }

    #[test]
    fn an_older_seq_is_ignored() {
        let mut board = Board::default();
        let events = stream(1);
        board.apply(&events[0]).unwrap();
        board.apply(&events[3]).unwrap();
        assert_eq!(
            board.apply(&events[1]).unwrap(),
            BoardChange::Unchanged(Ignored::Stale)
        );
        assert_eq!(board.card(ulid(1)).unwrap().state, CardState::Ready);
    }

    #[test]
    fn an_event_before_its_order_placed_is_retried() {
        let mut board = Board::default();
        let events = stream(1);
        assert_eq!(
            board.apply(&events[1]),
            Err(BoardError::UnknownOrder(ulid(1)))
        );
        board.apply(&events[0]).unwrap();
        // The retry is not a duplicate: the refusal recorded nothing.
        assert!(matches!(
            board.apply(&events[1]).unwrap(),
            BoardChange::Upserted(_)
        ));
    }

    #[test]
    fn a_removed_card_does_not_come_back() {
        let mut board = Board::default();
        board.apply(&envelope(1, 1, &placed(1))).unwrap();
        board
            .apply(&envelope(
                1,
                2,
                &OrderEvent::OrderCancelled {
                    by: CancelledBy::Customer,
                },
            ))
            .unwrap();
        assert_eq!(
            board.apply(&envelope(1, 3, &paid())).unwrap(),
            BoardChange::Unchanged(Ignored::Stale)
        );
        assert!(board.snapshot().is_empty());
    }

    #[test]
    fn other_types_and_bad_streams() {
        let mut board = Board::default();
        let mut slot = envelope(1, 1, &placed(1));
        slot.event_type = "SandboxSeeded".into();
        assert_eq!(
            board.apply(&slot).unwrap(),
            BoardChange::Unchanged(Ignored::NotForBoard)
        );
        let mut bad = envelope(2, 1, &placed(2));
        bad.stream = "catalog:x".into();
        assert!(matches!(board.apply(&bad), Err(BoardError::BadStream(_))));
        let mut malformed = envelope(3, 1, &placed(3));
        malformed.data = serde_json::json!({ "order": 3 });
        assert!(matches!(board.apply(&malformed), Err(BoardError::Codec(_))));
    }

    #[test]
    fn the_snapshot_is_by_slot() {
        let mut board = Board::default();
        for order in [3, 1, 2] {
            board.apply(&envelope(order, 1, &placed(order))).unwrap();
        }
        let orders: Vec<Ulid> = board.snapshot().iter().map(|c| c.order).collect();
        assert_eq!(orders, [ulid(1), ulid(2), ulid(3)]);
    }

    fn day(text: &str) -> BakeryDate {
        text.parse().unwrap()
    }

    fn schedule_envelope(date: &str, seq: u64, event: &ScheduleEvent) -> Envelope {
        Envelope {
            v: 1,
            id: ulid(900_000 + u128::from(seq) + 1_000 * u128::from(day(date).d())),
            sandbox: ulid(7),
            stream: format!("schedule:{}:{date}", ulid(7)),
            seq,
            event_type: event.name().to_owned(),
            at: "2026-11-07T08:00:00-07:00".parse().unwrap(),
            recorded_at: WallTime::from_unix_ms(1_793_000_000_000).unwrap(),
            data: event.to_data(),
            cause: None,
        }
    }

    fn plan(date: &str, version: u32, qty: u32) -> ScheduleEvent {
        ScheduleEvent::BakeListChanged {
            date: day(date),
            version,
            lines: vec![PlanLine {
                item: "fern-loaf".into(),
                qty,
                start: format!("{date}T09:00:00-07:00").parse().unwrap(),
            }],
        }
    }

    fn slot(date: &str, order: u128, reserved: bool) -> ScheduleEvent {
        let (kind, date, start, reference) = (
            crate::schedule::HoldKind::Slot,
            day(date),
            format!("{date}T09:00:00-07:00").parse().unwrap(),
            ulid(order),
        );
        if reserved {
            ScheduleEvent::SlotReserved {
                kind,
                date,
                start,
                reference,
                revived: false,
            }
        } else {
            ScheduleEvent::SlotReleased {
                kind,
                date,
                start,
                reference,
                reason: crate::schedule::ReleaseReason::Cancelled,
            }
        }
    }

    #[test]
    fn a_higher_plan_version_replaces_a_lower_and_others_are_ignored() {
        let mut board = Board::default();
        let change = board
            .apply(&schedule_envelope(
                "2026-11-08",
                2,
                &plan("2026-11-08", 2, 5),
            ))
            .unwrap();
        let BoardChange::BakeList(list) = change else {
            panic!("{change:?}");
        };
        assert_eq!((list.version, list.lines[0].qty), (2, 5));
        // Version 1 arrives late, and version 2 again under another id: both ignored.
        assert_eq!(
            board
                .apply(&schedule_envelope(
                    "2026-11-08",
                    1,
                    &plan("2026-11-08", 1, 3)
                ))
                .unwrap(),
            BoardChange::Unchanged(Ignored::Stale)
        );
        assert_eq!(
            board
                .apply(&schedule_envelope(
                    "2026-11-08",
                    7,
                    &plan("2026-11-08", 2, 9)
                ))
                .unwrap(),
            BoardChange::Unchanged(Ignored::Stale)
        );
        board
            .apply(&schedule_envelope(
                "2026-11-08",
                3,
                &plan("2026-11-08", 3, 8),
            ))
            .unwrap();
        assert_eq!(board.bake_list(day("2026-11-08")).lines[0].qty, 8);
    }

    #[test]
    fn reserved_refs_are_counted_per_day_by_latest_seq() {
        let mut board = Board::default();
        let d = "2026-11-07";
        board
            .apply(&schedule_envelope(d, 1, &slot(d, 1, true)))
            .unwrap();
        board
            .apply(&schedule_envelope(d, 2, &slot(d, 2, true)))
            .unwrap();
        // Order 2's release arrives before an older, redelivered reservation of it.
        board
            .apply(&schedule_envelope(d, 5, &slot(d, 2, false)))
            .unwrap();
        assert_eq!(
            board
                .apply(&schedule_envelope(d, 4, &slot(d, 2, true)))
                .unwrap(),
            BoardChange::Unchanged(Ignored::Stale)
        );
        assert_eq!(board.bake_list(day(d)).reserved, 1);
        // A duplicate delivery is a duplicate.
        let again = schedule_envelope(d, 1, &slot(d, 1, true));
        assert_eq!(
            board.apply(&again).unwrap(),
            BoardChange::Unchanged(Ignored::Duplicate)
        );
        // A release of an order the board never saw reserved changes no count.
        assert_eq!(
            board
                .apply(&schedule_envelope(d, 6, &slot(d, 3, false)))
                .unwrap(),
            BoardChange::Unchanged(Ignored::Stale)
        );
    }

    #[test]
    fn bake_lists_are_by_date_and_prune() {
        let mut board = Board::default();
        board
            .apply(&schedule_envelope(
                "2026-11-10",
                1,
                &plan("2026-11-10", 1, 2),
            ))
            .unwrap();
        board
            .apply(&schedule_envelope(
                "2026-11-07",
                1,
                &slot("2026-11-07", 1, true),
            ))
            .unwrap();
        board
            .apply(&schedule_envelope(
                "2026-11-08",
                1,
                &plan("2026-11-08", 1, 4),
            ))
            .unwrap();
        let dates: Vec<String> = board
            .bake_lists()
            .iter()
            .map(|b| b.date.to_string())
            .collect();
        assert_eq!(dates, ["2026-11-07", "2026-11-08", "2026-11-10"]);
        assert_eq!(board.bake_lists()[0].version, 0);
        assert_eq!(board.bake_lists()[0].reserved, 1);
        board.prune_before(day("2026-11-08"));
        assert_eq!(board.bake_lists().len(), 2);
        // Schedule events the board does not draw, and the cards, are untouched.
        let held = ScheduleEvent::CapsRefreshed {
            menu_version: 2,
            caps: vec![],
        };
        assert_eq!(
            board
                .apply(&schedule_envelope("2026-11-08", 9, &held))
                .unwrap(),
            BoardChange::Unchanged(Ignored::NotForBoard)
        );
        assert!(board.snapshot().is_empty());
    }

    #[test]
    fn a_published_plan_labels_its_cards_with_vans_and_stops() {
        use crate::dispatch::{PlanSource, VanRoute};
        let mut board = Board::default();
        for o in [1, 2, 3] {
            board.apply(&envelope(o, 1, &placed(o))).unwrap();
        }
        let published = |id: u128, plan_v: u16, vans: Vec<VanRoute>| {
            let event = DispatchEvent::RoutePublished {
                date: "2026-11-07".parse().unwrap(),
                plan_v,
                source: PlanSource::Server,
                vans,
                minutes: 40,
                publish: ulid(90),
            };
            Envelope {
                v: 1,
                id: ulid(id),
                sandbox: ulid(7),
                stream: format!("dispatch:{}:2026-11-07", ulid(7)),
                seq: u64::from(plan_v) + 10,
                event_type: event.name().to_owned(),
                at: "2026-11-07T08:00:00-07:00".parse().unwrap(),
                recorded_at: WallTime::from_unix_ms(1_793_000_000_000).unwrap(),
                data: event.to_data(),
                cause: None,
            }
        };
        let plan = vec![
            VanRoute {
                van: 1,
                stops: vec![ulid(2)],
            },
            VanRoute {
                van: 2,
                stops: vec![ulid(1), ulid(9)],
            },
        ];
        let first = published(500, 2, plan);
        let BoardChange::Labelled(cards) = board.apply(&first).unwrap() else {
            panic!()
        };
        // Order 9 has no card, so two cards are labelled; order 3 is in no van.
        assert_eq!(cards.len(), 2);
        let label = |b: &Board, o| {
            let c = b.card(ulid(o)).unwrap();
            (c.van.clone(), c.stop)
        };
        assert_eq!(label(&board, 2), (Some("van-1".into()), Some(1)));
        assert_eq!(label(&board, 1), (Some("van-2".into()), Some(2)));
        assert_eq!(label(&board, 3), (None, None));
        assert_eq!(
            board.apply(&first).unwrap(),
            BoardChange::Unchanged(Ignored::Duplicate)
        );
        // An older plan, delivered late, changes nothing.
        let older = published(
            501,
            1,
            vec![VanRoute {
                van: 1,
                stops: vec![ulid(1), ulid(2)],
            }],
        );
        assert_eq!(
            board.apply(&older).unwrap(),
            BoardChange::Unchanged(Ignored::Stale)
        );
        assert_eq!(label(&board, 1), (Some("van-2".into()), Some(2)));
        // The order's own event sets the pair it left with.
        board.apply(&envelope(3, 2, &paid())).unwrap();
        board
            .apply(&envelope(3, 3, &OrderEvent::OrderProductionStarted {}))
            .unwrap();
        board
            .apply(&envelope(3, 4, &OrderEvent::OrderReady {}))
            .unwrap();
        let out = OrderEvent::OrderOutForDelivery {
            route: "van-1".into(),
            stop: 2,
        };
        let BoardChange::Upserted(card) = board.apply(&envelope(3, 5, &out)).unwrap() else {
            panic!()
        };
        assert_eq!(
            (card.state, card.van.as_deref(), card.stop),
            (CardState::OutForDelivery, Some("van-1"), Some(2))
        );
        // A label never shows on the wire as null: a card without one has no such keys.
        let text = serde_json::to_string(&board.card(ulid(2)).unwrap()).unwrap();
        assert!(text.contains(r#""van":"van-1","stop":1"#));
        let none = serde_json::to_value(Board::default()).unwrap();
        assert!(none.get("routes").is_some());
    }

    #[test]
    fn a_board_stored_before_bake_lists_still_reads() {
        let mut board = Board::default();
        board.apply(&envelope(1, 1, &placed(1))).unwrap();
        let mut v = serde_json::to_value(&board).unwrap();
        let o = v.as_object_mut().unwrap();
        o.remove("plans");
        o.remove("slots");
        o.remove("routes");
        let back: Board = serde_json::from_value(v).unwrap();
        assert_eq!(back, board);
    }

    proptest! {
        /// Delivered in any order, with duplicates, and with every refusal retried later, the
        /// board ends where in-order delivery leaves it.
        #[test]
        fn any_delivery_order_converges(
            cut in proptest::collection::vec(1usize..7, 3),
            order in proptest::collection::vec(any::<prop::sample::Index>(), 0..60),
        ) {
            // Three orders, each stopped part-way through its life.
            let all: Vec<Envelope> = (1..=3u128)
                .zip(&cut)
                .flat_map(|(o, &n)| stream(o).into_iter().take(n))
                .collect();
            let mut expected = Board::default();
            for e in &all {
                expected.apply(e).unwrap();
            }

            let mut queue: Vec<Envelope> = all.clone();
            // Duplicates, as at-least-once delivery may send.
            queue.extend(all.iter().step_by(2).cloned());
            let mut board = Board::default();
            let mut picks = order.into_iter();
            let mut guard = 0;
            while !queue.is_empty() {
                guard += 1;
                prop_assert!(guard < 10_000);
                let i = picks.next().map_or(0, |ix| ix.index(queue.len()));
                let e = queue.remove(i);
                if board.apply(&e).is_err() {
                    // Retried later, as the consumer does.
                    queue.push(e);
                }
            }
            prop_assert_eq!(board.snapshot(), expected.snapshot());
        }
    }
}
