//! Crm, one object per sandbox (`crm:<sandbox>`), which holds two things (docs/domain.md,
//! "Campaign"; docs/architecture.md, "Durable Object topology"):
//!
//! - **The projection**, [`CrmProjection`]: the customer list, one timeline per customer, the
//!   activity log, the catering lead pipeline, campaign stats and the rebuild cursor, folded from
//!   the events the routing table sends Crm. It is never written by a command, so it can be
//!   dropped and rebuilt from Crm's log ([`CrmProjection::from_log`], [`Rebuild`]): the Backfill
//!   Lab's principle, "projections are disposable; the log is not".
//! - **The campaigns**, [`Campaigns`], an aggregate table: draft, edit, schedule, cancel, and the
//!   send the timer fires, whose recipients are read from the projection at that moment and
//!   frozen in `CampaignSent`.
//!
//! The projection follows the Kitchen's rules (`kitchen.rs`): idempotent by event id, and per
//! aggregate stream (`order:`, `catering:`, `customer:`) it keeps the newest `seq` it applied and
//! ignores anything not newer. Crm receives only some of each stream, so a gap is normal and is
//! not waited for; a later event for an order or a catering inquiry Crm has never seen is
//! refused with [`CrmError::UnknownRef`] and the consumer retries it. Streams that carry many
//! things (`inbox:`, `sandbox:`, `billing:` and the rest) need no `seq` rule: their events add
//! to sets and to time-ordered lists, which converge in any order.
//!
//! Only [`Outcome::Applied`] changes the projection, so the host appends exactly the applied
//! envelopes to Crm's log, and folding that log again reproduces the projection byte for byte.
//!
//! The order note and the catering brief are never stored here, even when an envelope carries
//! one (docs/domain.md, the paragraph under "The event catalog"): no field of the projection
//! holds free text, and [`log_entry`] strips both from what the host logs.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::aggregate::{Aggregate, DecideContext, DomainEvent, EventCodecError};
use crate::catering::CateringEvent;
use crate::customer::CustomerEvent;
use crate::inbox::{InboxEvent, MessageKind};
use crate::order::{CancelledBy, Line, OrderEvent, OrderKind};
use crate::{BakeryDate, BusinessTime, Cents, Envelope, Ulid};

/// A campaign is scheduled at least this many business minutes ahead.
pub const SCHEDULE_LEAD_MINUTES: i64 = 15;
/// Log entries replayed per rebuild alarm (docs/architecture.md, "A campaign send").
pub const REBUILD_BATCH: usize = 200;
/// How many member ids a segment's answer samples.
pub const SEGMENT_SAMPLE: usize = 5;

const MINUTES_PER_DAY: i64 = 24 * 60;

// ---------------------------------------------------------------------------------------------
// Reference data from the seed
// ---------------------------------------------------------------------------------------------

/// One persona as Crm is born knowing it: the seed's roster, which no event carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Persona {
    pub customer: Ulid,
    pub display_name: String,
    /// `z1` to `z3`.
    pub home_zone: String,
    pub marketing: bool,
    /// The seed's balance, from the persona's closed history.
    pub opening_points: u32,
}

/// What Crm is seeded with besides its log: the 60 personas, and which item slugs are cakes, so
/// the `cake-last-30-days` segment can read an order's lines. A rebuild keeps it; only the
/// projection is dropped.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Directory {
    pub personas: Vec<Persona>,
    pub cake_items: BTreeSet<String>,
}

// ---------------------------------------------------------------------------------------------
// Segments and templates
// ---------------------------------------------------------------------------------------------

/// A fixed, named rule over the projection, evaluated with business time `now` (docs/domain.md,
/// "Ubiquitous language": Segment). Staff pick one; none is typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Segment {
    /// Every persona.
    Everyone,
    /// A counted order with a cake line whose slot is no more than 30 days before `now`.
    #[serde(rename = "cake-last-30-days")]
    CakeLast30Days,
    /// Any counted delivery order.
    DeliveryCustomers,
    /// No counted order whose slot is within 60 days before `now`, or later.
    #[serde(rename = "lapsed-60-days")]
    Lapsed60Days,
    /// A catering inquiry still open: `inquiry`, `quoted` or `accepted`.
    CateringLeads,
}

impl Segment {
    pub const ALL: [Segment; 5] = [
        Segment::Everyone,
        Segment::CakeLast30Days,
        Segment::DeliveryCustomers,
        Segment::Lapsed60Days,
        Segment::CateringLeads,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            Segment::Everyone => "everyone",
            Segment::CakeLast30Days => "cake-last-30-days",
            Segment::DeliveryCustomers => "delivery-customers",
            Segment::Lapsed60Days => "lapsed-60-days",
            Segment::CateringLeads => "catering-leads",
        }
    }

    pub fn parse(text: &str) -> Option<Segment> {
        Segment::ALL.into_iter().find(|s| s.slug() == text)
    }
}

/// A campaign's subject: one of a fixed set, so no free text reaches a message (Q14).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SubjectTemplate {
    WeekendBake,
    CakeWeek,
    NewSeason,
    WeMissYou,
    CateringSeason,
    ThankYou,
}

impl SubjectTemplate {
    pub const ALL: [SubjectTemplate; 6] = [
        SubjectTemplate::WeekendBake,
        SubjectTemplate::CakeWeek,
        SubjectTemplate::NewSeason,
        SubjectTemplate::WeMissYou,
        SubjectTemplate::CateringSeason,
        SubjectTemplate::ThankYou,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            SubjectTemplate::WeekendBake => "weekend-bake",
            SubjectTemplate::CakeWeek => "cake-week",
            SubjectTemplate::NewSeason => "new-season",
            SubjectTemplate::WeMissYou => "we-miss-you",
            SubjectTemplate::CateringSeason => "catering-season",
            SubjectTemplate::ThankYou => "thank-you",
        }
    }

    /// The line the inbox shows.
    pub fn text(self) -> &'static str {
        match self {
            SubjectTemplate::WeekendBake => "This weekend at Proof of Concept Bakery",
            SubjectTemplate::CakeWeek => "It is cake week",
            SubjectTemplate::NewSeason => "New on the seasonal menu",
            SubjectTemplate::WeMissYou => "We have missed you at the counter",
            SubjectTemplate::CateringSeason => "Catering dates are filling up",
            SubjectTemplate::ThankYou => "Thank you for baking with us",
        }
    }

    pub fn parse(text: &str) -> Option<SubjectTemplate> {
        SubjectTemplate::ALL.into_iter().find(|s| s.slug() == text)
    }
}

/// A campaign's body: one of a fixed set, the same for every recipient.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BodyTemplate {
    /// What a `CampaignSent` written without a body shows.
    #[default]
    Announcement,
    FreshBread,
    CakeOrders,
    SeasonalMenu,
    ComeBack,
    CateringInvite,
}

impl BodyTemplate {
    pub const ALL: [BodyTemplate; 6] = [
        BodyTemplate::Announcement,
        BodyTemplate::FreshBread,
        BodyTemplate::CakeOrders,
        BodyTemplate::SeasonalMenu,
        BodyTemplate::ComeBack,
        BodyTemplate::CateringInvite,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            BodyTemplate::Announcement => "announcement",
            BodyTemplate::FreshBread => "fresh-bread",
            BodyTemplate::CakeOrders => "cake-orders",
            BodyTemplate::SeasonalMenu => "seasonal-menu",
            BodyTemplate::ComeBack => "come-back",
            BodyTemplate::CateringInvite => "catering-invite",
        }
    }

    /// The body as the inbox shows it.
    pub fn render(self) -> String {
        let text = match self {
            BodyTemplate::Announcement => {
                "There is news from the bakery this week. Look in on the storefront to see it."
            }
            BodyTemplate::FreshBread => {
                "The country loaf and the seeded rye come out of the oven before the counter opens at seven. Order ahead for a pickup slot."
            }
            BodyTemplate::CakeOrders => {
                "Whole cakes need two days' notice. Pick a slot two days out and we will have it boxed and ready."
            }
            BodyTemplate::SeasonalMenu => {
                "The seasonal items are back while the season lasts. Find them on the menu, marked seasonal."
            }
            BodyTemplate::ComeBack => {
                "It has been a while. Your loyalty points are waiting, and so is the morning bun."
            }
            BodyTemplate::CateringInvite => {
                "Planning a breakfast, a lunch or a celebration? Send an inquiry at least a week ahead and we will quote it."
            }
        };
        format!("Hello from Proof of Concept Bakery. {text}")
    }

    pub fn parse(text: &str) -> Option<BodyTemplate> {
        BodyTemplate::ALL.into_iter().find(|s| s.slug() == text)
    }
}

// ---------------------------------------------------------------------------------------------
// Crm's own events
// ---------------------------------------------------------------------------------------------

/// Crm's rows in docs/domain.md, "The event catalog".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum CrmEvent {
    /// Crm's own record of a draft. Not routed.
    CampaignDrafted {
        campaign: Ulid,
        subject: SubjectTemplate,
        body: BodyTemplate,
        segment: Segment,
    },
    /// Crm's own record of an edit to a draft. Not routed.
    CampaignEdited {
        campaign: Ulid,
        subject: SubjectTemplate,
        body: BodyTemplate,
        segment: Segment,
    },
    CampaignScheduled {
        campaign: Ulid,
        segment: Segment,
        send_at: Option<BusinessTime>,
    },
    /// From `scheduled` it carries the `send_at` it undoes and the campaign is a draft again;
    /// from `draft` it carries none and the campaign is cancelled.
    CampaignCancelled {
        campaign: Ulid,
        segment: Segment,
        #[serde(default)]
        send_at: Option<BusinessTime>,
    },
    /// The frozen recipients, sorted. `subject` is the template's slug; `body` is new, optional
    /// in the catalog, so a reader of an older envelope gets the default body.
    CampaignSent {
        campaign: Ulid,
        recipients: Vec<Ulid>,
        subject: SubjectTemplate,
        #[serde(default)]
        body: BodyTemplate,
    },
    ProjectionRebuildFinished {
        events: u32,
        ms: u32,
    },
}

impl DomainEvent for CrmEvent {
    const NAMES: &'static [&'static str] = &[
        "CampaignDrafted",
        "CampaignEdited",
        "CampaignScheduled",
        "CampaignCancelled",
        "CampaignSent",
        "ProjectionRebuildFinished",
    ];

    fn name(&self) -> &'static str {
        match self {
            CrmEvent::CampaignDrafted { .. } => "CampaignDrafted",
            CrmEvent::CampaignEdited { .. } => "CampaignEdited",
            CrmEvent::CampaignScheduled { .. } => "CampaignScheduled",
            CrmEvent::CampaignCancelled { .. } => "CampaignCancelled",
            CrmEvent::CampaignSent { .. } => "CampaignSent",
            CrmEvent::ProjectionRebuildFinished { .. } => "ProjectionRebuildFinished",
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------------------------

/// One row of the customer list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomerRow {
    pub customer: Ulid,
    pub display_name: String,
    pub home_zone: String,
    pub marketing: bool,
    pub loyalty_balance: i64,
    /// Counted orders: paid, or closed from the history, and not cancelled.
    pub orders: u32,
    /// The latest counted order's slot.
    pub last_order_at: Option<BusinessTime>,
    /// Catering inquiries.
    pub catering: u32,
}

/// One line of a customer's timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineEntry {
    pub at: BusinessTime,
    #[serde(rename = "type")]
    pub event_type: String,
    /// The order, catering inquiry, message or customer the entry is about.
    #[serde(rename = "ref")]
    pub reference: Ulid,
    /// A short fixed sentence filled with the event's own figures.
    pub label: String,
    /// The event's id, which breaks ties between entries at the same time.
    pub id: Ulid,
}

/// One line of the activity log: the "logs it" rows of the catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityEntry {
    pub at: BusinessTime,
    #[serde(rename = "type")]
    pub event_type: String,
    pub summary: String,
    pub id: Ulid,
}

/// A catering lead's place in the pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeadStage {
    Inquiry,
    Quoted,
    Accepted,
    /// The deposit is paid; the event is on.
    Won,
    /// Declined, expired or cancelled.
    Lost,
    /// Delivered, paid and closed.
    Closed,
}

impl LeadStage {
    pub const ALL: [LeadStage; 6] = [
        LeadStage::Inquiry,
        LeadStage::Quoted,
        LeadStage::Accepted,
        LeadStage::Won,
        LeadStage::Lost,
        LeadStage::Closed,
    ];

    pub fn is_open(self) -> bool {
        matches!(
            self,
            LeadStage::Inquiry | LeadStage::Quoted | LeadStage::Accepted
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lead {
    pub catering: Ulid,
    pub customer: Ulid,
    pub date: BakeryDate,
    pub stage: LeadStage,
}

/// What the projection knows of a campaign: its schedule from Crm's own events, and its
/// messages from the Inbox's.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignStats {
    pub segment: Option<Segment>,
    pub send_at: Option<BusinessTime>,
    pub delivered: BTreeSet<Ulid>,
    pub opened: BTreeSet<Ulid>,
    pub clicked: BTreeSet<Ulid>,
}

/// How far the projection has folded Crm's log.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    /// Envelopes that changed the projection.
    pub events_applied: u32,
    /// Log entries folded, applied or not.
    pub log_position: u32,
}

/// When the history starts, from `SandboxSeeded`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seeded {
    pub seed: u64,
    pub born: BakeryDate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct OrderRow {
    customer: Ulid,
    kind: OrderKind,
    slot: BusinessTime,
    cake: bool,
    paid: bool,
    cancelled: bool,
}

impl OrderRow {
    fn counts(&self) -> bool {
        self.paid && !self.cancelled
    }
}

/// What [`CrmProjection::apply`] did. Only `Applied` changed anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Applied,
    /// This event id was applied before.
    Duplicate,
    /// The projection already holds a newer `seq` for this aggregate.
    Stale,
    /// An event type the catalog does not route to Crm.
    NotForCrm,
}

/// Why an envelope could not be applied. An `Err` changes nothing, so the retry is applied as if
/// it were the first delivery.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CrmError {
    /// A later event for an order or an inquiry whose first event has not arrived yet; retry.
    #[error("nothing known yet of {0}")]
    UnknownRef(Ulid),
    /// A customer outside the seed's roster.
    #[error("no persona {0}")]
    UnknownCustomer(Ulid),
    #[error("not a stream Crm reads this event from: {0}")]
    BadStream(String),
    #[error(transparent)]
    Codec(#[from] EventCodecError),
}

/// The event types the catalog sends Crm for its activity log.
pub const ACTIVITY_TYPES: &[&str] = &[
    "SandboxSeeded",
    "ClockAdvanced",
    "FaultSet",
    "ApiTokenRotated",
    "MenuItemChanged",
    "CapacityChanged",
    "PaymentIntentCreated",
    "PaymentCanceled",
    "RouteProposed",
    "TrafficStarted",
    "TrafficStopped",
];

/// Crm's projection. Every map is ordered, so it serializes the same way however it was built.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrmProjection {
    cake_items: BTreeSet<String>,
    customers: BTreeMap<Ulid, CustomerRow>,
    timelines: BTreeMap<Ulid, Vec<TimelineEntry>>,
    activity: Vec<ActivityEntry>,
    leads: BTreeMap<Ulid, Lead>,
    campaigns: BTreeMap<Ulid, CampaignStats>,
    orders: BTreeMap<Ulid, OrderRow>,
    seeded: Option<Seeded>,
    heads: BTreeMap<String, u64>,
    seen: BTreeSet<Ulid>,
    cursor: Cursor,
}

impl CrmProjection {
    /// The empty projection over the seed's roster: every persona with its opening balance and
    /// no orders.
    pub fn new(directory: &Directory) -> CrmProjection {
        CrmProjection {
            cake_items: directory.cake_items.clone(),
            customers: directory
                .personas
                .iter()
                .map(|p| {
                    (
                        p.customer,
                        CustomerRow {
                            customer: p.customer,
                            display_name: p.display_name.clone(),
                            home_zone: p.home_zone.clone(),
                            marketing: p.marketing,
                            loyalty_balance: i64::from(p.opening_points),
                            orders: 0,
                            last_order_at: None,
                            catering: 0,
                        },
                    )
                })
                .collect(),
            timelines: BTreeMap::new(),
            activity: Vec::new(),
            leads: BTreeMap::new(),
            campaigns: BTreeMap::new(),
            orders: BTreeMap::new(),
            seeded: None,
            heads: BTreeMap::new(),
            seen: BTreeSet::new(),
            cursor: Cursor::default(),
        }
    }

    /// The projection Crm's log folds to: what a rebuild ends with.
    pub fn from_log<'a>(
        directory: &Directory,
        log: impl IntoIterator<Item = &'a Envelope>,
    ) -> Result<CrmProjection, CrmError> {
        let mut projection = CrmProjection::new(directory);
        for envelope in log {
            projection.replay(envelope)?;
        }
        Ok(projection)
    }

    /// Folds one log entry: [`CrmProjection::apply`], counting the entry whatever it did.
    pub fn replay(&mut self, envelope: &Envelope) -> Result<Outcome, CrmError> {
        let outcome = self.apply(envelope)?;
        if outcome != Outcome::Applied {
            self.cursor.log_position += 1;
        }
        Ok(outcome)
    }

    /// Applies one delivered envelope. Only `Applied` changes the projection; the host appends
    /// exactly those envelopes to Crm's log, through [`log_entry`].
    pub fn apply(&mut self, envelope: &Envelope) -> Result<Outcome, CrmError> {
        if self.seen.contains(&envelope.id) {
            return Ok(Outcome::Duplicate);
        }
        let t = envelope.event_type.as_str();
        let outcome = if OrderEvent::NAMES.contains(&t) {
            self.apply_order(envelope)?
        } else if CateringEvent::NAMES.contains(&t) {
            self.apply_catering(envelope)?
        } else if CustomerEvent::NAMES.contains(&t) {
            self.apply_customer(envelope)?
        } else if InboxEvent::NAMES.contains(&t) {
            self.apply_inbox(envelope)?
        } else if CrmEvent::NAMES.contains(&t) {
            self.apply_campaign(envelope)?
        } else if ACTIVITY_TYPES.contains(&t) {
            self.apply_activity(envelope)
        } else {
            Outcome::NotForCrm
        };
        if outcome == Outcome::Applied {
            self.seen.insert(envelope.id);
            self.cursor.events_applied += 1;
            self.cursor.log_position += 1;
        }
        Ok(outcome)
    }

    // --- reads --------------------------------------------------------------------------

    /// The customer list, by id.
    pub fn customers(&self) -> impl Iterator<Item = &CustomerRow> {
        self.customers.values()
    }

    pub fn customer(&self, customer: Ulid) -> Option<&CustomerRow> {
        self.customers.get(&customer)
    }

    /// One customer's timeline, in business-time order; empty for a customer with none.
    pub fn timeline(&self, customer: Ulid) -> &[TimelineEntry] {
        self.timelines.get(&customer).map_or(&[], Vec::as_slice)
    }

    /// The activity log, in business-time order.
    pub fn activity(&self) -> &[ActivityEntry] {
        &self.activity
    }

    /// Every catering lead, by id.
    pub fn leads(&self) -> impl Iterator<Item = &Lead> {
        self.leads.values()
    }

    /// The pipeline: each stage, in order, with its leads' ids.
    pub fn pipeline(&self) -> Vec<(LeadStage, Vec<Ulid>)> {
        LeadStage::ALL
            .into_iter()
            .map(|stage| {
                let ids = self
                    .leads
                    .values()
                    .filter(|l| l.stage == stage)
                    .map(|l| l.catering)
                    .collect();
                (stage, ids)
            })
            .collect()
    }

    pub fn campaign_stats(&self, campaign: Ulid) -> Option<&CampaignStats> {
        self.campaigns.get(&campaign)
    }

    pub fn seeded(&self) -> Option<Seeded> {
        self.seeded
    }

    pub fn cursor(&self) -> Cursor {
        self.cursor
    }

    /// The customer an order belongs to, once its first event has arrived.
    pub fn customer_of_order(&self, order: Ulid) -> Option<Ulid> {
        self.orders.get(&order).map(|o| o.customer)
    }

    /// The projection as text: what the rebuild test compares byte for byte.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("the projection is plain data")
    }

    // --- orders -------------------------------------------------------------------------

    fn apply_order(&mut self, envelope: &Envelope) -> Result<Outcome, CrmError> {
        let event = OrderEvent::from_envelope(envelope)?;
        let order = stream_id(&envelope.stream, "order")?;
        let routed = !matches!(
            event,
            OrderEvent::OrderRefundRequested { .. }
                | OrderEvent::OrderExpired { .. }
                | OrderEvent::OrderOutForDelivery { .. }
        );
        if !routed {
            return Ok(Outcome::NotForCrm);
        }
        if self.is_stale(&envelope.stream, envelope.seq) {
            return Ok(Outcome::Stale);
        }
        let label = match &event {
            OrderEvent::OrderPlaced {
                customer,
                kind,
                slot,
                lines,
                total_cents,
                ..
            } => {
                self.persona(*customer)?;
                let cake = self.has_cake(lines);
                self.orders.entry(order).or_insert(OrderRow {
                    customer: *customer,
                    kind: *kind,
                    slot: *slot,
                    cake,
                    paid: false,
                    cancelled: false,
                });
                format!(
                    "Placed a {} order: {}, {}",
                    kind_text(*kind),
                    items_text(lines),
                    total_cents.dollars()
                )
            }
            OrderEvent::OrderClosed {
                total_cents,
                refunded_cents,
                lines,
                customer,
                kind,
                slot,
                ..
            } => {
                let known = self.orders.contains_key(&order);
                if !known {
                    // The seed's history: the close is the order's only event.
                    let (Some(customer), Some(kind), Some(slot)) = (customer, kind, slot) else {
                        return Err(CrmError::UnknownRef(order));
                    };
                    self.persona(*customer)?;
                    let cake = lines.as_deref().is_some_and(|l| self.has_cake(l));
                    self.orders.insert(
                        order,
                        OrderRow {
                            customer: *customer,
                            kind: *kind,
                            slot: *slot,
                            cake,
                            paid: true,
                            cancelled: false,
                        },
                    );
                }
                let refunded = if refunded_cents.0 > 0 {
                    format!(", {} refunded", refunded_cents.dollars())
                } else {
                    String::new()
                };
                match lines {
                    Some(lines) if !known => format!(
                        "Order closed: {}, {}{refunded}",
                        items_text(lines),
                        total_cents.dollars()
                    ),
                    _ => format!("Order closed: {}{refunded}", total_cents.dollars()),
                }
            }
            other => {
                let Some(row) = self.orders.get_mut(&order) else {
                    return Err(CrmError::UnknownRef(order));
                };
                match other {
                    OrderEvent::OrderPaid { amount_cents, .. } => {
                        row.paid = true;
                        format!("Paid {}", amount_cents.dollars())
                    }
                    OrderEvent::OrderPaymentLate { amount_cents, .. } => {
                        format!("Paid {} late; it goes back", amount_cents.dollars())
                    }
                    OrderEvent::OrderCancelled { by } => {
                        row.cancelled = true;
                        match by {
                            CancelledBy::Customer => "Cancelled by the customer".to_owned(),
                            CancelledBy::Staff => "Cancelled by staff".to_owned(),
                        }
                    }
                    // Each step after payment implies it, so a late `OrderPaid` lost to the
                    // `seq` rule still leaves the order counted.
                    OrderEvent::OrderProductionStarted {} => {
                        row.paid = true;
                        "In production".to_owned()
                    }
                    OrderEvent::OrderReady {} => {
                        row.paid = true;
                        "Ready".to_owned()
                    }
                    OrderEvent::OrderPickedUp { .. } => {
                        row.paid = true;
                        "Picked up".to_owned()
                    }
                    OrderEvent::OrderDelivered { .. } => {
                        row.paid = true;
                        "Delivered".to_owned()
                    }
                    OrderEvent::OrderRefunded {
                        amount_cents, full, ..
                    } => {
                        if *full {
                            format!("Refunded {} in full", amount_cents.dollars())
                        } else {
                            format!("Refunded {}", amount_cents.dollars())
                        }
                    }
                    _ => unreachable!("filtered above"),
                }
            }
        };
        let row = &self.orders[&order];
        let customer = row.customer;
        if let OrderEvent::OrderPaid { amount_cents, .. } = &event {
            let summary = format!(
                "Order paid: {}, {}",
                amount_cents.dollars(),
                kind_text(row.kind)
            );
            self.push_activity(envelope, summary);
        }
        self.heads.insert(envelope.stream.clone(), envelope.seq);
        self.refresh(customer);
        self.add_entry(customer, envelope, order, label);
        Ok(Outcome::Applied)
    }

    fn has_cake(&self, lines: &[Line]) -> bool {
        lines.iter().any(|l| self.cake_items.contains(&l.item))
    }

    /// Recomputes a customer's order columns from the order rows.
    fn refresh(&mut self, customer: Ulid) {
        let counted = self
            .orders
            .values()
            .filter(|o| o.customer == customer && o.counts());
        let (mut n, mut last) = (0u32, None::<BusinessTime>);
        for o in counted {
            n += 1;
            last = Some(last.map_or(o.slot, |l| l.max(o.slot)));
        }
        if let Some(row) = self.customers.get_mut(&customer) {
            row.orders = n;
            row.last_order_at = last;
        }
    }

    // --- catering -----------------------------------------------------------------------

    fn apply_catering(&mut self, envelope: &Envelope) -> Result<Outcome, CrmError> {
        let event = CateringEvent::from_envelope(envelope)?;
        let catering = stream_id(&envelope.stream, "catering")?;
        if matches!(
            event,
            CateringEvent::CateringDepositLapsed {} | CateringEvent::CateringReminderDue { .. }
        ) {
            return Ok(Outcome::NotForCrm);
        }
        if self.is_stale(&envelope.stream, envelope.seq) {
            return Ok(Outcome::Stale);
        }
        let (stage, label) = match &event {
            CateringEvent::CateringInquiryReceived {
                customer,
                date,
                headcount,
                package,
                venue,
                ..
            } => {
                self.persona(*customer)?;
                if let std::collections::btree_map::Entry::Vacant(slot) = self.leads.entry(catering)
                {
                    slot.insert(Lead {
                        catering,
                        customer: *customer,
                        date: *date,
                        stage: LeadStage::Inquiry,
                    });
                    if let Some(row) = self.customers.get_mut(customer) {
                        row.catering += 1;
                    }
                }
                (
                    LeadStage::Inquiry,
                    format!(
                        "Catering inquiry for {date}: {headcount} people, {}, at {}",
                        slug_text(package),
                        slug_text(venue)
                    ),
                )
            }
            CateringEvent::CateringQuoteSent {
                total_cents,
                deposit_cents,
                ..
            } => (
                LeadStage::Quoted,
                format!(
                    "Quoted {}, deposit {}",
                    total_cents.dollars(),
                    deposit_cents.dollars()
                ),
            ),
            CateringEvent::CateringQuoteAccepted { .. } => {
                (LeadStage::Accepted, "Quote accepted".to_owned())
            }
            CateringEvent::CateringQuoteExpired { .. } => {
                (LeadStage::Lost, "Quote expired".to_owned())
            }
            CateringEvent::CateringDeclined { .. } => {
                (LeadStage::Lost, "Inquiry declined".to_owned())
            }
            CateringEvent::CateringDepositPaid { amount_cents, .. } => (
                LeadStage::Won,
                format!("Deposit paid: {}", amount_cents.dollars()),
            ),
            // Since 2026-11-08 (the console audit's finding 13, the part left open): the two
            // kitchen steps between the deposit and the balance.
            CateringEvent::CateringProductionStarted {} => {
                (LeadStage::Won, "Production started".to_owned())
            }
            CateringEvent::CateringDelivered { balance_cents, .. } => (
                LeadStage::Won,
                format!("Delivered; balance {}", balance_cents.dollars()),
            ),
            CateringEvent::CateringBalanceInvoiced { amount_cents, .. } => (
                LeadStage::Won,
                format!("Balance invoiced: {}", amount_cents.dollars()),
            ),
            CateringEvent::CateringBalancePaid { .. } => {
                (LeadStage::Won, "Balance paid".to_owned())
            }
            CateringEvent::CateringClosed { .. } => {
                (LeadStage::Closed, "Catering closed".to_owned())
            }
            CateringEvent::CateringCancelled { refund_deposit, .. } => (
                LeadStage::Lost,
                if *refund_deposit {
                    "Catering cancelled; the deposit goes back".to_owned()
                } else {
                    "Catering cancelled; the deposit is kept".to_owned()
                },
            ),
            _ => unreachable!("filtered above"),
        };
        let Some(lead) = self.leads.get_mut(&catering) else {
            return Err(CrmError::UnknownRef(catering));
        };
        lead.stage = stage;
        let customer = lead.customer;
        self.heads.insert(envelope.stream.clone(), envelope.seq);
        self.push_activity(envelope, catering_activity(&event));
        self.add_entry(customer, envelope, catering, label);
        Ok(Outcome::Applied)
    }

    // --- customers ----------------------------------------------------------------------

    fn apply_customer(&mut self, envelope: &Envelope) -> Result<Outcome, CrmError> {
        let event = CustomerEvent::from_envelope(envelope)?;
        let customer = stream_id(&envelope.stream, "customer")?;
        if matches!(event, CustomerEvent::CustomerRegistered { .. }) {
            return Ok(Outcome::NotForCrm);
        }
        self.persona(customer)?;
        if self.is_stale(&envelope.stream, envelope.seq) {
            return Ok(Outcome::Stale);
        }
        let row = self
            .customers
            .get_mut(&customer)
            .ok_or(CrmError::UnknownCustomer(customer))?;
        let (reference, label) = match event {
            CustomerEvent::ConsentChanged { marketing } => {
                row.marketing = marketing;
                let label = if marketing {
                    "Marketing consent given"
                } else {
                    "Marketing consent withdrawn"
                };
                (customer, label.to_owned())
            }
            CustomerEvent::LoyaltyPointsEarned { order, points, .. } => {
                row.loyalty_balance += i64::from(points);
                let label = if points >= 0 {
                    format!("Earned {points} points")
                } else {
                    format!("{} points taken back for a refund", -i64::from(points))
                };
                (order, label)
            }
            CustomerEvent::CustomerRegistered { .. } => unreachable!("filtered above"),
        };
        self.heads.insert(envelope.stream.clone(), envelope.seq);
        self.add_entry(customer, envelope, reference, label);
        Ok(Outcome::Applied)
    }

    // --- the inbox's events -------------------------------------------------------------

    fn apply_inbox(&mut self, envelope: &Envelope) -> Result<Outcome, CrmError> {
        match InboxEvent::from_envelope(envelope)? {
            InboxEvent::MessageDelivered {
                message,
                to,
                kind,
                reference,
            } => {
                self.persona(to)?;
                if kind == MessageKind::Campaign {
                    self.campaigns
                        .entry(reference)
                        .or_default()
                        .delivered
                        .insert(message);
                }
                let label = format!("Message delivered: {}", kind.label());
                self.add_entry(to, envelope, message, label);
            }
            InboxEvent::MessageOpened { message, campaign } => {
                if let Some(c) = campaign {
                    self.campaigns.entry(c).or_default().opened.insert(message);
                }
            }
            InboxEvent::MessageClicked { message, campaign } => {
                if let Some(c) = campaign {
                    self.campaigns.entry(c).or_default().clicked.insert(message);
                }
            }
        }
        Ok(Outcome::Applied)
    }

    // --- Crm's own campaign events ------------------------------------------------------

    fn apply_campaign(&mut self, envelope: &Envelope) -> Result<Outcome, CrmError> {
        let event = CrmEvent::from_envelope(envelope)?;
        let (campaign, segment, send_at) = match event {
            CrmEvent::CampaignScheduled {
                campaign,
                segment,
                send_at,
            } => (campaign, segment, send_at),
            // Back to a draft, or cancelled: either way nothing is due.
            CrmEvent::CampaignCancelled {
                campaign, segment, ..
            } => (campaign, segment, None),
            _ => return Ok(Outcome::NotForCrm),
        };
        let key = format!("campaign:{campaign}");
        if self.is_stale(&key, envelope.seq) {
            return Ok(Outcome::Stale);
        }
        let stats = self.campaigns.entry(campaign).or_default();
        stats.segment = Some(segment);
        stats.send_at = send_at;
        self.heads.insert(key, envelope.seq);
        Ok(Outcome::Applied)
    }

    // --- the activity log ---------------------------------------------------------------

    fn apply_activity(&mut self, envelope: &Envelope) -> Outcome {
        let data = &envelope.data;
        if envelope.event_type == "SandboxSeeded" {
            let seed = data.get("seed").and_then(Value::as_u64);
            let born = data
                .get("born")
                .and_then(Value::as_str)
                .and_then(|b| b.parse::<BakeryDate>().ok());
            if let (Some(seed), Some(born)) = (seed, born) {
                self.seeded = Some(Seeded { seed, born });
            }
        }
        self.push_activity(envelope, activity_summary(&envelope.event_type, data));
        Outcome::Applied
    }

    /// Adds an activity row for `envelope`, where business time puts it, ties by event id.
    fn push_activity(&mut self, envelope: &Envelope, summary: String) {
        let entry = activity_entry(envelope, summary);
        let key = (entry.at, entry.id);
        let at = self.activity.partition_point(|e| (e.at, e.id) < key);
        self.activity.insert(at, entry);
    }

    // --- shared -------------------------------------------------------------------------

    fn persona(&self, customer: Ulid) -> Result<(), CrmError> {
        if self.customers.contains_key(&customer) {
            Ok(())
        } else {
            Err(CrmError::UnknownCustomer(customer))
        }
    }

    fn is_stale(&self, key: &str, seq: u64) -> bool {
        self.heads.get(key).is_some_and(|&h| seq <= h)
    }

    /// Inserts an entry where business time puts it, ties broken by event id, so the timeline
    /// is the same whatever order its events arrived in.
    fn add_entry(&mut self, customer: Ulid, envelope: &Envelope, reference: Ulid, label: String) {
        let entry = TimelineEntry {
            at: envelope.at,
            event_type: envelope.event_type.clone(),
            reference,
            label,
            id: envelope.id,
        };
        let line = self.timelines.entry(customer).or_default();
        let key = (entry.at, entry.id);
        let at = line.partition_point(|e| (e.at, e.id) < key);
        line.insert(at, entry);
    }
}

/// The envelope as Crm logs it: the order note and the catering brief removed, whatever the
/// consumer already stripped.
pub fn log_entry(envelope: &Envelope) -> Envelope {
    let mut out = envelope.clone();
    if let Some(data) = out.data.as_object_mut() {
        data.remove("note");
        data.remove("brief");
    }
    out
}

fn activity_entry(envelope: &Envelope, summary: String) -> ActivityEntry {
    ActivityEntry {
        at: envelope.at,
        event_type: envelope.event_type.clone(),
        summary,
        id: envelope.id,
    }
}

/// Crm's own events the activity feed shows: a campaign sent and a rebuild finished. They are
/// Crm's record, not deliveries, so they live in its `events` stream rather than in the
/// projection: a rebuild then reproduces the projection byte for byte, and the feed still says
/// that it ran.
pub const OWN_ACTIVITY_TYPES: &[&str] = &["CampaignSent", "ProjectionRebuildFinished"];

/// The activity feed: the projection's rows and Crm's own `own` events among
/// [`OWN_ACTIVITY_TYPES`], in business-time order, ties by event id. Others in `own` are left
/// out.
pub fn activity_feed(projection: &CrmProjection, own: &[Envelope]) -> Vec<ActivityEntry> {
    let mut rows: Vec<ActivityEntry> = projection.activity().to_vec();
    rows.extend(
        own.iter()
            .filter(|e| OWN_ACTIVITY_TYPES.contains(&e.event_type.as_str()))
            .map(|e| activity_entry(e, activity_summary(&e.event_type, &e.data))),
    );
    rows.sort_by_key(|e| (e.at, e.id));
    rows
}

/// "1 van" or "4 vans".
fn count_text(n: Option<u64>, one: &str, many: &str) -> String {
    match n {
        Some(1) => format!("1 {one}"),
        Some(n) => format!("{n} {many}"),
        None => format!("some {many}"),
    }
}

/// The activity row for a catering step Crm hears of.
fn catering_activity(event: &CateringEvent) -> String {
    match event {
        CateringEvent::CateringInquiryReceived {
            date, headcount, ..
        } => format!(
            "Catering inquiry for {date}: {}",
            count_text(Some(u64::from(*headcount)), "person", "people")
        ),
        CateringEvent::CateringQuoteSent {
            total_cents,
            deposit_cents,
            ..
        } => format!(
            "Catering quote sent: {}, deposit {}",
            total_cents.dollars(),
            deposit_cents.dollars()
        ),
        CateringEvent::CateringQuoteAccepted { .. } => "Catering quote accepted".to_owned(),
        CateringEvent::CateringQuoteExpired { .. } => "Catering quote expired".to_owned(),
        CateringEvent::CateringDeclined { .. } => "Catering inquiry declined".to_owned(),
        CateringEvent::CateringDepositPaid { amount_cents, .. } => {
            format!("Catering deposit paid: {}", amount_cents.dollars())
        }
        CateringEvent::CateringProductionStarted {} => "Catering production started".to_owned(),
        CateringEvent::CateringDelivered {
            balance_cents, due, ..
        } => format!(
            "Catering delivered: balance {} due {due}",
            balance_cents.dollars()
        ),
        CateringEvent::CateringBalanceInvoiced { amount_cents, .. } => {
            format!("Catering balance invoiced: {}", amount_cents.dollars())
        }
        CateringEvent::CateringBalancePaid { .. } => "Catering balance paid".to_owned(),
        CateringEvent::CateringClosed { .. } => "Catering closed".to_owned(),
        CateringEvent::CateringCancelled { refund_deposit, .. } => if *refund_deposit {
            "Catering cancelled; the deposit goes back"
        } else {
            "Catering cancelled; the deposit is kept"
        }
        .to_owned(),
        _ => "Catering step logged".to_owned(),
    }
}

/// The members of `segment` at business time `now`, sorted by id. Consent is not read here:
/// a campaign's [`Audience`] filters by it.
pub fn segment_members(
    projection: &CrmProjection,
    segment: Segment,
    now: BusinessTime,
) -> Vec<Ulid> {
    let since = |days: i64| now.plus_minutes(-days * MINUTES_PER_DAY).unwrap_or(now);
    let counted = |c: Ulid| {
        projection
            .orders
            .values()
            .filter(move |o| o.customer == c && o.counts())
    };
    projection
        .customers
        .keys()
        .copied()
        .filter(|&c| match segment {
            Segment::Everyone => true,
            Segment::CakeLast30Days => {
                let from = since(30);
                counted(c).any(|o| o.cake && o.slot >= from)
            }
            Segment::DeliveryCustomers => counted(c).any(|o| o.kind == OrderKind::Delivery),
            Segment::Lapsed60Days => {
                let from = since(60);
                !counted(c).any(|o| o.slot >= from)
            }
            Segment::CateringLeads => projection
                .leads
                .values()
                .any(|l| l.customer == c && l.stage.is_open()),
        })
        .collect()
}

/// The last part of `<prefix>:<sandbox>:<ulid>` (or `<prefix>:<ulid>`).
fn stream_id(stream: &str, prefix: &str) -> Result<Ulid, CrmError> {
    let bad = || CrmError::BadStream(stream.chars().take(80).collect());
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

fn kind_text(kind: OrderKind) -> &'static str {
    match kind {
        OrderKind::Pickup => "pickup",
        OrderKind::Delivery => "delivery",
    }
}

/// "1 item" or "4 items": units across the lines.
pub(crate) fn items_text(lines: &[Line]) -> String {
    let n: u32 = lines.iter().map(|l| u32::from(l.qty)).sum();
    if n == 1 {
        "1 item".to_owned()
    } else {
        format!("{n} items")
    }
}

/// A slug as words: `breakfast-spread` is "breakfast spread". Anything not a slug is shown as a
/// placeholder, so no text from an event's data can carry free text into a label.
pub(crate) fn slug_text(slug: &str) -> String {
    if is_slug(slug) {
        slug.replace('-', " ")
    } else {
        "one of the list".to_owned()
    }
}

/// A menu item's slug as its name: `country-loaf` is "Country loaf", the way the menu says it.
pub(crate) fn item_name(slug: &str) -> String {
    let words = slug_text(slug);
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => words,
    }
}

/// A capacity target as a person says it: `slot:07:45` is "the 7:45 am slot", `zone:z2` is
/// "zone 2", `item:croissant` is "Croissant", `catering` is "catering". Anything else is
/// "a target", so no internal key reaches an activity row.
pub(crate) fn target_name(target: &str) -> String {
    let (kind, name) = target.split_once(':').unwrap_or((target, ""));
    match kind {
        "catering" if name.is_empty() => "catering".to_owned(),
        "slot" => {
            let parsed = name.split_once(':').and_then(|(h, m)| {
                let h: u32 = h.parse().ok()?;
                let m: u32 = m.parse().ok()?;
                (h < 24 && m < 60 && name.len() == 5).then_some((h, m))
            });
            match parsed {
                Some((h, m)) => {
                    let half = if h < 12 { "am" } else { "pm" };
                    let h12 = match h % 12 {
                        0 => 12,
                        h => h,
                    };
                    format!("the {h12}:{m:02} {half} slot")
                }
                None => "a slot".to_owned(),
            }
        }
        "zone" => match name.strip_prefix('z') {
            Some(n) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => {
                format!("zone {n}")
            }
            _ => "a zone".to_owned(),
        },
        "item" if is_slug(name) && !name.contains(':') => item_name(name),
        _ => "a target".to_owned(),
    }
}

fn is_slug(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 40
        && text.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | ':' | '/')
        })
}

/// A short sentence for an activity row, from a few named fields of its data, each a number, a
/// boolean, a time or a slug; anything else is left out.
fn activity_summary(event_type: &str, data: &Value) -> String {
    let slug = |name: &str| {
        data.get(name)
            .and_then(Value::as_str)
            .filter(|s| is_slug(s))
            .map(str::to_owned)
    };
    let time = |name: &str| {
        data.get(name)
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<BusinessTime>().ok())
            .map(|t| t.to_string())
    };
    let num = |name: &str| data.get(name).and_then(Value::as_u64);
    let flag = |name: &str| data.get(name).and_then(Value::as_bool);
    let or = |v: Option<String>, d: &str| v.unwrap_or_else(|| d.to_owned());
    let n = |v: Option<u64>| v.map_or_else(|| "some".to_owned(), |n| n.to_string());
    match event_type {
        "SandboxSeeded" => format!(
            "Sandbox seeded from seed {}, born {}",
            n(num("seed")),
            or(
                data.get("born")
                    .and_then(Value::as_str)
                    .and_then(|b| b.parse::<BakeryDate>().ok())
                    .map(|b| b.to_string()),
                "on its birth day"
            )
        ),
        "ClockAdvanced" => format!(
            "Clock moved from {} to {}",
            or(time("from"), "then"),
            or(time("to"), "now")
        ),
        "FaultSet" => format!(
            "Fault {} turned {}",
            or(slug("fault"), "switch"),
            if flag("on") == Some(true) {
                "on"
            } else {
                "off"
            }
        ),
        "ApiTokenRotated" => format!("API token rotated to version {}", n(num("token_v"))),
        "MenuItemChanged" => match slug("item") {
            Some(item) => format!("{} changed on the menu", item_name(&item)),
            None => "An item changed on the menu".to_owned(),
        },
        "CapacityChanged" => format!(
            "Capacity of {} set to {}",
            slug("target").map_or_else(|| "a target".to_owned(), |t| target_name(&t)),
            n(num("capacity"))
        ),
        "PaymentIntentCreated" => format!(
            "Payment intent created for {} ({})",
            data.get("amount_cents")
                .and_then(Value::as_i64)
                .map_or_else(|| "an amount".to_owned(), |c| Cents(c).dollars()),
            or(slug("purpose"), "a payment")
        ),
        "PaymentCanceled" => format!(
            "Payment intent canceled ({})",
            or(slug("purpose"), "a payment")
        ),
        "RouteProposed" => format!(
            "Routes proposed: {}, {}",
            count_text(num("vans"), "van", "vans"),
            count_text(num("minutes"), "minute", "minutes")
        ),
        "TrafficStarted" => format!(
            "Simulated traffic started at {} orders a minute",
            n(num("rate"))
        ),
        "TrafficStopped" => format!(
            "Simulated traffic stopped ({}) after {}",
            slug("reason").map_or_else(|| "stop".to_owned(), |r| slug_text(&r)),
            count_text(num("orders"), "order", "orders")
        ),
        "CampaignSent" => format!(
            "Campaign sent to {}",
            count_text(
                data.get("recipients")
                    .and_then(Value::as_array)
                    .map(|r| r.len() as u64),
                "customer",
                "customers"
            )
        ),
        "ProjectionRebuildFinished" => format!(
            "CRM projection rebuilt: {} replayed in {} ms",
            count_text(num("events"), "event", "events"),
            n(num("ms"))
        ),
        _ => "Logged".to_owned(),
    }
}

// ---------------------------------------------------------------------------------------------
// The rebuild
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RebuildState {
    Idle,
    Rebuilding,
    Finished,
}

/// The rebuild's progress, which the host keeps beside the log: truncate the projection, set
/// the cursor at the log's start, and replay [`REBUILD_BATCH`] entries per alarm
/// (docs/architecture.md, "A campaign send", the rebuild paragraph). While it runs, the host
/// appends new deliveries to the log without applying them, so the replay reaches them, and
/// defers a campaign send until it ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rebuild {
    pub state: RebuildState,
    /// Log entries replayed so far.
    pub position: u32,
    /// The log's length; it grows while the rebuild runs.
    pub total: u32,
}

impl Default for Rebuild {
    fn default() -> Rebuild {
        Rebuild {
            state: RebuildState::Idle,
            position: 0,
            total: 0,
        }
    }
}

impl Rebuild {
    /// Starts over: an empty projection and a cursor at the log's start.
    pub fn start(directory: &Directory, total: u32) -> (Rebuild, CrmProjection) {
        (
            Rebuild {
                state: RebuildState::Rebuilding,
                position: 0,
                total,
            },
            CrmProjection::new(directory),
        )
    }

    /// A rebuild already running is not restarted.
    pub fn is_running(&self) -> bool {
        self.state == RebuildState::Rebuilding
    }

    /// The log grew by `n` entries while the rebuild ran.
    pub fn extend(&mut self, n: u32) {
        self.total += n;
    }

    /// Replays the next entries, those from `position` on, which the host read from the log
    /// (at most [`REBUILD_BATCH`]). Returns whether the cursor reached the end. A duplicate in
    /// the log, appended while a rebuild ran, is skipped like any other.
    pub fn step(
        &mut self,
        projection: &mut CrmProjection,
        batch: &[Envelope],
    ) -> Result<bool, CrmError> {
        if self.state != RebuildState::Rebuilding {
            return Ok(true);
        }
        for envelope in batch {
            projection.replay(envelope)?;
            self.position += 1;
        }
        Ok(self.position >= self.total)
    }

    /// Ends the run: `ProjectionRebuildFinished` with the wall-clock milliseconds the host
    /// measured between start and end.
    pub fn finish(&mut self, ms: u32) -> CrmEvent {
        self.state = RebuildState::Finished;
        CrmEvent::ProjectionRebuildFinished {
            events: self.position,
            ms,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CampaignState {
    Draft,
    Scheduled,
    Sent,
    Cancelled,
}

impl CampaignState {
    pub fn as_str(self) -> &'static str {
        match self {
            CampaignState::Draft => "draft",
            CampaignState::Scheduled => "scheduled",
            CampaignState::Sent => "sent",
            CampaignState::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Campaign {
    pub campaign: Ulid,
    pub subject: SubjectTemplate,
    pub body: BodyTemplate,
    pub segment: Segment,
    pub state: CampaignState,
    pub send_at: Option<BusinessTime>,
    /// Frozen at the send, sorted.
    pub recipients: Vec<Ulid>,
}

/// The campaign table, the fold of Crm's campaign events.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignTable {
    campaigns: BTreeMap<Ulid, Campaign>,
}

impl CampaignTable {
    pub fn get(&self, campaign: Ulid) -> Option<&Campaign> {
        self.campaigns.get(&campaign)
    }

    /// Every campaign, by id.
    pub fn iter(&self) -> impl Iterator<Item = &Campaign> {
        self.campaigns.values()
    }
}

/// Who a send goes to: a segment's members at a moment, those with marketing consent only.
/// Its fields are private and [`Audience::of`] is its only constructor, so a send cannot be
/// handed a recipient the projection did not consent for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Audience {
    segment: Segment,
    recipients: Vec<Ulid>,
}

impl Audience {
    /// `segment`'s members at `now` whose `marketing` is true in the projection now, sorted.
    pub fn of(projection: &CrmProjection, segment: Segment, now: BusinessTime) -> Audience {
        let recipients = segment_members(projection, segment, now)
            .into_iter()
            .filter(|c| projection.customers.get(c).is_some_and(|r| r.marketing))
            .collect();
        Audience {
            segment,
            recipients,
        }
    }

    pub fn segment(&self) -> Segment {
        self.segment
    }

    pub fn recipients(&self) -> &[Ulid] {
        &self.recipients
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CampaignCommand {
    DraftCampaign {
        campaign: Ulid,
        subject: SubjectTemplate,
        body: BodyTemplate,
        segment: Segment,
    },
    /// Draft only.
    EditCampaign {
        campaign: Ulid,
        subject: SubjectTemplate,
        body: BodyTemplate,
        segment: Segment,
    },
    /// A business time at least [`SCHEDULE_LEAD_MINUTES`] after `ctx.now`.
    ScheduleCampaign {
        campaign: Ulid,
        send_at: BusinessTime,
    },
    CancelCampaign {
        campaign: Ulid,
    },
    /// The send timer, with the audience the host read from the projection at `ctx.now`.
    SendCampaign {
        campaign: Ulid,
        audience: Audience,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CampaignError {
    #[error("no campaign {0}")]
    UnknownCampaign(Ulid),
    #[error("campaign {0} exists with other content")]
    Exists(Ulid),
    #[error("{command} does not apply to a campaign that is {}", .state.as_str())]
    OutOfOrder {
        command: &'static str,
        state: CampaignState,
    },
    #[error("a campaign is scheduled at least 15 minutes ahead; the earliest is {earliest}")]
    ScheduleTooSoon { earliest: BusinessTime },
    #[error("the send is due at {send_at}")]
    NotDue { send_at: BusinessTime },
    #[error("the audience is for {}, the campaign for {}", .audience.slug(), .campaign.slug())]
    AudienceMismatch {
        audience: Segment,
        campaign: Segment,
    },
    #[error("time out of range")]
    Overflow,
}

impl CampaignError {
    /// The rule's slug: `schedule-too-soon` is answered 422; the rest 409 `campaign`, the
    /// unknown one 404.
    pub fn rule(&self) -> &'static str {
        match self {
            CampaignError::UnknownCampaign(_) => "unknown-campaign",
            CampaignError::Exists(_) => "campaign-exists",
            CampaignError::OutOfOrder { .. } => "out-of-order",
            CampaignError::ScheduleTooSoon { .. } => "schedule-too-soon",
            CampaignError::NotDue { .. } => "not-due",
            CampaignError::AudienceMismatch { .. } => "audience",
            CampaignError::Overflow => "overflow",
        }
    }
}

pub struct Campaigns;

impl Aggregate for Campaigns {
    type State = CampaignTable;
    type Command = CampaignCommand;
    type Event = CrmEvent;
    type Error = CampaignError;

    fn decide(
        state: &CampaignTable,
        cmd: &CampaignCommand,
        ctx: &DecideContext,
    ) -> Result<Vec<CrmEvent>, CampaignError> {
        let find = |id: &Ulid| {
            state
                .campaigns
                .get(id)
                .ok_or(CampaignError::UnknownCampaign(*id))
        };
        let out_of_order = |command, c: &Campaign| CampaignError::OutOfOrder {
            command,
            state: c.state,
        };
        match cmd {
            CampaignCommand::DraftCampaign {
                campaign,
                subject,
                body,
                segment,
            } => match state.campaigns.get(campaign) {
                None => Ok(vec![CrmEvent::CampaignDrafted {
                    campaign: *campaign,
                    subject: *subject,
                    body: *body,
                    segment: *segment,
                }]),
                Some(c) if (c.subject, c.body, c.segment) == (*subject, *body, *segment) => {
                    Ok(vec![])
                }
                Some(_) => Err(CampaignError::Exists(*campaign)),
            },
            CampaignCommand::EditCampaign {
                campaign,
                subject,
                body,
                segment,
            } => {
                let c = find(campaign)?;
                if c.state != CampaignState::Draft {
                    return Err(out_of_order("EditCampaign", c));
                }
                if (c.subject, c.body, c.segment) == (*subject, *body, *segment) {
                    return Ok(vec![]);
                }
                Ok(vec![CrmEvent::CampaignEdited {
                    campaign: *campaign,
                    subject: *subject,
                    body: *body,
                    segment: *segment,
                }])
            }
            CampaignCommand::ScheduleCampaign { campaign, send_at } => {
                let c = find(campaign)?;
                match c.state {
                    CampaignState::Scheduled if c.send_at == Some(*send_at) => return Ok(vec![]),
                    CampaignState::Draft => {}
                    _ => return Err(out_of_order("ScheduleCampaign", c)),
                }
                let earliest = ctx
                    .now
                    .plus_minutes(SCHEDULE_LEAD_MINUTES)
                    .map_err(|_| CampaignError::Overflow)?;
                if *send_at < earliest {
                    return Err(CampaignError::ScheduleTooSoon { earliest });
                }
                Ok(vec![CrmEvent::CampaignScheduled {
                    campaign: *campaign,
                    segment: c.segment,
                    send_at: Some(*send_at),
                }])
            }
            CampaignCommand::CancelCampaign { campaign } => {
                let c = find(campaign)?;
                match c.state {
                    CampaignState::Scheduled | CampaignState::Draft => {
                        Ok(vec![CrmEvent::CampaignCancelled {
                            campaign: *campaign,
                            segment: c.segment,
                            send_at: c.send_at,
                        }])
                    }
                    CampaignState::Cancelled => Ok(vec![]),
                    CampaignState::Sent => Err(out_of_order("CancelCampaign", c)),
                }
            }
            CampaignCommand::SendCampaign { campaign, audience } => {
                let c = find(campaign)?;
                // A second firing, or a timer left over from a cancelled schedule: nothing.
                if c.state != CampaignState::Scheduled {
                    return Ok(vec![]);
                }
                let send_at = c.send_at.ok_or(CampaignError::Overflow)?;
                if ctx.now < send_at {
                    return Err(CampaignError::NotDue { send_at });
                }
                if audience.segment != c.segment {
                    return Err(CampaignError::AudienceMismatch {
                        audience: audience.segment,
                        campaign: c.segment,
                    });
                }
                Ok(vec![CrmEvent::CampaignSent {
                    campaign: *campaign,
                    recipients: audience.recipients.clone(),
                    subject: c.subject,
                    body: c.body,
                }])
            }
        }
    }

    fn evolve(mut state: CampaignTable, event: &CrmEvent) -> CampaignTable {
        match event {
            CrmEvent::CampaignDrafted {
                campaign,
                subject,
                body,
                segment,
            } => {
                state.campaigns.entry(*campaign).or_insert(Campaign {
                    campaign: *campaign,
                    subject: *subject,
                    body: *body,
                    segment: *segment,
                    state: CampaignState::Draft,
                    send_at: None,
                    recipients: Vec::new(),
                });
            }
            CrmEvent::CampaignEdited {
                campaign,
                subject,
                body,
                segment,
            } => {
                if let Some(c) = state.campaigns.get_mut(campaign) {
                    c.subject = *subject;
                    c.body = *body;
                    c.segment = *segment;
                }
            }
            CrmEvent::CampaignScheduled {
                campaign, send_at, ..
            } => {
                if let Some(c) = state.campaigns.get_mut(campaign) {
                    c.state = CampaignState::Scheduled;
                    c.send_at = *send_at;
                }
            }
            CrmEvent::CampaignCancelled { campaign, .. } => {
                if let Some(c) = state.campaigns.get_mut(campaign) {
                    c.state = match c.state {
                        CampaignState::Scheduled => CampaignState::Draft,
                        _ => CampaignState::Cancelled,
                    };
                    c.send_at = None;
                }
            }
            CrmEvent::CampaignSent {
                campaign,
                recipients,
                ..
            } => {
                if let Some(c) = state.campaigns.get_mut(campaign) {
                    c.state = CampaignState::Sent;
                    c.recipients = recipients.clone();
                }
            }
            CrmEvent::ProjectionRebuildFinished { .. } => {}
        }
        state
    }
}

#[cfg(test)]
mod tests;
