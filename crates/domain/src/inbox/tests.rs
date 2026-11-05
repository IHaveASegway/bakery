use super::*;
use crate::WallTime;
use crate::catering::DeclineReason;
use crate::check_free_text;
use crate::order::Line;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(1_793_000_000_000, n)
}

const SANDBOX: u128 = 7;
const NOW: &str = "2026-11-07T09:00:00-07:00";

fn t(text: &str) -> BusinessTime {
    text.parse().unwrap()
}

fn envelope(id: u128, stream: String, event: &impl DomainEvent) -> Envelope {
    Envelope {
        v: 1,
        id: ulid(id),
        sandbox: ulid(SANDBOX),
        stream,
        seq: 1,
        event_type: event.name().to_owned(),
        at: t(NOW),
        recorded_at: WallTime::from_unix_ms(1_793_000_000_000).unwrap(),
        data: event.to_data(),
        cause: None,
    }
}

fn order(n: u128) -> String {
    format!("order:{}:{}", ulid(SANDBOX), ulid(n))
}

fn catering(n: u128) -> String {
    format!("catering:{}:{}", ulid(SANDBOX), ulid(n))
}

fn placed(n: u128, customer: u128) -> OrderEvent {
    OrderEvent::OrderPlaced {
        order: ulid(n),
        customer: ulid(customer),
        kind: OrderKind::Pickup,
        slot: t("2026-11-07T11:00:00-07:00"),
        zone: None,
        lines: vec![Line {
            item: "croissant".into(),
            variant: "croissant/box-6".into(),
            qty: 3,
            unit_cents: Cents(1_800),
        }],
        subtotal_cents: Cents(5_400),
        tax_cents: Cents(540),
        total_cents: Cents(5_940),
        note: Some("NOTE-CANARY ring twice".into()),
        menu_version: 1,
        held_until: t("2026-11-07T09:15:00-07:00"),
    }
}

fn applied(inbox: &mut Inbox, e: &Envelope) -> (Vec<Message>, Vec<InboxEvent>) {
    match inbox.apply(e) {
        Ok(InboxChange::Applied { messages, events }) => (messages, events),
        other => panic!("{other:?}"),
    }
}

#[test]
fn every_template_renders_without_a_free_text_field() {
    let all = every_template();
    assert!(all.len() > 50);
    for (subject, body) in all {
        for text in [&subject, &body] {
            assert_eq!(check_free_text(text), Ok(()), "{text}");
            assert!(!text.contains('@') && !text.contains("http"), "{text}");
            assert!(!text.is_empty());
        }
    }
}

#[test]
fn an_order_makes_a_receipt_a_ready_note_and_a_refund_notice() {
    let mut inbox = Inbox::default();
    let (none, events) = applied(&mut inbox, &envelope(1, order(10), &placed(10, 2)));
    assert!(none.is_empty() && events.is_empty());
    let paid = OrderEvent::OrderPaid {
        payment: ulid(11),
        amount_cents: Cents(5_940),
    };
    let (messages, events) = applied(&mut inbox, &envelope(2, order(10), &paid));
    assert_eq!(messages.len(), 1);
    let m = &messages[0];
    assert_eq!(
        (m.to, m.kind, m.reference),
        (ulid(2), MessageKind::Receipt, ulid(10))
    );
    assert_eq!(
        m.body,
        "Thank you. Your pickup order of 3 items is paid: $59.40. We will tell you when it is ready."
    );
    assert_eq!(m.delivered_at, t(NOW));
    assert_eq!(m.id, message_id(ulid(2), ulid(2)));
    assert_eq!(
        events,
        [InboxEvent::MessageDelivered {
            message: m.id,
            to: ulid(2),
            kind: MessageKind::Receipt,
            reference: ulid(10),
        }]
    );
    applied(
        &mut inbox,
        &envelope(3, order(10), &OrderEvent::OrderReady {}),
    );
    let refunded = OrderEvent::OrderRefunded {
        refund: ulid(12),
        amount_cents: Cents(5_940),
        full: true,
    };
    let (messages, _) = applied(&mut inbox, &envelope(4, order(10), &refunded));
    assert_eq!(
        messages[0].body,
        "$59.40 is on its way back to your card. That refunds the order in full."
    );
    let kinds: Vec<MessageKind> = inbox.messages().iter().map(|m| m.kind).collect();
    assert_eq!(kinds.len(), 3);
    // Nothing the Inbox stores holds the note.
    assert!(!serde_json::to_string(&inbox).unwrap().contains("CANARY"));
}

#[test]
fn a_replayed_event_makes_one_message() {
    let mut inbox = Inbox::default();
    applied(&mut inbox, &envelope(1, order(10), &placed(10, 2)));
    let paid = envelope(
        2,
        order(10),
        &OrderEvent::OrderPaid {
            payment: ulid(11),
            amount_cents: Cents(5_940),
        },
    );
    applied(&mut inbox, &paid);
    assert_eq!(inbox.apply(&paid), Ok(InboxChange::Duplicate));
    assert_eq!(inbox.messages().len(), 1);
    // A campaign sent twice, under two event ids, still makes one message per recipient.
    let sent = CrmEvent::CampaignSent {
        campaign: ulid(40),
        recipients: vec![ulid(2), ulid(3)],
        subject: SubjectTemplate::CakeWeek,
        body: BodyTemplate::CakeOrders,
    };
    let crm = format!("crm:{}", ulid(SANDBOX));
    let (first, _) = applied(&mut inbox, &envelope(20, crm.clone(), &sent));
    let (second, events) = applied(&mut inbox, &envelope(21, crm, &sent));
    assert_eq!(first.len(), 2);
    assert!(second.is_empty() && events.is_empty());
    assert_eq!(first[0].campaign(), Some(ulid(40)));
    assert_eq!(first[0].subject, "It is cake week");
}

#[test]
fn a_message_for_an_order_not_yet_placed_is_retried() {
    let mut inbox = Inbox::default();
    let ready = envelope(3, order(10), &OrderEvent::OrderReady {});
    assert_eq!(inbox.apply(&ready), Err(InboxError::UnknownRef(ulid(10))));
    applied(&mut inbox, &envelope(1, order(10), &placed(10, 2)));
    let (messages, _) = applied(&mut inbox, &ready);
    assert_eq!(messages[0].kind, MessageKind::Ready);
}

#[test]
fn a_catering_job_writes_to_the_customer_who_asked() {
    let mut inbox = Inbox::default();
    let inquiry = CateringEvent::CateringInquiryReceived {
        catering: ulid(30),
        customer: ulid(4),
        date: "2026-11-21".parse().unwrap(),
        headcount: 40,
        package: "breakfast-spread".into(),
        venue: "v3".into(),
        brief: Some("BRIEF-CANARY".into()),
    };
    let (m, _) = applied(&mut inbox, &envelope(1, catering(30), &inquiry));
    assert_eq!(
        m[0].body,
        "Thank you for asking about the breakfast spread for 40 people at v3 on Saturday 21 November 2026. A quote follows soon."
    );
    let quote = CateringEvent::CateringQuoteSent {
        total_cents: Cents(120_000),
        deposit_cents: Cents(30_000),
        valid_until: t("2026-11-25T07:00:00-07:00"),
        follow_up_at: t("2026-11-10T07:00:00-07:00"),
    };
    let (m, _) = applied(&mut inbox, &envelope(2, catering(30), &quote));
    assert_eq!(m[0].kind, MessageKind::Quote);
    assert_eq!(m[0].to, ulid(4));
    let invoiced = CateringEvent::CateringBalanceInvoiced {
        invoice: ulid(31),
        amount_cents: Cents(90_000),
        due: "2026-11-28".parse().unwrap(),
    };
    applied(&mut inbox, &envelope(3, catering(30), &invoiced));
    let due = CateringEvent::CateringReminderDue {
        kind: ReminderKind::InvoiceDue,
    };
    let (m, _) = applied(&mut inbox, &envelope(4, catering(30), &due));
    assert_eq!(
        m[0].body,
        "The balance of $900.00 for Saturday 21 November 2026 is due."
    );
    // The balance's payment receipts once, on the close.
    let paid = CateringEvent::CateringBalancePaid { payment: ulid(31) };
    assert_eq!(
        inbox.apply(&envelope(5, catering(30), &paid)),
        Ok(InboxChange::NotForInbox)
    );
    let closed = CateringEvent::CateringClosed {
        payment: Some(ulid(31)),
    };
    let (m, _) = applied(&mut inbox, &envelope(6, catering(30), &closed));
    assert_eq!(m[0].kind, MessageKind::Receipt);
    let declined = CateringEvent::CateringDeclined {
        reason: DeclineReason::Other,
    };
    let (m, _) = applied(&mut inbox, &envelope(7, catering(30), &declined));
    assert_eq!(m[0].kind, MessageKind::Notice);
    assert!(!serde_json::to_string(&inbox).unwrap().contains("CANARY"));
}

#[test]
fn a_declined_card_reaches_the_owner_of_its_ref() {
    let mut inbox = Inbox::default();
    applied(&mut inbox, &envelope(1, order(10), &placed(10, 2)));
    let failed = BillingEvent::PaymentFailed {
        payment: ulid(50),
        purpose: Purpose::Order,
        reference: ulid(10),
        code: "card_declined".into(),
        stripe_event: "evt_test".into(),
    };
    let billing = format!("billing:{}", ulid(SANDBOX));
    let (m, _) = applied(&mut inbox, &envelope(2, billing.clone(), &failed));
    assert_eq!((m[0].to, m[0].kind), (ulid(2), MessageKind::Declined));
    let orphan = BillingEvent::PaymentFailed {
        payment: ulid(51),
        purpose: Purpose::Deposit,
        reference: ulid(99),
        code: "card_declined".into(),
        stripe_event: "evt_test_2".into(),
    };
    assert_eq!(
        inbox.apply(&envelope(3, billing, &orphan)),
        Err(InboxError::UnknownRef(ulid(99)))
    );
}

#[test]
fn opens_and_clicks_are_recorded_once() {
    let mut inbox = Inbox::default();
    let sent = CrmEvent::CampaignSent {
        campaign: ulid(40),
        recipients: vec![ulid(2)],
        subject: SubjectTemplate::ThankYou,
        body: BodyTemplate::Announcement,
    };
    let (m, _) = applied(
        &mut inbox,
        &envelope(20, format!("crm:{}", ulid(SANDBOX)), &sent),
    );
    let id = m[0].id;
    let at = t("2026-11-07T10:00:00-07:00");
    let open = InboxCommand::RecordOpen { message: id };
    assert_eq!(
        inbox.handle(open, at),
        Ok(vec![InboxEvent::MessageOpened {
            message: id,
            campaign: Some(ulid(40))
        }])
    );
    assert_eq!(inbox.handle(open, at), Ok(vec![]));
    let click = InboxCommand::RecordClick { message: id };
    assert_eq!(inbox.handle(click, at).unwrap().len(), 1);
    assert_eq!(inbox.handle(click, at), Ok(vec![]));
    assert_eq!(inbox.message(id).unwrap().clicked_at, Some(at));
    assert_eq!(
        inbox.handle(open, at),
        Ok(vec![]),
        "an open after the click is still a repeat"
    );
    assert_eq!(
        inbox.handle(InboxCommand::RecordOpen { message: ulid(1) }, at),
        Err(InboxError::UnknownMessage(ulid(1)))
    );
}

#[test]
fn a_click_on_an_unopened_message_opens_it() {
    let mut inbox = Inbox::default();
    applied(&mut inbox, &envelope(1, order(10), &placed(10, 2)));
    let (m, _) = applied(
        &mut inbox,
        &envelope(
            2,
            order(10),
            &OrderEvent::OrderPaid {
                payment: ulid(11),
                amount_cents: Cents(100),
            },
        ),
    );
    let events = inbox
        .handle(InboxCommand::RecordClick { message: m[0].id }, t(NOW))
        .unwrap();
    assert_eq!(
        events,
        [
            InboxEvent::MessageOpened {
                message: m[0].id,
                campaign: None
            },
            InboxEvent::MessageClicked {
                message: m[0].id,
                campaign: None
            },
        ]
    );
}

#[test]
fn inbox_events_round_trip_through_an_envelope() {
    for event in [
        InboxEvent::MessageDelivered {
            message: ulid(1),
            to: ulid(2),
            kind: MessageKind::OnItsWay,
            reference: ulid(3),
        },
        InboxEvent::MessageOpened {
            message: ulid(1),
            campaign: None,
        },
        InboxEvent::MessageClicked {
            message: ulid(1),
            campaign: Some(ulid(4)),
        },
    ] {
        let e = envelope(9, format!("inbox:{}", ulid(SANDBOX)), &event);
        let back: Envelope = serde_json::from_str(&serde_json::to_string(&e).unwrap()).unwrap();
        assert_eq!(InboxEvent::from_envelope(&back).unwrap(), event);
    }
    let data = InboxEvent::MessageDelivered {
        message: ulid(1),
        to: ulid(2),
        kind: MessageKind::OnItsWay,
        reference: ulid(3),
    }
    .to_data();
    assert_eq!(data["kind"], "on_its_way");
    assert_eq!(data["ref"], ulid(3).to_string());
}

#[test]
fn message_ids_are_distinct_and_keep_the_cause_s_time() {
    let mut ids = BTreeSet::new();
    for source in 0..50u128 {
        for to in 0..60u128 {
            let id = message_id(ulid(source), ulid(1_000 + to));
            assert_eq!(id.unix_ms(), 1_793_000_000_000);
            assert!(ids.insert(id));
        }
    }
    assert_eq!(message_id(ulid(1), ulid(2)), message_id(ulid(1), ulid(2)));
}

#[test]
fn engagement_rates_are_within_bounds_and_the_same_every_run() {
    let messages: Vec<Ulid> = (0..2_000u128)
        .map(|n| message_id(ulid(n), ulid(n % 60)))
        .collect();
    let run =
        |seed: u64| -> Vec<Engagement> { messages.iter().map(|&m| engagement(seed, m)).collect() };
    let a = run(42);
    assert_eq!(a, run(42));
    assert_ne!(a, run(43));
    let opened = a.iter().filter(|e| e.opens_after.is_some()).count();
    let clicked = a.iter().filter(|e| e.clicks_after.is_some()).count();
    let open_rate = opened as f64 / a.len() as f64;
    let click_rate = clicked as f64 / opened as f64;
    assert!((0.40..0.50).contains(&open_rate), "{open_rate}");
    assert!((0.27..0.40).contains(&click_rate), "{click_rate}");
    for e in &a {
        match (e.opens_after, e.clicks_after) {
            (Some(o), c) => {
                assert!((5..=180).contains(&o));
                if let Some(c) = c {
                    assert!(c > o && c <= o + 10);
                }
            }
            (None, c) => assert_eq!(c, None),
        }
    }
}
