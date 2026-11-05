//! Object names, built by the server only (docs/architecture.md, "Object naming"; domain.md,
//! "Identifiers"). A client never names an object: every name here is made from a server-minted
//! id or a verified claim, before `id_from_name`.

use bakery_domain::Ulid;

/// `Control`'s one name.
pub const CONTROL: &str = "control";

/// `account:<64 hex>`, from [`crate::auth::account_id`].
pub fn account_object_name(account_id: &str) -> String {
    format!("account:{account_id}")
}

/// `sandbox:<ULID>`.
pub fn sandbox_object_name(sandbox: Ulid) -> String {
    format!("sandbox:{sandbox}")
}

/// A guest sandbox's owner, as the `Sandbox` stores it: `guest:<ULID>`. A guest has no
/// `Account` object.
pub fn guest_owner(guest: Ulid) -> String {
    format!("guest:{guest}")
}

/// A signed-in sandbox's owner, as the `Sandbox` stores it: the account's object name.
pub fn account_owner(account_id: &str) -> String {
    account_object_name(account_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        let id: Ulid = "01JC8Z6K3W9QF2N4T7XRB5M0HD".parse().unwrap();
        assert_eq!(
            sandbox_object_name(id),
            "sandbox:01JC8Z6K3W9QF2N4T7XRB5M0HD"
        );
        assert_eq!(guest_owner(id), "guest:01JC8Z6K3W9QF2N4T7XRB5M0HD");
        let acct = "ab".repeat(32);
        assert_eq!(account_object_name(&acct), format!("account:{acct}"));
        assert_eq!(account_owner(&acct), account_object_name(&acct));
        assert_eq!(CONTROL, "control");
    }
}
