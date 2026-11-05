//! Sign-in, sessions and their checks, with no network and no randomness of their own
//! (docs/security.md, "Sign-in and sessions"; ADR 0006).
//!
//! Everything the Worker sends to Google, GitHub and Turnstile is built here, and everything it
//! reads back is parsed here, into types that hold only what the bakery keeps: a `sub`, a
//! numeric id, a verdict. Functions that need random bytes take them as arguments; the Worker
//! draws them from the platform.

mod account;
mod encoding;
mod id_token;
mod lockout;
mod oauth;
mod password;
mod session;
mod signing;
mod turnstile;

pub use account::{AccountKind, account_id, demo_username, is_demo_username};
pub use encoding::{base64url, base64url_decode, form, hex, is_lower_hex, percent_encode};
pub use id_token::{
    Discovery, Expected, IdTokenError, Identity, Jwk, JwkSet, SKEW_S, verify_google_id_token,
};
pub use lockout::{LOCKOUT_FAILURES, LOCKOUT_WINDOW_MS, Lockout};
pub use oauth::{
    Client, DEFAULT_RETURN, GOOGLE_ISSUER, GitHubToken, GitHubUser, GoogleTokens, OAUTH_VERSION,
    OAuthError, OAuthTransaction, Provider, accepted_issuers, github_authorize_url,
    github_token_request, google_authorize_url, google_token_request, is_local_override,
    issue_transaction, parse_github_token, parse_github_user, parse_google_tokens, pkce_challenge,
    return_path, verify_transaction,
};
pub use password::{
    ARGON2_M_KIB, ARGON2_P, ARGON2_T, MAX_PASSWORD_CHARS, MIN_PASSWORD_CHARS, PasswordError,
    PasswordPolicy, hash_password, verify_password,
};
pub use session::{
    OAUTH_COOKIE, OAUTH_TTL_S, SESSION_COOKIE, SESSION_TTL_S, SESSION_VERSION, SessionClaims,
    SessionError, clear_oauth_cookie, clear_session_cookie, cookie_value, issue, oauth_cookie,
    session_cookie, verify,
};
pub use signing::{Keyring, MIN_KEY_LEN, Purpose, SigningError, decode_token, encode_token, mac};
pub use turnstile::{SiteverifyResponse, siteverify_body};
