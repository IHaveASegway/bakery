//! The checks every command passes before any object is asked: Origin and `Sec-Fetch-Site`
//! (docs/security.md, "Origin checks") and the `Idempotency-Key` (docs/domain.md,
//! "Idempotency"). Pure, so they are tested natively.

use bakery_domain::Ulid;

/// Whether a method changes state and so needs the Origin check.
pub fn is_command(method: &str) -> bool {
    matches!(method, "POST" | "PATCH" | "DELETE")
}

/// `Origin` must equal the allowed origin exactly, and `Sec-Fetch-Site` must not say
/// `cross-site`. The error is the log line's reason.
pub fn check_origin(
    origin: Option<&str>,
    sec_fetch_site: Option<&str>,
    allowed: &str,
) -> Result<(), &'static str> {
    if sec_fetch_site.is_some_and(|s| s.eq_ignore_ascii_case("cross-site")) {
        return Err("cross-site");
    }
    match origin {
        None => Err("no-origin"),
        Some(o) if !allowed.is_empty() && o == allowed => Ok(()),
        Some(_) => Err("origin"),
    }
}

/// The key must be a canonical ULID.
pub fn idempotency_key(value: Option<&str>) -> Option<Ulid> {
    value.and_then(|v| v.parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    const STOREFRONT: &str = "https://bakery.ihaveasegway.com";

    #[test]
    fn origin_exact_and_not_cross_site() {
        assert_eq!(check_origin(Some(STOREFRONT), None, STOREFRONT), Ok(()));
        assert_eq!(
            check_origin(Some(STOREFRONT), Some("same-site"), STOREFRONT),
            Ok(())
        );
        assert_eq!(
            check_origin(Some(STOREFRONT), Some("cross-site"), STOREFRONT),
            Err("cross-site")
        );
        assert_eq!(check_origin(None, None, STOREFRONT), Err("no-origin"));
        for bad in [
            "https://example.com",
            "https://bakery.ihaveasegway.com.example.com",
            "http://bakery.ihaveasegway.com",
            "https://bakery.ihaveasegway.com/",
            "null",
            "",
        ] {
            assert_eq!(
                check_origin(Some(bad), None, STOREFRONT),
                Err("origin"),
                "{bad}"
            );
        }
        assert_eq!(check_origin(Some(""), None, ""), Err("origin"));
        assert!(is_command("DELETE") && is_command("POST") && !is_command("GET"));
    }

    #[test]
    fn keys_are_canonical_ulids() {
        assert!(idempotency_key(Some("01JC8Z6K3W9QF2N4T7XRB5M0HD")).is_some());
        for bad in [
            None,
            Some(""),
            Some("01jc8z6k3w9qf2n4t7xrb5m0hd"),
            Some("not-a-ulid"),
            Some("01JC8Z6K3W9QF2N4T7XRB5M0H"),
        ] {
            assert!(idempotency_key(bad).is_none(), "{bad:?}");
        }
    }
}
