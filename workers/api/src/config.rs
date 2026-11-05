//! The Worker's configuration, read from `Env` once per request: the public vars from
//! wrangler.jsonc, the secrets from `.dev.vars` locally and Worker secrets at launch, and the
//! local provider overrides (docs/security.md, "Secrets inventory").
//!
//! A secret is read only by a route that needs it, so health and status answer on a machine
//! with no `.dev.vars` at all. A route whose secret is missing answers 503 problem `config`
//! naming the variable and nothing else, so a half-filled `.dev.vars` is easy to diagnose.

use bakery_app::admission::Caps;
use bakery_app::auth::{GOOGLE_ISSUER, Keyring, is_local_override};
use worker::{Env, console_log};

use crate::http::ALLOWED_ORIGIN_VAR as ALLOWED_ORIGIN;

/// The defaults when an override is unset, or refused.
const DEFAULT_GITHUB_AUTHORIZE_URL: &str = "https://github.com/login/oauth/authorize";
const DEFAULT_GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const DEFAULT_GITHUB_USER_URL: &str = "https://api.github.com/user";
const DEFAULT_TURNSTILE_SITEVERIFY_URL: &str =
    "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/// A variable a route needs and cannot use. Carries the name, never a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigError {
    Missing(&'static str),
    /// Present but unusable, such as a signing key under 32 bytes.
    Invalid(&'static str),
}

impl ConfigError {
    pub fn name(self) -> &'static str {
        match self {
            ConfigError::Missing(n) | ConfigError::Invalid(n) => n,
        }
    }

    pub fn detail(self) -> String {
        let n = self.name();
        match self {
            ConfigError::Missing(_) => format!(
                "The API is missing {n}. Set it in workers/api/.dev.vars locally, or as a Worker secret."
            ),
            ConfigError::Invalid(_) => format!(
                "The API cannot use {n}: a signing key needs at least 32 bytes. Set a longer one."
            ),
        }
    }
}

pub struct Config {
    pub allowed_origin: Option<String>,
    api_origin: Option<String>,
    pub caps: Caps,
    session_key: Option<String>,
    session_key_prev: Option<String>,
    account_key: Option<String>,
    turnstile_secret: Option<String>,
    google_client_id: Option<String>,
    google_client_secret: Option<String>,
    github_client_id: Option<String>,
    github_client_secret: Option<String>,
    pub google_issuer: String,
    pub github_authorize_url: String,
    pub github_token_url: String,
    pub github_user_url: String,
    pub turnstile_url: String,
}

impl Config {
    pub fn from_env(env: &Env) -> Config {
        Config {
            allowed_origin: read(env, ALLOWED_ORIGIN),
            api_origin: read(env, "API_ORIGIN"),
            caps: caps_from_env(env),
            session_key: read(env, "SESSION_HMAC_KEY"),
            session_key_prev: read(env, "SESSION_HMAC_KEY_PREV"),
            account_key: read(env, "ACCOUNT_HMAC_KEY"),
            turnstile_secret: read(env, "TURNSTILE_SECRET"),
            google_client_id: read(env, "GOOGLE_CLIENT_ID"),
            google_client_secret: read(env, "GOOGLE_CLIENT_SECRET"),
            github_client_id: read(env, "GITHUB_CLIENT_ID"),
            github_client_secret: read(env, "GITHUB_CLIENT_SECRET"),
            google_issuer: provider_url(env, "GOOGLE_ISSUER", GOOGLE_ISSUER),
            github_authorize_url: provider_url(
                env,
                "GITHUB_AUTHORIZE_URL",
                DEFAULT_GITHUB_AUTHORIZE_URL,
            ),
            github_token_url: provider_url(env, "GITHUB_TOKEN_URL", DEFAULT_GITHUB_TOKEN_URL),
            github_user_url: provider_url(env, "GITHUB_USER_URL", DEFAULT_GITHUB_USER_URL),
            turnstile_url: provider_url(
                env,
                "TURNSTILE_SITEVERIFY_URL",
                DEFAULT_TURNSTILE_SITEVERIFY_URL,
            ),
        }
    }

    pub fn origin(&self) -> Result<&str, ConfigError> {
        need(&self.allowed_origin, ALLOWED_ORIGIN)
    }

    /// This API's origin, the base of the OAuth redirect URIs.
    pub fn api_origin(&self) -> Result<&str, ConfigError> {
        need(&self.api_origin, "API_ORIGIN").map(|o| o.trim_end_matches('/'))
    }

    /// The session keyring: `SESSION_HMAC_KEY` signs, `SESSION_HMAC_KEY_PREV` also verifies
    /// during a rotation. `kid` 1 is the current key's label; a rotation moves it to 2.
    pub fn keyring(&self) -> Result<Keyring, ConfigError> {
        let current = need(&self.session_key, "SESSION_HMAC_KEY")?;
        let previous = self
            .session_key_prev
            .as_ref()
            .map(|k| k.as_bytes().to_vec());
        Keyring::new(current.as_bytes(), previous, 1).map_err(|_| {
            if current.len() < bakery_app::auth::MIN_KEY_LEN {
                ConfigError::Invalid("SESSION_HMAC_KEY")
            } else {
                ConfigError::Invalid("SESSION_HMAC_KEY_PREV")
            }
        })
    }

    pub fn account_key(&self) -> Result<&[u8], ConfigError> {
        need(&self.account_key, "ACCOUNT_HMAC_KEY").map(str::as_bytes)
    }

    pub fn turnstile_secret(&self) -> Result<&str, ConfigError> {
        need(&self.turnstile_secret, "TURNSTILE_SECRET")
    }

    pub fn google(&self) -> Result<(&str, &str), ConfigError> {
        Ok((
            need(&self.google_client_id, "GOOGLE_CLIENT_ID")?,
            need(&self.google_client_secret, "GOOGLE_CLIENT_SECRET")?,
        ))
    }

    pub fn github(&self) -> Result<(&str, &str), ConfigError> {
        Ok((
            need(&self.github_client_id, "GITHUB_CLIENT_ID")?,
            need(&self.github_client_secret, "GITHUB_CLIENT_SECRET")?,
        ))
    }
}

fn need<'a>(value: &'a Option<String>, name: &'static str) -> Result<&'a str, ConfigError> {
    value.as_deref().ok_or(ConfigError::Missing(name))
}

/// A var or secret as text; unset and empty are the same.
fn read(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|v| v.to_string())
        .filter(|v| !v.is_empty())
}

/// An override honored only on this machine; anything else logs its name and uses the default.
fn provider_url(env: &Env, name: &'static str, default: &str) -> String {
    let (url, refused) = resolve_override(read(env, name).as_deref(), default);
    if refused {
        console_log!("{{\"event\":\"provider_override_refused\",\"var\":{name:?}}}");
    }
    url
}

/// The URL to use, and whether a set override was refused for pointing off this machine.
fn resolve_override(value: Option<&str>, default: &str) -> (String, bool) {
    match value {
        None => (default.to_owned(), false),
        Some(v) if is_local_override(v) => (v.trim_end_matches('/').to_owned(), false),
        Some(_) => (default.to_owned(), true),
    }
}

/// Minutes of simulated traffic a sandbox may run in a UTC day (docs/cost.md, "Guardrails": 30).
pub const DEFAULT_TRAFFIC_MINUTES_CAP: u16 = 30;

/// `TRAFFIC_MINUTES_CAP`, read by `Control`, which owns the ledger, and by the `Simulator`, which
/// shows what is left. A local run may lower it to reach the cap in minutes; an unset or
/// unreadable var is the default.
pub fn traffic_minutes_cap(env: &Env) -> u16 {
    read(env, "TRAFFIC_MINUTES_CAP")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_TRAFFIC_MINUTES_CAP)
}

/// The daily caps from the vars, each falling back to its default (docs/cost.md, "Guardrails").
pub fn caps_from_env(env: &Env) -> Caps {
    let d = Caps::default();
    let cap = |name: &str, default: u32| {
        read(env, name)
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    };
    Caps {
        sandboxes: cap("SANDBOX_CAP", d.sandboxes),
        guests: cap("GUEST_SANDBOX_CAP", d.guests),
        demo_accounts: cap("DEMO_ACCOUNT_CAP", d.demo_accounts),
        account_sandboxes: cap("ACCOUNT_SANDBOX_CAP", d.account_sandboxes),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_only_for_this_machine() {
        let d = "https://github.com/login/oauth/access_token";
        assert_eq!(resolve_override(None, d), (d.to_owned(), false));
        assert_eq!(
            resolve_override(
                Some("http://127.0.0.1:8790/github/login/oauth/access_token"),
                d
            ),
            (
                "http://127.0.0.1:8790/github/login/oauth/access_token".to_owned(),
                false
            )
        );
        assert_eq!(
            resolve_override(Some("http://localhost:8790/google/"), d),
            ("http://localhost:8790/google".to_owned(), false)
        );
        for refused in [
            "https://example.com/token",
            "http://127.0.0.1.example.com/token",
            "http://user@127.0.0.1/token",
            "file:///etc/passwd",
        ] {
            assert_eq!(
                resolve_override(Some(refused), d),
                (d.to_owned(), true),
                "{refused}"
            );
        }
    }

    #[test]
    fn config_errors_name_the_variable_and_nothing_else() {
        let e = ConfigError::Missing("GOOGLE_CLIENT_SECRET");
        assert_eq!(e.name(), "GOOGLE_CLIENT_SECRET");
        assert!(e.detail().contains("GOOGLE_CLIENT_SECRET"));
        assert!(
            ConfigError::Invalid("SESSION_HMAC_KEY")
                .detail()
                .contains("32 bytes")
        );
    }
}
