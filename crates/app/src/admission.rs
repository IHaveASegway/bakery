//! Admission: who may have a new sandbox or demo account today (docs/security.md, "Sandbox
//! isolation"; docs/architecture.md, "Creating a sandbox"). `Control` holds the counts and
//! calls these inside its transaction; they decide and count nothing themselves.

use bakery_contracts::{Flag, SandboxKind};
use bakery_domain::WallTime;

/// The daily caps, from the Worker's vars. The defaults are the build spec's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    /// All sandboxes a UTC day (`SANDBOX_CAP`).
    pub sandboxes: u32,
    /// Guests' share of them (`GUEST_SANDBOX_CAP`).
    pub guests: u32,
    /// Demo accounts created a UTC day (`DEMO_ACCOUNT_CAP`).
    pub demo_accounts: u32,
    /// Sandboxes one account may create a UTC day (`ACCOUNT_SANDBOX_CAP`), counted in the
    /// `Account`.
    pub account_sandboxes: u32,
}

impl Default for Caps {
    fn default() -> Caps {
        Caps {
            sandboxes: 300,
            guests: 100,
            demo_accounts: 100,
            account_sandboxes: 3,
        }
    }
}

/// Today's counts in `Control`'s ledger, before this request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counts {
    pub sandboxes_today: u32,
    pub guests_today: u32,
    pub demo_accounts_today: u32,
}

/// Why a request was not admitted. Each is a problem slug.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The flag is `off`.
    Off,
    /// The flag is `read-only`: creating is a command.
    ReadOnly,
    /// 300 sandboxes today.
    SandboxCap,
    /// 100 guest sandboxes today.
    GuestCap,
    /// 100 demo accounts today.
    DemoCap,
    /// This account made its 3 sandboxes today.
    AccountSandboxCap,
}

impl Refusal {
    /// The problem slug, also the `reason` `Control` answers with.
    pub fn slug(self) -> &'static str {
        match self {
            Refusal::Off => "off",
            Refusal::ReadOnly => "read-only",
            Refusal::SandboxCap => "sandbox-cap",
            Refusal::GuestCap => "guest-cap",
            Refusal::DemoCap => "demo-cap",
            Refusal::AccountSandboxCap => "account-sandbox-cap",
        }
    }

    pub fn parse(slug: &str) -> Option<Refusal> {
        [
            Refusal::Off,
            Refusal::ReadOnly,
            Refusal::SandboxCap,
            Refusal::GuestCap,
            Refusal::DemoCap,
            Refusal::AccountSandboxCap,
        ]
        .into_iter()
        .find(|r| r.slug() == slug)
    }

    /// 503 for the demo's limits, 429 for one account's.
    pub fn status(self) -> u16 {
        match self {
            Refusal::AccountSandboxCap => 429,
            _ => 503,
        }
    }

    /// `Retry-After` in seconds: the caps reset at the next 00:00 UTC; a flag has no known end.
    pub fn retry_after(self, now: WallTime) -> Option<u32> {
        match self {
            Refusal::Off | Refusal::ReadOnly => None,
            Refusal::SandboxCap
            | Refusal::GuestCap
            | Refusal::DemoCap
            | Refusal::AccountSandboxCap => {
                let ms = now.next_utc_midnight().unix_ms() - now.unix_ms();
                u32::try_from((ms + 999) / 1_000).ok()
            }
        }
    }
}

fn flag_allows(flag: Flag) -> Result<(), Refusal> {
    match flag {
        Flag::Live => Ok(()),
        Flag::ReadOnly => Err(Refusal::ReadOnly),
        Flag::Off => Err(Refusal::Off),
    }
}

/// A new sandbox: the flag, then the day's cap, then the guests' share for a guest. An
/// account's own cap is the `Account`'s check, [`admit_account_sandbox`].
pub fn admit_sandbox(
    kind: SandboxKind,
    counts: Counts,
    flag: Flag,
    caps: Caps,
) -> Result<(), Refusal> {
    flag_allows(flag)?;
    if counts.sandboxes_today >= caps.sandboxes {
        return Err(Refusal::SandboxCap);
    }
    if kind == SandboxKind::Guest && counts.guests_today >= caps.guests {
        return Err(Refusal::GuestCap);
    }
    Ok(())
}

/// A new demo account: the flag, then the day's cap.
pub fn admit_demo_account(counts: Counts, flag: Flag, caps: Caps) -> Result<(), Refusal> {
    flag_allows(flag)?;
    if counts.demo_accounts_today >= caps.demo_accounts {
        return Err(Refusal::DemoCap);
    }
    Ok(())
}

/// One account's sandboxes today, before this one.
pub fn admit_account_sandbox(created_today: u32, caps: Caps) -> Result<(), Refusal> {
    if created_today >= caps.account_sandboxes {
        Err(Refusal::AccountSandboxCap)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(sandboxes: u32, guests: u32) -> Counts {
        Counts {
            sandboxes_today: sandboxes,
            guests_today: guests,
            demo_accounts_today: 0,
        }
    }

    #[test]
    fn the_101st_guest_is_refused_while_an_account_gets_in() {
        let caps = Caps::default();
        let c = counts(150, 100);
        assert_eq!(
            admit_sandbox(SandboxKind::Guest, c, Flag::Live, caps),
            Err(Refusal::GuestCap)
        );
        assert_eq!(
            admit_sandbox(SandboxKind::Account, c, Flag::Live, caps),
            Ok(())
        );
        assert_eq!(
            admit_sandbox(SandboxKind::Guest, counts(150, 99), Flag::Live, caps),
            Ok(())
        );
    }

    #[test]
    fn the_301st_of_any_kind_is_refused() {
        let caps = Caps::default();
        for kind in [SandboxKind::Guest, SandboxKind::Account] {
            assert_eq!(
                admit_sandbox(kind, counts(300, 0), Flag::Live, caps),
                Err(Refusal::SandboxCap)
            );
            assert_eq!(
                admit_sandbox(kind, counts(299, 0), Flag::Live, caps),
                Ok(())
            );
        }
        // The day's cap is reported before the guests' share.
        assert_eq!(
            admit_sandbox(SandboxKind::Guest, counts(300, 100), Flag::Live, caps),
            Err(Refusal::SandboxCap)
        );
    }

    #[test]
    fn flags_refuse_first() {
        let caps = Caps::default();
        for kind in [SandboxKind::Guest, SandboxKind::Account] {
            assert_eq!(
                admit_sandbox(kind, counts(0, 0), Flag::Off, caps),
                Err(Refusal::Off)
            );
            assert_eq!(
                admit_sandbox(kind, counts(300, 100), Flag::ReadOnly, caps),
                Err(Refusal::ReadOnly)
            );
        }
        assert_eq!(
            admit_demo_account(Counts::default(), Flag::Off, caps),
            Err(Refusal::Off)
        );
        assert_eq!(
            admit_demo_account(Counts::default(), Flag::ReadOnly, caps),
            Err(Refusal::ReadOnly)
        );
    }

    #[test]
    fn demo_accounts_and_account_sandboxes() {
        let caps = Caps::default();
        let at = |n| Counts {
            demo_accounts_today: n,
            ..Counts::default()
        };
        assert_eq!(admit_demo_account(at(99), Flag::Live, caps), Ok(()));
        assert_eq!(
            admit_demo_account(at(100), Flag::Live, caps),
            Err(Refusal::DemoCap)
        );
        assert_eq!(admit_account_sandbox(2, caps), Ok(()));
        assert_eq!(
            admit_account_sandbox(3, caps),
            Err(Refusal::AccountSandboxCap)
        );
    }

    #[test]
    fn refusals_name_their_problem() {
        let now: WallTime = "2026-11-05T23:00:00.000Z".parse().unwrap();
        for r in [
            Refusal::Off,
            Refusal::ReadOnly,
            Refusal::SandboxCap,
            Refusal::GuestCap,
            Refusal::DemoCap,
            Refusal::AccountSandboxCap,
        ] {
            assert_eq!(Refusal::parse(r.slug()), Some(r));
        }
        assert_eq!(Refusal::SandboxCap.retry_after(now), Some(3_600));
        assert_eq!(Refusal::Off.retry_after(now), None);
        assert_eq!(Refusal::AccountSandboxCap.status(), 429);
        assert_eq!(Refusal::GuestCap.status(), 503);
    }
}
