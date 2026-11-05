//! Stripe's request bodies: `application/x-www-form-urlencoded`, with nested fields in bracket
//! notation, `metadata[sandbox]=...` (https://docs.stripe.com/api).
//!
//! Values are percent-encoded outside RFC 3986's unreserved set. Key segments are encoded the
//! same way and the brackets between them are left as they are, as Stripe's own examples write
//! them; every key is a constant of this module's callers.

use crate::auth::percent_encode;

/// A form body under construction, its pairs in the order they were added.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Form {
    pairs: Vec<(String, String)>,
}

impl Form {
    pub fn new() -> Form {
        Form::default()
    }

    /// `key=value`.
    pub fn field(self, key: &str, value: impl AsRef<str>) -> Form {
        self.nested(&[key], value)
    }

    /// `a[b][c]=value` for the path `["a", "b", "c"]`. An empty path adds nothing.
    pub fn nested(mut self, path: &[&str], value: impl AsRef<str>) -> Form {
        let Some((first, rest)) = path.split_first() else {
            return self;
        };
        let mut key = percent_encode(first);
        for segment in rest {
            key.push('[');
            key.push_str(&percent_encode(segment));
            key.push(']');
        }
        self.pairs.push((key, percent_encode(value.as_ref())));
        self
    }

    /// The body: `k1=v1&k2=v2`.
    pub fn encode(&self) -> String {
        self.pairs
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("&")
    }

    /// The keys, in order: what a log or a test may show of a body.
    pub fn keys(&self) -> Vec<&str> {
        self.pairs.iter().map(|(k, _)| k.as_str()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brackets_and_percent_encoding_byte_exact() {
        let body = Form::new()
            .field("amount", "2090")
            .field("currency", "usd")
            .nested(&["automatic_payment_methods", "enabled"], "true")
            .nested(&["metadata", "sandbox"], "01JC8YV2D4QK7S1M9E3PZ6W8AN")
            .nested(&["metadata", "note"], "a b&c=d+e/é")
            .nested(&["a", "b", "c"], "deep")
            .nested(&[], "ignored")
            .encode();
        assert_eq!(
            body,
            "amount=2090&currency=usd&automatic_payment_methods[enabled]=true\
             &metadata[sandbox]=01JC8YV2D4QK7S1M9E3PZ6W8AN\
             &metadata[note]=a%20b%26c%3Dd%2Be%2F%C3%A9&a[b][c]=deep"
        );
    }

    #[test]
    fn key_segments_are_encoded_too() {
        let form = Form::new().nested(&["metadata", "a b"], "1");
        assert_eq!(form.encode(), "metadata[a%20b]=1");
        assert_eq!(form.keys(), ["metadata[a%20b]"]);
        assert_eq!(Form::new().encode(), "");
    }
}
