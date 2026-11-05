//! Demo passwords (docs/security.md, "Demo accounts").
//!
//! 12 to 128 characters with no composition rules (NIST SP 800-63B), hashed with argon2id at
//! OWASP's first recommended parameters, m = 19,456 KiB, t = 2, p = 1, and a 16-byte salt the
//! Worker draws, stored as a PHC string. The hash runs in the stateless Worker, not in the
//! `Account`, so the object's handler stays short. No error carries the password.

use argon2::password_hash::phc::PasswordHash;
use argon2::{Algorithm, Argon2, Params, PasswordHasher, PasswordVerifier, Version};
use thiserror::Error;

pub const MIN_PASSWORD_CHARS: usize = 12;
pub const MAX_PASSWORD_CHARS: usize = 128;
/// OWASP Password Storage Cheat Sheet, argon2id's second listed configuration (read
/// 2026-11-04); spike S1 measures its CPU time in workerd.
pub const ARGON2_M_KIB: u32 = 19_456;
pub const ARGON2_T: u32 = 2;
pub const ARGON2_P: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum PasswordError {
    #[error("a password needs at least {MIN_PASSWORD_CHARS} characters")]
    TooShort,
    #[error("a password has at most {MAX_PASSWORD_CHARS} characters")]
    TooLong,
    /// The stored PHC string did not parse, or named parameters argon2 refused.
    #[error("unusable password hash")]
    Hash,
}

/// NIST SP 800-63B's rules: length alone, counted in Unicode scalar values, so a passphrase in
/// any script counts what the visitor sees, more or less. No composition rules, no hints.
pub struct PasswordPolicy;

impl PasswordPolicy {
    pub fn check(password: &str) -> Result<(), PasswordError> {
        let chars = password.chars().count();
        if chars < MIN_PASSWORD_CHARS {
            Err(PasswordError::TooShort)
        } else if chars > MAX_PASSWORD_CHARS {
            Err(PasswordError::TooLong)
        } else {
            Ok(())
        }
    }
}

fn hasher() -> Argon2<'static> {
    let params = Params::new(ARGON2_M_KIB, ARGON2_T, ARGON2_P, None)
        .expect("OWASP's parameters are inside argon2's ranges");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// The PHC string, `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. The policy is checked
/// first, so an over-long password costs nothing.
pub fn hash_password(password: &str, salt: &[u8; 16]) -> Result<String, PasswordError> {
    PasswordPolicy::check(password)?;
    hasher()
        .hash_password_with_salt(password.as_bytes(), salt)
        .map(|hash| hash.to_string())
        .map_err(|_| PasswordError::Hash)
}

/// Whether `password` matches the stored hash. The PHC string's own parameters are used, so a
/// later change of parameters still verifies old hashes and can rehash at that sign-in. A
/// password outside the policy cannot match anything stored, so it is `false` without hashing.
pub fn verify_password(password: &str, phc: &str) -> Result<bool, PasswordError> {
    let hash = PasswordHash::new(phc).map_err(|_| PasswordError::Hash)?;
    if PasswordPolicy::check(password).is_err() {
        return Ok(false);
    }
    Ok(hasher().verify_password(password.as_bytes(), &hash).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANARY: &str = "canary-password-7f3k-do-not-log";
    const SALT: [u8; 16] = *b"test-salt-16byte";

    #[test]
    fn policy_counts_characters_not_bytes() {
        assert_eq!(
            PasswordPolicy::check("a".repeat(11).as_str()),
            Err(PasswordError::TooShort)
        );
        assert_eq!(PasswordPolicy::check("a".repeat(12).as_str()), Ok(()));
        assert_eq!(PasswordPolicy::check("a".repeat(128).as_str()), Ok(()));
        assert_eq!(
            PasswordPolicy::check("a".repeat(129).as_str()),
            Err(PasswordError::TooLong)
        );
        // Twelve two-byte characters are twelve, not twenty-four.
        assert_eq!(PasswordPolicy::check(&"é".repeat(12)), Ok(()));
        assert_eq!(
            PasswordPolicy::check(&"é".repeat(11)),
            Err(PasswordError::TooShort)
        );
        // Composition does not matter.
        assert_eq!(
            PasswordPolicy::check("correct horse battery staple"),
            Ok(())
        );
    }

    #[test]
    fn hashes_with_owasps_parameters_and_verifies() {
        let phc = hash_password(CANARY, &SALT).unwrap();
        assert!(phc.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"), "{phc}");
        assert!(!phc.contains(CANARY));
        assert_eq!(verify_password(CANARY, &phc), Ok(true));
        assert_eq!(
            verify_password("canary-password-7f3k-do-not-lo", &phc),
            Ok(false)
        );
        assert_eq!(verify_password("short", &phc), Ok(false));
        // Same salt, same hash: the Worker must draw a fresh salt each time.
        assert_eq!(hash_password(CANARY, &SALT).unwrap(), phc);
        assert_ne!(hash_password(CANARY, b"other-salt-16byt").unwrap(), phc);
    }

    #[test]
    fn refuses_bad_input_without_echoing_it() {
        let errors = [
            hash_password("short", &SALT).unwrap_err(),
            hash_password(&CANARY.repeat(10), &SALT).unwrap_err(),
            verify_password(CANARY, "not a phc string").unwrap_err(),
            verify_password(CANARY, CANARY).unwrap_err(),
        ];
        assert_eq!(
            errors,
            [
                PasswordError::TooShort,
                PasswordError::TooLong,
                PasswordError::Hash,
                PasswordError::Hash
            ]
        );
        for e in errors {
            assert!(!format!("{e:?} {e}").contains("canary"));
        }
    }
}
