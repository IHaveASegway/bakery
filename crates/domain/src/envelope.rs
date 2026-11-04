//! The event envelope (docs/domain.md, "The envelope"): one shape in each object's `events` and
//! `outbox` tables and on the Queue.

use serde::{Deserialize, Serialize};

use crate::{BusinessTime, Ulid, WallTime};

/// Adding an optional field stays version 1; renaming or redefining anything is version 2.
pub const ENVELOPE_VERSION: u8 = 1;

/// Fields are declared in the order the docs write them, which is the order serde writes them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u8,
    /// The event's ULID, and the key of every `seen` table.
    pub id: Ulid,
    pub sandbox: Ulid,
    /// The producing object's name, such as `order:<ulid>`.
    pub stream: String,
    /// Gap-free within the stream, because one object writes each stream.
    pub seq: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    /// Business time.
    pub at: BusinessTime,
    /// Wall time.
    pub recorded_at: WallTime,
    pub data: serde_json::Value,
    /// The command id, or for a reaction the id of the event that caused it; `sim:<ulid>` for a
    /// command the `Simulator` issued. A string, not a `Ulid`, for that prefix.
    pub cause: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    // The example in docs/domain.md, "The envelope", verbatim.
    const DOCS_EXAMPLE: &str = r#"{
  "v": 1,
  "id": "01JC8Z6K3W9QF2N4T7XRB5M0HD",
  "sandbox": "01JC8YV2D4QK7S1M9E3PZ6W8AN",
  "stream": "order:01JC8Z5R0T2B6Y8C4V1N3K7QXE",
  "seq": 2,
  "type": "OrderPaid",
  "at": "2026-11-07T12:12:10-07:00",
  "recorded_at": "2026-11-04T19:12:10.318Z",
  "data": { "payment": "01JC8Z6F1A5H3D7K9M2P4R6T8V", "amount_cents": 1870 },
  "cause": "01JC8Z6F0WQ3E5R7T9Y1V3K5P7"
}"#;

    #[test]
    fn reads_the_docs_example_field_for_field() {
        let e: Envelope = serde_json::from_str(DOCS_EXAMPLE).unwrap();
        assert_eq!(e.v, ENVELOPE_VERSION);
        assert_eq!(e.id.to_string(), "01JC8Z6K3W9QF2N4T7XRB5M0HD");
        assert_eq!(e.sandbox.to_string(), "01JC8YV2D4QK7S1M9E3PZ6W8AN");
        assert_eq!(e.stream, "order:01JC8Z5R0T2B6Y8C4V1N3K7QXE");
        assert_eq!(e.seq, 2);
        assert_eq!(e.event_type, "OrderPaid");
        assert_eq!(e.at.to_string(), "2026-11-07T12:12:10-07:00");
        assert_eq!(e.recorded_at.to_string(), "2026-11-04T19:12:10.318Z");
        assert_eq!(
            e.data,
            json!({ "payment": "01JC8Z6F1A5H3D7K9M2P4R6T8V", "amount_cents": 1870 })
        );
        assert_eq!(e.cause.as_deref(), Some("01JC8Z6F0WQ3E5R7T9Y1V3K5P7"));
    }

    #[test]
    fn writes_the_docs_example_back() {
        let e: Envelope = serde_json::from_str(DOCS_EXAMPLE).unwrap();
        let written = serde_json::to_string(&e).unwrap();

        // Same fields with the same values...
        let expected: Value = serde_json::from_str(DOCS_EXAMPLE).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&written).unwrap(), expected);

        // ...in the docs' order, with `event_type` on the wire as `type`.
        let order = [
            "\"v\"",
            "\"id\"",
            "\"sandbox\"",
            "\"stream\"",
            "\"seq\"",
            "\"type\"",
            "\"at\"",
            "\"recorded_at\"",
            "\"data\"",
            "\"cause\"",
        ];
        let positions: Vec<usize> = order.iter().map(|k| written.find(k).unwrap()).collect();
        assert!(positions.windows(2).all(|w| w[0] < w[1]), "{written}");

        // And a second trip changes nothing.
        let again: Envelope = serde_json::from_str(&written).unwrap();
        assert_eq!(again, e);
    }

    #[test]
    fn cause_may_be_null_or_a_simulator_command() {
        let mut v: Value = serde_json::from_str(DOCS_EXAMPLE).unwrap();
        v["cause"] = Value::Null;
        let e: Envelope = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(e.cause, None);
        v["cause"] = json!("sim:01JC8Z6F0WQ3E5R7T9Y1V3K5P7");
        let e: Envelope = serde_json::from_value(v).unwrap();
        assert_eq!(e.cause.as_deref(), Some("sim:01JC8Z6F0WQ3E5R7T9Y1V3K5P7"));
    }

    #[test]
    fn refuses_a_malformed_id() {
        let mut v: Value = serde_json::from_str(DOCS_EXAMPLE).unwrap();
        v["id"] = json!("not-a-ulid");
        assert!(serde_json::from_value::<Envelope>(v).is_err());
    }
}
