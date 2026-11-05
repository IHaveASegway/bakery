//! Account ids and demo usernames (docs/architecture.md, "Object naming"; ADR 0006, decisions
//! 3 to 5).
//!
//! An account id is `hex(HMAC-SHA256(ACCOUNT_HMAC_KEY, "<kind>:" + subject))`: Google's `sub`,
//! GitHub's numeric `id` in decimal, or a demo username. The prefix keeps the providers' id
//! spaces apart, and the HMAC means the store holds no provider identifier: someone holding
//! the database cannot look a visitor up at Google or GitHub.

use bakery_contracts::SessionKind;
use serde::{Deserialize, Serialize};

use super::encoding::hex;
use super::signing::mac;

/// How an account signs in. A guest has no account, so it is not here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountKind {
    Google,
    Github,
    Demo,
}

impl AccountKind {
    /// The HMAC input's prefix, and the text in the `Account`'s `meta` table.
    pub fn as_str(self) -> &'static str {
        match self {
            AccountKind::Google => "google",
            AccountKind::Github => "github",
            AccountKind::Demo => "demo",
        }
    }

    pub fn parse(text: &str) -> Option<AccountKind> {
        match text {
            "google" => Some(AccountKind::Google),
            "github" => Some(AccountKind::Github),
            "demo" => Some(AccountKind::Demo),
            _ => None,
        }
    }

    pub fn session_kind(self) -> SessionKind {
        match self {
            AccountKind::Google => SessionKind::Google,
            AccountKind::Github => SessionKind::Github,
            AccountKind::Demo => SessionKind::Demo,
        }
    }
}

/// The account id: 64 lower-case hex characters. `subject` is the provider's identifier with
/// no prefix (`AccountKind::Github` and `"12345"`, not `"github:12345"`); the prefix is added
/// here, so no caller can get it wrong. The key is `ACCOUNT_HMAC_KEY`, whose rotation orphans
/// every Google and GitHub mapping (ADR 0006, "Consequences").
pub fn account_id(account_hmac_key: &[u8], kind: AccountKind, subject: &str) -> String {
    let input = format!("{}:{subject}", kind.as_str());
    hex(&mac(account_hmac_key, input.as_bytes()))
}

const USERNAME_PREFIX: &str = "baker-";
/// Crockford's base32 in lower case without `i`, `l`, `o` and `u`: no letter reads as a digit,
/// and no four characters spell much.
const USERNAME_ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
const USERNAME_SUFFIX_LEN: usize = 4;

/// A demo username such as `baker-7f3k`, from four random bytes the platform drew. One
/// character per byte, modulo 32, which is uniform because 256 is a multiple of 32. The space
/// is 32^4, about a million names; at 100 demo accounts a day a clash is rare, and the
/// `Account` refuses to create over an existing one, so the Worker draws again.
pub fn demo_username(random: &[u8; 4]) -> String {
    let mut name = String::with_capacity(USERNAME_PREFIX.len() + USERNAME_SUFFIX_LEN);
    name.push_str(USERNAME_PREFIX);
    for &b in random {
        name.push(char::from(USERNAME_ALPHABET[usize::from(b % 32)]));
    }
    name
}

/// Whether typed input is a demo username this module could have generated. A sign-in with
/// anything else is refused before an object is named for it.
pub fn is_demo_username(text: &str) -> bool {
    text.strip_prefix(USERNAME_PREFIX).is_some_and(|suffix| {
        suffix.len() == USERNAME_SUFFIX_LEN
            && suffix.bytes().all(|b| USERNAME_ALPHABET.contains(&b))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::encoding::is_lower_hex;

    const ACCOUNT_KEY: &[u8] = b"test-account-key-0123456789abcdef";

    #[test]
    fn account_ids_are_prefixed_hmacs() {
        let id = account_id(ACCOUNT_KEY, AccountKind::Github, "12345");
        assert!(is_lower_hex(&id, 64));
        assert_eq!(id, hex(&mac(ACCOUNT_KEY, b"github:12345")));
        // The prefix keeps the providers apart.
        assert_ne!(id, account_id(ACCOUNT_KEY, AccountKind::Google, "12345"));
        assert_ne!(
            id,
            account_id(
                b"another-account-key-0123456789ab",
                AccountKind::Github,
                "12345"
            )
        );
        assert_eq!(
            account_id(ACCOUNT_KEY, AccountKind::Demo, "baker-7f3k"),
            hex(&mac(ACCOUNT_KEY, b"demo:baker-7f3k"))
        );
    }

    #[test]
    fn kinds_round_trip() {
        for kind in [AccountKind::Google, AccountKind::Github, AccountKind::Demo] {
            assert_eq!(AccountKind::parse(kind.as_str()), Some(kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
            assert_eq!(
                serde_json::to_value(kind.session_kind()).unwrap(),
                kind.as_str()
            );
        }
    }

    #[test]
    fn demo_usernames() {
        assert_eq!(demo_username(&[7, 15, 3, 19]), "baker-7f3k");
        // Modulo 32: 39 is 7, 255 is 31.
        assert_eq!(demo_username(&[39, 255, 0, 32]), "baker-7z00");
        for b in 0..=255u8 {
            let name = demo_username(&[b, b, b, b]);
            assert!(is_demo_username(&name), "{name}");
            for banned in ['i', 'l', 'o', 'u'] {
                assert!(!name[6..].contains(banned));
            }
        }
        for bad in [
            "baker-7f3",
            "baker-7f3kk",
            "baker-7F3K",
            "baker-7f3i",
            "Baker-7f3k",
            "7f3k",
            "",
        ] {
            assert!(!is_demo_username(bad), "{bad}");
        }
    }
}
