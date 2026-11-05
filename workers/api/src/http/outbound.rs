//! Requests the Worker makes to the providers, and the per-isolate caches and limits around
//! them. Nothing read here is logged: a reply's body goes to a parser in bakery-app that keeps
//! only what the bakery stores.

use std::cell::{Cell, RefCell};

use bakery_app::auth::{SiteverifyResponse, siteverify_body};
use bakery_app::log::ip_hash;
use bakery_domain::WallTime;
use worker::{Env, Fetch, Headers, Method, Request, RequestInit, Result, console_log};

use super::problem::{self, Failure};
use crate::config::Config;
use crate::objects::control;

/// A provider's reply: the status, the body, and `Cache-Control: max-age` if it sent one.
pub struct Reply {
    pub status: u16,
    pub body: String,
    pub max_age_s: Option<i64>,
}

impl Reply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

pub async fn send(
    method: Method,
    url: &str,
    headers: &[(&str, &str)],
    form_body: Option<&str>,
) -> Result<Reply> {
    let h = Headers::new();
    for (k, v) in headers {
        h.set(k, v)?;
    }
    let mut init = RequestInit::new();
    init.with_method(method);
    if let Some(body) = form_body {
        h.set("Content-Type", "application/x-www-form-urlencoded")?;
        init.with_body(Some(body.into()));
    }
    init.with_headers(h);
    let req = Request::new_with_init(url, &init)?;
    let mut res = Fetch::Request(req).send().await?;
    let max_age_s = res
        .headers()
        .get("Cache-Control")?
        .as_deref()
        .and_then(max_age);
    Ok(Reply {
        status: res.status_code(),
        body: res.text().await?,
        max_age_s,
    })
}

/// `max-age=N` from a `Cache-Control` value.
pub fn max_age(value: &str) -> Option<i64> {
    value.split(',').find_map(|part| {
        part.trim()
            .strip_prefix("max-age=")
            .and_then(|n| n.trim().parse().ok())
    })
}

/// Turnstile's siteverify with the secret and the token only: no `remoteip`, so the visitor's
/// address is in one request fewer (docs/security.md, "Sandbox isolation"). An unreachable or
/// unreadable siteverify is a failure, never a pass.
pub async fn siteverify(cfg: &Config, token: Option<&str>) -> std::result::Result<(), Failure> {
    let secret = cfg.turnstile_secret()?;
    let Some(token) = token.filter(|t| !t.is_empty()) else {
        return Err(problem::turnstile().because("turnstile-missing"));
    };
    let reply = send(
        Method::Post,
        &cfg.turnstile_url,
        &[],
        Some(&siteverify_body(secret, token)),
    )
    .await
    .map_err(|_| problem::turnstile().because("siteverify-unreachable"))?;
    if SiteverifyResponse::parse(&reply.body).success {
        Ok(())
    } else {
        Err(problem::turnstile())
    }
}

/// How long the router keeps `Control`'s daily salt (pr3 spec, "Objects").
const SALT_CACHE_MS: i64 = 30_000;

struct CachedSalt {
    day: String,
    salt: String,
    fetched_ms: i64,
}

thread_local! {
    static SALT: RefCell<Option<CachedSalt>> = const { RefCell::new(None) };
    static LIMITER_WARNED: Cell<bool> = const { Cell::new(false) };
}

/// The request's IP hash, from the day's salt. `None` when the request has no
/// `CF-Connecting-IP` or `Control` cannot be reached: the line is still written.
pub async fn ip_hash_for(env: &Env, ip: Option<&str>, now: WallTime) -> Option<String> {
    let ip = ip?;
    let day = now.utc_day();
    let cached = SALT.with_borrow(|s| {
        s.as_ref()
            .filter(|c| c.day == day && now.unix_ms() - c.fetched_ms < SALT_CACHE_MS)
            .map(|c| c.salt.clone())
    });
    let salt = match cached {
        Some(salt) => salt,
        None => {
            let fresh = control::salt(env).await.ok()?;
            SALT.with_borrow_mut(|s| {
                *s = Some(CachedSalt {
                    day: fresh.day,
                    salt: fresh.salt.clone(),
                    fetched_ms: now.unix_ms(),
                })
            });
            fresh.salt
        }
    };
    // The salt's hex text is the HMAC key: 64 characters carrying its 256 random bits.
    Some(ip_hash(salt.as_bytes(), ip))
}

/// One unit from a rate-limit binding. A missing or failing binding lets the request through
/// and logs `rate_limit_unavailable` once per isolate: `Control`'s caps still bound the day.
pub async fn within_limit(env: &Env, binding: &str, key: String) -> bool {
    let outcome = match env.rate_limiter(binding) {
        Ok(limiter) => limiter.limit(key).await.map(|o| o.success),
        Err(e) => Err(e),
    };
    match outcome {
        Ok(success) => success,
        Err(_) => {
            if !LIMITER_WARNED.replace(true) {
                console_log!("{{\"event\":\"rate_limit_unavailable\",\"binding\":{binding:?}}}");
            }
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::max_age;

    #[test]
    fn reads_max_age() {
        assert_eq!(
            max_age("public, max-age=19663, must-revalidate, no-transform"),
            Some(19663)
        );
        assert_eq!(max_age("max-age=0"), Some(0));
        assert_eq!(max_age("no-store"), None);
        assert_eq!(max_age("max-age=abc"), None);
    }
}
