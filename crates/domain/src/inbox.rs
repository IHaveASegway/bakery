//! The Inbox, one object per sandbox (`inbox:<sandbox>`): the sandbox's simulated mailbox,
//! where every message lands, with simulated opens and clicks (docs/domain.md, "Ubiquitous
//! language": Message, Inbox; docs/architecture.md, "A campaign send").
//!
//! It is a projection that reacts: each routed event the catalog sends it makes zero or more
//! messages, each with a [`InboxEvent::MessageDelivered`] the Inbox appends to its own log and
//! outbox in the transaction that records the consumed id as seen (ADR 0004, decision 8). A
//! message's id is derived from the event's id and the recipient, so a redelivery makes the
//! same message once.
//!
//! Every subject and body is a fixed synthetic template filled with the event's own figures:
//! amounts, dates, item counts, a stop number. No template holds an address, an email, a phone
//! number or a link, and none reads the order note or the catering brief (Q14, Q22): a test
//! runs every template through the free-text checks.
//!
//! Opens and clicks are simulated: [`engagement`] draws them from a PRNG seeded by the
//! sandbox's seed and the message id, so a seed gives the same open rate. The Worker arms the
//! timers from it; the Inbox records each idempotently.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::aggregate::{DomainEvent, EventCodecError};
use crate::billing::{BillingEvent, Purpose};
use crate::catering::{CateringEvent, ReminderKind};
use crate::crm::{BodyTemplate, CrmEvent, SubjectTemplate, slug_text};
use crate::order::{OrderEvent, OrderKind};
use crate::{BakeryDate, BusinessTime, Cents, Envelope, Ulid};

/// Whole business minutes.
pub type Minutes = u32;

/// What a message is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    /// An order paid, a deposit paid, or a catering event closed.
    Receipt,
    Ready,
    OnItsWay,
    Refund,
    /// A card declined.
    Declined,
    /// A catering inquiry received.
    Acknowledgement,
    Quote,
    /// A quote expired or an inquiry declined.
    Notice,
    Reminder,
    Invoice,
    Campaign,
}

impl MessageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageKind::Receipt => "receipt",
            MessageKind::Ready => "ready",
            MessageKind::OnItsWay => "on_its_way",
            MessageKind::Refund => "refund",
            MessageKind::Declined => "declined",
            MessageKind::Acknowledgement => "acknowledgement",
            MessageKind::Quote => "quote",
            MessageKind::Notice => "notice",
            MessageKind::Reminder => "reminder",
            MessageKind::Invoice => "invoice",
            MessageKind::Campaign => "campaign",
        }
    }

    /// The kind as the timeline says it.
    pub fn label(self) -> &'static str {
        match self {
            MessageKind::Receipt => "a receipt",
            MessageKind::Ready => "order ready",
            MessageKind::OnItsWay => "on its way",
            MessageKind::Refund => "a refund notice",
            MessageKind::Declined => "a declined card",
            MessageKind::Acknowledgement => "an inquiry acknowledged",
            MessageKind::Quote => "a quote",
            MessageKind::Notice => "a catering notice",
            MessageKind::Reminder => "a reminder",
            MessageKind::Invoice => "an invoice",
            MessageKind::Campaign => "a campaign",
        }
    }
}

/// The Inbox's rows in docs/domain.md, "The event catalog".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum InboxEvent {
    MessageDelivered {
        message: Ulid,
        /// A sandbox customer's id: the only recipient there is.
        to: Ulid,
        kind: MessageKind,
        #[serde(rename = "ref")]
        reference: Ulid,
    },
    MessageOpened {
        message: Ulid,
        #[serde(default)]
        campaign: Option<Ulid>,
    },
    MessageClicked {
        message: Ulid,
        #[serde(default)]
        campaign: Option<Ulid>,
    },
}

impl DomainEvent for InboxEvent {
    const NAMES: &'static [&'static str] = &["MessageDelivered", "MessageOpened", "MessageClicked"];

    fn name(&self) -> &'static str {
        match self {
            InboxEvent::MessageDelivered { .. } => "MessageDelivered",
            InboxEvent::MessageOpened { .. } => "MessageOpened",
            InboxEvent::MessageClicked { .. } => "MessageClicked",
        }
    }
}

/// One message in the inbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub id: Ulid,
    /// The customer it is for.
    pub to: Ulid,
    pub kind: MessageKind,
    /// The order, catering event or campaign it is about.
    #[serde(rename = "ref")]
    pub reference: Ulid,
    pub subject: String,
    pub body: String,
    pub delivered_at: BusinessTime,
    pub opened_at: Option<BusinessTime>,
    pub clicked_at: Option<BusinessTime>,
}

impl Message {
    /// The campaign it belongs to, for the open and click events.
    pub fn campaign(&self) -> Option<Ulid> {
        (self.kind == MessageKind::Campaign).then_some(self.reference)
    }
}

/// What the Inbox remembers of an order to write its messages: who, how, how many.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct OrderFacts {
    customer: Ulid,
    kind: OrderKind,
    items: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CateringFacts {
    customer: Ulid,
    date: BakeryDate,
    headcount: u16,
    package: String,
    venue: String,
    balance: Option<Cents>,
}

/// What [`Inbox::apply`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboxChange {
    /// The event was recorded; these messages are new, each with its `MessageDelivered`.
    Applied {
        messages: Vec<Message>,
        events: Vec<InboxEvent>,
    },
    Duplicate,
    /// An event the Inbox makes no message from.
    NotForInbox,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum InboxError {
    /// A message for an order or a catering event whose first event has not arrived; retry.
    #[error("nothing known yet of {0}")]
    UnknownRef(Ulid),
    #[error("no message {0}")]
    UnknownMessage(Ulid),
    #[error("not a stream the Inbox reads this event from: {0}")]
    BadStream(String),
    #[error(transparent)]
    Codec(#[from] EventCodecError),
}

/// A timer's command: the simulated open or click [`engagement`] scheduled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InboxCommand {
    RecordOpen {
        message: Ulid,
    },
    /// A click on an unopened message opens it too.
    RecordClick {
        message: Ulid,
    },
}

/// The inbox: messages by id, what it knows of orders and catering events, and the event ids
/// seen.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inbox {
    messages: BTreeMap<Ulid, Message>,
    orders: BTreeMap<Ulid, OrderFacts>,
    caterings: BTreeMap<Ulid, CateringFacts>,
    seen: BTreeSet<Ulid>,
}

impl Inbox {
    /// Messages the seed writes directly, with no event (docs/domain.md, "The seed": 240 Inbox
    /// messages). One already held is left as it is.
    pub fn seed(&mut self, messages: impl IntoIterator<Item = Message>) {
        for m in messages {
            self.messages.entry(m.id).or_insert(m);
        }
    }

    /// Every message, newest first, ties by id.
    pub fn messages(&self) -> Vec<&Message> {
        let mut out: Vec<&Message> = self.messages.values().collect();
        out.sort_by_key(|m| std::cmp::Reverse((m.delivered_at, m.id)));
        out
    }

    pub fn message(&self, id: Ulid) -> Option<&Message> {
        self.messages.get(&id)
    }

    /// Applies one delivered envelope. An `Err` changes nothing.
    pub fn apply(&mut self, envelope: &Envelope) -> Result<InboxChange, InboxError> {
        if self.seen.contains(&envelope.id) {
            return Ok(InboxChange::Duplicate);
        }
        let drafts = self.drafts(envelope)?;
        self.seen.insert(envelope.id);
        let Some(drafts) = drafts else {
            return Ok(InboxChange::NotForInbox);
        };
        let mut messages = Vec::new();
        let mut events = Vec::new();
        for d in drafts {
            if self.messages.contains_key(&d.id) {
                continue;
            }
            let message = Message {
                id: d.id,
                to: d.to,
                kind: d.kind,
                reference: d.reference,
                subject: d.subject,
                body: d.body,
                delivered_at: envelope.at,
                opened_at: None,
                clicked_at: None,
            };
            events.push(InboxEvent::MessageDelivered {
                message: message.id,
                to: message.to,
                kind: message.kind,
                reference: message.reference,
            });
            self.messages.insert(message.id, message.clone());
            messages.push(message);
        }
        Ok(InboxChange::Applied { messages, events })
    }

    /// Records a simulated open or click at business time `now`; a repeat is `Ok(vec![])`.
    pub fn handle(
        &mut self,
        cmd: InboxCommand,
        now: BusinessTime,
    ) -> Result<Vec<InboxEvent>, InboxError> {
        let (InboxCommand::RecordOpen { message } | InboxCommand::RecordClick { message }) = cmd;
        let m = self
            .messages
            .get_mut(&message)
            .ok_or(InboxError::UnknownMessage(message))?;
        let campaign = m.campaign();
        let mut events = Vec::new();
        if m.opened_at.is_none() {
            m.opened_at = Some(now);
            events.push(InboxEvent::MessageOpened { message, campaign });
        }
        if matches!(cmd, InboxCommand::RecordClick { .. }) && m.clicked_at.is_none() {
            m.clicked_at = Some(now);
            events.push(InboxEvent::MessageClicked { message, campaign });
        }
        Ok(events)
    }

    /// The messages an event makes, or `None` for an event the Inbox makes none from.
    /// Remembering an order's or an inquiry's facts happens here too, so it must not fail after.
    fn drafts(&mut self, envelope: &Envelope) -> Result<Option<Vec<Draft>>, InboxError> {
        let t = envelope.event_type.as_str();
        if OrderEvent::NAMES.contains(&t) {
            return self.order_drafts(envelope);
        }
        if CateringEvent::NAMES.contains(&t) {
            return self.catering_drafts(envelope);
        }
        if t == "PaymentFailed" {
            let BillingEvent::PaymentFailed {
                purpose, reference, ..
            } = BillingEvent::from_envelope(envelope)?
            else {
                return Ok(None);
            };
            let to = match purpose {
                Purpose::Order => self.orders.get(&reference).map(|o| o.customer),
                Purpose::Deposit | Purpose::Balance => {
                    self.caterings.get(&reference).map(|c| c.customer)
                }
            }
            .ok_or(InboxError::UnknownRef(reference))?;
            let (subject, body) = declined(purpose);
            return Ok(Some(vec![Draft::new(
                envelope.id,
                to,
                MessageKind::Declined,
                reference,
                subject,
                body,
            )]));
        }
        if t == "CampaignSent" {
            let CrmEvent::CampaignSent {
                campaign,
                recipients,
                subject,
                body,
            } = CrmEvent::from_envelope(envelope)?
            else {
                return Ok(None);
            };
            let (subject, body) = campaign_message(subject, body);
            // Keyed by campaign and customer, not by the event: one message per recipient per
            // campaign, whatever carried it (docs/domain.md, "Campaign").
            return Ok(Some(
                recipients
                    .into_iter()
                    .map(|to| {
                        Draft::new(
                            campaign,
                            to,
                            MessageKind::Campaign,
                            campaign,
                            subject.clone(),
                            body.clone(),
                        )
                    })
                    .collect(),
            ));
        }
        Ok(None)
    }

    fn order_drafts(&mut self, envelope: &Envelope) -> Result<Option<Vec<Draft>>, InboxError> {
        let event = OrderEvent::from_envelope(envelope)?;
        let order = stream_id(&envelope.stream, "order")?;
        if let OrderEvent::OrderPlaced {
            customer,
            kind,
            lines,
            ..
        } = &event
        {
            self.orders.entry(order).or_insert(OrderFacts {
                customer: *customer,
                kind: *kind,
                items: lines.iter().map(|l| u32::from(l.qty)).sum(),
            });
            return Ok(Some(vec![]));
        }
        let made = |facts: &OrderFacts| -> Option<(MessageKind, String, String)> {
            match &event {
                OrderEvent::OrderPaid { amount_cents, .. } => {
                    let (s, b) = receipt(facts.kind, facts.items, *amount_cents);
                    Some((MessageKind::Receipt, s, b))
                }
                OrderEvent::OrderReady {} => {
                    let (s, b) = ready(facts.kind, facts.items);
                    Some((MessageKind::Ready, s, b))
                }
                OrderEvent::OrderOutForDelivery { stop, .. } => {
                    let (s, b) = on_its_way(facts.items, *stop);
                    Some((MessageKind::OnItsWay, s, b))
                }
                OrderEvent::OrderRefunded {
                    amount_cents, full, ..
                } => {
                    let (s, b) = refund(*amount_cents, *full);
                    Some((MessageKind::Refund, s, b))
                }
                _ => None,
            }
        };
        if !matches!(
            event,
            OrderEvent::OrderPaid { .. }
                | OrderEvent::OrderReady {}
                | OrderEvent::OrderOutForDelivery { .. }
                | OrderEvent::OrderRefunded { .. }
        ) {
            return Ok(None);
        }
        let facts = *self
            .orders
            .get(&order)
            .ok_or(InboxError::UnknownRef(order))?;
        Ok(made(&facts).map(|(kind, subject, body)| {
            vec![Draft::new(
                envelope.id,
                facts.customer,
                kind,
                order,
                subject,
                body,
            )]
        }))
    }

    fn catering_drafts(&mut self, envelope: &Envelope) -> Result<Option<Vec<Draft>>, InboxError> {
        let event = CateringEvent::from_envelope(envelope)?;
        let catering = stream_id(&envelope.stream, "catering")?;
        if let CateringEvent::CateringInquiryReceived {
            customer,
            date,
            headcount,
            package,
            venue,
            ..
        } = &event
        {
            let facts = self
                .caterings
                .entry(catering)
                .or_insert(CateringFacts {
                    customer: *customer,
                    date: *date,
                    headcount: *headcount,
                    package: package.clone(),
                    venue: venue.clone(),
                    balance: None,
                })
                .clone();
            let (s, b) = acknowledgement(&facts);
            return Ok(Some(vec![Draft::new(
                envelope.id,
                facts.customer,
                MessageKind::Acknowledgement,
                catering,
                s,
                b,
            )]));
        }
        let makes = matches!(
            event,
            CateringEvent::CateringQuoteSent { .. }
                | CateringEvent::CateringQuoteExpired { .. }
                | CateringEvent::CateringDeclined { .. }
                | CateringEvent::CateringDepositPaid { .. }
                | CateringEvent::CateringReminderDue { .. }
                | CateringEvent::CateringBalanceInvoiced { .. }
                | CateringEvent::CateringClosed { .. }
        );
        if !makes {
            // `CateringBalancePaid` is routed here too; `CateringClosed`, in the same commit,
            // carries the one receipt, so a paid balance is not receipted twice.
            return Ok(None);
        }
        let facts = self
            .caterings
            .get_mut(&catering)
            .ok_or(InboxError::UnknownRef(catering))?;
        if let CateringEvent::CateringBalanceInvoiced { amount_cents, .. } = &event {
            facts.balance = Some(*amount_cents);
        }
        let facts = facts.clone();
        let (kind, (subject, body)) = match &event {
            CateringEvent::CateringQuoteSent {
                total_cents,
                deposit_cents,
                valid_until,
                ..
            } => (
                MessageKind::Quote,
                quote(*total_cents, *deposit_cents, BakeryDate::of(*valid_until)),
            ),
            CateringEvent::CateringQuoteExpired { .. } => {
                (MessageKind::Notice, quote_expired(&facts))
            }
            CateringEvent::CateringDeclined { .. } => {
                (MessageKind::Notice, declined_inquiry(&facts))
            }
            CateringEvent::CateringDepositPaid { amount_cents, .. } => {
                (MessageKind::Receipt, deposit_receipt(*amount_cents, &facts))
            }
            CateringEvent::CateringReminderDue { kind } => {
                (MessageKind::Reminder, reminder(*kind, &facts))
            }
            CateringEvent::CateringBalanceInvoiced {
                amount_cents, due, ..
            } => (MessageKind::Invoice, invoice(*amount_cents, *due, &facts)),
            CateringEvent::CateringClosed { .. } => (MessageKind::Receipt, closed(&facts)),
            _ => unreachable!("filtered above"),
        };
        Ok(Some(vec![Draft::new(
            envelope.id,
            facts.customer,
            kind,
            catering,
            subject,
            body,
        )]))
    }
}

struct Draft {
    id: Ulid,
    to: Ulid,
    kind: MessageKind,
    reference: Ulid,
    subject: String,
    body: String,
}

impl Draft {
    fn new(
        source: Ulid,
        to: Ulid,
        kind: MessageKind,
        reference: Ulid,
        subject: impl Into<String>,
        body: impl Into<String>,
    ) -> Draft {
        Draft {
            id: message_id(source, to),
            to,
            kind,
            reference,
            subject: subject.into(),
            body: body.into(),
        }
    }
}

/// A message's id, from what caused it (the event's id, or the campaign's) and its recipient:
/// the cause's time part, and 80 bits mixed from both. Pure, so a redelivery derives the same id.
pub fn message_id(source: Ulid, to: Ulid) -> Ulid {
    let a = mix(source.as_u128() as u64 ^ mix((source.as_u128() >> 64) as u64));
    let b = mix(to.as_u128() as u64 ^ mix((to.as_u128() >> 64) as u64 ^ a));
    let random = (u128::from(a) << 64 | u128::from(b)) & ((1u128 << 80) - 1);
    Ulid::from_parts(source.unix_ms(), random)
}

/// SplitMix64's finalizer: a fixed, well-mixed function of 64 bits.
fn mix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

// ---------------------------------------------------------------------------------------------
// Simulated engagement
// ---------------------------------------------------------------------------------------------

/// When a message is opened and clicked, in business minutes after delivery; `None` for never.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Engagement {
    pub opens_after: Option<Minutes>,
    /// Always after `opens_after`, and only when it is set.
    pub clicks_after: Option<Minutes>,
}

/// Opens in per mille.
pub const OPEN_PER_MILLE: u64 = 450;
/// Clicks among the opened, in per mille: about a third.
pub const CLICK_PER_MILLE: u64 = 333;
pub const OPEN_MINUTES: (Minutes, Minutes) = (5, 180);
pub const CLICK_DELAY_MINUTES: (Minutes, Minutes) = (1, 10);

/// The simulated engagement of one message: a PRNG seeded by the sandbox's seed and the
/// message's id, so the same seed gives the same opens and clicks. About 45% open, 5 to 180
/// minutes after delivery, and about a third of those click, 1 to 10 minutes after opening.
pub fn engagement(seed: u64, message: Ulid) -> Engagement {
    let mut state = mix(seed) ^ mix(message.as_u128() as u64) ^ ((message.as_u128() >> 64) as u64);
    let mut next = || {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        mix(state)
    };
    let span = |(lo, hi): (Minutes, Minutes), x: u64| lo + (x % u64::from(hi - lo + 1)) as Minutes;
    if next() % 1_000 >= OPEN_PER_MILLE {
        return Engagement {
            opens_after: None,
            clicks_after: None,
        };
    }
    let opens = span(OPEN_MINUTES, next());
    let clicks =
        (next() % 1_000 < CLICK_PER_MILLE).then(|| opens + span(CLICK_DELAY_MINUTES, next()));
    Engagement {
        opens_after: Some(opens),
        clicks_after: clicks,
    }
}

// ---------------------------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------------------------

const WEEKDAYS: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];
const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// "Saturday 21 November 2026": words between the numbers, so no date reads as a phone number.
pub fn date_words(date: BakeryDate) -> String {
    format!(
        "{} {} {} {}",
        WEEKDAYS[usize::from(crate::calendar::weekday(date.days()))],
        date.d(),
        MONTHS[usize::from(date.m() - 1)],
        date.y()
    )
}

fn kind_words(kind: OrderKind) -> &'static str {
    match kind {
        OrderKind::Pickup => "pickup",
        OrderKind::Delivery => "delivery",
    }
}

fn items_words(items: u32) -> String {
    if items == 1 {
        "1 item".to_owned()
    } else {
        format!("{items} items")
    }
}

/// `OrderPaid`'s receipt; the seed's history receipts use it too.
pub fn receipt(kind: OrderKind, items: u32, amount: Cents) -> (String, String) {
    (
        "Your receipt from Proof of Concept".to_owned(),
        format!(
            "Thank you. Your {} order of {} is paid: {}. We will tell you when it is ready.",
            kind_words(kind),
            items_words(items),
            amount.dollars()
        ),
    )
}

fn ready(kind: OrderKind, items: u32) -> (String, String) {
    let body = match kind {
        OrderKind::Pickup => format!(
            "Your order of {} is ready at the counter.",
            items_words(items)
        ),
        OrderKind::Delivery => format!(
            "Your order of {} is ready and leaves with the next van.",
            items_words(items)
        ),
    };
    ("Your order is ready".to_owned(), body)
}

fn on_its_way(items: u32, stop: u16) -> (String, String) {
    (
        "Your order is on its way".to_owned(),
        format!(
            "Your order of {} is in the van, stop {stop} on today's route.",
            items_words(items)
        ),
    )
}

fn refund(amount: Cents, full: bool) -> (String, String) {
    let rest = if full {
        " That refunds the order in full."
    } else {
        ""
    };
    (
        "Your refund".to_owned(),
        format!(
            "{} is on its way back to your card.{rest}",
            amount.dollars()
        ),
    )
}

fn declined(purpose: Purpose) -> (String, String) {
    let what = match purpose {
        Purpose::Order => "your order",
        Purpose::Deposit => "your catering deposit",
        Purpose::Balance => "your catering balance",
    };
    (
        "Your card was declined".to_owned(),
        format!(
            "The payment for {what} did not go through, so nothing was charged. You can try again with another card."
        ),
    )
}

fn acknowledgement(f: &CateringFacts) -> (String, String) {
    (
        "We have your catering inquiry".to_owned(),
        format!(
            "Thank you for asking about the {} for {} people at {} on {}. A quote follows soon.",
            slug_text(&f.package),
            f.headcount,
            slug_text(&f.venue),
            date_words(f.date)
        ),
    )
}

fn quote(total: Cents, deposit: Cents, valid_until: BakeryDate) -> (String, String) {
    (
        "Your catering quote".to_owned(),
        format!(
            "The quote is {}. A deposit of {} confirms the day. The quote holds until {}.",
            total.dollars(),
            deposit.dollars(),
            date_words(valid_until)
        ),
    )
}

fn quote_expired(f: &CateringFacts) -> (String, String) {
    (
        "Your catering quote has lapsed".to_owned(),
        format!(
            "The quote for {} has lapsed. Send a new inquiry if you would still like the day.",
            date_words(f.date)
        ),
    )
}

fn declined_inquiry(f: &CateringFacts) -> (String, String) {
    (
        "About your catering inquiry".to_owned(),
        format!(
            "We cannot take the event on {}. We are sorry, and hope to bake for you another time.",
            date_words(f.date)
        ),
    )
}

fn deposit_receipt(amount: Cents, f: &CateringFacts) -> (String, String) {
    (
        "Your deposit receipt".to_owned(),
        format!(
            "Thank you. The deposit of {} is paid and {} is yours.",
            amount.dollars(),
            date_words(f.date)
        ),
    )
}

fn reminder(kind: ReminderKind, f: &CateringFacts) -> (String, String) {
    let date = date_words(f.date);
    match kind {
        ReminderKind::FollowUp => (
            "A reminder about your quote".to_owned(),
            format!("Your quote for {date} is waiting for an answer."),
        ),
        ReminderKind::EventSoon => (
            "Your event is in two days".to_owned(),
            format!("We are getting ready for {} people on {date}.", f.headcount),
        ),
        ReminderKind::InvoiceDue => (
            "Your balance is due".to_owned(),
            match f.balance {
                Some(b) => format!("The balance of {} for {date} is due.", b.dollars()),
                None => format!("The balance for {date} is due."),
            },
        ),
    }
}

fn invoice(amount: Cents, due: BakeryDate, f: &CateringFacts) -> (String, String) {
    (
        "Your balance invoice".to_owned(),
        format!(
            "The balance of {} for {} is due by {}.",
            amount.dollars(),
            date_words(f.date),
            date_words(due)
        ),
    )
}

fn closed(f: &CateringFacts) -> (String, String) {
    (
        "Your catering receipt".to_owned(),
        format!(
            "Thank you. The balance is paid and the event on {} is closed.",
            date_words(f.date)
        ),
    )
}

fn campaign_message(subject: SubjectTemplate, body: BodyTemplate) -> (String, String) {
    (subject.text().to_owned(), body.render())
}

/// The last part of `<prefix>:<sandbox>:<ulid>` (or `<prefix>:<ulid>`).
fn stream_id(stream: &str, prefix: &str) -> Result<Ulid, InboxError> {
    let bad = || InboxError::BadStream(stream.chars().take(80).collect());
    if stream.split(':').next() != Some(prefix) {
        return Err(bad());
    }
    stream
        .rsplit(':')
        .next()
        .ok_or_else(bad)?
        .parse()
        .map_err(|_| bad())
}

/// Every template, rendered with sample figures: what the free-text test reads.
#[cfg(test)]
pub(crate) fn every_template() -> Vec<(String, String)> {
    let facts = CateringFacts {
        customer: Ulid::from_parts(0, 1),
        date: "2026-11-21".parse().unwrap(),
        headcount: 140,
        package: "breakfast-spread".into(),
        venue: "v3".into(),
        balance: Some(Cents(123_456)),
    };
    let mut no_balance = facts.clone();
    no_balance.balance = None;
    let day: BakeryDate = "2026-12-05".parse().unwrap();
    let mut out = vec![
        receipt(OrderKind::Pickup, 1, Cents(2_090)),
        receipt(OrderKind::Delivery, 24, Cents(123_456_789)),
        ready(OrderKind::Pickup, 3),
        ready(OrderKind::Delivery, 3),
        on_its_way(2, 63),
        refund(Cents(500), false),
        refund(Cents(2_090), true),
        acknowledgement(&facts),
        quote(Cents(1_234_500), Cents(308_625), day),
        quote_expired(&facts),
        declined_inquiry(&facts),
        deposit_receipt(Cents(308_625), &facts),
        invoice(Cents(925_875), day, &facts),
        closed(&facts),
    ];
    for p in [Purpose::Order, Purpose::Deposit, Purpose::Balance] {
        out.push(declined(p));
    }
    for k in [
        ReminderKind::FollowUp,
        ReminderKind::EventSoon,
        ReminderKind::InvoiceDue,
    ] {
        out.push(reminder(k, &facts));
        out.push(reminder(k, &no_balance));
    }
    for s in SubjectTemplate::ALL {
        for b in BodyTemplate::ALL {
            out.push(campaign_message(s, b));
        }
    }
    out
}

#[cfg(test)]
mod tests;
