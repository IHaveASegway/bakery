//! The OAuth authorization code flow for Google and GitHub, minus the network (docs/security.md,
//! "Google, with the openid scope alone" and "GitHub, with the numeric user id alone").
//!
//! The Worker draws the random bytes, makes the requests and sets the cookies; everything it
//! sends and reads is built and parsed here, so the flow is tested natively. `bakery-api` is a
//! confidential client using `state`, PKCE `S256` and, for Google, `nonce`. Google is asked for
//! `openid` alone (spike S2 passed on 2026-11-05) and GitHub for no scope at all.

use std::fmt;

use bakery_domain::WallTime;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::encoding::{base64url, constant_time_eq, form};
use super::session::{OAUTH_TTL_S, unix_s};
use super::signing::{Keyring, Purpose, SigningError, decode_token, encode_token};

pub const OAUTH_VERSION: u32 = 1;
/// Where a sign-in lands when no usable return path was given.
pub const DEFAULT_RETURN: &str = "/app/";
/// A longer return path is refused: it would only bloat the cookie.
const MAX_RETURN_LEN: usize = 256;

/// The issuer Google's discovery document names, and the bare form some tokens carry.
pub const GOOGLE_ISSUER: &str = "https://accounts.google.com";
const GOOGLE_ISSUER_BARE: &str = "accounts.google.com";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Github,
}

impl Provider {
    /// The route segment, `/v1/auth/<provider>/start`.
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Google => "google",
            Provider::Github => "github",
        }
    }
}

/// The `__Host-oauth` payload: one sign-in attempt, for 10 minutes. `nonce` is Google's alone
/// and is left out of the JSON for GitHub.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OAuthTransaction {
    pub v: u32,
    pub provider: Provider,
    /// 32 random bytes, base64url: echoed back by the provider and compared on the callback.
    pub state: String,
    /// 32 random bytes, base64url: Google puts it in the ID token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    /// The PKCE verifier: 32 random bytes, base64url, 43 characters (RFC 7636 section 4.1).
    pub verifier: String,
    /// Where to send the visitor afterwards, already checked by [`return_path`].
    pub ret: String,
    pub iat: i64,
    pub exp: i64,
    pub kid: u32,
}

/// The verifier is a secret until the exchange, so it is never printed.
impl fmt::Debug for OAuthTransaction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OAuthTransaction")
            .field("provider", &self.provider)
            .field("ret", &self.ret)
            .field("iat", &self.iat)
            .field("exp", &self.exp)
            .finish_non_exhaustive()
    }
}

/// Why a step of the flow failed. Each maps to a reason code for the log and a slug for the
/// `?error=` of the redirect to the sign-in page; no variant carries a code, token or claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum OAuthError {
    /// No `__Host-oauth`, or it did not verify, or it expired, or it was for the other
    /// provider, or `state` did not match it.
    #[error("the sign-in transaction did not check out")]
    State,
    /// The token endpoint's reply had no usable token.
    #[error("the code exchange failed")]
    Exchange,
    /// The provider's user reply had no usable id.
    #[error("the provider's reply was unusable")]
    Provider,
}

impl OAuthError {
    /// The `?error=` slug, which is also the log line's reason.
    pub fn slug(self) -> &'static str {
        match self {
            OAuthError::State => "state",
            OAuthError::Exchange => "exchange",
            OAuthError::Provider => "provider",
        }
    }
}

impl From<SigningError> for OAuthError {
    fn from(_: SigningError) -> OAuthError {
        OAuthError::State
    }
}

impl OAuthTransaction {
    /// A new attempt from 96 random bytes: `state` from the first 32, the PKCE verifier from the
    /// next 32 and, for Google, `nonce` from the last 32 (GitHub leaves them unused).
    pub fn new_from_random(
        provider: Provider,
        random: &[u8; 96],
        ret: Option<&str>,
        now: WallTime,
    ) -> OAuthTransaction {
        let iat = unix_s(now);
        OAuthTransaction {
            v: OAUTH_VERSION,
            provider,
            state: base64url(&random[..32]),
            nonce: (provider == Provider::Google).then(|| base64url(&random[64..])),
            verifier: base64url(&random[32..64]),
            ret: return_path(ret),
            iat,
            exp: iat + OAUTH_TTL_S,
            kid: 0,
        }
    }

    /// Compares the callback's `state` in constant time.
    pub fn state_matches(&self, state: &str) -> bool {
        constant_time_eq(self.state.as_bytes(), state.as_bytes())
    }

    /// The PKCE challenge for this attempt's verifier.
    pub fn code_challenge(&self) -> String {
        pkce_challenge(&self.verifier)
    }
}

/// Signs the transaction for `__Host-oauth`, stamping the current key's `kid`.
pub fn issue_transaction(tx: &OAuthTransaction, keyring: &Keyring) -> String {
    let tx = OAuthTransaction {
        kid: keyring.kid(),
        ..tx.clone()
    };
    encode_token(Purpose::OAuth, &tx, keyring)
}

/// Checks the cookie on a callback: its MAC, version, expiry, that it was started for this
/// callback's provider, and that the provider echoed its `state`. Any failure is
/// [`OAuthError::State`]: the sign-in page says to try again, and the log says `state`.
pub fn verify_transaction(
    token: &str,
    keyring: &Keyring,
    provider: Provider,
    state: &str,
    now: WallTime,
) -> Result<OAuthTransaction, OAuthError> {
    let tx: OAuthTransaction = decode_token(Purpose::OAuth, token, keyring)?;
    let fresh = unix_s(now) < tx.exp;
    let nonce_ok = tx.nonce.is_some() == (provider == Provider::Google);
    if tx.v != OAUTH_VERSION || !fresh || tx.provider != provider || !nonce_ok {
        return Err(OAuthError::State);
    }
    if !tx.state_matches(state) {
        return Err(OAuthError::State);
    }
    Ok(tx)
}

/// PKCE `S256`: base64url of the SHA-256 of the verifier's ASCII (RFC 7636 section 4.2).
pub fn pkce_challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// A return path on the storefront: `^/[a-z0-9/-]*$`, at most 256 characters, else `/app/`.
/// Nothing with a dot, colon, query or backslash can pass, so the 303 that appends it to
/// `ALLOWED_ORIGIN` always stays on the storefront.
pub fn return_path(input: Option<&str>) -> String {
    match input {
        Some(p)
            if p.len() <= MAX_RETURN_LEN
                && p.starts_with('/')
                && p.bytes()
                    .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-')) =>
        {
            p.to_owned()
        }
        _ => DEFAULT_RETURN.to_owned(),
    }
}

fn with_query(endpoint: &str, pairs: &[(&str, &str)]) -> String {
    let sep = if endpoint.contains('?') { '&' } else { '?' };
    format!("{endpoint}{sep}{}", form(pairs))
}

/// The 302 target for Google: `response_type=code&scope=openid` and nothing more in the scope,
/// then the client, the callback, `state`, `nonce` and the PKCE challenge.
pub fn google_authorize_url(
    authorization_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    tx: &OAuthTransaction,
) -> String {
    let challenge = tx.code_challenge();
    with_query(
        authorization_endpoint,
        &[
            ("response_type", "code"),
            ("scope", "openid"),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("state", &tx.state),
            ("nonce", tx.nonce.as_deref().unwrap_or_default()),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ],
    )
}

/// The 302 target for GitHub. No `scope` parameter, so GitHub's default empty scope applies:
/// no `user`, `read:user` or `user:email`.
pub fn github_authorize_url(
    authorize_url: &str,
    client_id: &str,
    redirect_uri: &str,
    tx: &OAuthTransaction,
) -> String {
    let challenge = tx.code_challenge();
    with_query(
        authorize_url,
        &[
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("state", &tx.state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ],
    )
}

/// The client's credentials and callback, as the Worker reads them from its secrets.
pub struct Client<'a> {
    pub client_id: &'a str,
    pub client_secret: &'a str,
    pub redirect_uri: &'a str,
}

/// Never prints the secret.
impl fmt::Debug for Client<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client")
            .field("client_id", &self.client_id)
            .field("redirect_uri", &self.redirect_uri)
            .finish_non_exhaustive()
    }
}

/// The `application/x-www-form-urlencoded` body for Google's token endpoint.
pub fn google_token_request(client: &Client<'_>, code: &str, verifier: &str) -> String {
    form(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", client.redirect_uri),
        ("client_id", client.client_id),
        ("client_secret", client.client_secret),
        ("code_verifier", verifier),
    ])
}

/// The `application/x-www-form-urlencoded` body for GitHub's token endpoint, sent with
/// `Accept: application/json`.
pub fn github_token_request(client: &Client<'_>, code: &str, verifier: &str) -> String {
    form(&[
        ("client_id", client.client_id),
        ("client_secret", client.client_secret),
        ("code", code),
        ("redirect_uri", client.redirect_uri),
        ("code_verifier", verifier),
    ])
}

/// Google's token reply, read for `id_token` alone. The `access_token` beside it is never
/// used, so serde skips it and it is never held as a field.
#[derive(Clone, Deserialize)]
pub struct GoogleTokens {
    pub id_token: String,
}

impl fmt::Debug for GoogleTokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GoogleTokens { .. }")
    }
}

pub fn parse_google_tokens(body: &str) -> Result<GoogleTokens, OAuthError> {
    serde_json::from_str::<GoogleTokens>(body)
        .ok()
        .filter(|t| !t.id_token.is_empty())
        .ok_or(OAuthError::Exchange)
}

/// GitHub's token reply. GitHub answers a failed exchange with 200 and an `error` field, which
/// lacks `access_token` and so fails to parse. The token is used for one `GET /user` and
/// dropped.
#[derive(Clone, Deserialize)]
pub struct GitHubToken {
    pub access_token: String,
    pub token_type: String,
    /// Empty, since no scope is asked for.
    #[serde(default)]
    pub scope: String,
}

impl fmt::Debug for GitHubToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GitHubToken")
            .field("token_type", &self.token_type)
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}

impl GitHubToken {
    /// The `Authorization` header value for `GET /user`.
    pub fn authorization(&self) -> String {
        format!("Bearer {}", self.access_token)
    }
}

pub fn parse_github_token(body: &str) -> Result<GitHubToken, OAuthError> {
    serde_json::from_str::<GitHubToken>(body)
        .ok()
        .filter(|t| !t.access_token.is_empty() && t.token_type.eq_ignore_ascii_case("bearer"))
        .ok_or(OAuthError::Exchange)
}

/// GitHub's `GET /user` reply, read for the numeric `id` alone: the login can change, the id
/// does not. The profile fields beside it, which can include a name and a public email, are
/// skipped by the parser and never held as fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct GitHubUser {
    pub id: u64,
}

impl GitHubUser {
    /// The account id's subject: the id in decimal. [`super::account_id`] adds `github:`.
    pub fn subject(self) -> String {
        self.id.to_string()
    }
}

pub fn parse_github_user(body: &str) -> Result<GitHubUser, OAuthError> {
    serde_json::from_str(body).map_err(|_| OAuthError::Provider)
}

/// The `iss` values to accept for an issuer: the issuer itself, and for Google also the bare
/// `accounts.google.com` that some of its ID tokens carry.
pub fn accepted_issuers(issuer: &str) -> Vec<String> {
    let mut issuers = vec![issuer.to_owned()];
    if issuer == GOOGLE_ISSUER {
        issuers.push(GOOGLE_ISSUER_BARE.to_owned());
    }
    issuers
}

/// Whether a provider override (`GOOGLE_ISSUER`, `GITHUB_TOKEN_URL` and the rest) points at
/// this machine, the only place the Worker honors one: `http` or `https`, host `127.0.0.1` or
/// `localhost`, any port, no user info. Anything else is refused and the default is used.
pub fn is_local_override(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return false;
    }
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        Some(_) => return false,
        None => authority,
    };
    matches!(host, "127.0.0.1" | "localhost")
}

/// Splits a URL's query into decoded-enough pairs for tests: no percent-decoding.
#[cfg(test)]
fn query_pairs(url: &str) -> Vec<(String, String)> {
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or_default();
    query
        .split('&')
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::encoding::percent_encode;

    const KEY: &[u8] = b"test-session-key-0123456789abcdef";
    const CLIENT_ID: &str = "test-client-id.example.com";
    const REDIRECT: &str = "http://127.0.0.1:8787/v1/auth/google/callback";

    fn keys() -> Keyring {
        Keyring::new(KEY, None, 1).unwrap()
    }

    fn now() -> WallTime {
        "2026-11-05T12:00:00.000Z".parse().unwrap()
    }

    fn random() -> [u8; 96] {
        let mut r = [0u8; 96];
        for (i, b) in r.iter_mut().enumerate() {
            *b = i as u8;
        }
        r
    }

    #[test]
    fn transaction_from_random_bytes() {
        let tx =
            OAuthTransaction::new_from_random(Provider::Google, &random(), Some("/app/x"), now());
        assert_eq!(tx.state, base64url(&random()[..32]));
        assert_eq!(tx.verifier, base64url(&random()[32..64]));
        assert_eq!(tx.verifier.len(), 43);
        assert_eq!(
            tx.nonce.as_deref(),
            Some(base64url(&random()[64..]).as_str())
        );
        assert_ne!(tx.state, tx.verifier);
        assert_eq!(tx.ret, "/app/x");
        assert_eq!(tx.exp - tx.iat, 600);

        let gh = OAuthTransaction::new_from_random(Provider::Github, &random(), None, now());
        assert_eq!(gh.nonce, None);
        assert_eq!(gh.ret, "/app/");
        let json = serde_json::to_value(&gh).unwrap();
        assert!(json.get("nonce").is_none());
        assert_eq!(json["provider"], "github");
    }

    #[test]
    fn rfc_7636_appendix_b_challenge() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn return_paths() {
        assert_eq!(return_path(Some("/app/")), "/app/");
        assert_eq!(return_path(Some("/")), "/");
        assert_eq!(return_path(Some("/app/sandbox-1")), "/app/sandbox-1");
        for bad in [
            "",
            "app/",
            "https://example.com/",
            "//example.com",
            "/App/",
            "/app/?x=1",
            "/app/#x",
            "/a\\b",
            "/a b",
            "/a.b",
            "/%2e%2e",
        ] {
            assert_eq!(return_path(Some(bad)), "/app/", "{bad}");
        }
        assert_eq!(return_path(None), "/app/");
        assert_eq!(return_path(Some(&format!("/{}", "a".repeat(256)))), "/app/");
    }

    #[test]
    fn verify_checks_mac_expiry_provider_and_state() {
        let tx = OAuthTransaction::new_from_random(Provider::Google, &random(), None, now());
        let token = issue_transaction(&tx, &keys());
        let back = verify_transaction(&token, &keys(), Provider::Google, &tx.state, now()).unwrap();
        assert_eq!(back.kid, 1);
        assert_eq!(back.verifier, tx.verifier);

        let late = WallTime::from_unix_ms(now().unix_ms() + 600_000).unwrap();
        let wrong_state = base64url(&[9; 32]);
        for (provider, state, at) in [
            (Provider::Google, wrong_state.as_str(), now()),
            (Provider::Google, "", now()),
            (Provider::Github, tx.state.as_str(), now()),
            (Provider::Google, tx.state.as_str(), late),
        ] {
            assert_eq!(
                verify_transaction(&token, &keys(), provider, state, at).unwrap_err(),
                OAuthError::State
            );
        }
        assert_eq!(
            verify_transaction("nope", &keys(), Provider::Google, &tx.state, now()).unwrap_err(),
            OAuthError::State
        );
    }

    #[test]
    fn google_url_asks_for_openid_alone() {
        let tx = OAuthTransaction::new_from_random(Provider::Google, &random(), None, now());
        let url = google_authorize_url(
            "https://accounts.google.com/o/oauth2/v2/auth",
            CLIENT_ID,
            REDIRECT,
            &tx,
        );
        assert!(url.starts_with(
            "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&scope=openid&"
        ));
        let pairs = query_pairs(&url);
        let scopes: Vec<_> = pairs.iter().filter(|(k, _)| k == "scope").collect();
        assert_eq!(scopes, [&("scope".to_owned(), "openid".to_owned())]);
        let get = |k: &str| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("client_id"), Some(CLIENT_ID));
        assert_eq!(get("redirect_uri"), Some(percent_encode(REDIRECT).as_str()));
        assert_eq!(get("state"), Some(tx.state.as_str()));
        assert_eq!(get("nonce"), tx.nonce.as_deref());
        assert_eq!(get("code_challenge"), Some(tx.code_challenge().as_str()));
        assert_eq!(get("code_challenge_method"), Some("S256"));
        assert_eq!(pairs.len(), 8);
    }

    #[test]
    fn github_url_has_no_scope() {
        let tx = OAuthTransaction::new_from_random(Provider::Github, &random(), None, now());
        let url = github_authorize_url(
            "https://github.com/login/oauth/authorize",
            CLIENT_ID,
            REDIRECT,
            &tx,
        );
        let pairs = query_pairs(&url);
        assert!(
            pairs.iter().all(|(k, _)| k != "scope" && k != "nonce"),
            "{url}"
        );
        let keys: Vec<_> = pairs.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            [
                "client_id",
                "redirect_uri",
                "state",
                "code_challenge",
                "code_challenge_method"
            ]
        );
        assert!(!url.contains("scope"));
    }

    #[test]
    fn token_request_bodies() {
        let client = Client {
            client_id: CLIENT_ID,
            client_secret: "test-secret",
            redirect_uri: REDIRECT,
        };
        assert_eq!(
            google_token_request(&client, "code/1", "ver"),
            format!(
                "grant_type=authorization_code&code=code%2F1&redirect_uri={}&client_id={CLIENT_ID}\
                 &client_secret=test-secret&code_verifier=ver",
                percent_encode(REDIRECT)
            )
        );
        assert_eq!(
            github_token_request(&client, "c", "ver"),
            format!(
                "client_id={CLIENT_ID}&client_secret=test-secret&code=c&redirect_uri={}\
                 &code_verifier=ver",
                percent_encode(REDIRECT)
            )
        );
        assert!(!format!("{client:?}").contains("test-secret"));
    }

    #[test]
    fn google_reply_keeps_the_id_token_alone() {
        let body = r#"{"access_token":"fake-access","expires_in":3599,"scope":"openid",
                      "token_type":"Bearer","id_token":"a.b.c"}"#;
        let tokens = parse_google_tokens(body).unwrap();
        assert_eq!(tokens.id_token, "a.b.c");
        assert!(!format!("{tokens:?}").contains("a.b.c"));
        assert_eq!(
            parse_google_tokens(r#"{"error":"invalid_grant"}"#).unwrap_err(),
            OAuthError::Exchange
        );
    }

    #[test]
    fn github_token_reply() {
        let token =
            parse_github_token(r#"{"access_token":"fake-token","token_type":"bearer","scope":""}"#)
                .unwrap();
        assert_eq!(token.authorization(), "Bearer fake-token");
        assert!(!format!("{token:?}").contains("fake-token"));
        for bad in [
            r#"{"error":"bad_verification_code","error_description":"x"}"#,
            r#"{"access_token":"","token_type":"bearer"}"#,
            r#"{"access_token":"t","token_type":"mac"}"#,
            "not json",
        ] {
            assert_eq!(
                parse_github_token(bad).unwrap_err(),
                OAuthError::Exchange,
                "{bad}"
            );
        }
    }

    #[test]
    fn github_user_holds_the_id_alone() {
        let body = r#"{"login":"fake-login","id":4242,"name":"Fake Person",
                      "email":"fake@example.com","avatar_url":"https://example.com/a.png",
                      "public_repos":3}"#;
        let user = parse_github_user(body).unwrap();
        assert_eq!(user, GitHubUser { id: 4242 });
        assert_eq!(user.subject(), "4242");
        let debug = format!("{user:?}");
        assert_eq!(debug, "GitHubUser { id: 4242 }");
        for leak in ["fake-login", "Fake Person", "fake@example.com", "@"] {
            assert!(!debug.contains(leak));
        }
        assert_eq!(std::mem::size_of::<GitHubUser>(), 8);
        assert_eq!(
            parse_github_user(r#"{"login":"x"}"#).unwrap_err(),
            OAuthError::Provider
        );
        assert_eq!(
            parse_github_user(r#"{"id":-1}"#).unwrap_err(),
            OAuthError::Provider
        );
    }

    #[test]
    fn issuers() {
        assert_eq!(
            accepted_issuers(GOOGLE_ISSUER),
            ["https://accounts.google.com", "accounts.google.com"]
        );
        assert_eq!(
            accepted_issuers("http://127.0.0.1:9999"),
            ["http://127.0.0.1:9999"]
        );
    }

    #[test]
    fn local_overrides_only() {
        for ok in [
            "http://127.0.0.1:9999",
            "http://127.0.0.1:9999/token",
            "http://localhost/login/oauth/authorize",
            "https://localhost:8443?x",
        ] {
            assert!(is_local_override(ok), "{ok}");
        }
        for bad in [
            "https://accounts.google.com",
            "http://127.0.0.1.example.com/",
            "http://localhost.example.com",
            "http://user@localhost/",
            "http://example.com@127.0.0.1/",
            "http://127.0.0.1:/",
            "http://127.0.0.1:99x/",
            "ftp://localhost/",
            "localhost",
            "",
        ] {
            assert!(!is_local_override(bad), "{bad}");
        }
    }
}
