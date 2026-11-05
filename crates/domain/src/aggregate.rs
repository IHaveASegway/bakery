//! The shape every aggregate shares (docs/domain.md, "Aggregates and their objects"): `decide`
//! turns a command and the current state into events or a rejection, and `evolve` folds one
//! event into the state. Both are pure. The object that hosts an aggregate stores the events,
//! and its state is the fold of them, so a state can always be rebuilt from the log.
//!
//! Time and the command's id arrive in a [`DecideContext`], so nothing here reads a clock or
//! draws an id.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use thiserror::Error;

use crate::{BusinessTime, Envelope, Ulid};

/// What `decide` may know besides the state and the command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecideContext {
    /// Business time when the command is decided, from the `Clock` port.
    pub now: BusinessTime,
    /// The command's id: its `Idempotency-Key`, and the `cause` of the events it emits.
    pub id: Ulid,
}

/// One consistency boundary: its state, the commands it takes and the events it emits.
pub trait Aggregate {
    type State;
    type Command;
    type Event: DomainEvent;
    type Error;

    /// The events `cmd` causes in `state`, or the rule it breaks. An empty list is a command
    /// that changes nothing, such as a repeat of one already applied.
    fn decide(
        state: &Self::State,
        cmd: &Self::Command,
        ctx: &DecideContext,
    ) -> Result<Vec<Self::Event>, Self::Error>;

    /// `state` after `event`. Total: the log holds only events `decide` emitted, so an event
    /// that does not fit its state cannot be read back, and one that somehow is leaves the
    /// state as it was rather than panicking inside an object.
    fn evolve(state: Self::State, event: &Self::Event) -> Self::State;
}

/// The state a log of events folds to, from the aggregate's empty state.
pub fn replay<'a, A>(events: impl IntoIterator<Item = &'a A::Event>) -> A::State
where
    A: Aggregate,
    A::State: Default,
    A::Event: 'a,
{
    replay_from::<A>(A::State::default(), events)
}

/// `state` after each of `events` in turn: a left fold of [`Aggregate::evolve`].
pub fn replay_from<'a, A>(
    state: A::State,
    events: impl IntoIterator<Item = &'a A::Event>,
) -> A::State
where
    A: Aggregate,
    A::Event: 'a,
{
    events.into_iter().fold(state, A::evolve)
}

/// What [`execute`] returns: the new state and the events to store.
pub type Executed<A> = (<A as Aggregate>::State, Vec<<A as Aggregate>::Event>);

/// `decide`, then `evolve` over what it emitted: the new state and the events to store. The
/// object commits both in one transaction (docs/architecture.md, "Events and the outbox").
pub fn execute<A>(
    state: A::State,
    cmd: &A::Command,
    ctx: &DecideContext,
) -> Result<Executed<A>, A::Error>
where
    A: Aggregate,
{
    let events = A::decide(&state, cmd, ctx)?;
    let state = replay_from::<A>(state, &events);
    Ok((state, events))
}

/// Why an event could not be written into, or read out of, an envelope's `type` and `data`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EventCodecError {
    /// The type is not one this event family knows; a tolerant reader skips it.
    #[error("unknown event type {0}")]
    UnknownType(String),
    /// The type is known and the data does not fit it.
    #[error("malformed {event_type} data: {reason}")]
    Malformed { event_type: String, reason: String },
}

/// An event family, serialized as the catalog writes it (docs/domain.md, "The event catalog"):
/// its name goes in the envelope's `type` and its fields, an object, in `data`.
///
/// Implementors derive serde with `#[serde(tag = "type", content = "data")]` and give every
/// variant named fields (`{}` for none), so the provided methods can split and join the two.
pub trait DomainEvent: Serialize + DeserializeOwned {
    /// Every name in the family, in catalog order; the routing table is checked against it.
    const NAMES: &'static [&'static str];

    /// The catalog's name for this event, such as `OrderPlaced`.
    fn name(&self) -> &'static str;

    /// The envelope's `data`: this event's fields as a JSON object.
    fn to_data(&self) -> Value {
        match serde_json::to_value(self) {
            Ok(Value::Object(mut tagged)) => tagged
                .remove("data")
                .unwrap_or_else(|| Value::Object(Map::new())),
            // Every implementor is an adjacently tagged enum of structs, which serializes to
            // an object; an empty object stands in should one ever not.
            _ => Value::Object(Map::new()),
        }
    }

    /// The event an envelope's `type` and `data` describe.
    fn from_parts(event_type: &str, data: &Value) -> Result<Self, EventCodecError> {
        if !Self::NAMES.contains(&event_type) {
            return Err(EventCodecError::UnknownType(event_type.to_owned()));
        }
        let mut tagged = Map::new();
        tagged.insert("type".to_owned(), Value::String(event_type.to_owned()));
        tagged.insert("data".to_owned(), data.clone());
        serde_json::from_value(Value::Object(tagged)).map_err(|e| EventCodecError::Malformed {
            event_type: event_type.to_owned(),
            reason: e.to_string(),
        })
    }

    /// The event an envelope carries.
    fn from_envelope(envelope: &Envelope) -> Result<Self, EventCodecError> {
        Self::from_parts(&envelope.event_type, &envelope.data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use serde::Deserialize;

    // A counter small enough to see the fold in: Add n, or Reset.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "type", content = "data")]
    enum Tally {
        Added { n: i64 },
        Reset {},
    }

    impl DomainEvent for Tally {
        const NAMES: &'static [&'static str] = &["Added", "Reset"];
        fn name(&self) -> &'static str {
            match self {
                Tally::Added { .. } => "Added",
                Tally::Reset {} => "Reset",
            }
        }
    }

    struct Counter;

    impl Aggregate for Counter {
        type State = i64;
        type Command = i64;
        type Event = Tally;
        type Error = ();

        fn decide(_: &i64, cmd: &i64, _: &DecideContext) -> Result<Vec<Tally>, ()> {
            match *cmd {
                0 => Ok(vec![Tally::Reset {}]),
                n if n > 0 => Ok(vec![Tally::Added { n }]),
                _ => Err(()),
            }
        }

        fn evolve(state: i64, event: &Tally) -> i64 {
            match event {
                Tally::Added { n } => state + n,
                Tally::Reset {} => 0,
            }
        }
    }

    fn ctx() -> DecideContext {
        DecideContext {
            now: "2026-11-07T09:00:00-07:00".parse().unwrap(),
            id: Ulid::from_parts(1, 1),
        }
    }

    #[test]
    fn execute_decides_then_folds() {
        assert_eq!(
            execute::<Counter>(5, &3, &ctx()),
            Ok((8, vec![Tally::Added { n: 3 }]))
        );
        assert_eq!(execute::<Counter>(5, &-1, &ctx()), Err(()));
    }

    #[test]
    fn data_is_an_object_even_for_an_event_with_no_fields() {
        assert_eq!(Tally::Reset {}.to_data(), serde_json::json!({}));
        assert_eq!(
            Tally::Added { n: 2 }.to_data(),
            serde_json::json!({ "n": 2 })
        );
        assert_eq!(
            Tally::from_parts("Reset", &serde_json::json!({})),
            Ok(Tally::Reset {})
        );
    }

    #[test]
    fn unknown_and_malformed_events_are_told_apart() {
        assert_eq!(
            Tally::from_parts("Subtracted", &serde_json::json!({})),
            Err(EventCodecError::UnknownType("Subtracted".into()))
        );
        assert!(matches!(
            Tally::from_parts("Added", &serde_json::json!({ "n": "two" })),
            Err(EventCodecError::Malformed { .. })
        ));
    }

    fn tally() -> impl Strategy<Value = Tally> {
        prop_oneof![
            (-100i64..100).prop_map(|n| Tally::Added { n }),
            Just(Tally::Reset {}),
        ]
    }

    proptest! {
        #[test]
        fn replay_is_a_left_fold(
            a in proptest::collection::vec(tally(), 0..20),
            b in proptest::collection::vec(tally(), 0..20),
        ) {
            let all: Vec<Tally> = a.iter().chain(&b).cloned().collect();
            let whole = replay::<Counter>(&all);
            let split = replay_from::<Counter>(replay::<Counter>(&a), &b);
            prop_assert_eq!(whole, split);
            let by_hand = all.iter().fold(0, Counter::evolve);
            prop_assert_eq!(whole, by_hand);
        }
    }
}
