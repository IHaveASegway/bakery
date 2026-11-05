//! What a Stripe key is, read from its prefix (ADR 0007, decision 2; docs/security.md, "Payments
//! safety"). A sandbox's keys start `pk_test_`, `sk_test_` and `rk_test_`; an account's other
//! mode uses the same three letters with the other mode word, and endpoint secrets start
//! `whsec_` (as read from Stripe's dashboard on 2026-11-04).
//!
//! The Worker calls Stripe only with a key that classifies as [`KeyKind::Test`] and is a secret
//! or restricted key ([`is_sandbox_secret_key`]); anything else answers 503 `stripe-key`.

/// A key's mode, as its prefix says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KeyKind {
    /// A sandbox key (`sk_`, `rk_` or `pk_` then `test_`), or an endpoint secret (`whsec_`),
    /// which carries no mode of its own and is accepted on its shape.
    Test,
    /// The same three prefixes with the other mode word: never accepted.
    Live,
    /// Anything else, including an empty value and a bare prefix.
    Other,
}

/// What a key is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KeyRole {
    /// `sk_`: a secret key.
    Secret,
    /// `rk_`: a restricted key, the one ADR 0007 asks for.
    Restricted,
    /// `pk_`: the publishable key the storefront compiles in.
    Publishable,
    /// `whsec_`: a webhook endpoint's signing secret.
    WebhookSecret,
}

/// The parts of `<role>_<mode>_<rest>`, or of `whsec_<rest>`, with a non-empty `rest` of ASCII
/// letters, digits and underscores.
fn parts(key: &str) -> Option<(KeyRole, Option<&str>)> {
    let well_formed = |rest: &str| {
        !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    };
    if let Some(rest) = key.strip_prefix("whsec_") {
        return well_formed(rest).then_some((KeyRole::WebhookSecret, None));
    }
    let (role, rest) = key.split_once('_')?;
    let role = match role {
        "sk" => KeyRole::Secret,
        "rk" => KeyRole::Restricted,
        "pk" => KeyRole::Publishable,
        _ => return None,
    };
    let (mode, rest) = rest.split_once('_')?;
    well_formed(rest).then_some((role, Some(mode)))
}

impl KeyKind {
    pub fn classify(key: &str) -> KeyKind {
        match parts(key) {
            Some((KeyRole::WebhookSecret, None)) => KeyKind::Test,
            Some((_, Some("test"))) => KeyKind::Test,
            Some((_, Some("live"))) => KeyKind::Live,
            _ => KeyKind::Other,
        }
    }
}

/// The key's role, if it is shaped like a Stripe key at all.
pub fn key_role(key: &str) -> Option<KeyRole> {
    parts(key).map(|(role, _)| role)
}

/// The guard on `STRIPE_SECRET_KEY`: a sandbox secret or restricted key, nothing else.
pub fn is_sandbox_secret_key(key: &str) -> bool {
    KeyKind::classify(key) == KeyKind::Test
        && matches!(key_role(key), Some(KeyRole::Secret | KeyRole::Restricted))
}

/// The guard on `STRIPE_WEBHOOK_SECRET`.
pub fn is_webhook_secret(key: &str) -> bool {
    key_role(key) == Some(KeyRole::WebhookSecret)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A key in the mode the bakery never uses, built from parts so no such prefix is written
    /// out anywhere in the tree.
    fn other_mode(role: &str) -> String {
        format!("{role}_{}_fake000000000000000000000000", "live")
    }

    #[test]
    fn classifies_by_prefix() {
        for key in [
            "sk_test_not_a_key",
            "rk_test_not_a_key",
            "pk_test_not_a_key",
            "whsec_not_a_secret",
        ] {
            assert_eq!(KeyKind::classify(key), KeyKind::Test, "{key}");
        }
        for role in ["sk", "rk", "pk"] {
            assert_eq!(
                KeyKind::classify(&other_mode(role)),
                KeyKind::Live,
                "{role}"
            );
        }
        for key in [
            "",
            "sk_test_",
            "whsec_",
            "sk_fake000",
            "xk_test_fake000",
            "sk_test_fake 000",
            "SK_TEST_fake000",
            "sk_demo_fake000",
            "Bearer sk_test_not_a_key",
        ] {
            assert_eq!(KeyKind::classify(key), KeyKind::Other, "{key:?}");
        }
    }

    #[test]
    fn the_secret_key_guard_takes_sandbox_secret_and_restricted_keys_only() {
        assert!(is_sandbox_secret_key("sk_test_not_a_key"));
        assert!(is_sandbox_secret_key("rk_test_not_a_key"));
        assert!(!is_sandbox_secret_key("pk_test_not_a_key"));
        assert!(!is_sandbox_secret_key("whsec_not_a_secret"));
        assert!(!is_sandbox_secret_key(&other_mode("sk")));
        assert!(!is_sandbox_secret_key(&other_mode("rk")));
        assert!(!is_sandbox_secret_key(""));
        assert!(is_webhook_secret("whsec_not_a_secret"));
        assert!(!is_webhook_secret("sk_test_not_a_key"));
        assert_eq!(key_role("rk_test_not_a_key"), Some(KeyRole::Restricted));
        assert_eq!(key_role("pk_test_not_a_key"), Some(KeyRole::Publishable));
        assert_eq!(key_role("nope"), None);
    }
}
