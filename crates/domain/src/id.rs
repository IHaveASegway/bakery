//! ULIDs for aggregates, events and commands (docs/domain.md, "Identifiers").
//!
//! A small value type rather than the `ulid` crate: that crate pulls `web-time`, and with it
//! `wasm-bindgen`, into any build for `wasm32`, and this crate depends on no platform crate. The
//! random part comes from the caller, the Worker's `random::ulid` or a test's counter, so
//! nothing here draws randomness.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::DomainError;

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LEN: usize = 26;
const RANDOM_BITS: u32 = 80;
const MAX_MS: u64 = (1 << 48) - 1;

/// 128 bits: 48 of Unix milliseconds, then 80 random. Sorts by creation time.
///
/// The text form is canonical: 26 characters of upper-case Crockford base32. Parsing accepts
/// only that form, so a ULID always serializes back to the bytes it was read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Ulid(u128);

impl Ulid {
    /// Builds a ULID from its time and random parts. Bits above 48 and 80 are dropped.
    pub fn from_parts(unix_ms: u64, random: u128) -> Ulid {
        let time = u128::from(unix_ms & MAX_MS) << RANDOM_BITS;
        let random = random & ((1u128 << RANDOM_BITS) - 1);
        Ulid(time | random)
    }

    /// The Unix milliseconds in the time part.
    pub fn unix_ms(self) -> u64 {
        // The shifted value has at most 48 bits, so it fits.
        (self.0 >> RANDOM_BITS) as u64
    }

    pub fn as_u128(self) -> u128 {
        self.0
    }
}

impl fmt::Display for Ulid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut out = [0u8; LEN];
        let mut value = self.0;
        for slot in out.iter_mut().rev() {
            *slot = ALPHABET[(value & 0x1f) as usize];
            value >>= 5;
        }
        // Every byte is from ALPHABET, so this is ASCII.
        f.write_str(std::str::from_utf8(&out).map_err(|_| fmt::Error)?)
    }
}

impl FromStr for Ulid {
    type Err = DomainError;

    fn from_str(s: &str) -> Result<Ulid, DomainError> {
        let invalid = || DomainError::InvalidUlid(s.chars().take(LEN + 4).collect());
        let bytes = s.as_bytes();
        // 26 characters hold 130 bits; the first may use only 3 of its 5.
        if bytes.len() != LEN || bytes[0] > b'7' {
            return Err(invalid());
        }
        let mut value: u128 = 0;
        for &b in bytes {
            let digit = ALPHABET.iter().position(|&a| a == b).ok_or_else(invalid)?;
            value = (value << 5) | digit as u128;
        }
        Ok(Ulid(value))
    }
}

impl Serialize for Ulid {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Ulid {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Ulid, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn parses_and_prints_the_docs_example() {
        let text = "01JC8Z6K3W9QF2N4T7XRB5M0HD";
        let id: Ulid = text.parse().unwrap();
        assert_eq!(id.to_string(), text);
    }

    #[test]
    fn time_part_round_trips() {
        let id = Ulid::from_parts(1_793_819_530_318, 42);
        assert_eq!(id.unix_ms(), 1_793_819_530_318);
        assert_eq!(id.as_u128() & 0xff, 42);
    }

    #[test]
    fn sorts_by_time() {
        let early = Ulid::from_parts(1_000, u128::MAX);
        let late = Ulid::from_parts(1_001, 0);
        assert!(early < late);
        assert!(early.to_string() < late.to_string());
    }

    #[test]
    fn refuses_non_canonical_text() {
        for bad in [
            "",
            "01JC8Z6K3W9QF2N4T7XRB5M0H",   // 25 characters
            "01JC8Z6K3W9QF2N4T7XRB5M0HDX", // 27
            "01jc8z6k3w9qf2n4t7xrb5m0hd",  // lower case
            "01JC8Z6K3W9QF2N4T7XRB5M0HI",  // I is not in the alphabet
            "81JC8Z6K3W9QF2N4T7XRB5M0HD",  // more than 128 bits
        ] {
            assert!(bad.parse::<Ulid>().is_err(), "{bad}");
        }
    }

    proptest! {
        #[test]
        fn text_round_trips(raw in any::<u128>()) {
            let id = Ulid(raw);
            prop_assert_eq!(id.to_string().parse::<Ulid>(), Ok(id));
        }
    }
}
