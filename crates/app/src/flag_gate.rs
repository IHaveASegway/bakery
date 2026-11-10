//! What `Control`'s flag lets through (roadmap R85, built on 2026-11-10; docs/operations.md, "Kill
//! switch L0 to L4").
//!
//! Found on 2026-11-10: the flag's own words (`read-only`: "Reads work; commands get 503"; `off`:
//! "Only the storefront's static pages work") and the runbooks that set it "so no new data
//! arrives" were not true. Only admission, the Queue's consumer and the breaker read the flag, so
//! at `read-only` or `off` every route but sandbox and demo-account creation still wrote. This
//! module is the one decision; the router applies it to every route of the table, the Kitchen to
//! its socket's frames and the Simulator to its ticks.
//!
//! The flag is read from a copy at most [`FLAG_COPY_MS`] old, so a change bites within about a
//! minute in each isolate and each object, not at once, and a request with the flag `live` pays
//! no `Control` call but the one that refreshes the copy.

use bakery_contracts::Flag;

use crate::admission::Refusal;

/// How long an isolate or an object trusts its copy of the flag: 60 s, the figure the Queue's
/// consumer kept its copy for before this module (`FLAG_CACHE_MS` in workers/api/src/queue.rs,
/// main at 744f4af). A flip takes up to this long to reach every isolate.
pub const FLAG_COPY_MS: i64 = 60_000;

/// Whether a copy of the flag read at `read_at_ms` may still be used at `now_ms`. A copy from the
/// future (another clock) is not trusted.
pub fn copy_is_fresh(read_at_ms: i64, now_ms: i64) -> bool {
    let age = now_ms - read_at_ms;
    (0..FLAG_COPY_MS).contains(&age)
}

/// What a route does, for the flag. The router names each route of its table as one of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteKind {
    /// `GET /v1/health` and `GET /v1/status`: always answered, so the status page can say why
    /// the rest is refused.
    Probe,
    /// A read: a `GET`, a socket's upgrade included (the socket's own commands are the Kitchen's
    /// to refuse).
    Read,
    /// A command: a `POST`, `PATCH` or `DELETE` that writes.
    Command,
    /// Signing in and out (`/v1/auth/google/*`, `/v1/auth/github/*`, `/v1/auth/demo/signin`,
    /// `/v1/auth/signout`): a signed-in sandbox is read with a session, so they are allowed at
    /// `read-only`. They write an account's sign-in time (`last_signin` in
    /// workers/api/src/objects/account.rs), not a sandbox's data.
    SignIn,
    /// "Wipe now", `DELETE /v1/sandboxes/{id}`: allowed at `read-only`, since it removes data
    /// and is the visitor's own wipe ("Wipe now" runs the nightly wipe's steps 2 to 4 for one
    /// sandbox: docs/security.md, "The wipe"); refused at `off` with everything else, when the
    /// 10:00 UTC wipe still runs.
    Wipe,
    /// Stripe's webhook: allowed at every flag. It records money that already moved at Stripe,
    /// so refusing it makes the books disagree with Stripe, and Stripe gives up soon on a
    /// sandbox's events: "We retry event deliveries created in a sandbox three times over the
    /// course of a few hours" (https://docs.stripe.com/webhooks, "Automatic retries", read on
    /// 2026-11-10). It is signed and server to server, not a visitor's write.
    Webhook,
}

/// Whether a route of `kind` is answered with the flag at `flag`: `read-only` refuses commands
/// (503 `read-only`), `off` refuses everything but the probes and the webhook (503 `off`).
pub fn gate(flag: Flag, kind: RouteKind) -> Result<(), Refusal> {
    match (flag, kind) {
        (Flag::Live, _) | (_, RouteKind::Probe | RouteKind::Webhook) => Ok(()),
        (Flag::ReadOnly, RouteKind::Read | RouteKind::SignIn | RouteKind::Wipe) => Ok(()),
        (Flag::ReadOnly, RouteKind::Command) => Err(Refusal::ReadOnly),
        (Flag::Off, _) => Err(Refusal::Off),
    }
}

/// What the Kitchen does with a frame from a board's socket at `flag`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketFrame {
    /// Handled as always.
    Handle,
    /// A command answered `nack` with the rule `read-only`; the socket stays open and keeps its
    /// events.
    RefuseCommand,
    /// The socket is closed, `bye` with the reason `off` first: "sockets end at their next
    /// message" (the L1 row).
    Close,
}

/// The Kitchen's decision for a frame: at `off` any frame closes the socket; at `read-only` a
/// command is refused and anything else is handled.
pub fn socket_frame(flag: Flag, is_command: bool) -> SocketFrame {
    match flag {
        Flag::Live => SocketFrame::Handle,
        Flag::ReadOnly if is_command => SocketFrame::RefuseCommand,
        Flag::ReadOnly => SocketFrame::Handle,
        Flag::Off => SocketFrame::Close,
    }
}

/// The reason simulated traffic stops at `flag`, or `None` to keep going: its ticks place and pay
/// orders, which are writes.
pub fn traffic_stops(flag: Flag) -> Option<&'static str> {
    match flag {
        Flag::Live => None,
        Flag::ReadOnly => Some("read_only"),
        Flag::Off => Some("off"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KINDS: [RouteKind; 6] = [
        RouteKind::Probe,
        RouteKind::Read,
        RouteKind::Command,
        RouteKind::SignIn,
        RouteKind::Wipe,
        RouteKind::Webhook,
    ];

    #[test]
    fn live_lets_everything_through() {
        for kind in KINDS {
            assert_eq!(gate(Flag::Live, kind), Ok(()), "{kind:?}");
        }
    }

    #[test]
    fn read_only_refuses_commands_and_nothing_else() {
        assert_eq!(
            gate(Flag::ReadOnly, RouteKind::Command),
            Err(Refusal::ReadOnly)
        );
        for kind in [
            RouteKind::Probe,
            RouteKind::Read,
            RouteKind::SignIn,
            RouteKind::Wipe,
            RouteKind::Webhook,
        ] {
            assert_eq!(gate(Flag::ReadOnly, kind), Ok(()), "{kind:?}");
        }
    }

    #[test]
    fn off_refuses_all_but_the_probes_and_the_webhook() {
        for kind in [
            RouteKind::Read,
            RouteKind::Command,
            RouteKind::SignIn,
            RouteKind::Wipe,
        ] {
            assert_eq!(gate(Flag::Off, kind), Err(Refusal::Off), "{kind:?}");
        }
        assert_eq!(gate(Flag::Off, RouteKind::Probe), Ok(()));
        assert_eq!(gate(Flag::Off, RouteKind::Webhook), Ok(()));
    }

    #[test]
    fn the_socket_refuses_a_command_at_read_only_and_closes_at_off() {
        assert_eq!(socket_frame(Flag::Live, true), SocketFrame::Handle);
        assert_eq!(
            socket_frame(Flag::ReadOnly, true),
            SocketFrame::RefuseCommand
        );
        assert_eq!(socket_frame(Flag::ReadOnly, false), SocketFrame::Handle);
        assert_eq!(socket_frame(Flag::Off, true), SocketFrame::Close);
        assert_eq!(socket_frame(Flag::Off, false), SocketFrame::Close);
    }

    #[test]
    fn traffic_stops_at_read_only_and_off() {
        assert_eq!(traffic_stops(Flag::Live), None);
        assert_eq!(traffic_stops(Flag::ReadOnly), Some("read_only"));
        assert_eq!(traffic_stops(Flag::Off), Some("off"));
    }

    #[test]
    fn a_copy_of_the_flag_lasts_a_minute() {
        assert!(copy_is_fresh(1_000, 1_000));
        assert!(copy_is_fresh(1_000, 1_000 + FLAG_COPY_MS - 1));
        assert!(!copy_is_fresh(1_000, 1_000 + FLAG_COPY_MS));
        assert!(!copy_is_fresh(2_000, 1_000));
    }
}
