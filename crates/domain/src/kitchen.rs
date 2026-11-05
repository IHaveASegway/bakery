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
//! Protocol v1, the socket's frames, arrives with the Worker; [`Board::snapshot`] is what a
//! joining socket is sent.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::aggregate::{DomainEvent, EventCodecError};
use crate::order::{Line, OrderEvent, OrderKind};
use crate::{BusinessTime, Envelope, Ulid};

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
}

/// What [`Board::apply`] did, so the Kitchen knows what to fan out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoardChange {
    /// A card was added or moved; send it.
    Upserted(Card),
    /// A card left the board; send its order id.
    Removed(Ulid),
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

/// The board: cards by order id, the highest `seq` per order, and the event ids seen.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Board {
    cards: BTreeMap<Ulid, Card>,
    heads: BTreeMap<Ulid, u64>,
    seen: BTreeSet<Ulid>,
}

impl Board {
    /// Applies one delivered envelope. An `Err` changes nothing and records nothing, so the
    /// retry is applied as if it were the first delivery.
    pub fn apply(&mut self, envelope: &Envelope) -> Result<BoardChange, BoardError> {
        if self.seen.contains(&envelope.id) {
            return Ok(BoardChange::Unchanged(Ignored::Duplicate));
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
            OrderEvent::OrderOutForDelivery { .. } => {
                self.move_card(order, head, envelope.seq, CardState::OutForDelivery)?
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
        slot.event_type = "SlotReserved".into();
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
