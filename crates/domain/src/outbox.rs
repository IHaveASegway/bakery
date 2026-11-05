//! The write side every aggregate object shares (docs/architecture.md, "Events and the outbox"):
//! the envelopes for the events `decide` returned, the outbox rows that copy them, and the rule
//! for a command whose key was seen before.
//!
//! The object commits all three in one transaction with the new state, so a crash cannot leave
//! an event without its outbox row or a command key without its events
//! (ADR 0003, decision 3).

use thiserror::Error;

use crate::aggregate::DomainEvent;
use crate::{BusinessTime, ENVELOPE_VERSION, Envelope, Ulid, WallTime};

/// The stream an object writes, as it stands before the new events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamHead {
    pub sandbox: Ulid,
    /// The object's name, such as `order:<sandbox>:<ulid>`.
    pub stream: String,
    /// The last `seq` written, 0 for an empty stream.
    pub last_seq: u64,
}

/// What every envelope of one command shares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    /// Business time, the `DecideContext`'s `now`.
    pub at: BusinessTime,
    /// Wall time, from the `Clock` port.
    pub recorded_at: WallTime,
    /// The command id, the causing event's id for a reaction, or `sim:<ulid>` for a command the
    /// `Simulator` issued (docs/domain.md, "The envelope").
    pub cause: Option<String>,
}

/// Why envelopes could not be built.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OutboxError {
    /// The stream's `seq` would pass `u64::MAX`.
    #[error("seq overflow on {0}")]
    SeqOverflow(String),
    #[error("envelope could not be written: {0}")]
    Serialize(String),
}

/// The envelopes for `events`, numbered gap-free from the stream's last `seq`. Each event's id
/// comes from `next_id`, which the object wires to the `IdGen` port; nothing here draws one.
pub fn envelopes<E: DomainEvent>(
    head: &StreamHead,
    stamp: &Stamp,
    events: &[E],
    mut next_id: impl FnMut() -> Ulid,
) -> Result<Vec<Envelope>, OutboxError> {
    let mut seq = head.last_seq;
    events
        .iter()
        .map(|event| {
            seq = seq
                .checked_add(1)
                .ok_or_else(|| OutboxError::SeqOverflow(head.stream.clone()))?;
            Ok(Envelope {
                v: ENVELOPE_VERSION,
                id: next_id(),
                sandbox: head.sandbox,
                stream: head.stream.clone(),
                seq,
                event_type: event.name().to_owned(),
                at: stamp.at,
                recorded_at: stamp.recorded_at,
                data: event.to_data(),
                cause: stamp.cause.clone(),
            })
        })
        .collect()
}

/// One row of the `outbox` table: the envelope's `seq` and its JSON text. The envelope travels
/// as a string, not a `serde_json::Value`, because spike S6 found on 2026-11-04 that `worker`
/// 0.8.7 sends a `Value` map to the Queue as `{}` (docs/architecture.md, "Events and the
/// outbox", Relay).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxRow {
    pub seq: u64,
    pub envelope: String,
}

/// The outbox rows that copy `envelopes`, in order.
pub fn outbox_rows(envelopes: &[Envelope]) -> Result<Vec<OutboxRow>, OutboxError> {
    envelopes
        .iter()
        .map(|e| {
            Ok(OutboxRow {
                seq: e.seq,
                envelope: serde_json::to_string(e)
                    .map_err(|err| OutboxError::Serialize(err.to_string()))?,
            })
        })
        .collect()
}

/// A row of `commands_seen`: the hash of the request body the key first came with, and the
/// result that was answered (docs/domain.md, "Idempotency", the HTTP command row).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeenCommand {
    pub body_hash: String,
    pub result: String,
}

/// What to do with a command, given its key's row in `commands_seen`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandCheck<'a> {
    /// A key not seen before: decide it.
    Fresh,
    /// The same key with the same body: answer the stored result again, with
    /// `Idempotent-Replayed: true`, and append nothing.
    Replay(&'a str),
}

/// The same key came with a different body: a 422 problem, and nothing is decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("the Idempotency-Key was used with a different request")]
pub struct KeyReused;

/// The `commands_seen` rule. `body_hash` is the caller's digest of the request body; this
/// crate computes none.
pub fn check_command<'a>(
    seen: Option<&'a SeenCommand>,
    body_hash: &str,
) -> Result<CommandCheck<'a>, KeyReused> {
    match seen {
        None => Ok(CommandCheck::Fresh),
        Some(row) if row.body_hash == body_hash => Ok(CommandCheck::Replay(&row.result)),
        Some(_) => Err(KeyReused),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Cents;
    use crate::aggregate::DomainEvent;
    use crate::catalog::{CatalogEvent, ItemFields};
    use crate::order::{CancelledBy, Line, OrderEvent, OrderKind, RefundReason};
    use proptest::prelude::*;

    fn ulid(n: u128) -> Ulid {
        Ulid::from_parts(1_793_819_530_318, n)
    }

    fn head(last_seq: u64) -> StreamHead {
        StreamHead {
            sandbox: ulid(1),
            stream: format!("order:{}:{}", ulid(1), ulid(2)),
            last_seq,
        }
    }

    fn stamp() -> Stamp {
        Stamp {
            at: "2026-11-07T12:12:10-07:00".parse().unwrap(),
            recorded_at: "2026-11-04T19:12:10.318Z".parse().unwrap(),
            cause: Some(ulid(3).to_string()),
        }
    }

    fn ids() -> impl FnMut() -> Ulid {
        let mut n = 100;
        move || {
            n += 1;
            ulid(n)
        }
    }

    /// One of every Order event, with the catalog's data fields.
    fn every_order_event() -> Vec<OrderEvent> {
        let line = Line {
            item: "fern-loaf".into(),
            variant: "fern-loaf/whole".into(),
            qty: 2,
            unit_cents: Cents(950),
        };
        let t = "2026-11-07T09:00:00-07:00".parse().unwrap();
        vec![
            OrderEvent::OrderPlaced {
                order: ulid(2),
                customer: ulid(4),
                kind: OrderKind::Delivery,
                slot: t,
                zone: Some("z1".into()),
                lines: vec![line.clone()],
                subtotal_cents: Cents(1_900),
                tax_cents: Cents(190),
                total_cents: Cents(2_090),
                note: Some("Leave at the side door".into()),
                menu_version: 3,
                held_until: t,
            },
            OrderEvent::OrderPaid {
                payment: ulid(5),
                amount_cents: Cents(2_090),
            },
            OrderEvent::OrderPaymentLate {
                payment: ulid(5),
                amount_cents: Cents(2_090),
            },
            OrderEvent::OrderRefundRequested {
                payment: ulid(5),
                amount_cents: Cents(500),
                reason: RefundReason::MissingItem,
            },
            OrderEvent::OrderExpired { held_until: t },
            OrderEvent::OrderCancelled {
                by: CancelledBy::Customer,
            },
            OrderEvent::OrderProductionStarted {},
            OrderEvent::OrderReady {},
            OrderEvent::OrderOutForDelivery {
                route: "van-1".into(),
                stop: 4,
            },
            OrderEvent::OrderPickedUp { at_stop: None },
            OrderEvent::OrderDelivered { at_stop: Some(4) },
            OrderEvent::OrderRefunded {
                refund: ulid(6),
                amount_cents: Cents(500),
                full: false,
            },
            OrderEvent::OrderClosed {
                total_cents: Cents(2_090),
                refunded_cents: Cents(500),
                lines: None,
                customer: None,
                kind: None,
                slot: None,
                zone: None,
            },
            OrderEvent::OrderClosed {
                total_cents: Cents(2_090),
                refunded_cents: Cents::ZERO,
                lines: Some(vec![line]),
                customer: None,
                kind: None,
                slot: None,
                zone: None,
            },
        ]
    }

    fn round_trip<E: DomainEvent + PartialEq + std::fmt::Debug>(events: &[E]) {
        let built = envelopes(&head(0), &stamp(), events, ids()).unwrap();
        let rows = outbox_rows(&built).unwrap();
        for ((event, envelope), row) in events.iter().zip(&built).zip(&rows) {
            let read: Envelope = serde_json::from_str(&row.envelope).unwrap();
            assert_eq!(&read, envelope);
            assert_eq!(read.event_type, event.name());
            assert!(read.data.is_object(), "{}", row.envelope);
            assert_eq!(&E::from_envelope(&read).unwrap(), event);
        }
    }

    #[test]
    fn every_order_event_round_trips_through_an_envelope() {
        let events = every_order_event();
        let names: std::collections::BTreeSet<&str> =
            events.iter().map(DomainEvent::name).collect();
        assert_eq!(names.len(), OrderEvent::NAMES.len());
        round_trip(&events);
    }

    #[test]
    fn every_catalog_event_round_trips_through_an_envelope() {
        round_trip(&[
            CatalogEvent::MenuItemChanged {
                item: "fern-loaf".into(),
                fields: ItemFields {
                    daily_cap: Some(30),
                    season: Some(None),
                    ..ItemFields::default()
                },
            },
            CatalogEvent::MenuPublished {
                version: 2,
                items: 24,
                item: None,
            },
            CatalogEvent::MenuPublished {
                version: 3,
                items: 23,
                item: Some("fern-loaf".into()),
            },
        ]);
    }

    #[test]
    fn data_fields_are_named_as_the_catalog_names_them() {
        let data = every_order_event()[0].to_data();
        let keys: Vec<&str> = data
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        for key in [
            "order",
            "customer",
            "kind",
            "slot",
            "zone",
            "lines",
            "subtotal_cents",
            "tax_cents",
            "total_cents",
            "note",
        ] {
            assert!(keys.contains(&key), "{key} in {keys:?}");
        }
        assert_eq!(data["kind"], "delivery");
        assert_eq!(data["lines"][0]["unit_cents"], 950);
        assert_eq!(OrderEvent::OrderReady {}.to_data(), serde_json::json!({}));
        assert_eq!(
            every_order_event()[1].to_data(),
            serde_json::json!({ "payment": ulid(5).to_string(), "amount_cents": 2090 })
        );
        // A history close carries its lines; a live one leaves the key out.
        assert!(every_order_event()[12].to_data().get("lines").is_none());
    }

    #[test]
    fn envelopes_continue_the_stream() {
        let events = [
            OrderEvent::OrderReady {},
            OrderEvent::OrderPickedUp { at_stop: None },
        ];
        let built = envelopes(&head(4), &stamp(), &events, ids()).unwrap();
        assert_eq!(built.iter().map(|e| e.seq).collect::<Vec<_>>(), [5, 6]);
        assert_eq!(
            built[0].cause.as_deref(),
            Some(ulid(3).to_string().as_str())
        );
        assert_eq!(built[0].at.to_string(), "2026-11-07T12:12:10-07:00");
        assert_ne!(built[0].id, built[1].id);
        assert_eq!(
            envelopes(&head(u64::MAX), &stamp(), &events, ids()),
            Err(OutboxError::SeqOverflow(head(0).stream))
        );
    }

    #[test]
    fn a_seen_key_replays_and_a_reused_key_is_refused() {
        let row = SeenCommand {
            body_hash: "ab12".into(),
            result: "{\"order\":\"x\"}".into(),
        };
        assert_eq!(check_command(None, "ab12"), Ok(CommandCheck::Fresh));
        assert_eq!(
            check_command(Some(&row), "ab12"),
            Ok(CommandCheck::Replay("{\"order\":\"x\"}"))
        );
        assert_eq!(check_command(Some(&row), "cd34"), Err(KeyReused));
    }

    proptest! {
        #[test]
        fn seqs_are_gap_free_from_the_last(last in 0u64..1_000_000, n in 0usize..30) {
            let events = vec![OrderEvent::OrderReady {}; n];
            let built = envelopes(&head(last), &stamp(), &events, ids()).unwrap();
            prop_assert_eq!(built.len(), n);
            for (i, e) in built.iter().enumerate() {
                prop_assert_eq!(e.seq, last + 1 + i as u64);
            }
            let rows = outbox_rows(&built).unwrap();
            prop_assert!(rows.iter().zip(&built).all(|(r, e)| r.seq == e.seq));
        }
    }
}
