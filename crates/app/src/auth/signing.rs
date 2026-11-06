//! HMAC-SHA256 signing for the two cookies and the API token (docs/security.md, "The session
//! cookie", "The API token").
//!
//! A token is `<base64url(payload JSON)>.<base64url(MAC)>`. The payload holds identifiers and
//! no secret, so it is signed and left unencrypted. Verification tries `SESSION_HMAC_KEY`, then
//! `SESSION_HMAC_KEY_PREV` during a rotation, each in constant time.

use std::fmt;

use hmac::{Hmac, KeyInit, Mac};
use serde::Serialize;
use serde::de::DeserializeOwned;
use sha2::Sha256;
use thiserror::Error;

use super::encoding::{base64url, base64url_decode};

type HmacSha256 = Hmac<Sha256>;

/// The shortest signing key accepted: 256 bits, the size of the MAC.
pub const MIN_KEY_LEN: usize = 32;

/// Why a key was refused or a token did not verify. No variant carries the token or a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SigningError {
    #[error("a signing key must be at least {MIN_KEY_LEN} bytes")]
    KeyTooShort,
    /// Not `<base64url>.<base64url>`, or the payload is not the expected JSON.
    #[error("malformed token")]
    Malformed,
    /// Neither key produced this MAC.
    #[error("bad signature")]
    Signature,
}

impl SigningError {
    /// A reason code for a log line.
    pub fn reason(self) -> &'static str {
        match self {
            SigningError::KeyTooShort => "key",
            SigningError::Malformed => "malformed",
            SigningError::Signature => "signature",
        }
    }
}

/// The session signing keys: the current one signs and verifies, the previous one, while a
/// rotation lasts (one cookie lifetime, 24 h), only verifies. `kid` names the current key in
/// each payload, so a log can tell which key signed a token.
#[derive(Clone)]
pub struct Keyring {
    current: Vec<u8>,
    previous: Option<Vec<u8>>,
    kid: u32,
}

impl Keyring {
    /// Refuses a key shorter than [`MIN_KEY_LEN`] bytes, current or previous.
    pub fn new(
        current: impl Into<Vec<u8>>,
        previous: Option<Vec<u8>>,
        kid: u32,
    ) -> Result<Keyring, SigningError> {
        let current = current.into();
        let too_short = |k: &[u8]| k.len() < MIN_KEY_LEN;
        if too_short(&current) || previous.as_deref().is_some_and(too_short) {
            return Err(SigningError::KeyTooShort);
        }
        Ok(Keyring {
            current,
            previous,
            kid,
        })
    }

    pub fn kid(&self) -> u32 {
        self.kid
    }

    /// HMAC-SHA256 of `payload` under the current key.
    pub fn sign(&self, payload: &[u8]) -> [u8; 32] {
        mac(&self.current, payload)
    }

    /// Accepts a MAC made by the current key or the previous one. `verify_slice` compares in
    /// constant time; both keys are always tried when the first fails, so timing says nothing
    /// about which key matched beyond what the answer does.
    pub fn verify(&self, payload: &[u8], mac: &[u8]) -> Result<(), SigningError> {
        let ok = |key: &[u8]| {
            let mut m = HmacSha256::new_from_slice(key).expect("HMAC takes any key length");
            m.update(payload);
            m.verify_slice(mac).is_ok()
        };
        let current = ok(&self.current);
        let previous = self.previous.as_deref().is_some_and(ok);
        if current || previous {
            Ok(())
        } else {
            Err(SigningError::Signature)
        }
    }
}

/// Never prints a key.
impl fmt::Debug for Keyring {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Keyring")
            .field("kid", &self.kid)
            .field("previous", &self.previous.is_some())
            .finish_non_exhaustive()
    }
}

/// HMAC-SHA256 with any key: account ids and IP hashes use it with their own keys.
pub fn mac(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut m = HmacSha256::new_from_slice(key).expect("HMAC takes any key length");
    m.update(message);
    m.finalize().into_bytes().into()
}

/// What a token is for. The label goes into the MAC and not onto the wire, so a session token
/// can never verify as an OAuth transaction, or as a later token type, even if their JSON
/// shapes came to overlap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// `__Host-session`.
    Session,
    /// `__Host-oauth`.
    OAuth,
    /// The sandbox's API token, in `Authorization: Bearer` (docs/security.md, "The API token").
    /// Its own label, so a session cookie never verifies as a bearer token, nor a token as a
    /// cookie, though both are signed with the same key.
    ApiToken,
}

impl Purpose {
    fn label(self) -> &'static [u8] {
        match self {
            Purpose::Session => b"bakery-session-v1",
            Purpose::OAuth => b"bakery-oauth-v1",
            Purpose::ApiToken => b"bakery-api-token-v1",
        }
    }
}

/// The MAC input: the purpose's label, a zero byte, then the payload JSON.
fn signed_bytes(purpose: Purpose, payload_json: &[u8]) -> Vec<u8> {
    let label = purpose.label();
    let mut bytes = Vec::with_capacity(label.len() + 1 + payload_json.len());
    bytes.extend_from_slice(label);
    bytes.push(0);
    bytes.extend_from_slice(payload_json);
    bytes
}

/// Signs `payload` as `<base64url(JSON)>.<base64url(MAC)>`.
pub fn encode_token<T: Serialize>(purpose: Purpose, payload: &T, keyring: &Keyring) -> String {
    let json = serde_json::to_vec(payload).expect("a token payload serializes");
    let mac = keyring.sign(&signed_bytes(purpose, &json));
    format!("{}.{}", base64url(&json), base64url(&mac))
}

/// Checks the MAC first and parses the JSON only after, so an unsigned payload is never read.
pub fn decode_token<T: DeserializeOwned>(
    purpose: Purpose,
    token: &str,
    keyring: &Keyring,
) -> Result<T, SigningError> {
    let (payload, mac) = token.split_once('.').ok_or(SigningError::Malformed)?;
    let json = base64url_decode(payload).ok_or(SigningError::Malformed)?;
    let mac = base64url_decode(mac).ok_or(SigningError::Malformed)?;
    keyring.verify(&signed_bytes(purpose, &json), &mac)?;
    serde_json::from_slice(&json).map_err(|_| SigningError::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const KEY: &[u8] = b"test-session-key-0123456789abcdef";
    const OLD_KEY: &[u8] = b"test-session-key-old-0123456789ab";
    const OTHER_KEY: &[u8] = b"test-session-key-other-0123456789";

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Payload {
        a: u32,
    }

    fn ring(current: &[u8], previous: Option<&[u8]>) -> Keyring {
        Keyring::new(current, previous.map(<[u8]>::to_vec), 1).unwrap()
    }

    #[test]
    fn refuses_short_keys() {
        assert_eq!(
            Keyring::new(&b"short"[..], None, 1).unwrap_err(),
            SigningError::KeyTooShort
        );
        assert_eq!(
            Keyring::new(KEY, Some(b"short".to_vec()), 1).unwrap_err(),
            SigningError::KeyTooShort
        );
    }

    #[test]
    fn matches_rfc_4231_test_case_2() {
        // RFC 4231 section 4.3: key "Jefe", data "what do ya want for nothing?".
        let out = mac(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            crate::auth::encoding::hex(&out),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn verifies_current_then_previous() {
        let old = ring(OLD_KEY, None);
        let rotated = ring(KEY, Some(OLD_KEY));
        let mac = old.sign(b"payload");
        assert!(rotated.verify(b"payload", &mac).is_ok());
        assert!(ring(KEY, None).verify(b"payload", &mac).is_err());
        assert_eq!(
            ring(OTHER_KEY, Some(KEY)).verify(b"payload", &mac),
            Err(SigningError::Signature)
        );
        assert_eq!(
            rotated.verify(b"payload", &mac[..31]),
            Err(SigningError::Signature)
        );
    }

    #[test]
    fn token_round_trips_and_refuses_tampering() {
        let keys = ring(KEY, None);
        let token = encode_token(Purpose::Session, &Payload { a: 7 }, &keys);
        let (payload, mac) = token.split_once('.').unwrap();
        assert_eq!(base64url_decode(payload).unwrap(), br#"{"a":7}"#);
        assert_eq!(
            decode_token::<Payload>(Purpose::Session, &token, &keys),
            Ok(Payload { a: 7 })
        );

        let forged = format!("{}.{mac}", base64url(br#"{"a":8}"#));
        assert_eq!(
            decode_token::<Payload>(Purpose::Session, &forged, &keys),
            Err(SigningError::Signature)
        );
        for bad in ["", "abc", "a.b.c", "!!.!!"] {
            assert!(decode_token::<Payload>(Purpose::Session, bad, &keys).is_err());
        }
    }

    #[test]
    fn a_token_for_one_purpose_does_not_verify_as_another() {
        let keys = ring(KEY, None);
        let token = encode_token(Purpose::Session, &Payload { a: 7 }, &keys);
        assert_eq!(
            decode_token::<Payload>(Purpose::OAuth, &token, &keys),
            Err(SigningError::Signature)
        );
        for (made, read) in [
            (Purpose::Session, Purpose::ApiToken),
            (Purpose::ApiToken, Purpose::Session),
            (Purpose::ApiToken, Purpose::OAuth),
        ] {
            let token = encode_token(made, &Payload { a: 7 }, &keys);
            assert_eq!(
                decode_token::<Payload>(read, &token, &keys),
                Err(SigningError::Signature),
                "{made:?} read as {read:?}"
            );
        }
    }

    #[test]
    fn debug_never_prints_a_key() {
        let text = format!("{:?}", ring(KEY, Some(OLD_KEY)));
        assert!(!text.contains("test-session-key"), "{text}");
        assert!(!text.contains("116"), "{text}"); // the byte 't'
    }
}
