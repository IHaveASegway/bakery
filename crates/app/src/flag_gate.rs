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
//! no `Control` call but the one that refreshes the copy. A refresh that fails keeps the last
//! flag read and waits [`FLAG_RETRY_MS`] before the next ([`flag_read`]).

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

/// How long an isolate waits after a failed refresh of its copy before it asks `Control` again:
/// 5 s. While `Control` is slow or failing, a request on the hot path pays a failing call at most
/// once per 5 s per isolate rather than on every request, and a `Control` that has recovered is
/// read again within 5 s, well inside the copy's own 60 s. The number is this module's choice.
pub const FLAG_RETRY_MS: i64 = 5_000;

/// What an adapter does to know the flag ([`flag_read`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlagRead {
    /// Use this flag without asking `Control`: the copy is fresh, or the last refresh failed
    /// less than [`FLAG_RETRY_MS`] ago and this is the last flag the isolate read.
    Use(Flag),
    /// Ask `Control` now. On success keep the answer and its time; on a failure keep the time of
    /// the failure and use [`after_failure`].
    Refresh,
}

/// The decision, given the last good copy (the flag and when it was read), the time of the last
/// failed refresh, and now. A failed refresh never opens the gate: the isolate goes on with the
/// last flag it read, however old, so a `Control` hiccup at `off` lets no write through.
pub fn flag_read(
    last_good: Option<(Flag, i64)>,
    last_failed: Option<i64>,
    now_ms: i64,
) -> FlagRead {
    if let Some((flag, at)) = last_good
        && copy_is_fresh(at, now_ms)
    {
        return FlagRead::Use(flag);
    }
    let waiting = last_failed.is_some_and(|f| (0..FLAG_RETRY_MS).contains(&(now_ms - f)));
    if waiting {
        FlagRead::Use(after_failure(last_good))
    } else {
        FlagRead::Refresh
    }
}

/// The flag to use when a refresh failed or is waiting: the last one the isolate read, however
/// old; `live` only for an isolate that has never read one. That case stays open on purpose: a
/// stalled first read must not take the demo down or drain every sandbox's events to the
/// dead-letter queue, and the harm is bounded, since `Control`'s admission reads the flag in its
/// own transaction and so still refuses a new sandbox at `read-only` or `off`, and at `off` the
/// breaker's WAF rule (L3) blocks the API hostname at the edge.
pub fn after_failure(last_good: Option<(Flag, i64)>) -> Flag {
    last_good.map_or(Flag::Live, |(flag, _)| flag)
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
    fn a_fresh_copy_is_used_without_asking() {
        assert_eq!(
            flag_read(Some((Flag::Off, 1_000)), None, 30_000),
            FlagRead::Use(Flag::Off)
        );
        // A fresh copy wins even just after a failure.
        assert_eq!(
            flag_read(Some((Flag::ReadOnly, 1_000)), Some(29_000), 30_000),
            FlagRead::Use(Flag::ReadOnly)
        );
    }

    #[test]
    fn a_stale_copy_or_none_is_refreshed() {
        assert_eq!(
            flag_read(Some((Flag::Live, 1_000)), None, 1_000 + FLAG_COPY_MS),
            FlagRead::Refresh
        );
        assert_eq!(flag_read(None, None, 5_000), FlagRead::Refresh);
        // The wait after a failure is over.
        assert_eq!(
            flag_read(
                Some((Flag::Off, 1_000)),
                Some(70_000),
                70_000 + FLAG_RETRY_MS
            ),
            FlagRead::Refresh
        );
    }

    #[test]
    fn after_a_failure_the_last_flag_holds_until_the_next_try() {
        // The breaker tripped and Control then failed: off stays off, without asking again.
        let stale = Some((Flag::Off, 1_000));
        assert_eq!(
            flag_read(stale, Some(90_000), 90_000),
            FlagRead::Use(Flag::Off)
        );
        assert_eq!(
            flag_read(stale, Some(90_000), 90_000 + FLAG_RETRY_MS - 1),
            FlagRead::Use(Flag::Off)
        );
        assert_eq!(after_failure(stale), Flag::Off);
        assert_eq!(after_failure(Some((Flag::ReadOnly, 0))), Flag::ReadOnly);
        // A failure time from another clock's future does not hold the isolate back.
        assert_eq!(flag_read(stale, Some(95_000), 90_000), FlagRead::Refresh);
    }

    #[test]
    fn an_isolate_that_never_read_the_flag_falls_back_to_live() {
        assert_eq!(after_failure(None), Flag::Live);
        assert_eq!(
            flag_read(None, Some(10_000), 12_000),
            FlagRead::Use(Flag::Live)
        );
    }

    #[test]
    fn a_copy_of_the_flag_lasts_a_minute() {
        assert!(copy_is_fresh(1_000, 1_000));
        assert!(copy_is_fresh(1_000, 1_000 + FLAG_COPY_MS - 1));
        assert!(!copy_is_fresh(1_000, 1_000 + FLAG_COPY_MS));
        assert!(!copy_is_fresh(2_000, 1_000));
    }
}
