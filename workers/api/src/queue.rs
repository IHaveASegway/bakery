//! The `bakery-events` consumer and the `bakery-events-dlq` writer, one `#[event(queue)]`
//! handler told apart by `batch.queue()` (docs/architecture.md, "Events and the outbox",
//! Consume and Dead letters; ADR 0004).
//!
//! For each message on `bakery-events`: read the envelope (a JSON string, spike S6); refuse a
//! malformed one, or one whose `stream` the envelope's `sandbox` does not own, as poison: it is
//! written to that Sandbox's dead letters at once and acked, since retrying cannot fix it. Then
//! `routing::deliver_to` names the live subscribers, `routing::strip_for` takes the note out for
//! every one but the Kitchen, and the note and the brief out of everything Crm and the Inbox
//! get, and each gets the envelope at its `/_event` by name. The message is acked when every
//! subscriber answered 2xx, else retried; after 3 retries the platform moves it to
//! `bakery-events-dlq` (wrangler.jsonc). The consumer never enqueues anything it consumed (ADR
//! 0004, decision 8): it holds no producer binding.
//!
//! Since PR 8: `all(Crm)` and `all(Inbox)` are the sandbox's one of each; a 410 from either
//! (not yet seeded, or wiped) counts as delivered, since everything the sandbox's seeding writes
//! before they exist reaches them through their seed. `all(Customer)` on `OrderPaid` and
//! `OrderRefunded` is the order's customer, which the Order's `/_customer` names; a customer
//! never touched (410) is registered with the Sandbox, which answers its birth and the
//! persona's profile, and the delivery is sent again with them.
//!
//! Since PR 9: `all(Dispatch)` is the day of the order's window. `OrderPlaced` (a delivery; the
//! routing table already skips a pickup's) carries its slot, and its customer's place comes from
//! the Sandbox (`/_place/<customer>`, the persona's `p<n>`, read through the matrix as index
//! `n - 1`); `OrderPaid`, `OrderExpired` and `OrderCancelled` carry neither, so the Order's
//! `/_order` names the slot and the kind, and a pickup's is acked with nothing sent. A day never
//! touched (410) is registered with the Sandbox (`/_register-dispatch`) and sent the delivery
//! again with its birth; a date outside the sandbox's days is acked. `Order (each stop)` on
//! `RoutePublished` is each order of the plan, and `all(Order)` on `StopCompleted` the order it
//! names: each gets the envelope at its `/_event`, which turns it into `MarkOutForDelivery` or
//! `MarkDelivered`. `all(Kitchen)` on `RoutePublished` is the sandbox's board, which labels its
//! cards with their vans. Since 2026-11-08 `OrderReady` reaches the day of the order's window as
//! the other order events do, and the Dispatch's `StopReady` the order it names, which goes out
//! for delivery; `OrderOutForDelivery` reaches the day as well, whose stop then reads out for
//! delivery.
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
use bakery_app::analytics::{Event, Point};
use bakery_app::names::sandbox_object_name;
use bakery_app::routing::{Subscriber, deliver_to, reference, strip_for};
use bakery_contracts::{CateringResponse, Flag, OrderResponse};
use bakery_domain::{BakeryDate, BusinessTime, Envelope, Ulid};
use worker::{Cache, Context, Env, MessageBatch, MessageExt, Method, Result, console_log, event};

use crate::clock::SystemClock;
use crate::http::menu_cache_key;
use crate::metrics;
use crate::objects::sandbox::{self, CustomerBirth, DeadLetterIn, DeliveryError, RegisterCustomer};
use crate::objects::sql::{call, call_empty};
use crate::objects::{
    billing, catering, control, crm, customer, dispatch, inbox, kitchen, order, schedule,
};

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
/// Billing is the sandbox's one; an Order or a CateringEvent is the one the data's `ref` names,
/// for Billing's `ByPurpose` and `ByRef` routes (the purpose was matched already by
/// `routing::routes_for`) and for `InvoiceIssued`, whose `ref` is the catering job.
/// The `Schedule` is resolved by [`schedule_days`] instead, since finding its day takes a call.
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
        Subscriber::CateringEvent => {
            let job = reference(envelope)?;
            Some((catering::BINDING, catering::name(envelope.sandbox, job)))
        }
        Subscriber::Crm => Some((crm::BINDING, crm::name(envelope.sandbox))),
        Subscriber::Inbox => Some((inbox::BINDING, inbox::name(envelope.sandbox))),
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
                if let Some(sandbox) = sandbox_of(&body)
                    && let Ok(200) =
                        write_dead_letter(env, sandbox, body, Some(p.code().into())).await
                {
                    metrics::write(env, &Point::one(Event::Dlq));
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
    let order = OrderRead::default();
    for route in deliver_to(envelope) {
        if route.to == Subscriber::Schedule {
            deliver_to_days(env, envelope, &order).await?;
            continue;
        }
        if route.to == Subscriber::Customer {
            deliver_to_customer(env, envelope).await?;
            continue;
        }
        if route.to == Subscriber::Dispatch {
            deliver_to_dispatch(env, envelope, &order).await?;
            continue;
        }
        if route.to == Subscriber::Order
            && matches!(
                envelope.event_type.as_str(),
                "RoutePublished" | "StopCompleted" | "StopReady"
            )
        {
            deliver_to_stops(env, envelope).await?;
            continue;
        }
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
        if status == 410 && matches!(route.to, Subscriber::Crm | Subscriber::Inbox) {
            // Not yet seeded (its seed carries what came before it) or wiped: nothing to do.
            console_log!(
                "{{\"event\":\"subscriber_unborn\",\"id\":\"{}\",\"to\":\"{}\"}}",
                envelope.id,
                route.to.class()
            );
            continue;
        }
        if !(200..300).contains(&status) {
            return Err(format!("{} answered {status}", route.to.class()));
        }
    }
    Ok(())
}

/// `all(Customer)`: the order's customer, from the Order, gets the envelope; one never touched
/// is registered with the Sandbox first, and gets its birth and persona with the envelope.
async fn deliver_to_customer(env: &Env, envelope: &Envelope) -> std::result::Result<(), String> {
    let Some(order) = order_in(envelope) else {
        return Err("Customer has no order for this stream".to_owned());
    };
    let mut res = call_empty(
        env,
        order::BINDING,
        &order::name(envelope.sandbox, order),
        Method::Get,
        "/_customer",
    )
    .await
    .map_err(|_| "Order could not be reached".to_owned())?;
    #[derive(serde::Deserialize)]
    struct Whose {
        customer: Ulid,
    }
    let who: Whose = match res.status_code() {
        200 => res
            .json()
            .await
            .map_err(|_| "Order's customer could not be read".to_owned())?,
        // A wiped order has no customer left to tell.
        410 => return Ok(()),
        status => return Err(format!("Order answered {status} for its customer")),
    };
    let stripped = strip_for(envelope, Subscriber::Customer);
    let name = customer::name(envelope.sandbox, who.customer);
    let send = |birth: Option<CustomerBirth>| {
        let body = customer::EventIn {
            envelope: stripped.clone(),
            birth: birth.as_ref().map(|b| crate::objects::child::Birth {
                sandbox: envelope.sandbox,
                name: b.name.clone(),
                clock_offset_s: b.clock_offset_s,
                clock_v: b.clock_v,
            }),
            register: birth.map(|b| b.register),
        };
        let name = name.clone();
        async move {
            call(
                env,
                customer::BINDING,
                &name,
                Method::Post,
                "/_event",
                Some(&body),
            )
            .await
            .map(|r| r.status_code())
            .map_err(|_| "Customer could not be reached".to_owned())
        }
    };
    match send(None).await? {
        200..=299 => return Ok(()),
        410 => {}
        status => return Err(format!("Customer answered {status}")),
    }
    let mut res = call(
        env,
        sandbox::BINDING,
        &sandbox_object_name(envelope.sandbox),
        Method::Post,
        "/_register-customer",
        Some(&RegisterCustomer {
            customer: who.customer,
        }),
    )
    .await
    .map_err(|_| "Sandbox could not be reached".to_owned())?;
    let birth: CustomerBirth = match res.status_code() {
        200 => res
            .json()
            .await
            .map_err(|_| "Sandbox's customer birth could not be read".to_owned())?,
        // A wiped sandbox has no customer to give points to.
        410 => return Ok(()),
        status => return Err(format!("Sandbox answered {status} for a customer")),
    };
    match send(Some(birth)).await? {
        200..=299 => Ok(()),
        status => Err(format!("Customer answered {status}")),
    }
}

/// `all(Dispatch)`: the day of the order's window gets the envelope, with the customer's place
/// for `OrderPlaced`; a pickup's later events are acked unsent. A day never touched is
/// registered first and sent the envelope again with its birth.
async fn deliver_to_dispatch(
    env: &Env,
    envelope: &Envelope,
    read: &OrderRead,
) -> std::result::Result<(), String> {
    let Some(order) = order_in(envelope) else {
        return Err("Dispatch has no day for this stream".to_owned());
    };
    let (slot, place) = if envelope.event_type == "OrderPlaced" {
        let field = |name: &str| envelope.data.get(name).and_then(|v| v.as_str());
        let slot: BusinessTime = field("slot")
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| "OrderPlaced's slot could not be read".to_owned())?;
        let customer: Ulid = field("customer")
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| "OrderPlaced's customer could not be read".to_owned())?;
        match persona_place(env, envelope.sandbox, customer).await? {
            Some(place) => (slot, Some(place)),
            None => {
                console_log!(
                    "{{\"event\":\"dispatch_no_place\",\"id\":\"{}\"}}",
                    envelope.id
                );
                return Ok(());
            }
        }
    } else {
        let o = match read.get(env, envelope.sandbox, order).await? {
            (200, Some(o)) => o,
            // A wiped order has no stop left to change.
            (404 | 410, _) => return Ok(()),
            (status, _) => return Err(format!("Order answered {status} for its slot")),
        };
        if o.kind != bakery_contracts::OrderKind::Delivery {
            return Ok(());
        }
        let slot: BusinessTime = o
            .slot
            .parse()
            .map_err(|_| "Order's slot could not be read".to_owned())?;
        (slot, None)
    };
    let date = BakeryDate::of(slot);
    let name = dispatch::name(envelope.sandbox, date);
    let stripped = strip_for(envelope, Subscriber::Dispatch);
    let send = |birth: Option<crate::objects::child::Birth>| {
        let body = dispatch::EventIn {
            envelope: stripped.clone(),
            birth,
            place,
        };
        let name = name.clone();
        async move {
            call(
                env,
                dispatch::BINDING,
                &name,
                Method::Post,
                "/_event",
                Some(&body),
            )
            .await
            .map(|r| r.status_code())
            .map_err(|_| "Dispatch could not be reached".to_owned())
        }
    };
    match send(None).await? {
        200..=299 => return Ok(()),
        410 => {}
        status => return Err(format!("Dispatch answered {status}")),
    }
    let mut res = call(
        env,
        sandbox::BINDING,
        &sandbox_object_name(envelope.sandbox),
        Method::Post,
        "/_register-dispatch",
        Some(&sandbox::RegisterDay {
            date,
            catering: false,
        }),
    )
    .await
    .map_err(|_| "Sandbox could not be reached".to_owned())?;
    let day: sandbox::DayBirth = match res.status_code() {
        200 => res
            .json()
            .await
            .map_err(|_| "Sandbox's dispatch day could not be read".to_owned())?,
        // A window outside the sandbox's days, or a wiped sandbox: no day to keep the stop.
        404 | 410 => {
            console_log!(
                "{{\"event\":\"dispatch_no_day\",\"id\":\"{}\"}}",
                envelope.id
            );
            return Ok(());
        }
        status => return Err(format!("Sandbox answered {status} for a dispatch day")),
    };
    let birth = crate::objects::child::Birth {
        sandbox: envelope.sandbox,
        name: day.name,
        clock_offset_s: day.clock_offset_s,
        clock_v: day.clock_v,
    };
    match send(Some(birth)).await? {
        200..=299 => Ok(()),
        status => Err(format!("Dispatch answered {status}")),
    }
}

/// A persona's place as a matrix index: the Sandbox's `p<n>`, read through the city's matrix.
/// `None` for a customer who is no persona, or a place the matrix lacks.
async fn persona_place(
    env: &Env,
    sandbox_id: Ulid,
    customer: Ulid,
) -> std::result::Result<Option<u8>, String> {
    let mut res = call_empty(
        env,
        sandbox::BINDING,
        &sandbox_object_name(sandbox_id),
        Method::Get,
        &format!("/_place/{customer}"),
    )
    .await
    .map_err(|_| "Sandbox could not be reached".to_owned())?;
    #[derive(serde::Deserialize)]
    struct Place {
        place: String,
    }
    match res.status_code() {
        200 => {
            let p: Place = res
                .json()
                .await
                .map_err(|_| "Sandbox's place could not be read".to_owned())?;
            let matrix = dispatch::matrix().map_err(|_| "the city matrix".to_owned())?;
            Ok(matrix.place_index(&p.place))
        }
        404 | 410 => Ok(None),
        status => Err(format!("Sandbox answered {status} for a place")),
    }
}

/// `Order (each stop)` on `RoutePublished` and `all(Order)` on `StopCompleted` and `StopReady`:
/// each order the event names gets it. An order that is gone (410) has nothing to mark.
async fn deliver_to_stops(env: &Env, envelope: &Envelope) -> std::result::Result<(), String> {
    use bakery_domain::DomainEvent;
    use bakery_domain::dispatch::{DispatchEvent, deliveries};
    let orders: Vec<Ulid> = match DispatchEvent::from_envelope(envelope) {
        Ok(DispatchEvent::RoutePublished { vans, .. }) => {
            deliveries(&vans).into_iter().map(|(o, _, _)| o).collect()
        }
        Ok(DispatchEvent::StopCompleted { order, .. } | DispatchEvent::StopReady { order, .. }) => {
            vec![order]
        }
        Ok(_) => Vec::new(),
        Err(_) => return Err("a dispatch event could not be read".to_owned()),
    };
    let stripped = strip_for(envelope, Subscriber::Order);
    for o in orders {
        let res = call(
            env,
            order::BINDING,
            &order::name(envelope.sandbox, o),
            Method::Post,
            "/_event",
            Some(&stripped),
        )
        .await
        .map_err(|_| "Order could not be reached".to_owned())?;
        match res.status_code() {
            200..=299 => {}
            404 | 410 => console_log!(
                "{{\"event\":\"stop_order_gone\",\"id\":\"{}\"}}",
                envelope.id
            ),
            status => return Err(format!("Order answered {status} for its stop")),
        }
    }
    Ok(())
}

/// The `Schedule` days an envelope goes to. `all(Schedule)` on an Order event is the one day
/// that holds the order: the Order's slot names it; on a CateringEvent event, the event's date.
/// `scoped(Schedule, TodayOn)` on `MenuPublished` is every registered day from business today
/// on, from the Sandbox.
async fn schedule_days(
    env: &Env,
    envelope: &Envelope,
    read: &OrderRead,
) -> std::result::Result<Vec<String>, String> {
    if envelope.event_type == "MenuPublished" {
        let mut res = call_empty(
            env,
            sandbox::BINDING,
            &sandbox_object_name(envelope.sandbox),
            Method::Get,
            "/_days",
        )
        .await
        .map_err(|_| "Sandbox could not be reached".to_owned())?;
        return match res.status_code() {
            200 => res
                .json::<Vec<String>>()
                .await
                .map_err(|_| "Sandbox's days could not be read".to_owned()),
            // A wiped sandbox has no days left to tell.
            410 => Ok(Vec::new()),
            status => Err(format!("Sandbox answered {status}")),
        };
    }
    if let Some(job) = catering::id_of(&envelope.stream, envelope.sandbox) {
        let mut res = call_empty(
            env,
            catering::BINDING,
            &catering::name(envelope.sandbox, job),
            Method::Get,
            "/_state",
        )
        .await
        .map_err(|_| "CateringEvent could not be reached".to_owned())?;
        return match res.status_code() {
            200 => {
                let c: CateringResponse = res
                    .json()
                    .await
                    .map_err(|_| "CateringEvent could not be read".to_owned())?;
                let date: BakeryDate = c
                    .date
                    .parse()
                    .map_err(|_| "CateringEvent's date could not be read".to_owned())?;
                Ok(vec![schedule::name(envelope.sandbox, date)])
            }
            // A wiped event holds no day.
            410 => Ok(Vec::new()),
            status => Err(format!("CateringEvent answered {status}")),
        };
    }
    let Some(order) = order_in(envelope) else {
        return Err("Schedule has no day for this stream".to_owned());
    };
    match read.get(env, envelope.sandbox, order).await? {
        (200, Some(o)) => {
            let slot: BusinessTime = o
                .slot
                .parse()
                .map_err(|_| "Order's slot could not be read".to_owned())?;
            Ok(vec![schedule::name(envelope.sandbox, BakeryDate::of(slot))])
        }
        (status, _) => Err(format!("Order answered {status}")),
    }
}

/// The Order's `/_order` answer for one delivery, read at most once however many subscribers
/// need it (the Schedule's day and, since PR 9, the Dispatch's day and the order's kind): the
/// status, and the order when it is 200.
#[derive(Default)]
struct OrderRead(RefCell<Option<(u16, Option<OrderResponse>)>>);

impl OrderRead {
    async fn get(
        &self,
        env: &Env,
        sandbox_id: Ulid,
        order: Ulid,
    ) -> std::result::Result<(u16, Option<OrderResponse>), String> {
        if let Some(read) = self.0.borrow().clone() {
            return Ok(read);
        }
        let mut res = call_empty(
            env,
            order::BINDING,
            &order::name(sandbox_id, order),
            Method::Get,
            "/_order",
        )
        .await
        .map_err(|_| "Order could not be reached".to_owned())?;
        let status = res.status_code();
        let o: Option<OrderResponse> = if status == 200 {
            Some(
                res.json()
                    .await
                    .map_err(|_| "Order could not be read".to_owned())?,
            )
        } else {
            None
        };
        *self.0.borrow_mut() = Some((status, o.clone()));
        Ok((status, o))
    }
}

/// The order an Order stream names, `order:<sandbox>:<ulid>`, in the envelope's own sandbox.
fn order_in(envelope: &Envelope) -> Option<Ulid> {
    let parts: Vec<&str> = envelope.stream.split(':').collect();
    match parts.as_slice() {
        ["order", sandbox, order] if *sandbox == envelope.sandbox.to_string() => order.parse().ok(),
        _ => None,
    }
}

/// Each day the envelope goes to gets it at `/_event`. A day that was never born (410) holds
/// nothing the event could change, so it counts as delivered.
async fn deliver_to_days(
    env: &Env,
    envelope: &Envelope,
    read: &OrderRead,
) -> std::result::Result<(), String> {
    let stripped = strip_for(envelope, Subscriber::Schedule);
    for name in schedule_days(env, envelope, read).await? {
        let res = call(
            env,
            schedule::BINDING,
            &name,
            Method::Post,
            "/_event",
            Some(&stripped),
        )
        .await
        .map_err(|_| "Schedule could not be reached".to_owned())?;
        match res.status_code() {
            200..=299 => {}
            410 => console_log!(
                "{{\"event\":\"schedule_no_day\",\"id\":\"{}\"}}",
                envelope.id
            ),
            status => return Err(format!("Schedule answered {status}")),
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
                metrics::write(env, &Point::one(Event::Dlq));
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
    fn an_order_event_names_its_order_for_the_schedule() {
        let mut e: Envelope =
            serde_json::from_str(&envelope(SANDBOX, &format!("order:{SANDBOX}:{OTHER}"))).unwrap();
        assert_eq!(order_in(&e), Some(OTHER.parse().unwrap()));
        e.stream = format!("schedule:{SANDBOX}:2026-11-07");
        assert_eq!(order_in(&e), None);
        e.stream = format!("order:{OTHER}:{OTHER}");
        assert_eq!(order_in(&e), None);
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
    fn every_live_class_is_reachable_the_kitchen_billing_crm_and_the_inbox_by_sandbox_and_the_order_and_catering_event_by_ref()
     {
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
        for live in bakery_app::routing::LIVE.iter().filter(|s| {
            !matches!(
                **s,
                Subscriber::Schedule | Subscriber::Customer | Subscriber::Dispatch
            )
        }) {
            assert!(
                subscriber(*live, &e).is_some(),
                "{live:?} is live but unbound"
            );
        }
        assert_eq!(
            subscriber(Subscriber::CateringEvent, &e),
            Some((catering::BINDING, format!("catering:{SANDBOX}:{OTHER}")))
        );
        assert_eq!(
            subscriber(Subscriber::Crm, &e),
            Some((crm::BINDING, format!("crm:{SANDBOX}")))
        );
        assert_eq!(
            subscriber(Subscriber::Inbox, &e),
            Some((inbox::BINDING, format!("inbox:{SANDBOX}")))
        );
        // The Customer is the order's, which takes a call: no instance from the envelope alone.
        assert_eq!(subscriber(Subscriber::Customer, &e), None);
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
