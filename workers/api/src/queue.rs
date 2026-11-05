//! The `bakery-events` consumer and the `bakery-events-dlq` writer, one `#[event(queue)]`
//! handler told apart by `batch.queue()` (docs/architecture.md, "Events and the outbox",
//! Consume and Dead letters; ADR 0004).
//!
//! For each message on `bakery-events`: read the envelope (a JSON string, spike S6); refuse a
//! malformed one, or one whose `stream` the envelope's `sandbox` does not own, as poison: it is
//! written to that Sandbox's dead letters at once and acked, since retrying cannot fix it. Then
//! `routing::deliver_to` names the live subscribers, `routing::strip_for` takes the note out for
//! every one but the Kitchen, and each gets the envelope at its `/_event` by name. The message
//! is acked when every subscriber answered 2xx, else retried; after 3 retries the platform
//! moves it to `bakery-events-dlq` (wrangler.jsonc). The consumer never enqueues anything it
//! consumed (ADR 0004, decision 8): it holds no producer binding.
//!
//! `Control`'s flag is read once a minute per isolate: `off` retries everything, so the
//! messages drain to the DLQ after 3 retries rather than being lost (docs/architecture.md,
//! "Bulkheads and failure modes").
//!
//! For each message on `bakery-events-dlq`: write it, with the consumer's last error for it,
//! to the owning Sandbox (`/_dead-letter`), log `dlq` and ack. A wiped sandbox has nowhere to
//! keep it, and the message is acked.

use std::cell::RefCell;

use bakery_app::Clock;
use bakery_app::names::sandbox_object_name;
use bakery_app::routing::{Subscriber, deliver_to, reference, strip_for};
use bakery_contracts::Flag;
use bakery_domain::{Envelope, Ulid};
use worker::{Cache, Context, Env, MessageBatch, MessageExt, Method, Result, console_log, event};

use crate::clock::SystemClock;
use crate::http::menu_cache_key;
use crate::objects::sandbox::{self, DeadLetterIn, DeliveryError};
use crate::objects::sql::call;
use crate::objects::{billing, control, kitchen, order};

/// The dead-letter queue's name, as `batch.queue()` reports it.
const DLQ: &str = "bakery-events-dlq";

/// How long an isolate trusts its copy of `Control`'s flag.
const FLAG_CACHE_MS: i64 = 60_000;

thread_local! {
    static FLAG: RefCell<Option<(Flag, i64)>> = const { RefCell::new(None) };
}

#[event(queue)]
async fn queue(batch: MessageBatch<String>, env: Env, _ctx: Context) -> Result<()> {
    if batch.queue() == DLQ {
        dead_letters(&batch, &env).await
    } else {
        consume(&batch, &env).await
    }
}

/// The flag, from the isolate's copy when it is under a minute old. An unreachable `Control`
/// reads as `live`: the subscribers' own checks still hold, and a stalled flag read must not
/// drain every sandbox's events to the DLQ.
async fn flag(env: &Env) -> Flag {
    let now = SystemClock::new().now_wall().unix_ms();
    let cached = FLAG.with_borrow(|f| f.filter(|(_, at)| now - at < FLAG_CACHE_MS));
    if let Some((flag, _)) = cached {
        return flag;
    }
    match control::flag(env).await {
        Ok(flag) => {
            FLAG.with_borrow_mut(|f| *f = Some((flag, now)));
            flag
        }
        Err(_) => {
            console_log!("{{\"event\":\"flag_unavailable\"}}");
            Flag::Live
        }
    }
}

/// Why an envelope is refused outright.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Poison {
    NotAString,
    Malformed,
    ForeignStream,
}

impl Poison {
    fn code(self) -> &'static str {
        match self {
            Poison::NotAString => "not-a-string",
            Poison::Malformed => "malformed",
            Poison::ForeignStream => "foreign-stream",
        }
    }
}

/// Whether `sandbox` owns `stream`: `sandbox:<id>`, or `<class>:<id>` and `<class>:<id>:<x>`
/// (docs/architecture.md, "Object naming").
pub fn owns(sandbox: Ulid, stream: &str) -> bool {
    let id = sandbox.to_string();
    let parts: Vec<&str> = stream.split(':').collect();
    match parts.as_slice() {
        [class, owner] => !class.is_empty() && *owner == id,
        [class, owner, rest] => !class.is_empty() && *owner == id && !rest.is_empty(),
        _ => false,
    }
}

/// The envelope a message carries, or why it is poison.
fn read(body: &str) -> std::result::Result<Envelope, Poison> {
    let envelope: Envelope = serde_json::from_str(body).map_err(|_| Poison::Malformed)?;
    if !owns(envelope.sandbox, &envelope.stream) {
        return Err(Poison::ForeignStream);
    }
    Ok(envelope)
}

/// The sandbox a message names, read tolerantly, for a poisoned one's dead letter.
fn sandbox_of(body: &str) -> Option<Ulid> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value.get("sandbox")?.as_str()?.parse().ok()
}

/// The binding and object name that host a subscriber for this envelope. Only the classes in
/// `routing::LIVE` are reachable; one added there without a line here fails its deliveries,
/// which retry and dead-letter where a person sees them.
///
/// Billing is the sandbox's one; an Order is the one the data's `ref` names, for Billing's
/// `ByPurpose` and `ByRef` routes (the purpose was matched already by `routing::routes_for`).
/// An Order route with no `ref` (`RoutePublished`'s stops, `StopCompleted`, which nothing
/// produces before PR 7) has no instance yet.
fn subscriber(to: Subscriber, envelope: &Envelope) -> Option<(&'static str, String)> {
    match to {
        Subscriber::Kitchen => Some((kitchen::BINDING, kitchen::name(envelope.sandbox))),
        Subscriber::Billing => Some((billing::BINDING, billing::name(envelope.sandbox))),
        Subscriber::Order => {
            let order = reference(envelope)?;
            Some((order::BINDING, order::name(envelope.sandbox, order)))
        }
        _ => None,
    }
}

async fn consume(batch: &MessageBatch<String>, env: &Env) -> Result<()> {
    let off = flag(env).await == Flag::Off;
    let (mut acked, mut retried, mut poisoned) = (0u32, 0u32, 0u32);
    for message in batch.raw_iter() {
        if off {
            message.retry();
            retried += 1;
            continue;
        }
        let Some(body) = message.body().as_string() else {
            console_log!(
                "{{\"event\":\"poison\",\"reason\":\"{}\"}}",
                Poison::NotAString.code()
            );
            message.ack();
            poisoned += 1;
            continue;
        };
        let envelope = match read(&body) {
            Ok(e) => e,
            Err(p) => {
                console_log!("{{\"event\":\"poison\",\"reason\":\"{}\"}}", p.code());
                if let Some(sandbox) = sandbox_of(&body) {
                    let _ = write_dead_letter(env, sandbox, body, Some(p.code().into())).await;
                }
                message.ack();
                poisoned += 1;
                continue;
            }
        };
        if envelope.event_type == "MenuPublished" {
            forget_old_menu(env, &envelope).await;
        }
        match deliver(env, &envelope).await {
            Ok(()) => {
                message.ack();
                acked += 1;
            }
            Err(error) => {
                console_log!(
                    "{{\"event\":\"delivery_failed\",\"id\":\"{}\",\"type\":{:?},\"error\":{:?}}}",
                    envelope.id,
                    envelope.event_type,
                    error
                );
                remember_error(env, &envelope, error).await;
                message.retry();
                retried += 1;
            }
        }
    }
    console_log!(
        "{{\"event\":\"queue_batch\",\"queue\":{:?},\"acked\":{acked},\"retried\":{retried},\"poisoned\":{poisoned},\"off\":{off}}}",
        batch.queue()
    );
    Ok(())
}

/// Every live subscriber gets the envelope, stripped for it. The first failure is the error.
async fn deliver(env: &Env, envelope: &Envelope) -> std::result::Result<(), String> {
    for route in deliver_to(envelope) {
        let Some((binding, name)) = subscriber(route.to, envelope) else {
            return Err(format!("{} has no binding", route.to.class()));
        };
        let stripped = strip_for(envelope, route.to);
        let res = call(
            env,
            binding,
            &name,
            Method::Post,
            "/_event",
            Some(&stripped),
        )
        .await
        .map_err(|_| format!("{} could not be reached", route.to.class()))?;
        let status = res.status_code();
        if !(200..300).contains(&status) {
            return Err(format!("{} answered {status}", route.to.class()));
        }
    }
    Ok(())
}

/// The consumer's last error for an event, kept by its Sandbox for the dead letter. Best
/// effort: losing it loses a reason, not the message.
async fn remember_error(env: &Env, envelope: &Envelope, error: String) {
    let _ = call(
        env,
        sandbox::BINDING,
        &sandbox_object_name(envelope.sandbox),
        Method::Post,
        "/_delivery-error",
        Some(&DeliveryError {
            id: envelope.id.to_string(),
            error,
        }),
    )
    .await;
}

/// `MenuPublished`: the previous version's cache entry is unreachable already (the key names
/// the version), so deleting it only frees the space early.
async fn forget_old_menu(env: &Env, envelope: &Envelope) {
    let Some(version) = envelope.data.get("version").and_then(|v| v.as_u64()) else {
        return;
    };
    let Ok(origin) = env.var("API_ORIGIN").map(|v| v.to_string()) else {
        return;
    };
    let Some(previous) = version.checked_sub(1).and_then(|v| u32::try_from(v).ok()) else {
        return;
    };
    let key = menu_cache_key(&origin, envelope.sandbox, previous);
    if Cache::default().delete(key.as_str(), false).await.is_ok() {
        console_log!("{{\"event\":\"menu_cache_forget\",\"version\":{previous}}}");
    }
}

async fn write_dead_letter(
    env: &Env,
    sandbox: Ulid,
    body: String,
    error: Option<String>,
) -> Result<u16> {
    let res = call(
        env,
        sandbox::BINDING,
        &sandbox_object_name(sandbox),
        Method::Post,
        "/_dead-letter",
        Some(&DeadLetterIn {
            envelope: body,
            error,
        }),
    )
    .await?;
    Ok(res.status_code())
}

async fn dead_letters(batch: &MessageBatch<String>, env: &Env) -> Result<()> {
    for message in batch.raw_iter() {
        let body = message.body().as_string();
        let sandbox = body.as_deref().and_then(sandbox_of);
        let (Some(body), Some(sandbox)) = (body, sandbox) else {
            console_log!("{{\"event\":\"dlq\",\"outcome\":\"unowned\"}}");
            message.ack();
            continue;
        };
        let id = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(str::to_owned))
            .unwrap_or_default();
        match write_dead_letter(env, sandbox, body, None).await {
            Ok(200) => {
                console_log!("{{\"event\":\"dlq\",\"outcome\":\"kept\",\"id\":{id:?}}}");
                message.ack();
            }
            Ok(410) => {
                console_log!("{{\"event\":\"dlq\",\"outcome\":\"wiped\",\"id\":{id:?}}}");
                message.ack();
            }
            _ => {
                console_log!("{{\"event\":\"dlq\",\"outcome\":\"retry\",\"id\":{id:?}}}");
                message.retry();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SANDBOX: &str = "01JC8YV2D4QK7S1M9E3PZ6W8AN";
    const OTHER: &str = "01JC8Z6K3W9QF2N4T7XRB5M0HD";

    fn envelope(sandbox: &str, stream: &str) -> String {
        serde_json::json!({
            "v": 1, "id": "01JC8Z6K3W9QF2N4T7XRB5M0HD", "sandbox": sandbox, "stream": stream,
            "seq": 1, "type": "OrderReady", "at": "2026-11-07T12:12:10-07:00",
            "recorded_at": "2026-11-04T19:12:10.318Z", "data": {}, "cause": null
        })
        .to_string()
    }

    #[test]
    fn a_sandbox_owns_only_its_own_streams() {
        let s: Ulid = SANDBOX.parse().unwrap();
        assert!(owns(s, &format!("sandbox:{SANDBOX}")));
        assert!(owns(s, &format!("catalog:{SANDBOX}")));
        assert!(owns(s, &format!("order:{SANDBOX}:{OTHER}")));
        for bad in [
            format!("order:{OTHER}:{SANDBOX}"),
            format!("order:{OTHER}"),
            format!(":{SANDBOX}"),
            format!("order:{SANDBOX}:"),
            format!("order:{SANDBOX}:{OTHER}:x"),
            "control".to_owned(),
            String::new(),
        ] {
            assert!(!owns(s, &bad), "{bad}");
        }
    }

    #[test]
    fn poison_is_told_apart_and_still_finds_its_sandbox() {
        assert!(read(&envelope(SANDBOX, &format!("order:{SANDBOX}:{OTHER}"))).is_ok());
        let foreign = envelope(SANDBOX, &format!("order:{OTHER}:{SANDBOX}"));
        assert_eq!(read(&foreign), Err(Poison::ForeignStream));
        assert_eq!(sandbox_of(&foreign), Some(SANDBOX.parse().unwrap()));
        assert_eq!(read("{}"), Err(Poison::Malformed));
        assert_eq!(read("not json"), Err(Poison::Malformed));
        assert_eq!(sandbox_of("not json"), None);
        let half = serde_json::json!({ "sandbox": SANDBOX, "type": "OrderReady" }).to_string();
        assert_eq!(read(&half), Err(Poison::Malformed));
        assert_eq!(sandbox_of(&half), Some(SANDBOX.parse().unwrap()));
    }

    #[test]
    fn the_kitchen_billing_and_the_order_by_ref_are_reachable_and_nothing_else_is_yet() {
        let mut e: Envelope =
            serde_json::from_str(&envelope(SANDBOX, &format!("billing:{SANDBOX}"))).unwrap();
        e.event_type = "PaymentSucceeded".into();
        e.data = serde_json::json!({ "purpose": "order", "ref": OTHER });
        assert_eq!(
            subscriber(Subscriber::Kitchen, &e),
            Some((kitchen::BINDING, format!("kitchen:{SANDBOX}")))
        );
        assert_eq!(
            subscriber(Subscriber::Billing, &e),
            Some((billing::BINDING, format!("billing:{SANDBOX}")))
        );
        assert_eq!(
            subscriber(Subscriber::Order, &e),
            Some((order::BINDING, format!("order:{SANDBOX}:{OTHER}")))
        );
        for live in bakery_app::routing::LIVE {
            assert!(
                subscriber(*live, &e).is_some(),
                "{live:?} is live but unbound"
            );
        }
        assert_eq!(subscriber(Subscriber::Crm, &e), None);
        // An Order route needs a `ref`.
        e.data = serde_json::json!({});
        assert_eq!(subscriber(Subscriber::Order, &e), None);
        let routes = bakery_app::routing::deliver_to(&{
            let mut paid = e.clone();
            paid.data = serde_json::json!({ "purpose": "order", "ref": OTHER });
            paid
        });
        assert_eq!(
            routes.iter().map(|r| r.to).collect::<Vec<_>>(),
            [Subscriber::Order]
        );
    }
}
