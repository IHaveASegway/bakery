//! The Analytics Engine SQL adapter and the status snapshot's refresh (docs/operations.md,
//! "Observability"). `bakery_app::analytics` holds the kept queries, builds each request and
//! reads each answer; this file adds the base URL, the token and the network, and the
//! 15-minute cron calls [`refresh`]. Nothing it sends or reads is logged: a line carries a
//! reason code, a query's name and a status, never the token, the account id or a body.
//!
//! Configuration, read from `Env`:
//!
//! - `ANALYTICS_API_TOKEN`, a secret: a Cloudflare account token with Account Analytics Read
//!   only, sent as `Authorization: Bearer`.
//! - `ANALYTICS_ACCOUNT_ID`, a secret: the account the dataset is in, a secret only because
//!   this repository's logs are public.
//! - `ANALYTICS_API_BASE`, a local override (default `https://api.cloudflare.com/client/v4`),
//!   honored only for loopback hosts; anything else logs `analytics_base_refused` and uses the
//!   default. `scripts/fake-analytics.mjs` serves it on `http://127.0.0.1:8792`.
//!
//! With either secret missing the refresh is skipped with `analytics_unconfigured`, and the
//! counters stay as they were (`unavailable` before any snapshot). A failed query logs
//! `analytics_failed` with its status, and `Control` keeps the old snapshot, marked stale. Each
//! query has 5 s; the refresh runs the two in turn (`counts_24h`, then `last_wipe`), inside the
//! cron's own wall limit, so 96 refreshes a day are 192 queries.

use bakery_app::Clock;
use bakery_app::analytics::{self as ae, KEPT, KeptQuery, ReadError, SqlAnswer};
use bakery_app::auth::is_local_override;
use worker::web_sys;
use worker::{AbortSignal, Env, Fetch, Headers, Method, Request, RequestInit, console_log};

use crate::clock::SystemClock;
use crate::config::read;
use crate::objects::control;

pub const TOKEN: &str = "ANALYTICS_API_TOKEN";
pub const ACCOUNT_ID: &str = "ANALYTICS_ACCOUNT_ID";
pub const API_BASE_VAR: &str = "ANALYTICS_API_BASE";

/// Why the refresh did not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unconfigured {
    /// The variable is unset or empty.
    Missing(&'static str),
    /// The account id is not letters and digits, so it cannot be put in a path.
    Shape(&'static str),
}

/// Why a query gave no answer: a reason code, and the status when there was one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failed {
    pub reason: &'static str,
    pub status: Option<u16>,
}

impl From<ReadError> for Failed {
    fn from(e: ReadError) -> Failed {
        Failed {
            reason: e.code(),
            status: e.status(),
        }
    }
}

/// The adapter, built from `Env` when both secrets are there.
pub struct Analytics {
    base: String,
    token: String,
    account: String,
}

/// The base to use, and whether a set override was refused for pointing off this machine.
fn resolve_base(value: Option<&str>) -> (String, bool) {
    match value {
        None => (ae::API_BASE.to_owned(), false),
        Some(v) if is_local_override(v) => (v.trim_end_matches('/').to_owned(), false),
        Some(_) => (ae::API_BASE.to_owned(), true),
    }
}

/// The two secrets, checked: what [`Analytics::from_env`] needs, pure for the tests.
fn check(token: Option<&str>, account: Option<&str>) -> Result<(), Unconfigured> {
    if token.is_none() {
        return Err(Unconfigured::Missing(TOKEN));
    }
    match account {
        None => Err(Unconfigured::Missing(ACCOUNT_ID)),
        Some(a) if !ae::is_account_id(a) => Err(Unconfigured::Shape(ACCOUNT_ID)),
        Some(_) => Ok(()),
    }
}

impl Analytics {
    pub fn from_env(env: &Env) -> Result<Analytics, Unconfigured> {
        let token = read(env, TOKEN);
        let account = read(env, ACCOUNT_ID);
        check(token.as_deref(), account.as_deref())?;
        let (base, refused) = resolve_base(read(env, API_BASE_VAR).as_deref());
        if refused {
            console_log!("{{\"event\":\"analytics_base_refused\",\"var\":\"{API_BASE_VAR}\"}}");
        }
        Ok(Analytics {
            base,
            token: token.unwrap_or_default(),
            account: account.unwrap_or_default(),
        })
    }

    /// One kept query, with [`ae::TIMEOUT_MS`] for the call and its body.
    pub async fn query(&self, query: &KeptQuery) -> Result<SqlAnswer, Failed> {
        let fail = |reason| Failed {
            reason,
            status: None,
        };
        let r = ae::sql_request(&self.account, query).ok_or(fail("account"))?;
        let headers = Headers::new();
        for (k, v) in r.headers(&self.token) {
            headers.set(k, &v).map_err(|_| fail("request"))?;
        }
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(r.body.into()));
        let req = Request::new_with_init(&r.url(&self.base), &init).map_err(|_| fail("request"))?;
        let signal = AbortSignal::from(web_sys::AbortSignal::timeout_with_u32(ae::TIMEOUT_MS));
        let mut res = Fetch::Request(req)
            .send_with_signal(&signal)
            .await
            .map_err(|_| {
                fail(if signal.aborted() {
                    "timeout"
                } else {
                    "unreachable"
                })
            })?;
        let status = res.status_code();
        let text = res.text().await.map_err(|_| {
            fail(if signal.aborted() {
                "timeout"
            } else {
                "unreachable"
            })
        })?;
        Ok(ae::read(status, &text)?)
    }
}

/// The 15-minute cron's refresh: the kept queries, then the snapshot in `Control`, or the
/// failure, so the old snapshot is served as stale. Never fails the cron.
pub async fn refresh(env: &Env) {
    let analytics = match Analytics::from_env(env) {
        Ok(a) => a,
        Err(Unconfigured::Missing(var)) => {
            console_log!("{{\"event\":\"analytics_unconfigured\",\"var\":\"{var}\"}}");
            return;
        }
        Err(Unconfigured::Shape(var)) => {
            console_log!(
                "{{\"event\":\"analytics_unconfigured\",\"var\":\"{var}\",\"reason\":\"shape\"}}"
            );
            return;
        }
    };
    let clock = SystemClock::new();
    let started = clock.now_wall();
    let mut answers = Vec::with_capacity(KEPT.len());
    let mut failure: Option<(&'static str, Failed)> = None;
    for query in &KEPT {
        match analytics.query(query).await {
            Ok(a) => answers.push(a),
            Err(f) => {
                failure = Some((query.name, f));
                break;
            }
        }
    }
    let counters = match failure {
        Some(f) => Err(f),
        None => ae::counters(&answers).map_err(|e| ("counters", Failed::from(e))),
    };
    let now = clock.now_wall();
    let ms = now.unix_ms() - started.unix_ms();
    match counters {
        Ok(counters) => {
            let snapshot = control::StatusSnapshot {
                as_of: now.to_string(),
                counters,
            };
            match control::store_snapshot(env, &snapshot).await {
                Ok(()) => console_log!(
                    "{{\"event\":\"analytics_refreshed\",\"queries\":{},\"ms\":{ms}}}",
                    KEPT.len()
                ),
                Err(e) => console_log!(
                    "{{\"event\":\"analytics_failed\",\"reason\":\"control\",\"error\":{:?}}}",
                    e.to_string()
                ),
            }
        }
        Err((query, f)) => {
            let status = f
                .status
                .map_or_else(|| "null".to_owned(), |s| s.to_string());
            console_log!(
                "{{\"event\":\"analytics_failed\",\"query\":\"{query}\",\"reason\":\"{}\",\"status\":{status},\"ms\":{ms}}}",
                f.reason
            );
            let failed = control::SnapshotFailed {
                at: now.to_string(),
            };
            if let Err(e) = control::snapshot_failed(env, &failed).await {
                console_log!(
                    "{{\"event\":\"analytics_failed\",\"reason\":\"control\",\"error\":{:?}}}",
                    e.to_string()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_base_is_overridden_on_this_machine_only() {
        assert_eq!(resolve_base(None), (ae::API_BASE.to_owned(), false));
        assert_eq!(
            resolve_base(Some("http://127.0.0.1:8792/")),
            ("http://127.0.0.1:8792".to_owned(), false)
        );
        for refused in [
            "https://api.example.com/client/v4",
            "http://127.0.0.1.example.com",
            "http://user@127.0.0.1:8792",
        ] {
            assert_eq!(
                resolve_base(Some(refused)),
                (ae::API_BASE.to_owned(), true),
                "{refused}"
            );
        }
    }

    #[test]
    fn both_secrets_are_needed_and_the_account_must_fit_a_path() {
        let account = "0123456789abcdef0123456789abcdef";
        assert_eq!(check(Some("t"), Some(account)), Ok(()));
        assert_eq!(
            check(None, Some(account)),
            Err(Unconfigured::Missing(TOKEN))
        );
        assert_eq!(
            check(Some("t"), None),
            Err(Unconfigured::Missing(ACCOUNT_ID))
        );
        assert_eq!(
            check(Some("t"), Some("../accounts")),
            Err(Unconfigured::Shape(ACCOUNT_ID))
        );
    }

    #[test]
    fn a_read_error_keeps_its_status() {
        assert_eq!(
            Failed::from(ReadError::Status(403)),
            Failed {
                reason: "status",
                status: Some(403)
            }
        );
    }
}
