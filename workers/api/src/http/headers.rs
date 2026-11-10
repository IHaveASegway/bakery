//! CORS and the API's response headers, exactly as docs/security.md tables them ("The API's
//! CORS"). The header sets are plain data so native tests can check them byte for byte.

use worker::{Response, Result};

/// The var holding the one origin CORS allows: `https://bakery.ihaveasegway.com`.
pub const ALLOWED_ORIGIN_VAR: &str = "ALLOWED_ORIGIN";

/// On every response, whatever the origin.
pub const SECURITY: &[(&str, &str)] = &[
    ("X-Content-Type-Options", "nosniff"),
    ("Cache-Control", "no-store"),
    (
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'",
    ),
    ("Referrer-Policy", "no-referrer"),
    ("Cross-Origin-Resource-Policy", "same-site"),
    // On every response, not only the allowed origin's: a cache must not serve the answer
    // without CORS headers to the storefront, nor the reverse.
    ("Vary", "Origin"),
];

/// On a response to the allowed origin.
const CORS_ALWAYS: &[(&str, &str)] = &[("Access-Control-Allow-Credentials", "true")];
/// Only on a preflight's answer.
const CORS_PREFLIGHT: &[(&str, &str)] = &[
    ("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE"),
    // `Authorization` is absent on purpose: no page can spend a visitor's API token.
    (
        "Access-Control-Allow-Headers",
        "Content-Type, Idempotency-Key, If-Match, If-None-Match",
    ),
    ("Access-Control-Max-Age", "7200"),
];
/// Only on an actual response, for the islands to read. `Bakery-Cache` says whether the menu
/// came from the Cache API (PR 4); `Bakery-Cause` names the cause a command's events carry
/// (2026-11-10, ADR 0013's postscript).
const CORS_ACTUAL: &[(&str, &str)] = &[(
    "Access-Control-Expose-Headers",
    "ETag, Location, Retry-After, Bakery-Cache, Bakery-Cause",
)];

/// The one `Cache-Control` a route may set instead of `no-store`: the menu's, which a browser
/// may keep and must revalidate with its `ETag` (docs/architecture.md, "Data ownership").
pub const REVALIDATE: &str = "private, no-cache";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyKind {
    Json,
    Problem,
}

impl BodyKind {
    pub fn content_type(self) -> &'static str {
        match self {
            BodyKind::Json => "application/json",
            BodyKind::Problem => "application/problem+json",
        }
    }
}

/// The CORS headers for a request from `origin`: all of them when it equals the allowed origin
/// exactly, none otherwise. Never reflected, never `*`.
pub fn cors(
    origin: Option<&str>,
    allowed: Option<&str>,
    preflight: bool,
) -> Vec<(&'static str, String)> {
    let Some(origin) = origin.filter(|o| Some(*o) == allowed && !o.is_empty()) else {
        return Vec::new();
    };
    let extra = if preflight {
        CORS_PREFLIGHT
    } else {
        CORS_ACTUAL
    };
    std::iter::once(("Access-Control-Allow-Origin", origin.to_owned()))
        .chain(
            CORS_ALWAYS
                .iter()
                .chain(extra)
                .map(|&(k, v)| (k, v.to_owned())),
        )
        .collect()
}

pub fn body_kind(res: &Response) -> Option<BodyKind> {
    let ct = res.headers().get("Content-Type").ok().flatten()?;
    if ct.starts_with("application/problem+json") {
        Some(BodyKind::Problem)
    } else if ct.starts_with("application/json") {
        Some(BodyKind::Json)
    } else {
        None
    }
}

/// Sets every header the response needs, last, so no route can forget one.
pub fn apply(
    res: &mut Response,
    origin: Option<&str>,
    allowed: Option<&str>,
    preflight: bool,
) -> Result<()> {
    let kind = body_kind(res);
    let headers = res.headers_mut();
    match kind {
        Some(kind) => headers.set("Content-Type", kind.content_type())?,
        None => headers.delete("Content-Type")?,
    }
    let revalidate = headers.get("Cache-Control")?.as_deref() == Some(REVALIDATE);
    for (k, v) in SECURITY {
        if *k == "Cache-Control" && revalidate {
            continue;
        }
        headers.set(k, v)?;
    }
    for (k, v) in cors(origin, allowed, preflight) {
        headers.set(k, &v)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const STOREFRONT: &str = "https://bakery.ihaveasegway.com";

    fn names(h: &[(&'static str, String)]) -> Vec<&'static str> {
        h.iter().map(|(k, _)| *k).collect()
    }

    #[test]
    fn the_storefront_gets_exact_headers() {
        let h = cors(Some(STOREFRONT), Some(STOREFRONT), false);
        assert_eq!(
            h,
            vec![
                ("Access-Control-Allow-Origin", STOREFRONT.to_owned()),
                ("Access-Control-Allow-Credentials", "true".to_owned()),
                (
                    "Access-Control-Expose-Headers",
                    "ETag, Location, Retry-After, Bakery-Cache, Bakery-Cause".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn a_preflight_gets_methods_headers_and_max_age() {
        let h = cors(Some(STOREFRONT), Some(STOREFRONT), true);
        assert_eq!(
            names(&h),
            [
                "Access-Control-Allow-Origin",
                "Access-Control-Allow-Credentials",
                "Access-Control-Allow-Methods",
                "Access-Control-Allow-Headers",
                "Access-Control-Max-Age",
            ]
        );
        assert!(h.contains(&("Access-Control-Max-Age", "7200".to_owned())));
        assert!(!h.iter().any(|(_, v)| v.contains("Authorization")));
    }

    #[test]
    fn any_other_origin_gets_nothing() {
        for origin in [
            Some("https://example.com"),
            Some("https://bakery.ihaveasegway.com.example.com"),
            Some("http://bakery.ihaveasegway.com"),
            Some("https://BAKERY.ihaveasegway.com"),
            Some("https://bakery.ihaveasegway.com/"),
            Some("null"),
            Some(""),
            None,
        ] {
            assert!(
                cors(origin, Some(STOREFRONT), false).is_empty(),
                "{origin:?}"
            );
            assert!(
                cors(origin, Some(STOREFRONT), true).is_empty(),
                "{origin:?}"
            );
        }
    }

    #[test]
    fn no_configured_origin_allows_nothing() {
        assert!(cors(Some(STOREFRONT), None, false).is_empty());
        assert!(cors(Some(""), Some(""), false).is_empty());
    }

    #[test]
    fn security_headers_match_the_doc() {
        let get = |k: &str| SECURITY.iter().find(|(n, _)| *n == k).map(|(_, v)| *v);
        assert_eq!(get("X-Content-Type-Options"), Some("nosniff"));
        assert_eq!(get("Cache-Control"), Some("no-store"));
        assert_eq!(
            get("Content-Security-Policy"),
            Some("default-src 'none'; frame-ancestors 'none'")
        );
        assert_eq!(get("Referrer-Policy"), Some("no-referrer"));
        assert_eq!(get("Cross-Origin-Resource-Policy"), Some("same-site"));
        assert_eq!(get("Vary"), Some("Origin"));
    }
}
