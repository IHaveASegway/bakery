//! Google's ID token, verified locally (docs/security.md, "Google, with the openid scope
//! alone"; ADR 0006, decisions 1 to 3).
//!
//! A hand-rolled RS256 check on `rsa` and `sha2`: pure Rust, built for wasm32, short enough to
//! review. It checks, in order: the shape, the header (`alg` is `RS256` and nothing else, the
//! `kid` is in the JWKS), the signature, then `iss`, `aud`, `azp`, `exp` and `iat` with 60 s of
//! skew, and `nonce`. The one output is [`Identity`], which holds `sub` and nothing else: the
//! claims struct names no other field, so `email`, `name`, `picture` and the rest are skipped by
//! the parser and never become values in memory.

use std::fmt;

use bakery_domain::WallTime;
use rsa::pkcs1v15::Pkcs1v15Sign;
use rsa::{BigUint, RsaPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::encoding::base64url_decode;
use super::session::unix_s;

/// Clock skew allowed on `exp` and `iat`, in seconds.
pub const SKEW_S: i64 = 60;
/// Google's keys are 2048-bit; a shorter one is refused, whatever the JWKS says.
const MIN_MODULUS_BITS: usize = 2048;
/// A longer token is refused before any parsing. Google's are about 1 KiB.
const MAX_TOKEN_LEN: usize = 16 * 1024;
/// The DER `DigestInfo` prefix for SHA-256 in EMSA-PKCS1-v1_5 (RFC 8017 section 9.2, note 1).
/// Written out because `rsa`'s own `sha2` feature would pull a second sha2.
const SHA256_DIGEST_INFO: [u8; 19] = [
    0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05,
    0x00, 0x04, 0x20,
];

/// The OpenID configuration at `<issuer>/.well-known/openid-configuration`, read for the four
/// fields the flow uses.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Discovery {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub jwks_uri: String,
}

impl Discovery {
    /// The discovery document's URL for an issuer.
    pub fn url(issuer: &str) -> String {
        format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        )
    }

    /// Refuses a document whose `issuer` is not the one asked for (OpenID Connect Discovery
    /// 1.0, section 4.3).
    pub fn parse(body: &str, issuer: &str) -> Result<Discovery, IdTokenError> {
        let d: Discovery = serde_json::from_str(body).map_err(|_| IdTokenError::Discovery)?;
        if d.issuer.trim_end_matches('/') != issuer.trim_end_matches('/') {
            return Err(IdTokenError::Discovery);
        }
        Ok(d)
    }
}

/// The JWKS document, `{"keys":[...]}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct JwkSet {
    pub keys: Vec<Jwk>,
}

/// One key. Fields other key types use are optional, so an EC key in the set does not break
/// parsing; it is just never matched.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Jwk {
    pub kty: String,
    #[serde(default)]
    pub kid: Option<String>,
    #[serde(default)]
    pub alg: Option<String>,
    #[serde(default, rename = "use")]
    pub key_use: Option<String>,
    /// The modulus, base64url big-endian.
    #[serde(default)]
    pub n: Option<String>,
    /// The exponent, base64url big-endian.
    #[serde(default)]
    pub e: Option<String>,
}

impl JwkSet {
    pub fn parse(body: &str) -> Result<JwkSet, IdTokenError> {
        serde_json::from_str(body).map_err(|_| IdTokenError::Keys)
    }

    /// The key named `kid`, if the set has exactly one.
    pub fn find(&self, kid: &str) -> Option<&Jwk> {
        let mut found = self.keys.iter().filter(|k| k.kid.as_deref() == Some(kid));
        let first = found.next();
        if found.next().is_some() { None } else { first }
    }
}

/// What the token must say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expected {
    /// From [`super::accepted_issuers`].
    pub issuers: Vec<String>,
    pub client_id: String,
    /// The nonce from `__Host-oauth`.
    pub nonce: String,
}

/// The only thing a verified token yields. `sub` is "unique among all Google Accounts and
/// never reused"; it becomes the account id's subject and is then dropped, never stored or
/// logged, so `Debug` does not print it.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct Identity {
    pub sub: String,
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Identity { sub: <redacted> }")
    }
}

/// Why a token was refused: a reason code, never a claim's value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum IdTokenError {
    #[error("the discovery document is unusable")]
    Discovery,
    #[error("the key set is unusable")]
    Keys,
    /// Not three base64url parts, or too long.
    #[error("malformed token")]
    Malformed,
    /// The header is not JSON, has a `typ` other than `JWT`, or has `crit`.
    #[error("unusable header")]
    Header,
    /// `alg` is anything but `RS256`: `none`, `HS256` and the rest.
    #[error("algorithm refused")]
    Algorithm,
    /// No single key in the set has this `kid`.
    #[error("unknown key")]
    UnknownKey,
    /// The key is not an RS256 signing key of at least 2048 bits.
    #[error("unusable key")]
    Key,
    #[error("bad signature")]
    Signature,
    /// The payload is not JSON with the claims below.
    #[error("unusable claims")]
    Claims,
    #[error("wrong issuer")]
    Issuer,
    #[error("wrong audience")]
    Audience,
    #[error("wrong authorized party")]
    AuthorizedParty,
    #[error("expired")]
    Expired,
    #[error("issued in the future")]
    IssuedInFuture,
    #[error("wrong nonce")]
    Nonce,
    #[error("unusable subject")]
    Subject,
}

impl IdTokenError {
    /// A reason code for a log line. The redirect's `?error=` says `token` for all of them.
    pub fn reason(self) -> &'static str {
        match self {
            IdTokenError::Discovery => "discovery",
            IdTokenError::Keys => "keys",
            IdTokenError::Malformed => "malformed",
            IdTokenError::Header => "header",
            IdTokenError::Algorithm => "alg",
            IdTokenError::UnknownKey => "kid",
            IdTokenError::Key => "key",
            IdTokenError::Signature => "signature",
            IdTokenError::Claims => "claims",
            IdTokenError::Issuer => "iss",
            IdTokenError::Audience => "aud",
            IdTokenError::AuthorizedParty => "azp",
            IdTokenError::Expired => "exp",
            IdTokenError::IssuedInFuture => "iat",
            IdTokenError::Nonce => "nonce",
            IdTokenError::Subject => "sub",
        }
    }

    /// Whether a refetch of the key set might help: the key may have rotated in since the
    /// cache was filled. The Worker refetches at most once a minute.
    pub fn may_be_stale_keys(self) -> bool {
        self == IdTokenError::UnknownKey
    }
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    #[serde(default)]
    kid: Option<String>,
    #[serde(default)]
    typ: Option<String>,
    #[serde(default)]
    crit: Option<serde::de::IgnoredAny>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

impl Audience {
    fn contains(&self, client_id: &str) -> bool {
        match self {
            Audience::One(a) => a == client_id,
            Audience::Many(all) => all.iter().any(|a| a == client_id),
        }
    }
}

/// The claims read, and the only ones: every other claim is skipped by serde.
#[derive(Deserialize)]
struct Claims {
    iss: String,
    aud: Audience,
    #[serde(default)]
    azp: Option<String>,
    exp: i64,
    iat: i64,
    #[serde(default)]
    nonce: Option<String>,
    sub: String,
}

/// Verifies a Google ID token and returns its `sub`, or the first reason it fails.
pub fn verify_google_id_token(
    token: &str,
    jwks: &JwkSet,
    expected: &Expected,
    now: WallTime,
) -> Result<Identity, IdTokenError> {
    if token.len() > MAX_TOKEN_LEN {
        return Err(IdTokenError::Malformed);
    }
    let mut parts = token.split('.');
    let (Some(header_b64), Some(payload_b64), Some(signature_b64), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(IdTokenError::Malformed);
    };
    let decode = |p: &str| base64url_decode(p).ok_or(IdTokenError::Malformed);
    let header_json = decode(header_b64)?;
    let payload_json = decode(payload_b64)?;
    let signature = decode(signature_b64)?;

    let header: Header = serde_json::from_slice(&header_json).map_err(|_| IdTokenError::Header)?;
    if header.alg != "RS256" {
        return Err(IdTokenError::Algorithm);
    }
    if header.crit.is_some() || header.typ.as_deref().is_some_and(|t| t != "JWT") {
        return Err(IdTokenError::Header);
    }
    let kid = header.kid.ok_or(IdTokenError::UnknownKey)?;
    let jwk = jwks.find(&kid).ok_or(IdTokenError::UnknownKey)?;
    let key = rsa_key(jwk)?;

    let signing_input = &token.as_bytes()[..header_b64.len() + 1 + payload_b64.len()];
    let digest = Sha256::digest(signing_input);
    let scheme = Pkcs1v15Sign {
        hash_len: Some(32),
        prefix: SHA256_DIGEST_INFO.into(),
    };
    key.verify(scheme, &digest, &signature)
        .map_err(|_| IdTokenError::Signature)?;

    // Only now, with the signature good, is the payload read.
    let claims: Claims = serde_json::from_slice(&payload_json).map_err(|_| IdTokenError::Claims)?;
    check_claims(claims, expected, unix_s(now))
}

fn rsa_key(jwk: &Jwk) -> Result<RsaPublicKey, IdTokenError> {
    let usable = jwk.kty == "RSA"
        && jwk.alg.as_deref().is_none_or(|a| a == "RS256")
        && jwk.key_use.as_deref().is_none_or(|u| u == "sig");
    if !usable {
        return Err(IdTokenError::Key);
    }
    let part = |p: &Option<String>| {
        p.as_deref()
            .and_then(base64url_decode)
            .map(|b| BigUint::from_bytes_be(&b))
            .ok_or(IdTokenError::Key)
    };
    let (n, e) = (part(&jwk.n)?, part(&jwk.e)?);
    if n.bits() < MIN_MODULUS_BITS {
        return Err(IdTokenError::Key);
    }
    RsaPublicKey::new(n, e).map_err(|_| IdTokenError::Key)
}

fn check_claims(claims: Claims, expected: &Expected, now_s: i64) -> Result<Identity, IdTokenError> {
    if !expected.issuers.contains(&claims.iss) {
        return Err(IdTokenError::Issuer);
    }
    if !claims.aud.contains(&expected.client_id) {
        return Err(IdTokenError::Audience);
    }
    if claims
        .azp
        .as_deref()
        .is_some_and(|azp| azp != expected.client_id)
    {
        return Err(IdTokenError::AuthorizedParty);
    }
    if claims.exp <= now_s - SKEW_S {
        return Err(IdTokenError::Expired);
    }
    if claims.iat > now_s + SKEW_S {
        return Err(IdTokenError::IssuedInFuture);
    }
    if claims.nonce.as_deref() != Some(expected.nonce.as_str()) || expected.nonce.is_empty() {
        return Err(IdTokenError::Nonce);
    }
    // Google's `sub` is at most 255 ASCII characters; anything else is not one of its ids.
    let sub_ok = !claims.sub.is_empty()
        && claims.sub.len() <= 255
        && claims.sub.bytes().all(|b| b.is_ascii_graphic());
    if !sub_ok {
        return Err(IdTokenError::Subject);
    }
    Ok(Identity { sub: claims.sub })
}

#[cfg(test)]
mod tests {
    use std::sync::OnceLock;

    use rand_chacha_rsa::ChaCha8Rng;
    use rand_chacha_rsa::rand_core::SeedableRng;
    use rsa::RsaPrivateKey;
    use rsa::traits::PublicKeyParts;
    use serde_json::{Value, json};

    use super::*;
    use crate::auth::encoding::base64url;

    const CLIENT_ID: &str = "test-client.apps.example.com";
    const NONCE: &str = "test-nonce-0123456789";
    const SUB: &str = "100000000000000000001";
    const NOW: &str = "2026-11-05T12:00:00.000Z";
    const NOW_S: i64 = 1_793_880_000;

    /// One 2048-bit key per test run, from a fixed seed: generated, never committed.
    fn key() -> &'static RsaPrivateKey {
        static KEY: OnceLock<RsaPrivateKey> = OnceLock::new();
        KEY.get_or_init(|| {
            let mut rng = ChaCha8Rng::seed_from_u64(0x5eed);
            RsaPrivateKey::new(&mut rng, 2048).expect("a test key")
        })
    }

    fn jwk(kid: &str, key: &RsaPrivateKey) -> Value {
        json!({
            "kty": "RSA", "alg": "RS256", "use": "sig", "kid": kid,
            "n": base64url(&key.n().to_bytes_be()),
            "e": base64url(&key.e().to_bytes_be()),
        })
    }

    fn jwks() -> JwkSet {
        let doc = json!({ "keys": [
            { "kty": "EC", "kid": "ec-1", "crv": "P-256", "x": "AA", "y": "AA" },
            jwk("test-kid-1", key()),
        ]});
        JwkSet::parse(&doc.to_string()).unwrap()
    }

    fn expected() -> Expected {
        Expected {
            issuers: crate::auth::accepted_issuers(crate::auth::GOOGLE_ISSUER),
            client_id: CLIENT_ID.into(),
            nonce: NONCE.into(),
        }
    }

    fn claims() -> Value {
        json!({
            "iss": "https://accounts.google.com",
            "azp": CLIENT_ID,
            "aud": CLIENT_ID,
            "sub": SUB,
            "at_hash": "fake-at-hash",
            "nonce": NONCE,
            "iat": NOW_S - 10,
            "exp": NOW_S + 3_590,
        })
    }

    fn sign_with(header: &Value, claims: &Value, key: &RsaPrivateKey) -> String {
        let input = format!(
            "{}.{}",
            base64url(header.to_string().as_bytes()),
            base64url(claims.to_string().as_bytes())
        );
        let scheme = Pkcs1v15Sign {
            hash_len: Some(32),
            prefix: SHA256_DIGEST_INFO.into(),
        };
        let sig = key.sign(scheme, &Sha256::digest(input.as_bytes())).unwrap();
        format!("{input}.{}", base64url(&sig))
    }

    fn sign(claims: &Value) -> String {
        sign_with(
            &json!({"alg":"RS256","kid":"test-kid-1","typ":"JWT"}),
            claims,
            key(),
        )
    }

    fn verify(token: &str) -> Result<Identity, IdTokenError> {
        verify_google_id_token(token, &jwks(), &expected(), NOW.parse().unwrap())
    }

    fn with(changes: Value) -> Value {
        let mut c = claims();
        for (k, v) in changes.as_object().unwrap() {
            if v.is_null() {
                c.as_object_mut().unwrap().remove(k);
            } else {
                c[k] = v.clone();
            }
        }
        c
    }

    #[test]
    fn a_valid_token_yields_sub_alone() {
        let identity = verify(&sign(&claims())).unwrap();
        assert_eq!(identity.sub, SUB);
    }

    #[test]
    fn profile_claims_are_never_kept() {
        let token = sign(&with(json!({
            "email": "fake@example.com",
            "email_verified": true,
            "name": "Fake Person",
            "picture": "https://example.com/fake.png",
            "given_name": "Fake",
        })));
        let identity = verify(&token).unwrap();
        assert_eq!(identity, Identity { sub: SUB.into() });
        let debug = format!("{identity:?}");
        let json = serde_json::to_string(&identity).unwrap();
        assert_eq!(json, format!(r#"{{"sub":"{SUB}"}}"#));
        for text in [&debug, &json] {
            for leak in ["@", "email", "name", "Fake", "picture"] {
                assert!(!text.contains(leak), "{text} holds {leak}");
            }
        }
        assert!(!debug.contains(SUB));
    }

    #[test]
    fn the_digest_info_prefix_is_sha256s() {
        // DigestInfo ::= SEQUENCE { SEQUENCE { OID 2.16.840.1.101.3.4.2.1, NULL }, OCTET STRING (32) }
        assert_eq!(SHA256_DIGEST_INFO[0], 0x30);
        assert_eq!(
            usize::from(SHA256_DIGEST_INFO[1]),
            SHA256_DIGEST_INFO.len() - 2 + 32
        );
        assert_eq!(
            &SHA256_DIGEST_INFO[6..15],
            &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]
        );
        assert_eq!(&SHA256_DIGEST_INFO[17..], &[0x04, 0x20]);
    }

    #[test]
    fn audience_may_be_an_array_and_bare_issuer_is_google() {
        let token = sign(&with(json!({
            "aud": ["other-client.example.com", CLIENT_ID],
            "iss": "accounts.google.com",
            "azp": null,
        })));
        assert!(verify(&token).is_ok());
    }

    #[test]
    fn claims_are_checked() {
        let cases = [
            (json!({"nonce": "other-nonce"}), IdTokenError::Nonce),
            (json!({"nonce": null}), IdTokenError::Nonce),
            (
                json!({"aud": "other-client.example.com"}),
                IdTokenError::Audience,
            ),
            (
                json!({"aud": ["other-client.example.com"]}),
                IdTokenError::Audience,
            ),
            (
                json!({"azp": "other-client.example.com"}),
                IdTokenError::AuthorizedParty,
            ),
            (
                json!({"iss": "https://issuer.example.com"}),
                IdTokenError::Issuer,
            ),
            (
                json!({"iss": "http://accounts.google.com"}),
                IdTokenError::Issuer,
            ),
            (json!({"exp": NOW_S - 60}), IdTokenError::Expired),
            (json!({"iat": NOW_S + 61}), IdTokenError::IssuedInFuture),
            (json!({"sub": ""}), IdTokenError::Subject),
            (json!({"sub": "a b"}), IdTokenError::Subject),
            (json!({"sub": null}), IdTokenError::Claims),
            (json!({"exp": "soon"}), IdTokenError::Claims),
        ];
        for (change, reason) in cases {
            let token = sign(&with(change.clone()));
            assert_eq!(verify(&token).unwrap_err(), reason, "{change}");
        }
        // Inside the skew still passes.
        assert!(verify(&sign(&with(json!({"exp": NOW_S - 59, "iat": NOW_S + 60})))).is_ok());
    }

    #[test]
    fn the_header_is_checked() {
        let c = claims();
        let cases = [
            (
                json!({"alg":"none","kid":"test-kid-1"}),
                IdTokenError::Algorithm,
            ),
            (
                json!({"alg":"HS256","kid":"test-kid-1"}),
                IdTokenError::Algorithm,
            ),
            (
                json!({"alg":"RS512","kid":"test-kid-1"}),
                IdTokenError::Algorithm,
            ),
            (
                json!({"alg":"rs256","kid":"test-kid-1"}),
                IdTokenError::Algorithm,
            ),
            (
                json!({"alg":"RS256","kid":"unknown-kid"}),
                IdTokenError::UnknownKey,
            ),
            (json!({"alg":"RS256"}), IdTokenError::UnknownKey),
            (
                json!({"alg":"RS256","kid":"test-kid-1","typ":"at+jwt"}),
                IdTokenError::Header,
            ),
            (
                json!({"alg":"RS256","kid":"test-kid-1","crit":["exp"]}),
                IdTokenError::Header,
            ),
            (json!({"kid":"test-kid-1"}), IdTokenError::Header),
        ];
        for (header, reason) in cases {
            let token = sign_with(&header, &c, key());
            assert_eq!(verify(&token).unwrap_err(), reason, "{header}");
        }
        assert!(IdTokenError::UnknownKey.may_be_stale_keys());
    }

    #[test]
    fn alg_none_with_an_empty_signature_fails() {
        let token = format!(
            "{}.{}.",
            base64url(br#"{"alg":"none","kid":"test-kid-1"}"#),
            base64url(claims().to_string().as_bytes())
        );
        assert_eq!(verify(&token).unwrap_err(), IdTokenError::Algorithm);
    }

    #[test]
    fn tampering_fails() {
        let token = sign(&claims());
        let parts: Vec<&str> = token.split('.').collect();

        let other = base64url(
            with(json!({"sub": "100000000000000000002"}))
                .to_string()
                .as_bytes(),
        );
        let tampered_payload = format!("{}.{other}.{}", parts[0], parts[2]);
        assert_eq!(
            verify(&tampered_payload).unwrap_err(),
            IdTokenError::Signature
        );

        let mut sig = base64url_decode(parts[2]).unwrap();
        sig[10] ^= 1;
        let tampered_sig = format!("{}.{}.{}", parts[0], parts[1], base64url(&sig));
        assert_eq!(verify(&tampered_sig).unwrap_err(), IdTokenError::Signature);

        let short_sig = format!("{}.{}.{}", parts[0], parts[1], base64url(&sig[..255]));
        assert_eq!(verify(&short_sig).unwrap_err(), IdTokenError::Signature);
    }

    #[test]
    fn a_token_signed_by_another_key_fails() {
        let mut rng = ChaCha8Rng::seed_from_u64(0xbad);
        let other = RsaPrivateKey::new(&mut rng, 2048).unwrap();
        let token = sign_with(
            &json!({"alg":"RS256","kid":"test-kid-1"}),
            &claims(),
            &other,
        );
        assert_eq!(verify(&token).unwrap_err(), IdTokenError::Signature);
    }

    #[test]
    fn malformed_tokens_fail() {
        let token = sign(&claims());
        for bad in [
            String::new(),
            "a.b".to_owned(),
            format!("{token}.extra"),
            token.replacen('.', ".=", 1),
            "!.!.!".to_owned(),
            "a".repeat(MAX_TOKEN_LEN + 1),
        ] {
            assert_eq!(verify(&bad).unwrap_err(), IdTokenError::Malformed);
        }
    }

    #[test]
    fn keys_are_checked() {
        let token = sign(&claims());
        let now = NOW.parse().unwrap();
        let set = |k: Value| JwkSet::parse(&json!({ "keys": [k] }).to_string()).unwrap();

        let mut wrong_alg = jwk("test-kid-1", key());
        wrong_alg["alg"] = json!("RS512");
        let mut enc = jwk("test-kid-1", key());
        enc["use"] = json!("enc");
        let mut no_n = jwk("test-kid-1", key());
        no_n.as_object_mut().unwrap().remove("n");
        let mut not_rsa = jwk("test-kid-1", key());
        not_rsa["kty"] = json!("oct");
        for k in [wrong_alg, enc, no_n, not_rsa] {
            assert_eq!(
                verify_google_id_token(&token, &set(k), &expected(), now).unwrap_err(),
                IdTokenError::Key
            );
        }

        let mut rng = ChaCha8Rng::seed_from_u64(7);
        let small = RsaPrivateKey::new(&mut rng, 1024).unwrap();
        let small_token = sign_with(&json!({"alg":"RS256","kid":"small"}), &claims(), &small);
        assert_eq!(
            verify_google_id_token(&small_token, &set(jwk("small", &small)), &expected(), now)
                .unwrap_err(),
            IdTokenError::Key
        );

        // Two keys with one kid: ambiguous, so neither.
        let dup = JwkSet::parse(
            &json!({ "keys": [jwk("test-kid-1", key()), jwk("test-kid-1", key())] }).to_string(),
        )
        .unwrap();
        assert_eq!(
            verify_google_id_token(&token, &dup, &expected(), now).unwrap_err(),
            IdTokenError::UnknownKey
        );
        assert_eq!(JwkSet::parse("{}").unwrap_err(), IdTokenError::Keys);
    }

    #[test]
    fn discovery() {
        assert_eq!(
            Discovery::url("https://accounts.google.com"),
            "https://accounts.google.com/.well-known/openid-configuration"
        );
        let body = json!({
            "issuer": "http://127.0.0.1:9999",
            "authorization_endpoint": "http://127.0.0.1:9999/authorize",
            "token_endpoint": "http://127.0.0.1:9999/token",
            "jwks_uri": "http://127.0.0.1:9999/jwks",
            "scopes_supported": ["openid"],
        })
        .to_string();
        let d = Discovery::parse(&body, "http://127.0.0.1:9999/").unwrap();
        assert_eq!(d.jwks_uri, "http://127.0.0.1:9999/jwks");
        assert_eq!(
            Discovery::parse(&body, "https://accounts.google.com").unwrap_err(),
            IdTokenError::Discovery
        );
    }

    #[test]
    fn reasons_are_distinct() {
        use std::collections::HashSet;
        let all = [
            IdTokenError::Discovery,
            IdTokenError::Keys,
            IdTokenError::Malformed,
            IdTokenError::Header,
            IdTokenError::Algorithm,
            IdTokenError::UnknownKey,
            IdTokenError::Key,
            IdTokenError::Signature,
            IdTokenError::Claims,
            IdTokenError::Issuer,
            IdTokenError::Audience,
            IdTokenError::AuthorizedParty,
            IdTokenError::Expired,
            IdTokenError::IssuedInFuture,
            IdTokenError::Nonce,
            IdTokenError::Subject,
        ];
        let reasons: HashSet<_> = all.iter().map(|e| e.reason()).collect();
        assert_eq!(reasons.len(), all.len());
    }
}
