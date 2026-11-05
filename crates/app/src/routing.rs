//! The static subscriber table: which object classes each event goes to (docs/domain.md, "The
//! event catalog"; docs/architecture.md, "Events and the outbox", Consume). The consumer reads
//! it for every message; a new subscriber is a line here
//! (ADR 0004, decision 2).
//!
//! The table names every subscriber the catalog names, including classes that do not exist
//! yet. [`LIVE`] says which do, and [`deliver_to`] filters by it, so PR 4's consumer delivered to
//! the Kitchen only, PR 5's adds Billing and the Order, PR 6's the Schedule, PR 7's the
//! CateringEvent, and each later pull request turns its classes on by adding them to [`LIVE`].
//! A test reads the catalog table out of docs/domain.md and checks this one against it.

use bakery_domain::Envelope;

/// The object classes that subscribe to events, by the catalog's names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Subscriber {
    Control,
    Order,
    CateringEvent,
    Kitchen,
    Schedule,
    Billing,
    Dispatch,
    Customer,
    Crm,
    Inbox,
}

impl Subscriber {
    /// The class name, as docs/architecture.md, "Durable Object topology", writes it.
    pub fn class(self) -> &'static str {
        match self {
            Subscriber::Control => "Control",
            Subscriber::Order => "Order",
            Subscriber::CateringEvent => "CateringEvent",
            Subscriber::Kitchen => "Kitchen",
            Subscriber::Schedule => "Schedule",
            Subscriber::Billing => "Billing",
            Subscriber::Dispatch => "Dispatch",
            Subscriber::Customer => "Customer",
            Subscriber::Crm => "Crm",
            Subscriber::Inbox => "Inbox",
        }
    }
}

/// The classes that exist, as of PR 7 (docs/roadmap.md, "PR 7": catering and billing): the
/// Kitchen board, Billing (refund requests and expiries from the Order; the balance invoice
/// and the deposit's refund from the CateringEvent), the Order (payments and refunds from
/// Billing, by purpose and `ref`), the Schedule (an order's day, from its slot; a catering
/// event's day, from its date; every day from today on for `MenuPublished`) and the
/// CateringEvent (deposits and balances from Billing, by purpose and `ref`, and its invoice).
/// The consumer delivers to no other; Crm and the rest join as their pull requests build them.
pub const LIVE: &[Subscriber] = &[
    Subscriber::Kitchen,
    Subscriber::Billing,
    Subscriber::Order,
    Subscriber::Schedule,
    Subscriber::CateringEvent,
];

/// Which instances of a class an event goes to, where the catalog narrows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scope {
    /// The sandbox's one object of the class, or the aggregate the stream names.
    All,
    /// Delivery orders only: `Dispatch (delivery)` on `OrderPlaced`.
    DeliveryOrders,
    /// The aggregate the data's `purpose` names: `order` goes to `Order`, `deposit` and
    /// `balance` to `CateringEvent`.
    ByPurpose,
    /// The aggregate the payment or refund belongs to, named by the data's `ref`
    /// (`PaymentFailed`, `RefundIssued`). The catalog gives these events no purpose; Billing's
    /// carry one all the same, and where it does [`routes_for`] narrows by it as for
    /// [`Scope::ByPurpose`]. Without one the consumer resolves `ref` through the Sandbox's
    /// registry.
    ByRef,
    /// One delivery per order in the plan's stops: `Order (each stop)` on `RoutePublished`.
    EachStop,
    /// Every `Schedule` day from today on: `Schedule (today on)` on `MenuPublished`.
    TodayOn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Route {
    pub to: Subscriber,
    pub scope: Scope,
}

const fn all(to: Subscriber) -> Route {
    Route {
        to,
        scope: Scope::All,
    }
}

const fn scoped(to: Subscriber, scope: Scope) -> Route {
    Route { to, scope }
}

use Scope::{ByPurpose, ByRef, DeliveryOrders, EachStop, TodayOn};
use Subscriber::{
    Billing, CateringEvent, Control, Crm, Customer, Dispatch, Inbox, Kitchen, Order, Schedule,
};

/// Every event in the catalog, in its order, with its subscribers in the order the catalog
/// lists them. An empty list is an event no one consumes.
pub const ROUTES: &[(&str, &[Route])] = &[
    ("SandboxSeeded", &[all(Crm)]),
    ("ClockAdvanced", &[all(Crm)]),
    ("FaultSet", &[all(Crm)]),
    ("ApiTokenRotated", &[all(Crm)]),
    ("SandboxWiped", &[all(Control)]),
    ("MenuItemChanged", &[all(Crm)]),
    ("MenuPublished", &[scoped(Schedule, TodayOn)]),
    (
        "OrderPlaced",
        &[all(Kitchen), all(Crm), scoped(Dispatch, DeliveryOrders)],
    ),
    (
        "OrderPaid",
        &[
            all(Schedule),
            all(Kitchen),
            all(Crm),
            all(Customer),
            all(Inbox),
        ],
    ),
    ("OrderPaymentLate", &[all(Crm)]),
    ("OrderRefundRequested", &[all(Billing)]),
    (
        "OrderExpired",
        &[all(Schedule), all(Billing), all(Kitchen), all(Dispatch)],
    ),
    (
        "OrderCancelled",
        &[all(Schedule), all(Kitchen), all(Dispatch), all(Crm)],
    ),
    ("OrderProductionStarted", &[all(Kitchen), all(Crm)]),
    ("OrderReady", &[all(Kitchen), all(Inbox), all(Crm)]),
    ("OrderOutForDelivery", &[all(Kitchen), all(Inbox)]),
    ("OrderPickedUp", &[all(Kitchen), all(Crm)]),
    ("OrderDelivered", &[all(Kitchen), all(Crm)]),
    ("OrderRefunded", &[all(Crm), all(Customer), all(Inbox)]),
    ("OrderClosed", &[all(Schedule), all(Crm)]),
    ("SlotHeld", &[]),
    ("SlotReserved", &[all(Kitchen)]),
    ("SlotReleased", &[all(Kitchen)]),
    ("SlotFulfilled", &[]),
    ("CapacityChanged", &[all(Crm)]),
    ("CapsRefreshed", &[]),
    ("BakeListChanged", &[all(Kitchen)]),
    ("CateringInquiryReceived", &[all(Crm), all(Inbox)]),
    ("CateringQuoteSent", &[all(Crm), all(Inbox)]),
    ("CateringQuoteAccepted", &[all(Crm)]),
    ("CateringDepositLapsed", &[all(Schedule)]),
    ("CateringQuoteExpired", &[all(Crm), all(Inbox)]),
    ("CateringDeclined", &[all(Crm), all(Inbox)]),
    (
        "CateringDepositPaid",
        &[all(Schedule), all(Crm), all(Inbox)],
    ),
    ("CateringReminderDue", &[all(Inbox)]),
    ("CateringProductionStarted", &[all(Kitchen)]),
    ("CateringDelivered", &[all(Billing), all(Kitchen)]),
    ("CateringBalanceInvoiced", &[all(Inbox), all(Crm)]),
    (
        "CateringBalancePaid",
        &[all(Schedule), all(Crm), all(Inbox)],
    ),
    ("CateringClosed", &[all(Schedule), all(Crm), all(Inbox)]),
    (
        "CateringCancelled",
        &[all(Schedule), all(Billing), all(Crm)],
    ),
    ("PaymentIntentCreated", &[all(Crm)]),
    ("PaymentIntentRecorded", &[]),
    (
        "PaymentSucceeded",
        &[scoped(Order, ByPurpose), scoped(CateringEvent, ByPurpose)],
    ),
    (
        "PaymentFailed",
        &[
            scoped(Order, ByRef),
            scoped(CateringEvent, ByRef),
            all(Inbox),
        ],
    ),
    ("PaymentCanceled", &[all(Crm)]),
    ("RefundRequested", &[]),
    (
        "RefundIssued",
        &[scoped(Order, ByRef), scoped(CateringEvent, ByRef)],
    ),
    ("InvoiceIssued", &[all(CateringEvent)]),
    ("RouteProposed", &[all(Crm)]),
    ("RoutePublished", &[scoped(Order, EachStop), all(Kitchen)]),
    ("StopCompleted", &[all(Order)]),
    ("ConsentChanged", &[all(Crm)]),
    ("LoyaltyPointsEarned", &[all(Crm)]),
    ("CampaignScheduled", &[all(Crm)]),
    ("CampaignCancelled", &[all(Crm)]),
    ("CampaignSent", &[all(Inbox)]),
    ("ProjectionRebuildFinished", &[]),
    ("MessageDelivered", &[all(Crm)]),
    ("MessageOpened", &[all(Crm)]),
    ("MessageClicked", &[all(Crm)]),
    ("TrafficStarted", &[all(Crm)]),
    ("TrafficStopped", &[all(Crm)]),
];

/// The catalog's routes for an event type; `None` for a type the catalog does not list.
pub fn routes(event_type: &str) -> Option<&'static [Route]> {
    ROUTES
        .iter()
        .find(|(name, _)| *name == event_type)
        .map(|(_, routes)| *routes)
}

/// The routes this envelope takes, narrowed by what its data says: a pickup skips `Dispatch`,
/// and a payment or refund goes to the aggregate its `purpose` names. The instance is the
/// consumer's to find: for `ByPurpose` and `ByRef` the aggregate the data's `ref` names
/// ([`reference`]), and for `EachStop` and `TodayOn` the registry and the days.
pub fn routes_for(envelope: &Envelope) -> Vec<Route> {
    let Some(routes) = routes(&envelope.event_type) else {
        return Vec::new();
    };
    let field = |name: &str| envelope.data.get(name).and_then(|v| v.as_str());
    let purpose_fits = |to: Subscriber, purpose: Option<&str>| {
        matches!(
            (to, purpose),
            (Subscriber::Order, Some("order"))
                | (Subscriber::CateringEvent, Some("deposit" | "balance"))
        )
    };
    routes
        .iter()
        .copied()
        .filter(|r| match r.scope {
            Scope::DeliveryOrders => field("kind") == Some("delivery"),
            Scope::ByPurpose => purpose_fits(r.to, field("purpose")),
            Scope::ByRef => field("purpose").is_none_or(|p| purpose_fits(r.to, Some(p))),
            Scope::All | Scope::EachStop | Scope::TodayOn => true,
        })
        .collect()
}

/// The aggregate a `ByPurpose` or `ByRef` route delivers to: the ULID in the data's `ref`.
pub fn reference(envelope: &Envelope) -> Option<bakery_domain::Ulid> {
    envelope.data.get("ref")?.as_str()?.parse().ok()
}

/// The routes the consumer delivers on now: [`routes_for`], limited to the [`LIVE`] classes.
/// An envelope with none is acked at once.
pub fn deliver_to(envelope: &Envelope) -> Vec<Route> {
    routes_for(envelope)
        .into_iter()
        .filter(|r| LIVE.contains(&r.to))
        .collect()
}

/// The envelope as `to` receives it. The order note is kept for the Kitchen alone, and the
/// catering brief for no subscriber, since staff read it from the aggregate (docs/domain.md,
/// "The event catalog", the paragraph under the table).
pub fn strip_for(envelope: &Envelope, to: Subscriber) -> Envelope {
    let mut out = envelope.clone();
    let field = match out.event_type.as_str() {
        "OrderPlaced" if to != Subscriber::Kitchen => Some("note"),
        "CateringInquiryReceived" => Some("brief"),
        _ => None,
    };
    if let (Some(field), Some(data)) = (field, out.data.as_object_mut()) {
        data.remove(field);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakery_domain::billing::BillingEvent;
    use bakery_domain::catalog::CatalogEvent;
    use bakery_domain::catering::CateringEvent as CateringEvents;
    use bakery_domain::order::OrderEvent;
    use bakery_domain::schedule::ScheduleEvent;
    use bakery_domain::{DomainEvent, Ulid, WallTime};
    use serde_json::json;
    use std::collections::BTreeSet;

    const DOMAIN_MD: &str = include_str!("../../../docs/domain.md");

    /// The catalog table in docs/domain.md as `(event names, subscribers cell)` rows.
    fn catalog_rows() -> Vec<(Vec<String>, String)> {
        let section = DOMAIN_MD
            .split("\n## The event catalog\n")
            .nth(1)
            .and_then(|rest| rest.split("\n## ").next())
            .expect("docs/domain.md has an event catalog section");
        section
            .lines()
            .filter(|l| l.starts_with("| `"))
            .map(|l| {
                let cells: Vec<&str> = l.trim_matches('|').split('|').map(str::trim).collect();
                let names = cells[0]
                    .split('`')
                    .skip(1)
                    .step_by(2)
                    .map(str::to_owned)
                    .collect();
                (names, cells[3].to_owned())
            })
            .collect()
    }

    fn class_named(name: &str) -> Subscriber {
        [
            Control,
            Order,
            CateringEvent,
            Kitchen,
            Schedule,
            Billing,
            Dispatch,
            Customer,
            Crm,
            Inbox,
        ]
        .into_iter()
        .find(|s| s.class() == name)
        .unwrap_or_else(|| panic!("the catalog names an unknown class {name:?}"))
    }

    /// Reads a subscribers cell the way the catalog writes it: `;` between subscribers, a
    /// parenthetical or "by purpose" narrowing one, and "none".
    fn parse_subscribers(cell: &str) -> Vec<Route> {
        if cell == "none" {
            return Vec::new();
        }
        cell.split(';')
            .map(str::trim)
            .flat_map(|part| {
                if let Some(both) = part.strip_suffix(", by purpose") {
                    return both
                        .split(" or ")
                        .map(|c| scoped(class_named(c), ByPurpose))
                        .collect::<Vec<_>>();
                }
                if part.contains(" or ") {
                    return part
                        .split(" or ")
                        .map(|c| scoped(class_named(c), ByRef))
                        .collect();
                }
                let (name, scope) = match part.split_once(" (") {
                    Some((name, "delivery)")) => (name, DeliveryOrders),
                    Some((name, "each stop)")) => (name, EachStop),
                    Some((name, "today on)")) => (name, TodayOn),
                    Some((_, other)) => panic!("unknown narrowing ({other}"),
                    None => (part, Scope::All),
                };
                vec![scoped(class_named(name), scope)]
            })
            .collect()
    }

    #[test]
    fn every_catalog_event_has_its_row_and_no_more() {
        let rows = catalog_rows();
        let mut in_doc = BTreeSet::new();
        for (names, cell) in &rows {
            let expected = parse_subscribers(cell);
            for name in names {
                in_doc.insert(name.as_str());
                assert_eq!(
                    routes(name),
                    Some(expected.as_slice()),
                    "{name}: the table disagrees with docs/domain.md ({cell})"
                );
            }
        }
        let in_table: BTreeSet<&str> = ROUTES.iter().map(|(name, _)| *name).collect();
        assert_eq!(in_table, in_doc);
        assert_eq!(ROUTES.len(), in_table.len(), "an event is listed twice");
        // The table has as many rows as the catalog has events.
        assert_eq!(in_doc.len(), 63);
    }

    #[test]
    fn every_domain_event_is_routed() {
        for name in OrderEvent::NAMES
            .iter()
            .chain(CatalogEvent::NAMES)
            .chain(ScheduleEvent::NAMES)
            .chain(BillingEvent::NAMES)
            .chain(CateringEvents::NAMES)
        {
            assert!(routes(name).is_some(), "{name} has no row");
        }
    }

    #[test]
    fn the_catering_saga_reaches_the_schedule_and_billing() {
        let schedule_and = |name: &str| classes(routes_for(&envelope(name, json!({}))));
        // Confirm, Release, Fulfil.
        assert_eq!(
            schedule_and("CateringDepositPaid"),
            ["Schedule", "Crm", "Inbox"]
        );
        assert_eq!(schedule_and("CateringDepositLapsed"), ["Schedule"]);
        assert_eq!(
            schedule_and("CateringCancelled"),
            ["Schedule", "Billing", "Crm"]
        );
        assert_eq!(schedule_and("CateringClosed"), ["Schedule", "Crm", "Inbox"]);
        // The balance invoice: raised on delivery, recorded by the job, paid by purpose.
        assert_eq!(schedule_and("CateringDelivered"), ["Billing", "Kitchen"]);
        assert_eq!(schedule_and("InvoiceIssued"), ["CateringEvent"]);
        let balance = envelope("PaymentSucceeded", json!({ "purpose": "balance" }));
        assert_eq!(classes(routes_for(&balance)), ["CateringEvent"]);
    }

    #[test]
    fn pr4_subscribers_are_named_as_the_catalog_names_them() {
        let named: BTreeSet<&str> = ROUTES
            .iter()
            .flat_map(|(_, r)| r.iter().map(|r| r.to.class()))
            .collect();
        for class in [
            "Kitchen", "Crm", "Billing", "Schedule", "Dispatch", "Inbox", "Customer",
        ] {
            assert!(named.contains(class), "{class}");
        }
    }

    fn envelope(event_type: &str, data: serde_json::Value) -> Envelope {
        let id = Ulid::from_parts(1_793_819_530_318, 1);
        Envelope {
            v: 1,
            id,
            sandbox: id,
            stream: format!("order:{id}:{id}"),
            seq: 1,
            event_type: event_type.to_owned(),
            at: "2026-11-07T09:00:00-07:00".parse().unwrap(),
            recorded_at: WallTime::from_unix_ms(1_793_819_530_318).unwrap(),
            data,
            cause: None,
        }
    }

    fn classes(routes: Vec<Route>) -> Vec<&'static str> {
        routes.into_iter().map(|r| r.to.class()).collect()
    }

    #[test]
    fn data_narrows_the_routes() {
        let pickup = envelope(
            "OrderPlaced",
            json!({ "kind": "pickup", "note": "Slice it" }),
        );
        assert_eq!(classes(routes_for(&pickup)), ["Kitchen", "Crm"]);
        let delivery = envelope("OrderPlaced", json!({ "kind": "delivery" }));
        assert_eq!(
            classes(routes_for(&delivery)),
            ["Kitchen", "Crm", "Dispatch"]
        );
        let order_payment = envelope("PaymentSucceeded", json!({ "purpose": "order" }));
        assert_eq!(classes(routes_for(&order_payment)), ["Order"]);
        let deposit = envelope("PaymentSucceeded", json!({ "purpose": "deposit" }));
        assert_eq!(classes(routes_for(&deposit)), ["CateringEvent"]);
        // A failed payment with no purpose goes to both, for the consumer to resolve its `ref`;
        // Billing's carry a purpose, which narrows it.
        let failed = envelope(
            "PaymentFailed",
            json!({ "payment": "x", "code": "card_declined" }),
        );
        assert_eq!(
            classes(routes_for(&failed)),
            ["Order", "CateringEvent", "Inbox"]
        );
        let failed = envelope(
            "PaymentFailed",
            json!({ "payment": "x", "purpose": "order", "code": "card_declined" }),
        );
        assert_eq!(classes(routes_for(&failed)), ["Order", "Inbox"]);
        let refund = envelope("RefundIssued", json!({ "purpose": "balance" }));
        assert_eq!(classes(routes_for(&refund)), ["CateringEvent"]);
        assert!(routes_for(&envelope("NotAnEvent", json!({}))).is_empty());
        assert!(routes_for(&envelope("ProjectionRebuildFinished", json!({}))).is_empty());
    }

    #[test]
    fn pr7_delivers_to_the_kitchen_billing_the_order_the_schedule_and_the_catering_event() {
        assert_eq!(LIVE, [Kitchen, Billing, Order, Schedule, CateringEvent]);
        let paid = envelope("OrderPaid", json!({ "payment": "x", "amount_cents": 1 }));
        assert_eq!(classes(deliver_to(&paid)), ["Schedule", "Kitchen"]);
        assert_eq!(
            classes(deliver_to(&envelope("MenuPublished", json!({})))),
            ["Schedule"]
        );
        assert_eq!(
            classes(deliver_to(&envelope("OrderClosed", json!({})))),
            ["Schedule"]
        );
        for name in ["BakeListChanged", "SlotReserved", "SlotReleased"] {
            assert_eq!(classes(deliver_to(&envelope(name, json!({})))), ["Kitchen"]);
        }
        // Events with no live subscriber are acked at once.
        for name in [
            "SlotHeld",
            "SandboxWiped",
            "PaymentIntentCreated",
            "PaymentCanceled",
            "PaymentIntentRecorded",
            "RefundRequested",
        ] {
            assert!(deliver_to(&envelope(name, json!({}))).is_empty(), "{name}");
        }
        // The Order asks Billing for its refunds and its intent's cancel.
        assert_eq!(
            classes(deliver_to(&envelope("OrderRefundRequested", json!({})))),
            ["Billing"]
        );
        assert_eq!(
            classes(deliver_to(&envelope("OrderExpired", json!({})))),
            ["Schedule", "Billing", "Kitchen"]
        );
        // Billing answers the Order named by `ref`, when the purpose is an order.
        let order = Ulid::from_parts(1_793_819_530_318, 7);
        for name in ["PaymentSucceeded", "PaymentFailed", "RefundIssued"] {
            let to_order = envelope(
                name,
                json!({ "purpose": "order", "ref": order.to_string() }),
            );
            assert_eq!(classes(deliver_to(&to_order)), ["Order"], "{name}");
            assert_eq!(reference(&to_order), Some(order));
            let to_catering = envelope(
                name,
                json!({ "purpose": "deposit", "ref": order.to_string() }),
            );
            assert_eq!(
                classes(deliver_to(&to_catering)),
                ["CateringEvent"],
                "{name}"
            );
        }
        // The saga's edges: the day, Billing and the event itself.
        for (name, to) in [
            ("CateringDepositPaid", &["Schedule"][..]),
            ("CateringDepositLapsed", &["Schedule"]),
            ("CateringDelivered", &["Billing", "Kitchen"]),
            ("CateringClosed", &["Schedule"]),
            ("CateringCancelled", &["Schedule", "Billing"]),
            ("InvoiceIssued", &["CateringEvent"]),
        ] {
            assert_eq!(
                classes(deliver_to(&envelope(name, json!({})))),
                to,
                "{name}"
            );
        }
        assert_eq!(
            reference(&envelope("RefundIssued", json!({ "ref": "nope" }))),
            None
        );
        // Every order event the board draws reaches it.
        for name in [
            "OrderPlaced",
            "OrderPaid",
            "OrderCancelled",
            "OrderProductionStarted",
            "OrderReady",
            "OrderOutForDelivery",
            "OrderPickedUp",
            "OrderDelivered",
        ] {
            assert!(
                classes(deliver_to(&envelope(name, json!({})))).contains(&"Kitchen"),
                "{name}"
            );
        }
    }

    #[test]
    fn the_note_reaches_the_kitchen_alone_and_the_brief_no_one() {
        let placed = envelope(
            "OrderPlaced",
            json!({ "kind": "pickup", "note": "Slice it" }),
        );
        assert_eq!(strip_for(&placed, Kitchen).data["note"], "Slice it");
        let for_crm = strip_for(&placed, Crm);
        assert!(for_crm.data.get("note").is_none());
        assert_eq!(for_crm.data["kind"], "pickup");
        let inquiry = envelope(
            "CateringInquiryReceived",
            json!({ "headcount": 40, "brief": "Gluten-free options" }),
        );
        for to in [Crm, Inbox, Kitchen] {
            assert!(strip_for(&inquiry, to).data.get("brief").is_none());
        }
        assert_eq!(strip_for(&inquiry, Crm).data["headcount"], 40);
    }
}
