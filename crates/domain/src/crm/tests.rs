use super::*;
use crate::catering::DeclineReason;
use crate::inbox::InboxEvent;
use crate::{WallTime, execute};
use proptest::prelude::*;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(1_793_000_000_000, n)
}

const SANDBOX: u128 = 7;
const ALDER: u128 = 1;
const BIRCH: u128 = 2;
const CEDAR: u128 = 3;

fn directory() -> Directory {
    let persona = |n: u128, name: &str, marketing: bool| Persona {
        customer: ulid(n),
        display_name: name.into(),
        home_zone: "z1".into(),
        marketing,
        opening_points: 10 * n as u32,
    };
    Directory {
        personas: vec![
            persona(ALDER, "Alder Ridge", true),
            persona(BIRCH, "Birch Cove", true),
            persona(CEDAR, "Cedar Kiln", false),
        ],
        cake_items: ["chocolate-layer".to_owned()].into_iter().collect(),
    }
}

fn t(text: &str) -> BusinessTime {
    text.parse().unwrap()
}

const NOW: &str = "2026-11-07T09:00:00-07:00";

fn envelope(id: u128, stream: String, seq: u64, at: &str, event: &impl DomainEvent) -> Envelope {
    Envelope {
        v: 1,
        id: ulid(id),
        sandbox: ulid(SANDBOX),
        stream,
        seq,
        event_type: event.name().to_owned(),
        at: t(at),
        recorded_at: WallTime::from_unix_ms(1_793_000_000_000).unwrap(),
        data: event.to_data(),
        cause: None,
    }
}

fn order_stream(order: u128) -> String {
    format!("order:{}:{}", ulid(SANDBOX), ulid(order))
}

fn line(item: &str, qty: u16) -> Line {
    Line {
        item: item.into(),
        variant: format!("{item}/whole"),
        qty,
        unit_cents: Cents(1_000),
    }
}

fn placed(order: u128, customer: u128, kind: OrderKind, slot: &str, item: &str) -> OrderEvent {
    OrderEvent::OrderPlaced {
        order: ulid(order),
        customer: ulid(customer),
        kind,
        slot: t(slot),
        zone: (kind == OrderKind::Delivery).then(|| "z1".into()),
        lines: vec![line(item, 2)],
        subtotal_cents: Cents(2_000),
        tax_cents: Cents(200),
        total_cents: Cents(2_200),
        note: Some("NOTE-CANARY leave it by the bins".into()),
        menu_version: 1,
        held_until: t(slot),
    }
}

fn paid() -> OrderEvent {
    OrderEvent::OrderPaid {
        payment: ulid(900),
        amount_cents: Cents(2_200),
    }
}

/// A seed-history close: the order's only event, carrying who, how and when.
fn history(order: u128, customer: u128, kind: OrderKind, slot: &str, item: &str) -> Envelope {
    let event = OrderEvent::OrderClosed {
        total_cents: Cents(2_200),
        refunded_cents: Cents::ZERO,
        lines: Some(vec![line(item, 1)]),
        customer: Some(ulid(customer)),
        kind: Some(kind),
        slot: Some(t(slot)),
        zone: None,
    };
    envelope(10_000 + order, order_stream(order), 1, slot, &event)
}

fn live_order(order: u128, customer: u128, slot: &str, item: &str) -> Vec<Envelope> {
    vec![
        envelope(
            100 * order + 1,
            order_stream(order),
            1,
            "2026-11-06T10:00:00-07:00",
            &placed(order, customer, OrderKind::Pickup, slot, item),
        ),
        envelope(
            100 * order + 2,
            order_stream(order),
            2,
            "2026-11-06T10:02:00-07:00",
            &paid(),
        ),
    ]
}

fn applied(p: &mut CrmProjection, envelopes: &[Envelope]) {
    for e in envelopes {
        assert_eq!(p.apply(e), Ok(Outcome::Applied), "{}", e.event_type);
    }
}

fn members(p: &CrmProjection, segment: Segment) -> Vec<Ulid> {
    segment_members(p, segment, t(NOW))
}

#[test]
fn the_roster_is_the_customer_list_before_any_event() {
    let p = CrmProjection::new(&directory());
    let rows: Vec<(&str, i64, u32)> = p
        .customers()
        .map(|r| (r.display_name.as_str(), r.loyalty_balance, r.orders))
        .collect();
    assert_eq!(
        rows,
        [
            ("Alder Ridge", 10, 0),
            ("Birch Cove", 20, 0),
            ("Cedar Kiln", 30, 0)
        ]
    );
    assert_eq!(members(&p, Segment::Everyone).len(), 3);
    assert_eq!(members(&p, Segment::Lapsed60Days).len(), 3);
}

#[test]
fn a_history_close_counts_as_an_order_with_its_timeline_row() {
    let mut p = CrmProjection::new(&directory());
    applied(
        &mut p,
        &[history(
            50,
            ALDER,
            OrderKind::Delivery,
            "2026-10-20T11:00:00-07:00",
            "chocolate-layer",
        )],
    );
    let row = p.customer(ulid(ALDER)).unwrap();
    assert_eq!(row.orders, 1);
    assert_eq!(row.last_order_at, Some(t("2026-10-20T11:00:00-07:00")));
    let line = p.timeline(ulid(ALDER));
    assert_eq!(line.len(), 1);
    assert_eq!(line[0].event_type, "OrderClosed");
    assert_eq!(line[0].reference, ulid(50));
    assert_eq!(line[0].label, "Order closed: 1 item, $22.00");
    assert_eq!(members(&p, Segment::CakeLast30Days), [ulid(ALDER)]);
    assert_eq!(members(&p, Segment::DeliveryCustomers), [ulid(ALDER)]);
    assert_eq!(
        members(&p, Segment::Lapsed60Days),
        [ulid(BIRCH), ulid(CEDAR)]
    );
}

#[test]
fn a_live_close_with_no_order_placed_is_retried() {
    let mut p = CrmProjection::new(&directory());
    let close = OrderEvent::OrderClosed {
        total_cents: Cents(2_200),
        refunded_cents: Cents::ZERO,
        lines: None,
        customer: None,
        kind: None,
        slot: None,
        zone: None,
    };
    let e = envelope(1, order_stream(60), 5, NOW, &close);
    let before = p.to_json();
    assert_eq!(p.apply(&e), Err(CrmError::UnknownRef(ulid(60))));
    assert_eq!(p.to_json(), before);
}

#[test]
fn an_event_before_its_order_placed_is_retried_and_then_applies() {
    let mut p = CrmProjection::new(&directory());
    let order = live_order(61, BIRCH, "2026-11-08T09:00:00-07:00", "baguette");
    let before = p.to_json();
    assert_eq!(p.apply(&order[1]), Err(CrmError::UnknownRef(ulid(61))));
    assert_eq!(p.to_json(), before, "a refusal records nothing");
    applied(&mut p, &order);
    assert_eq!(p.customer(ulid(BIRCH)).unwrap().orders, 1);
    let labels: Vec<&str> = p
        .timeline(ulid(BIRCH))
        .iter()
        .map(|e| e.label.as_str())
        .collect();
    assert_eq!(
        labels,
        ["Placed a pickup order: 2 items, $22.00", "Paid $22.00"]
    );
}

#[test]
fn the_note_and_the_brief_are_never_stored() {
    let mut p = CrmProjection::new(&directory());
    let order = live_order(62, ALDER, "2026-11-08T09:00:00-07:00", "baguette");
    assert!(
        order[0].data["note"].as_str().is_some(),
        "the envelope has a note"
    );
    let inquiry = CateringEvent::CateringInquiryReceived {
        catering: ulid(70),
        customer: ulid(ALDER),
        date: "2026-11-21".parse().unwrap(),
        headcount: 40,
        package: "breakfast-spread".into(),
        venue: "v3".into(),
        brief: Some("BRIEF-CANARY gluten-free table".into()),
    };
    let inquiry = envelope(
        7_001,
        format!("catering:{}:{}", ulid(SANDBOX), ulid(70)),
        1,
        NOW,
        &inquiry,
    );
    let mut log = Vec::new();
    for e in order.iter().chain([&inquiry]) {
        assert_eq!(p.apply(e), Ok(Outcome::Applied));
        log.push(log_entry(e));
    }
    let text = p.to_json();
    assert!(!text.contains("CANARY"), "{text}");
    let logged = serde_json::to_string(&log).unwrap();
    assert!(!logged.contains("CANARY"), "{logged}");
    // The stripped log still rebuilds the same projection.
    assert_eq!(
        CrmProjection::from_log(&directory(), &log)
            .unwrap()
            .to_json(),
        text
    );
    assert_eq!(p.customer(ulid(ALDER)).unwrap().catering, 1);
    assert_eq!(members(&p, Segment::CateringLeads), [ulid(ALDER)]);
}

#[test]
fn a_duplicate_or_a_stale_envelope_changes_nothing() {
    let mut p = CrmProjection::new(&directory());
    let order = live_order(63, ALDER, "2026-11-08T09:00:00-07:00", "baguette");
    applied(&mut p, &order);
    let ready = envelope(6_304, order_stream(63), 4, NOW, &OrderEvent::OrderReady {});
    applied(&mut p, std::slice::from_ref(&ready));
    let before = p.to_json();
    assert_eq!(p.apply(&order[1]), Ok(Outcome::Duplicate));
    // The production step, seq 3, arrives after seq 4.
    let late = envelope(
        6_303,
        order_stream(63),
        3,
        NOW,
        &OrderEvent::OrderProductionStarted {},
    );
    assert_eq!(p.apply(&late), Ok(Outcome::Stale));
    // A type the catalog does not send Crm.
    let other = envelope(
        6_305,
        order_stream(63),
        5,
        NOW,
        &OrderEvent::OrderOutForDelivery {
            route: "van-1".into(),
            stop: 3,
        },
    );
    assert_eq!(p.apply(&other), Ok(Outcome::NotForCrm));
    assert_eq!(p.to_json(), before);
}

#[test]
fn a_cancelled_order_stops_counting() {
    let mut p = CrmProjection::new(&directory());
    applied(
        &mut p,
        &live_order(64, ALDER, "2026-11-08T09:00:00-07:00", "chocolate-layer"),
    );
    assert_eq!(members(&p, Segment::CakeLast30Days), [ulid(ALDER)]);
    let cancel = envelope(
        6_403,
        order_stream(64),
        3,
        NOW,
        &OrderEvent::OrderCancelled {
            by: CancelledBy::Staff,
        },
    );
    applied(&mut p, &[cancel]);
    assert!(members(&p, Segment::CakeLast30Days).is_empty());
    assert_eq!(p.customer(ulid(ALDER)).unwrap().orders, 0);
}

#[test]
fn membership_changes_exactly_when_the_event_arrives() {
    let mut p = CrmProjection::new(&directory());
    let order = live_order(65, BIRCH, "2026-11-08T09:00:00-07:00", "chocolate-layer");
    // Placed and not paid: not an order yet.
    applied(&mut p, &order[..1]);
    assert!(members(&p, Segment::CakeLast30Days).is_empty());
    assert!(members(&p, Segment::Lapsed60Days).contains(&ulid(BIRCH)));
    applied(&mut p, &order[1..]);
    assert_eq!(members(&p, Segment::CakeLast30Days), [ulid(BIRCH)]);
    assert!(!members(&p, Segment::Lapsed60Days).contains(&ulid(BIRCH)));
    // Time moves on: a month later the cake is out of the window, two months later Birch lapses.
    let later = |days: i64| t(NOW).plus_minutes(days * 24 * 60).unwrap();
    assert!(segment_members(&p, Segment::CakeLast30Days, later(32)).is_empty());
    assert!(segment_members(&p, Segment::Lapsed60Days, later(62)).contains(&ulid(BIRCH)));
}

#[test]
fn consent_comes_from_the_customer_stream_and_gates_the_audience() {
    let mut p = CrmProjection::new(&directory());
    let everyone = Audience::of(&p, Segment::Everyone, t(NOW));
    assert_eq!(everyone.recipients(), [ulid(ALDER), ulid(BIRCH)]);
    let stream = format!("customer:{}:{}", ulid(SANDBOX), ulid(ALDER));
    let off = envelope(
        8_001,
        stream.clone(),
        2,
        NOW,
        &CustomerEvent::ConsentChanged { marketing: false },
    );
    applied(&mut p, &[off]);
    assert_eq!(
        Audience::of(&p, Segment::Everyone, t(NOW)).recipients(),
        [ulid(BIRCH)]
    );
    // An older consent arriving late is stale and does not turn it back on.
    let old_on = envelope(
        8_000,
        stream,
        1,
        NOW,
        &CustomerEvent::ConsentChanged { marketing: true },
    );
    assert_eq!(p.apply(&old_on), Ok(Outcome::Stale));
    assert!(!p.customer(ulid(ALDER)).unwrap().marketing);
    // Still a member of the segment: consent gates the send, not the rule.
    assert_eq!(members(&p, Segment::Everyone).len(), 3);
}

#[test]
fn loyalty_comes_from_the_customer_stream() {
    let mut p = CrmProjection::new(&directory());
    let stream = format!("customer:{}:{}", ulid(SANDBOX), ulid(BIRCH));
    let earn = envelope(
        8_101,
        stream.clone(),
        2,
        NOW,
        &CustomerEvent::LoyaltyPointsEarned {
            order: ulid(66),
            points: 22,
            refund: None,
        },
    );
    let back = envelope(
        8_102,
        stream,
        3,
        NOW,
        &CustomerEvent::LoyaltyPointsEarned {
            order: ulid(66),
            points: -5,
            refund: Some(ulid(67)),
        },
    );
    applied(&mut p, &[earn, back]);
    assert_eq!(
        p.customer(ulid(BIRCH)).unwrap().loyalty_balance,
        20 + 22 - 5
    );
    let labels: Vec<&str> = p
        .timeline(ulid(BIRCH))
        .iter()
        .map(|e| e.label.as_str())
        .collect();
    assert_eq!(
        labels,
        ["Earned 22 points", "5 points taken back for a refund"]
    );
}

fn catering(id: u128, seq: u64, event: &CateringEvent) -> Envelope {
    envelope(
        9_000 + 10 * id + u128::from(seq),
        format!("catering:{}:{}", ulid(SANDBOX), ulid(id)),
        seq,
        NOW,
        event,
    )
}

fn inquiry(id: u128, customer: u128) -> CateringEvent {
    CateringEvent::CateringInquiryReceived {
        catering: ulid(id),
        customer: ulid(customer),
        date: "2026-11-28".parse().unwrap(),
        headcount: 30,
        package: "pastry-platter".into(),
        venue: "v1".into(),
        brief: None,
    }
}

fn quote_sent() -> CateringEvent {
    CateringEvent::CateringQuoteSent {
        total_cents: Cents(60_000),
        deposit_cents: Cents(15_000),
        valid_until: t("2026-11-25T07:00:00-07:00"),
        follow_up_at: t("2026-11-10T07:00:00-07:00"),
    }
}

#[test]
fn the_pipeline_moves_each_lead_through_its_stages() {
    let mut p = CrmProjection::new(&directory());
    applied(
        &mut p,
        &[
            catering(1, 1, &inquiry(1, ALDER)),
            catering(2, 1, &inquiry(2, BIRCH)),
            catering(2, 2, &quote_sent()),
            catering(3, 1, &inquiry(3, CEDAR)),
            catering(
                3,
                2,
                &CateringEvent::CateringDeclined {
                    reason: DeclineReason::Other,
                },
            ),
        ],
    );
    let stages: Vec<(LeadStage, usize)> = p
        .pipeline()
        .into_iter()
        .map(|(s, ids)| (s, ids.len()))
        .collect();
    assert_eq!(
        stages,
        [
            (LeadStage::Inquiry, 1),
            (LeadStage::Quoted, 1),
            (LeadStage::Accepted, 0),
            (LeadStage::Won, 0),
            (LeadStage::Lost, 1),
            (LeadStage::Closed, 0),
        ]
    );
    assert_eq!(
        members(&p, Segment::CateringLeads),
        [ulid(ALDER), ulid(BIRCH)]
    );
    // A later step for an inquiry never seen is retried.
    let orphan = catering(
        4,
        2,
        &CateringEvent::CateringQuoteAccepted { lapses_at: t(NOW) },
    );
    assert_eq!(p.apply(&orphan), Err(CrmError::UnknownRef(ulid(4))));
}

#[test]
fn the_activity_log_is_in_business_time_order_and_reads_only_named_fields() {
    let mut p = CrmProjection::new(&directory());
    let raw = |id: u128, ty: &str, at: &str, data: serde_json::Value| Envelope {
        v: 1,
        id: ulid(id),
        sandbox: ulid(SANDBOX),
        stream: format!("sandbox:{}", ulid(SANDBOX)),
        seq: id as u64,
        event_type: ty.into(),
        at: t(at),
        recorded_at: WallTime::from_unix_ms(1_793_000_000_000).unwrap(),
        data,
        cause: None,
    };
    let later = raw(
        2,
        "FaultSet",
        "2026-11-07T10:00:00-07:00",
        serde_json::json!({ "fault": "inbox", "on": true }),
    );
    let earlier = raw(
        1,
        "SandboxSeeded",
        "2026-11-07T00:00:00-07:00",
        serde_json::json!({ "seed": 42, "born": "2026-11-07", "rows": 1978 }),
    );
    let odd = raw(
        3,
        "MenuItemChanged",
        "2026-11-07T11:00:00-07:00",
        serde_json::json!({ "item": "Not A Slug at all", "fields": {} }),
    );
    applied(&mut p, &[later, earlier, odd]);
    let rows: Vec<(&str, &str)> = p
        .activity()
        .iter()
        .map(|a| (a.event_type.as_str(), a.summary.as_str()))
        .collect();
    assert_eq!(
        rows,
        [
            (
                "SandboxSeeded",
                "Sandbox seeded from seed 42, born 2026-11-07"
            ),
            ("FaultSet", "Fault inbox turned on"),
            ("MenuItemChanged", "An item changed on the menu"),
        ]
    );
    assert_eq!(
        p.seeded(),
        Some(Seeded {
            seed: 42,
            born: "2026-11-07".parse().unwrap()
        })
    );
}

fn ctx(now: &str) -> DecideContext {
    DecideContext {
        now: t(now),
        id: ulid(5_000),
    }
}

const CAMPAIGN: u128 = 400;

fn draft() -> CampaignCommand {
    CampaignCommand::DraftCampaign {
        campaign: ulid(CAMPAIGN),
        subject: SubjectTemplate::WeekendBake,
        body: BodyTemplate::FreshBread,
        segment: Segment::Everyone,
    }
}

fn run(
    state: CampaignTable,
    cmd: &CampaignCommand,
    now: &str,
) -> Result<(CampaignTable, Vec<CrmEvent>), CampaignError> {
    execute::<Campaigns>(state, cmd, &ctx(now))
}

#[test]
fn a_campaign_is_drafted_edited_scheduled_and_sent_once() {
    let p = CrmProjection::new(&directory());
    let (s, e) = run(CampaignTable::default(), &draft(), NOW).unwrap();
    assert_eq!(e.len(), 1);
    // The same draft again is a no-op; another under the same id is refused.
    assert_eq!(run(s.clone(), &draft(), NOW).unwrap().1, []);
    let edit = CampaignCommand::EditCampaign {
        campaign: ulid(CAMPAIGN),
        subject: SubjectTemplate::CakeWeek,
        body: BodyTemplate::CakeOrders,
        segment: Segment::Everyone,
    };
    let (s, _) = run(s, &edit, NOW).unwrap();
    assert_eq!(
        run(s.clone(), &draft(), NOW).unwrap_err().rule(),
        "campaign-exists"
    );

    let schedule = |at: &str| CampaignCommand::ScheduleCampaign {
        campaign: ulid(CAMPAIGN),
        send_at: t(at),
    };
    let too_soon = run(s.clone(), &schedule("2026-11-07T09:14:00-07:00"), NOW).unwrap_err();
    assert_eq!(too_soon.rule(), "schedule-too-soon");
    assert_eq!(
        too_soon,
        CampaignError::ScheduleTooSoon {
            earliest: t("2026-11-07T09:15:00-07:00")
        }
    );
    // Tomorrow.
    let tomorrow = "2026-11-08T09:00:00-07:00";
    let (s, e) = run(s, &schedule(tomorrow), NOW).unwrap();
    assert_eq!(
        e,
        [CrmEvent::CampaignScheduled {
            campaign: ulid(CAMPAIGN),
            segment: Segment::Everyone,
            send_at: Some(t(tomorrow)),
        }]
    );
    assert_eq!(
        run(s.clone(), &edit, NOW).unwrap_err().rule(),
        "out-of-order"
    );

    let send = |p: &CrmProjection, now: &str| CampaignCommand::SendCampaign {
        campaign: ulid(CAMPAIGN),
        audience: Audience::of(p, Segment::Everyone, t(now)),
    };
    assert_eq!(
        run(s.clone(), &send(&p, NOW), NOW).unwrap_err().rule(),
        "not-due"
    );
    let at = "2026-11-08T09:00:30-07:00";
    let (s, e) = run(s, &send(&p, at), at).unwrap();
    assert_eq!(
        e,
        [CrmEvent::CampaignSent {
            campaign: ulid(CAMPAIGN),
            recipients: vec![ulid(ALDER), ulid(BIRCH)],
            subject: SubjectTemplate::CakeWeek,
            body: BodyTemplate::CakeOrders,
        }]
    );
    // The alarm fires again: nothing.
    let (s, e) = run(s, &send(&p, at), at).unwrap();
    assert!(e.is_empty());
    let c = s.get(ulid(CAMPAIGN)).unwrap();
    assert_eq!(c.state, CampaignState::Sent);
    assert_eq!(c.recipients, [ulid(ALDER), ulid(BIRCH)]);
    let cancel = CampaignCommand::CancelCampaign {
        campaign: ulid(CAMPAIGN),
    };
    assert_eq!(run(s, &cancel, at).unwrap_err().rule(), "out-of-order");
}

#[test]
fn cancel_takes_a_schedule_back_to_draft_and_a_draft_to_cancelled() {
    let (s, _) = run(CampaignTable::default(), &draft(), NOW).unwrap();
    let at = "2026-11-08T09:00:00-07:00";
    let schedule = CampaignCommand::ScheduleCampaign {
        campaign: ulid(CAMPAIGN),
        send_at: t(at),
    };
    let (s, _) = run(s, &schedule, NOW).unwrap();
    let cancel = CampaignCommand::CancelCampaign {
        campaign: ulid(CAMPAIGN),
    };
    let (s, e) = run(s, &cancel, NOW).unwrap();
    assert_eq!(
        e,
        [CrmEvent::CampaignCancelled {
            campaign: ulid(CAMPAIGN),
            segment: Segment::Everyone,
            send_at: Some(t(at)),
        }]
    );
    assert_eq!(s.get(ulid(CAMPAIGN)).unwrap().state, CampaignState::Draft);
    // The old timer fires: a draft sends nothing.
    let p = CrmProjection::new(&directory());
    let send = CampaignCommand::SendCampaign {
        campaign: ulid(CAMPAIGN),
        audience: Audience::of(&p, Segment::Everyone, t(at)),
    };
    assert!(run(s.clone(), &send, at).unwrap().1.is_empty());
    let (s, e) = run(s, &cancel, NOW).unwrap();
    assert_eq!(
        e,
        [CrmEvent::CampaignCancelled {
            campaign: ulid(CAMPAIGN),
            segment: Segment::Everyone,
            send_at: None,
        }]
    );
    assert_eq!(
        s.get(ulid(CAMPAIGN)).unwrap().state,
        CampaignState::Cancelled
    );
    assert!(run(s, &cancel, NOW).unwrap().1.is_empty());
}

#[test]
fn an_audience_for_another_segment_is_refused() {
    let (s, _) = run(CampaignTable::default(), &draft(), NOW).unwrap();
    let at = "2026-11-08T09:00:00-07:00";
    let schedule = CampaignCommand::ScheduleCampaign {
        campaign: ulid(CAMPAIGN),
        send_at: t(at),
    };
    let (s, _) = run(s, &schedule, NOW).unwrap();
    let p = CrmProjection::new(&directory());
    let send = CampaignCommand::SendCampaign {
        campaign: ulid(CAMPAIGN),
        audience: Audience::of(&p, Segment::CateringLeads, t(at)),
    };
    assert_eq!(run(s, &send, at).unwrap_err().rule(), "audience");
}

#[test]
fn campaign_stats_come_from_the_inbox_and_the_schedule_from_crm() {
    let mut p = CrmProjection::new(&directory());
    let crm = format!("crm:{}", ulid(SANDBOX));
    let inbox = format!("inbox:{}", ulid(SANDBOX));
    let scheduled = CrmEvent::CampaignScheduled {
        campaign: ulid(CAMPAIGN),
        segment: Segment::Everyone,
        send_at: Some(t("2026-11-08T09:00:00-07:00")),
    };
    let delivered = |id: u128, msg: u128, to: u128| {
        envelope(
            id,
            inbox.clone(),
            id as u64,
            "2026-11-08T09:00:00-07:00",
            &InboxEvent::MessageDelivered {
                message: ulid(msg),
                to: ulid(to),
                kind: MessageKind::Campaign,
                reference: ulid(CAMPAIGN),
            },
        )
    };
    let opened = envelope(
        13,
        inbox.clone(),
        13,
        "2026-11-08T10:00:00-07:00",
        &InboxEvent::MessageOpened {
            message: ulid(500),
            campaign: Some(ulid(CAMPAIGN)),
        },
    );
    let clicked = envelope(
        14,
        inbox.clone(),
        14,
        "2026-11-08T10:05:00-07:00",
        &InboxEvent::MessageClicked {
            message: ulid(500),
            campaign: Some(ulid(CAMPAIGN)),
        },
    );
    // The inbox's events, out of order: sets converge.
    applied(
        &mut p,
        &[
            clicked,
            delivered(12, 501, BIRCH),
            envelope(10, crm, 3, NOW, &scheduled),
            opened,
            delivered(11, 500, ALDER),
        ],
    );
    let stats = p.campaign_stats(ulid(CAMPAIGN)).unwrap();
    assert_eq!(
        (
            stats.delivered.len(),
            stats.opened.len(),
            stats.clicked.len()
        ),
        (2, 1, 1)
    );
    assert_eq!(stats.segment, Some(Segment::Everyone));
    assert_eq!(
        p.timeline(ulid(ALDER))[0].label,
        "Message delivered: a campaign"
    );
}

#[test]
fn the_rebuild_reproduces_the_projection_in_batches() {
    let log = sample_log();
    let mut live = CrmProjection::new(&directory());
    for e in &log {
        assert_eq!(live.apply(e), Ok(Outcome::Applied));
    }
    let (mut rebuild, mut fresh) = Rebuild::start(&directory(), log.len() as u32);
    assert!(rebuild.is_running());
    let mut steps = 0;
    for batch in log.chunks(4) {
        steps += 1;
        let done = rebuild.step(&mut fresh, batch).unwrap();
        assert_eq!(done, rebuild.position as usize == log.len());
    }
    assert!(steps > 1);
    assert_eq!(
        rebuild.finish(17),
        CrmEvent::ProjectionRebuildFinished {
            events: log.len() as u32,
            ms: 17
        }
    );
    assert_eq!(rebuild.state, RebuildState::Finished);
    assert_eq!(fresh.to_json(), live.to_json());
    assert_eq!(
        fresh.cursor(),
        Cursor {
            events_applied: log.len() as u32,
            log_position: log.len() as u32
        }
    );
}

#[test]
fn a_duplicate_appended_during_a_rebuild_is_skipped() {
    let mut log = sample_log();
    let live = CrmProjection::from_log(&directory(), &log).unwrap();
    log.push(log[0].clone());
    let again = CrmProjection::from_log(&directory(), &log).unwrap();
    assert_eq!(again.cursor().events_applied, live.cursor().events_applied);
    assert_eq!(again.cursor().log_position, live.cursor().log_position + 1);
}

#[test]
fn segments_and_templates_parse_their_slugs() {
    for s in Segment::ALL {
        assert_eq!(Segment::parse(s.slug()), Some(s));
        assert_eq!(serde_json::to_value(s).unwrap(), s.slug());
    }
    for s in SubjectTemplate::ALL {
        assert_eq!(SubjectTemplate::parse(s.slug()), Some(s));
        assert_eq!(serde_json::to_value(s).unwrap(), s.slug());
    }
    for b in BodyTemplate::ALL {
        assert_eq!(BodyTemplate::parse(b.slug()), Some(b));
        assert_eq!(serde_json::to_value(b).unwrap(), b.slug());
    }
    assert_eq!(Segment::parse("vip"), None);
}

#[test]
fn crm_events_round_trip_and_campaign_sent_reads_without_a_body() {
    let sent = CrmEvent::CampaignSent {
        campaign: ulid(1),
        recipients: vec![ulid(2)],
        subject: SubjectTemplate::ThankYou,
        body: BodyTemplate::ComeBack,
    };
    let e = envelope(1, format!("crm:{}", ulid(SANDBOX)), 1, NOW, &sent);
    let back: Envelope = serde_json::from_str(&serde_json::to_string(&e).unwrap()).unwrap();
    assert_eq!(CrmEvent::from_envelope(&back).unwrap(), sent);
    let mut data = sent.to_data();
    data.as_object_mut().unwrap().remove("body");
    assert_eq!(
        CrmEvent::from_parts("CampaignSent", &data).unwrap(),
        CrmEvent::CampaignSent {
            campaign: ulid(1),
            recipients: vec![ulid(2)],
            subject: SubjectTemplate::ThankYou,
            body: BodyTemplate::Announcement,
        }
    );
}

/// A log of every kind Crm folds.
fn sample_log() -> Vec<Envelope> {
    let mut log = vec![
        history(
            50,
            ALDER,
            OrderKind::Delivery,
            "2026-10-20T11:00:00-07:00",
            "chocolate-layer",
        ),
        history(
            51,
            CEDAR,
            OrderKind::Pickup,
            "2026-08-01T08:00:00-06:00",
            "baguette",
        ),
    ];
    log.extend(live_order(
        52,
        BIRCH,
        "2026-11-08T09:00:00-07:00",
        "chocolate-layer",
    ));
    log.push(catering(1, 1, &inquiry(1, ALDER)));
    log.push(envelope(
        8_201,
        format!("customer:{}:{}", ulid(SANDBOX), ulid(BIRCH)),
        2,
        NOW,
        &CustomerEvent::ConsentChanged { marketing: false },
    ));
    log
}

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

/// Every envelope a small world can send Crm: orders' streams, consent and loyalty, a catering
/// lead, a campaign's messages.
fn world() -> Vec<Envelope> {
    let mut all = sample_log();
    for (order, customer, item) in [(53, ALDER, "baguette"), (54, CEDAR, "chocolate-layer")] {
        all.extend(live_order(
            order,
            customer,
            "2026-11-08T10:00:00-07:00",
            item,
        ));
        all.push(envelope(
            100 * order + 3,
            order_stream(order),
            3,
            NOW,
            &OrderEvent::OrderReady {},
        ));
    }
    all.push(envelope(
        5_404,
        order_stream(54),
        4,
        NOW,
        &OrderEvent::OrderCancelled {
            by: CancelledBy::Customer,
        },
    ));
    for (seq, marketing) in [(3u64, true), (4, false), (5, true)] {
        all.push(envelope(
            8_300 + u128::from(seq),
            format!("customer:{}:{}", ulid(SANDBOX), ulid(CEDAR)),
            seq,
            NOW,
            &CustomerEvent::ConsentChanged { marketing },
        ));
    }
    all.push(catering(1, 2, &quote_sent()));
    let inbox = format!("inbox:{}", ulid(SANDBOX));
    for (n, to) in [(600u128, ALDER), (601, BIRCH)] {
        all.push(envelope(
            n,
            inbox.clone(),
            n as u64,
            NOW,
            &InboxEvent::MessageDelivered {
                message: ulid(n),
                to: ulid(to),
                kind: MessageKind::Campaign,
                reference: ulid(CAMPAIGN),
            },
        ));
    }
    all.push(envelope(
        602,
        inbox,
        602,
        NOW,
        &InboxEvent::MessageOpened {
            message: ulid(600),
            campaign: Some(ulid(CAMPAIGN)),
        },
    ));
    all
}

proptest! {
    /// Delivered in any order, with duplicates and every refusal retried later, the projection
    /// equals `from_log` of the envelopes it applied, byte for byte; and a duplicate or stale
    /// delivery changed nothing when it came.
    #[test]
    fn the_projection_is_the_fold_of_its_own_log(
        picks in proptest::collection::vec(any::<prop::sample::Index>(), 0..80),
    ) {
        let all = world();
        let mut queue = all.clone();
        queue.extend(all.iter().step_by(3).cloned());
        let mut picks = picks.into_iter();
        let mut live = CrmProjection::new(&directory());
        let mut log = Vec::new();
        let mut guard = 0;
        while !queue.is_empty() {
            guard += 1;
            prop_assert!(guard < 10_000);
            let i = picks.next().map_or(0, |ix| ix.index(queue.len()));
            let e = queue.remove(i);
            let before = live.to_json();
            match live.apply(&e) {
                Ok(Outcome::Applied) => log.push(log_entry(&e)),
                Ok(_) => prop_assert_eq!(live.to_json(), before),
                Err(_) => {
                    prop_assert_eq!(live.to_json(), before);
                    queue.push(e);
                }
            }
        }
        let rebuilt = CrmProjection::from_log(&directory(), &log).unwrap();
        prop_assert_eq!(rebuilt.to_json(), live.to_json());
    }

    /// Whatever consent flips arrive, a customer whose `marketing` is false at the send is never
    /// a recipient, every member who consents is one, and a campaign fired twice sends once.
    #[test]
    fn consent_gates_every_send_and_a_send_fires_once(
        flips in proptest::collection::vec((0u128..3, any::<bool>()), 0..12),
        segment in prop::sample::select(Segment::ALL.to_vec()),
    ) {
        let mut p = CrmProjection::from_log(&directory(), &world()[..6]).unwrap();
        for (i, (who, marketing)) in flips.iter().enumerate() {
            let e = envelope(
                20_000 + i as u128,
                format!("customer:{}:{}", ulid(SANDBOX), ulid(who + 1)),
                100 + i as u64,
                NOW,
                &CustomerEvent::ConsentChanged { marketing: *marketing },
            );
            p.apply(&e).unwrap();
        }
        let draft = CampaignCommand::DraftCampaign {
            campaign: ulid(CAMPAIGN),
            subject: SubjectTemplate::ThankYou,
            body: BodyTemplate::Announcement,
            segment,
        };
        let (s, _) = run(CampaignTable::default(), &draft, NOW).unwrap();
        let at = "2026-11-08T09:00:00-07:00";
        let schedule = CampaignCommand::ScheduleCampaign {
            campaign: ulid(CAMPAIGN),
            send_at: t(at),
        };
        let (s, _) = run(s, &schedule, NOW).unwrap();
        let send = CampaignCommand::SendCampaign {
            campaign: ulid(CAMPAIGN),
            audience: Audience::of(&p, segment, t(at)),
        };
        let (s, first) = run(s, &send, at).unwrap();
        let (_, second) = run(s, &send, at).unwrap();
        prop_assert_eq!(first.len(), 1);
        prop_assert!(second.is_empty());
        let CrmEvent::CampaignSent { recipients, .. } = &first[0] else {
            panic!("{first:?}");
        };
        let members = segment_members(&p, segment, t(at));
        for r in recipients {
            prop_assert!(p.customer(*r).unwrap().marketing);
            prop_assert!(members.contains(r));
        }
        for m in members {
            prop_assert_eq!(recipients.contains(&m), p.customer(m).unwrap().marketing);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The activity feed's rows for each kind it shows (the console audit of 2026-11-08, findings 13
// and 36; Activity.tsx: "an order paid, a campaign sent, a rebuild finished")
// ---------------------------------------------------------------------------------------------

/// The activity rows' `(type, summary)`, oldest first.
fn activity_rows(p: &CrmProjection) -> Vec<(String, String)> {
    p.activity()
        .iter()
        .map(|a| (a.event_type.clone(), a.summary.clone()))
        .collect()
}

#[test]
fn an_order_paid_is_an_activity_row() {
    let mut p = CrmProjection::new(&directory());
    applied(
        &mut p,
        &live_order(1, ALDER, "2026-11-07T10:00:00-07:00", "fern-loaf"),
    );
    // Placing is the customer's timeline only; paying is also the feed's.
    assert_eq!(
        activity_rows(&p),
        [(
            "OrderPaid".to_owned(),
            "Order paid: $22.00, pickup".to_owned()
        )]
    );
    assert_eq!(p.timeline(ulid(ALDER)).len(), 2);
}

#[test]
fn every_catering_step_crm_hears_of_is_an_activity_row() {
    let mut p = CrmProjection::new(&directory());
    let steps = [
        inquiry(1, ALDER),
        quote_sent(),
        CateringEvent::CateringQuoteAccepted { lapses_at: t(NOW) },
        CateringEvent::CateringDepositPaid {
            payment: ulid(901),
            amount_cents: Cents(15_000),
        },
        CateringEvent::CateringProductionStarted {},
        CateringEvent::CateringDelivered {
            customer: ulid(ALDER),
            balance_cents: Cents(45_000),
            due: "2026-12-05".parse().unwrap(),
        },
        CateringEvent::CateringBalanceInvoiced {
            invoice: ulid(902),
            amount_cents: Cents(45_000),
            due: "2026-12-05".parse().unwrap(),
        },
        CateringEvent::CateringBalancePaid { payment: ulid(903) },
        CateringEvent::CateringClosed {
            payment: Some(ulid(903)),
        },
    ];
    let envelopes: Vec<Envelope> = steps
        .iter()
        .enumerate()
        .map(|(k, e)| catering(1, k as u64 + 1, e))
        .collect();
    applied(&mut p, &envelopes);
    // Three more leads end otherwise.
    applied(
        &mut p,
        &[
            catering(2, 1, &inquiry(2, BIRCH)),
            catering(
                2,
                2,
                &CateringEvent::CateringDeclined {
                    reason: DeclineReason::Other,
                },
            ),
            catering(3, 1, &inquiry(3, CEDAR)),
            catering(3, 2, &quote_sent()),
            catering(3, 3, &CateringEvent::CateringQuoteExpired { reason: None }),
            catering(4, 1, &inquiry(4, ALDER)),
            catering(
                4,
                2,
                &CateringEvent::CateringCancelled {
                    refund_deposit: true,
                    by: CancelledBy::Customer,
                    reason: crate::catering::CancelReason::CustomerChange,
                },
            ),
        ],
    );
    let summaries: Vec<String> = activity_rows(&p).into_iter().map(|(_, s)| s).collect();
    for want in [
        "Catering inquiry for 2026-11-28: 30 people",
        "Catering quote sent: $600.00, deposit $150.00",
        "Catering quote accepted",
        "Catering deposit paid: $150.00",
        "Catering production started",
        "Catering delivered: balance $450.00 due 2026-12-05",
        "Catering balance invoiced: $450.00",
        "Catering balance paid",
        "Catering closed",
        "Catering inquiry declined",
        "Catering quote expired",
        "Catering cancelled; the deposit goes back",
    ] {
        assert!(summaries.iter().any(|s| s == want), "{want}: {summaries:?}");
    }
    assert_eq!(summaries.len(), 9 + 2 + 3 + 2);
    // The customer's timeline has every step of the first lead, the kitchen's two among them,
    // and the lead is still won between the deposit and the balance.
    let labels: Vec<&str> = p
        .timeline(ulid(ALDER))
        .iter()
        .filter(|e| e.event_type.starts_with("Catering"))
        .map(|e| e.label.as_str())
        .collect();
    assert!(labels.contains(&"Production started"), "{labels:?}");
    assert!(labels.contains(&"Delivered; balance $450.00"), "{labels:?}");
    assert_eq!(labels.len(), 9 + 2);
    // No row carries the brief or a slug's raw form.
    assert!(summaries.iter().all(|s| !s.contains("pastry-platter")));
}

#[test]
fn a_campaign_sent_and_a_rebuild_finished_join_the_feed_from_crms_own_events() {
    let mut p = CrmProjection::new(&directory());
    applied(
        &mut p,
        &live_order(1, ALDER, "2026-11-07T10:00:00-07:00", "fern-loaf"),
    );
    let own_stream = format!("crm:{}", ulid(SANDBOX));
    let sent = envelope(
        7_001,
        own_stream.clone(),
        3,
        "2026-11-07T11:00:00-07:00",
        &CrmEvent::CampaignSent {
            campaign: ulid(CAMPAIGN),
            recipients: vec![ulid(ALDER), ulid(BIRCH)],
            subject: SubjectTemplate::ThankYou,
            body: BodyTemplate::default(),
        },
    );
    let one = envelope(
        7_002,
        own_stream.clone(),
        4,
        "2026-11-07T11:05:00-07:00",
        &CrmEvent::CampaignSent {
            campaign: ulid(CAMPAIGN + 1),
            recipients: vec![ulid(ALDER)],
            subject: SubjectTemplate::ThankYou,
            body: BodyTemplate::default(),
        },
    );
    let rebuilt = envelope(
        7_003,
        own_stream.clone(),
        5,
        "2026-11-07T12:00:00-07:00",
        &CrmEvent::ProjectionRebuildFinished {
            events: 909,
            ms: 1_235,
        },
    );
    let drafted = envelope(
        7_000,
        own_stream,
        1,
        "2026-11-07T08:00:00-07:00",
        &CrmEvent::CampaignDrafted {
            campaign: ulid(CAMPAIGN),
            subject: SubjectTemplate::ThankYou,
            body: BodyTemplate::default(),
            segment: Segment::Everyone,
        },
    );
    let feed: Vec<(String, String)> =
        activity_feed(&p, &[drafted, rebuilt.clone(), sent.clone(), one])
            .into_iter()
            .map(|a| (a.event_type, a.summary))
            .collect();
    let s = |a: &str, b: &str| (a.to_owned(), b.to_owned());
    assert_eq!(
        feed,
        [
            s("OrderPaid", "Order paid: $22.00, pickup"),
            s("CampaignSent", "Campaign sent to 2 customers"),
            s("CampaignSent", "Campaign sent to 1 customer"),
            s(
                "ProjectionRebuildFinished",
                "CRM projection rebuilt: 909 events replayed in 1235 ms"
            ),
        ]
    );
    // They are not the projection's, so a rebuild of the log reproduces it unchanged, and Crm
    // does not take them as deliveries.
    assert_eq!(p.activity().len(), 1);
    assert_eq!(p.apply(&sent), Ok(Outcome::NotForCrm));
    assert_eq!(p.apply(&rebuilt), Ok(Outcome::NotForCrm));
}

#[test]
fn counts_in_activity_rows_agree_with_their_noun() {
    let mut p = CrmProjection::new(&directory());
    let raw = |id: u128, ty: &str, data: serde_json::Value| Envelope {
        v: 1,
        id: ulid(id),
        sandbox: ulid(SANDBOX),
        stream: format!("dispatch:{}:2026-11-07", ulid(SANDBOX)),
        seq: id as u64,
        event_type: ty.into(),
        at: t(NOW),
        recorded_at: WallTime::from_unix_ms(1_793_000_000_000).unwrap(),
        data,
        cause: None,
    };
    applied(
        &mut p,
        &[
            raw(
                1,
                "RouteProposed",
                serde_json::json!({ "vans": 1, "minutes": 1 }),
            ),
            raw(
                2,
                "RouteProposed",
                serde_json::json!({ "vans": 2, "minutes": 41 }),
            ),
            raw(
                3,
                "TrafficStopped",
                serde_json::json!({ "reason": "stop", "minutes": 1, "orders": 1 }),
            ),
        ],
    );
    let summaries: Vec<String> = activity_rows(&p).into_iter().map(|(_, s)| s).collect();
    assert_eq!(
        summaries,
        [
            "Routes proposed: 1 van, 1 minute",
            "Routes proposed: 2 vans, 41 minutes",
            "Simulated traffic stopped (stop) after 1 order",
        ]
    );
}

#[test]
fn an_activity_row_names_things_as_a_person_does_never_by_their_keys() {
    use super::{item_name, target_name};
    assert_eq!(item_name("country-loaf"), "Country loaf");
    assert_eq!(item_name("seeded-rye"), "Seeded rye");
    assert_eq!(target_name("slot:07:45"), "the 7:45 am slot");
    assert_eq!(target_name("slot:12:00"), "the 12:00 pm slot");
    assert_eq!(target_name("slot:13:15"), "the 1:15 pm slot");
    assert_eq!(target_name("zone:z2"), "zone 2");
    assert_eq!(target_name("item:croissant"), "Croissant");
    assert_eq!(target_name("catering"), "catering");
    for odd in [
        "slot:7",
        "slot:25:00",
        "zone:",
        "item:",
        "nothing",
        "zone:zx",
    ] {
        assert!(!target_name(odd).contains(':'), "{odd}");
    }
    let mut p = CrmProjection::new(&directory());
    let raw = |id: u128, ty: &str, data: serde_json::Value| Envelope {
        v: 1,
        id: ulid(id),
        sandbox: ulid(SANDBOX),
        stream: format!("sandbox:{}", ulid(SANDBOX)),
        seq: id as u64,
        event_type: ty.into(),
        at: t(NOW),
        recorded_at: WallTime::from_unix_ms(1_793_000_000_000).unwrap(),
        data,
        cause: None,
    };
    applied(
        &mut p,
        &[
            raw(
                1,
                "MenuItemChanged",
                serde_json::json!({ "item": "country-loaf", "fields": {} }),
            ),
            raw(
                2,
                "CapacityChanged",
                serde_json::json!({ "target": "slot:07:45", "capacity": 3 }),
            ),
            raw(
                3,
                "TrafficStopped",
                serde_json::json!({ "reason": "minutes-spent", "minutes": 30, "orders": 4 }),
            ),
        ],
    );
    let summaries: Vec<String> = activity_rows(&p).into_iter().map(|(_, s)| s).collect();
    assert_eq!(
        summaries,
        [
            "Country loaf changed on the menu",
            "Capacity of the 7:45 am slot set to 3",
            "Simulated traffic stopped (minutes spent) after 4 orders",
        ]
    );
}
