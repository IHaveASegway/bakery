//! The Order aggregate, hosted by `Order`, one object per order (docs/domain.md, "Order"). It
//! protects the order's lines, prices, payment status and lifecycle.
//!
//! The commands, events and rejections follow the doc's table, and the states its diagram. Where
//! the doc leaves a step open, the choice is written at the step:
//!
//! - Cancelling a paid order emits `OrderCancelled` and `OrderRefundRequested` together and
//!   moves to `refund_pending`; `OrderRefunded` for the whole amount then moves it to
//!   `cancelled`. `OrderCancelled` is what Schedule, Kitchen and Dispatch release on, so a paid
//!   order cannot be cancelled without it.
//! - A payment that lands after expiry or cancellation emits `OrderPaymentLate` and an
//!   `OrderRefundRequested` for the whole amount, since Billing refunds only on the latter
//!   (docs/architecture.md, "Placing and paying an order": "a full refund"). From `cancelled`
//!   that is the one transition the diagram does not draw, `cancelled --> refund_pending`.
//! - A staff refund (`RefundOrder`), full or partial, is taken in every paid state that is not
//!   terminal and not on the road: `confirmed`, `in_production`, `ready`, `picked_up`,
//!   `delivered` and `closed`. A partial refund leaves the state as it is. A full refund (all
//!   that is left) of an order that is not yet `closed` is a cancellation by staff, as above:
//!   `OrderCancelled` and `OrderRefundRequested`, then `cancelled` on `OrderRefunded`. In
//!   `closed` a full refund leaves it `closed`, the diagram's `closed --> closed`.
//! - `RecordPayment` checks the amount against the order's total. Billing created the intent
//!   from that total, so a different amount is a bug: it is refused as `amount-mismatch` and
//!   emits nothing.
//! - Repeats are no-ops: a command whose effect already holds (a second `MarkReady`, the
//!   expiry timer firing twice, the same payment recorded again) emits nothing.
//!
//! Three fields go beyond the catalog row and are optional additions in envelope v1:
//! `OrderPlaced.menu_version` (the version the prices came from), `OrderPlaced.held_until` (when
//! an unpaid order expires, so `evolve` needs no clock) and `OrderPaymentLate.amount_cents` (what
//! the late refund returns).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::aggregate::{Aggregate, DecideContext, DomainEvent};
use crate::catalog::{ItemStatus, MenuView};
use crate::free_text::{FreeTextError, check_note};
use crate::{BusinessTime, Cents, DomainError, Ulid};

/// At most 20 lines (docs/domain.md, "Order", invariants).
pub const MAX_LINES: usize = 20;
/// Each line a quantity of 1 to 24 (docs/domain.md, "Order", invariants).
pub const MAX_QTY: u16 = 24;
/// An unpaid order expires 15 minutes of business time after placement (docs/domain.md,
/// "Order", invariants; Q13 · Q-order-flow).
pub const EXPIRY_MINUTES: i64 = 15;
/// The demo tax rate, 1,000 bp or 10.00%, which staff may change (docs/domain.md, "Money and
/// time").
pub const DEFAULT_TAX_BP: u32 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderKind {
    Pickup,
    Delivery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CancelledBy {
    Customer,
    Staff,
}

/// Why money goes back. A choice from a list, like every field but the note and the brief
/// (docs/domain.md, "Free text and personal data").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefundReason {
    Cancelled,
    PaymentLate,
    MissingItem,
    Quality,
    Goodwill,
}

/// The states of the diagram in docs/domain.md, "Order". The seed's open orders use the first
/// four names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    Placed,
    Confirmed,
    Expired,
    Cancelled,
    RefundPending,
    InProduction,
    Ready,
    PickedUp,
    OutForDelivery,
    Delivered,
    Closed,
}

/// A line as the customer asks for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineInput {
    pub variant: String,
    pub qty: u16,
}

/// A line as placed: priced from the menu, never repriced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Line {
    pub item: String,
    pub variant: String,
    pub qty: u16,
    pub unit_cents: Cents,
}

/// Everything `PlaceOrder` needs. The order's id is the one the Sandbox registered for the
/// client's key (docs/domain.md, "Aggregates and their objects": creating an aggregate), and the
/// menu is the published version the router read from `Catalog`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaceOrder {
    pub order: Ulid,
    pub customer: Ulid,
    pub kind: OrderKind,
    pub slot: BusinessTime,
    /// The delivery zone; `None` for a pickup.
    pub zone: Option<String>,
    pub lines: Vec<LineInput>,
    pub note: Option<String>,
    pub menu: MenuView,
    pub tax_bp: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrderCommand {
    PlaceOrder(Box<PlaceOrder>),
    CancelOrder {
        by: CancelledBy,
    },
    /// From `PaymentSucceeded`.
    RecordPayment {
        payment: Ulid,
        amount: Cents,
    },
    /// From the expiry timer.
    Expire,
    StartProduction,
    MarkReady,
    MarkPickedUp,
    /// From `RoutePublished`.
    MarkOutForDelivery {
        route: String,
        stop: u16,
    },
    /// From `StopCompleted`.
    MarkDelivered {
        stop: u16,
    },
    RefundOrder {
        amount: Cents,
        reason: RefundReason,
    },
    /// From `RefundIssued`.
    RecordRefund {
        refund: Ulid,
        amount: Cents,
    },
    /// From the end-of-day timer.
    Close,
}

impl OrderCommand {
    fn name(&self) -> &'static str {
        match self {
            OrderCommand::PlaceOrder(_) => "PlaceOrder",
            OrderCommand::CancelOrder { .. } => "CancelOrder",
            OrderCommand::RecordPayment { .. } => "RecordPayment",
            OrderCommand::Expire => "Expire",
            OrderCommand::StartProduction => "StartProduction",
            OrderCommand::MarkReady => "MarkReady",
            OrderCommand::MarkPickedUp => "MarkPickedUp",
            OrderCommand::MarkOutForDelivery { .. } => "MarkOutForDelivery",
            OrderCommand::MarkDelivered { .. } => "MarkDelivered",
            OrderCommand::RefundOrder { .. } => "RefundOrder",
            OrderCommand::RecordRefund { .. } => "RecordRefund",
            OrderCommand::Close => "Close",
        }
    }
}

/// The Order's rows in docs/domain.md, "The event catalog", with the data fields listed there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum OrderEvent {
    OrderPlaced {
        order: Ulid,
        customer: Ulid,
        kind: OrderKind,
        slot: BusinessTime,
        zone: Option<String>,
        lines: Vec<Line>,
        subtotal_cents: Cents,
        tax_cents: Cents,
        total_cents: Cents,
        /// Stripped by the consumer for every subscriber but the Kitchen.
        #[serde(default)]
        note: Option<String>,
        menu_version: u32,
        held_until: BusinessTime,
    },
    OrderPaid {
        payment: Ulid,
        amount_cents: Cents,
    },
    OrderPaymentLate {
        payment: Ulid,
        amount_cents: Cents,
    },
    OrderRefundRequested {
        payment: Ulid,
        amount_cents: Cents,
        reason: RefundReason,
    },
    OrderExpired {
        held_until: BusinessTime,
    },
    OrderCancelled {
        by: CancelledBy,
    },
    OrderProductionStarted {},
    OrderReady {},
    OrderOutForDelivery {
        route: String,
        stop: u16,
    },
    OrderPickedUp {
        at_stop: Option<u16>,
    },
    OrderDelivered {
        at_stop: Option<u16>,
    },
    OrderRefunded {
        refund: Ulid,
        amount_cents: Cents,
        /// True when this refund brings the refunded total to the amount paid.
        full: bool,
    },
    /// `lines`, `customer`, `kind`, `slot` and `zone` are for the seed's history only, which
    /// has no `OrderPlaced` for Crm to learn them from (docs/domain.md, "Seed history versus
    /// `OrderClosed`"); a live order's close leaves them out.
    OrderClosed {
        total_cents: Cents,
        refunded_cents: Cents,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lines: Option<Vec<Line>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        customer: Option<Ulid>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<OrderKind>,
        /// The pickup slot's or the delivery window's start.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        slot: Option<BusinessTime>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        zone: Option<String>,
    },
}

impl DomainEvent for OrderEvent {
    const NAMES: &'static [&'static str] = &[
        "OrderPlaced",
        "OrderPaid",
        "OrderPaymentLate",
        "OrderRefundRequested",
        "OrderExpired",
        "OrderCancelled",
        "OrderProductionStarted",
        "OrderReady",
        "OrderOutForDelivery",
        "OrderPickedUp",
        "OrderDelivered",
        "OrderRefunded",
        "OrderClosed",
    ];

    fn name(&self) -> &'static str {
        match self {
            OrderEvent::OrderPlaced { .. } => "OrderPlaced",
            OrderEvent::OrderPaid { .. } => "OrderPaid",
            OrderEvent::OrderPaymentLate { .. } => "OrderPaymentLate",
            OrderEvent::OrderRefundRequested { .. } => "OrderRefundRequested",
            OrderEvent::OrderExpired { .. } => "OrderExpired",
            OrderEvent::OrderCancelled { .. } => "OrderCancelled",
            OrderEvent::OrderProductionStarted {} => "OrderProductionStarted",
            OrderEvent::OrderReady {} => "OrderReady",
            OrderEvent::OrderOutForDelivery { .. } => "OrderOutForDelivery",
            OrderEvent::OrderPickedUp { .. } => "OrderPickedUp",
            OrderEvent::OrderDelivered { .. } => "OrderDelivered",
            OrderEvent::OrderRefunded { .. } => "OrderRefunded",
            OrderEvent::OrderClosed { .. } => "OrderClosed",
        }
    }
}

/// The rule an order command broke, one per row of the doc's "Rejected when" column and the
/// invariants under it. [`OrderError::rule`] names it for the 422 problem; the note's error
/// carries only the matched class, never the text.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OrderError {
    #[error("an order needs at least one line")]
    NoLines,
    #[error("an order holds at most {max} lines")]
    TooManyLines { max: usize },
    #[error("{variant}: a quantity is 1 to {max}")]
    QtyOutOfRange { variant: String, max: u16 },
    #[error("{variant} is not in menu version {version}")]
    NotOnMenu { variant: String, version: u32 },
    #[error("{item} is paused")]
    ItemPaused { item: String },
    #[error("{item} is not baked on the slot's day")]
    NotBakedThatDay { item: String },
    #[error("{item} is out of season on the slot's day")]
    OutOfSeason { item: String },
    #[error("{item} is pickup only")]
    PickupOnly { item: String },
    #[error("a delivery needs a zone")]
    ZoneRequired,
    #[error("a pickup has no zone")]
    ZoneOnPickup,
    /// `item` is the slug of the line that needs the longest lead, `name` its menu name, and
    /// `away_minutes` how far the slot is from now (negative once it has passed).
    #[error("{}", lead_time_text(.name, *.needed_minutes, *.away_minutes))]
    LeadTimeNotMet {
        item: String,
        name: String,
        needed_minutes: u32,
        away_minutes: i64,
    },
    #[error("the note was refused: {}", .0.slug())]
    Note(FreeTextError),
    #[error("the order is already placed")]
    AlreadyPlaced,
    #[error("no order has been placed")]
    NotPlaced,
    #[error("a payment is positive cents")]
    PaymentNotPositive,
    #[error("the payment is {paid:?} cents and the order's total {total:?}")]
    AmountMismatch { paid: Cents, total: Cents },
    #[error("the order is already paid by another payment")]
    SecondPayment,
    #[error("the order is already paid")]
    AlreadyPaid,
    #[error("the order is not due to expire yet")]
    NotDue,
    #[error("the order is in production or later")]
    CancelTooLate,
    #[error("a delivery order is not picked up")]
    NotAPickup,
    #[error("a pickup order is not delivered")]
    NotADelivery,
    #[error("a refund is positive cents")]
    RefundNotPositive,
    #[error("at most {available:?} cents can still be refunded")]
    RefundExceedsPaid { available: Cents },
    #[error("no refund of that amount was requested")]
    UnknownRefund,
    #[error("the order is not picked up or delivered")]
    NotFulfilled,
    #[error("{command} does not apply to an order that is {status:?}")]
    OutOfOrder {
        command: &'static str,
        status: OrderStatus,
    },
    #[error("amount out of range")]
    Overflow,
}

/// "Chocolate layer cake needs 48 h; the slot is 22 h away": whole hours as hours, anything
/// else as hours and minutes, so the 409's detail names the rule as the menu states it.
fn lead_time_text(name: &str, needed_minutes: u32, away_minutes: i64) -> String {
    let away = if away_minutes < 0 {
        "the slot has passed".to_owned()
    } else {
        format!("the slot is {} away", duration_text(away_minutes))
    };
    format!(
        "{name} needs {}; {away}",
        duration_text(i64::from(needed_minutes))
    )
}

fn duration_text(minutes: i64) -> String {
    match (minutes / 60, minutes % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

impl OrderError {
    /// The slug a problem document names the rule by.
    pub fn rule(&self) -> &'static str {
        match self {
            OrderError::NoLines => "no-lines",
            OrderError::TooManyLines { .. } => "too-many-lines",
            OrderError::QtyOutOfRange { .. } => "qty-out-of-range",
            OrderError::NotOnMenu { .. } => "not-on-menu",
            OrderError::ItemPaused { .. } => "item-paused",
            OrderError::NotBakedThatDay { .. } => "not-baked-that-day",
            OrderError::OutOfSeason { .. } => "out-of-season",
            OrderError::PickupOnly { .. } => "pickup-only",
            OrderError::ZoneRequired => "zone-required",
            OrderError::ZoneOnPickup => "zone-on-pickup",
            OrderError::LeadTimeNotMet { .. } => "lead-time",
            OrderError::Note(_) => "note",
            OrderError::AlreadyPlaced => "already-placed",
            OrderError::NotPlaced => "not-placed",
            OrderError::PaymentNotPositive => "payment-not-positive",
            OrderError::AmountMismatch { .. } => "amount-mismatch",
            OrderError::SecondPayment => "second-payment",
            OrderError::AlreadyPaid => "already-paid",
            OrderError::NotDue => "not-due",
            OrderError::CancelTooLate => "cancel-too-late",
            OrderError::NotAPickup => "not-a-pickup",
            OrderError::NotADelivery => "not-a-delivery",
            OrderError::RefundNotPositive => "refund-not-positive",
            OrderError::RefundExceedsPaid { .. } => "refund-exceeds-paid",
            OrderError::UnknownRefund => "unknown-refund",
            OrderError::NotFulfilled => "not-fulfilled",
            OrderError::OutOfOrder { .. } => "out-of-order",
            OrderError::Overflow => "overflow",
        }
    }
}

impl From<DomainError> for OrderError {
    fn from(_: DomainError) -> OrderError {
        OrderError::Overflow
    }
}

/// The one payment that counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Payment {
    pub id: Ulid,
    pub amount: Cents,
}

/// A placed order: what `OrderPlaced` fixed, and what has happened since.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderRecord {
    pub id: Ulid,
    pub customer: Ulid,
    pub kind: OrderKind,
    pub slot: BusinessTime,
    pub zone: Option<String>,
    pub lines: Vec<Line>,
    pub subtotal_cents: Cents,
    pub tax_cents: Cents,
    pub total_cents: Cents,
    pub note: Option<String>,
    pub menu_version: u32,
    pub held_until: BusinessTime,
    pub status: OrderStatus,
    pub payment: Option<Payment>,
    /// Requested refunds, issued or not; never more than paid.
    pub refund_requested: Cents,
    /// Refunds issued; never more than requested.
    pub refunded: Cents,
    pub refunds: Vec<Ulid>,
    pub route: Option<(String, u16)>,
}

impl OrderRecord {
    fn paid(&self) -> Cents {
        self.payment.map_or(Cents::ZERO, |p| p.amount)
    }
}

/// An order's state: nothing before `OrderPlaced`, then its record.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderState {
    record: Option<OrderRecord>,
}

impl OrderState {
    pub fn record(&self) -> Option<&OrderRecord> {
        self.record.as_ref()
    }

    pub fn status(&self) -> Option<OrderStatus> {
        self.record.as_ref().map(|r| r.status)
    }
}

/// The aggregate hosted by `Order`.
pub struct Order;

impl Aggregate for Order {
    type State = OrderState;
    type Command = OrderCommand;
    type Event = OrderEvent;
    type Error = OrderError;

    fn decide(
        state: &OrderState,
        cmd: &OrderCommand,
        ctx: &DecideContext,
    ) -> Result<Vec<OrderEvent>, OrderError> {
        let OrderCommand::PlaceOrder(place) = cmd else {
            let record = state.record.as_ref().ok_or(OrderError::NotPlaced)?;
            return decide_placed(record, cmd, ctx);
        };
        if state.record.is_some() {
            return Err(OrderError::AlreadyPlaced);
        }
        place_order(place, ctx).map(|e| vec![e])
    }

    fn evolve(mut state: OrderState, event: &OrderEvent) -> OrderState {
        if let OrderEvent::OrderPlaced {
            order,
            customer,
            kind,
            slot,
            zone,
            lines,
            subtotal_cents,
            tax_cents,
            total_cents,
            note,
            menu_version,
            held_until,
        } = event
        {
            if state.record.is_none() {
                state.record = Some(OrderRecord {
                    id: *order,
                    customer: *customer,
                    kind: *kind,
                    slot: *slot,
                    zone: zone.clone(),
                    lines: lines.clone(),
                    subtotal_cents: *subtotal_cents,
                    tax_cents: *tax_cents,
                    total_cents: *total_cents,
                    note: note.clone(),
                    menu_version: *menu_version,
                    held_until: *held_until,
                    status: OrderStatus::Placed,
                    payment: None,
                    refund_requested: Cents::ZERO,
                    refunded: Cents::ZERO,
                    refunds: Vec::new(),
                    route: None,
                });
            }
            return state;
        }
        let Some(r) = state.record.as_mut() else {
            return state;
        };
        match event {
            OrderEvent::OrderPlaced { .. } => {}
            OrderEvent::OrderPaid {
                payment,
                amount_cents,
            } => {
                r.payment = Some(Payment {
                    id: *payment,
                    amount: *amount_cents,
                });
                r.status = OrderStatus::Confirmed;
            }
            OrderEvent::OrderPaymentLate {
                payment,
                amount_cents,
            } => {
                r.payment = Some(Payment {
                    id: *payment,
                    amount: *amount_cents,
                });
                r.status = OrderStatus::RefundPending;
            }
            OrderEvent::OrderRefundRequested { amount_cents, .. } => {
                r.refund_requested = r
                    .refund_requested
                    .checked_add(*amount_cents)
                    .unwrap_or(r.refund_requested);
            }
            OrderEvent::OrderExpired { .. } => r.status = OrderStatus::Expired,
            OrderEvent::OrderCancelled { .. } => {
                // Paid: the money goes back before the order is cancelled.
                r.status = if r.payment.is_some() {
                    OrderStatus::RefundPending
                } else {
                    OrderStatus::Cancelled
                };
            }
            OrderEvent::OrderProductionStarted {} => r.status = OrderStatus::InProduction,
            OrderEvent::OrderReady {} => r.status = OrderStatus::Ready,
            OrderEvent::OrderOutForDelivery { route, stop } => {
                r.route = Some((route.clone(), *stop));
                r.status = OrderStatus::OutForDelivery;
            }
            OrderEvent::OrderPickedUp { .. } => r.status = OrderStatus::PickedUp,
            OrderEvent::OrderDelivered { .. } => r.status = OrderStatus::Delivered,
            OrderEvent::OrderRefunded {
                refund,
                amount_cents,
                ..
            } => {
                r.refunded = r.refunded.checked_add(*amount_cents).unwrap_or(r.refunded);
                r.refunds.push(*refund);
                if r.status == OrderStatus::RefundPending && r.refunded >= r.paid() {
                    r.status = OrderStatus::Cancelled;
                }
            }
            OrderEvent::OrderClosed { .. } => r.status = OrderStatus::Closed,
        }
        state
    }
}

fn place_order(p: &PlaceOrder, ctx: &DecideContext) -> Result<OrderEvent, OrderError> {
    if p.lines.is_empty() {
        return Err(OrderError::NoLines);
    }
    if p.lines.len() > MAX_LINES {
        return Err(OrderError::TooManyLines { max: MAX_LINES });
    }
    match (p.kind, &p.zone) {
        (OrderKind::Delivery, None) => return Err(OrderError::ZoneRequired),
        (OrderKind::Delivery, Some(z)) if z.is_empty() => return Err(OrderError::ZoneRequired),
        (OrderKind::Pickup, Some(_)) => return Err(OrderError::ZoneOnPickup),
        _ => {}
    }
    let mut lines = Vec::with_capacity(p.lines.len());
    // Quantity per variant, for the bulk rule: more than 4 of one loaf is one rule however the
    // lines split it.
    let mut per_variant: BTreeMap<&str, u32> = BTreeMap::new();
    let mut needed_minutes = 0u32;
    // The first line that needs the longest lead, named in the refusal.
    let mut needed_by: Option<(String, String)> = None;
    for input in &p.lines {
        if !(1..=MAX_QTY).contains(&input.qty) {
            return Err(OrderError::QtyOutOfRange {
                variant: input.variant.clone(),
                max: MAX_QTY,
            });
        }
        let (item, variant) =
            p.menu
                .variant(&input.variant)
                .ok_or_else(|| OrderError::NotOnMenu {
                    variant: input.variant.clone(),
                    version: p.menu.version,
                })?;
        let named = || item.slug.clone();
        if item.status == ItemStatus::Paused {
            return Err(OrderError::ItemPaused { item: named() });
        }
        if item.pickup_only && p.kind == OrderKind::Delivery {
            return Err(OrderError::PickupOnly { item: named() });
        }
        if !item.baked_on(p.slot) {
            return Err(OrderError::NotBakedThatDay { item: named() });
        }
        if !item.in_season_on(p.slot) {
            return Err(OrderError::OutOfSeason { item: named() });
        }
        let qty = per_variant.entry(variant.slug.as_str()).or_default();
        *qty += u32::from(input.qty);
        let bulk = match item.bulk_lead {
            Some(b) if *qty > b.over_qty => b.lead_minutes,
            _ => 0,
        };
        let line_needs = variant.lead_minutes.max(bulk);
        if line_needs > needed_minutes || needed_by.is_none() {
            needed_minutes = needed_minutes.max(line_needs);
            needed_by = Some((item.slug.clone(), item.name.clone()));
        }
        lines.push(Line {
            item: item.slug.clone(),
            variant: variant.slug.clone(),
            qty: input.qty,
            unit_cents: variant.price_cents,
        });
    }
    // The slot's start is at least the longest lead time after placement, in business time.
    let ahead_ms = i128::from(p.slot.unix_ms()) - i128::from(ctx.now.unix_ms());
    if ahead_ms < i128::from(needed_minutes) * 60_000 {
        let (item, name) = needed_by.unwrap_or_default();
        return Err(OrderError::LeadTimeNotMet {
            item,
            name,
            needed_minutes,
            // Whole minutes, rounded down; a slot seconds away reads as 0 min.
            away_minutes: i64::try_from(ahead_ms.div_euclid(60_000)).unwrap_or(i64::MIN),
        });
    }
    let note = match &p.note {
        None => None,
        Some(text) => {
            let checked = check_note(text).map_err(OrderError::Note)?;
            (!checked.trim().is_empty()).then_some(checked)
        }
    };
    let mut subtotal = Cents::ZERO;
    for line in &lines {
        let amount = line
            .unit_cents
            .0
            .checked_mul(i64::from(line.qty))
            .ok_or(OrderError::Overflow)?;
        subtotal = subtotal.checked_add(Cents(amount))?;
    }
    // Tax once, on the subtotal, half-up (docs/domain.md, "Money and time").
    let tax = subtotal.apply_bp(p.tax_bp)?;
    let total = subtotal.checked_add(tax)?;
    Ok(OrderEvent::OrderPlaced {
        order: p.order,
        customer: p.customer,
        kind: p.kind,
        slot: p.slot,
        zone: p.zone.clone(),
        lines,
        subtotal_cents: subtotal,
        tax_cents: tax,
        total_cents: total,
        note,
        menu_version: p.menu.version,
        held_until: ctx.now.plus_minutes(EXPIRY_MINUTES)?,
    })
}

fn decide_placed(
    r: &OrderRecord,
    cmd: &OrderCommand,
    ctx: &DecideContext,
) -> Result<Vec<OrderEvent>, OrderError> {
    use OrderStatus as S;
    let out_of_order = || OrderError::OutOfOrder {
        command: cmd.name(),
        status: r.status,
    };
    let none = Ok(Vec::new());
    match cmd {
        OrderCommand::PlaceOrder(_) => Err(OrderError::AlreadyPlaced),
        OrderCommand::CancelOrder { by } => match r.status {
            S::Placed => Ok(vec![OrderEvent::OrderCancelled { by: *by }]),
            S::Confirmed => {
                let payment = r.payment.ok_or_else(out_of_order)?;
                Ok(vec![
                    OrderEvent::OrderCancelled { by: *by },
                    OrderEvent::OrderRefundRequested {
                        payment: payment.id,
                        amount_cents: payment.amount.checked_sub(r.refund_requested)?,
                        reason: RefundReason::Cancelled,
                    },
                ])
            }
            S::Cancelled => none,
            S::InProduction
            | S::Ready
            | S::PickedUp
            | S::OutForDelivery
            | S::Delivered
            | S::Closed => Err(OrderError::CancelTooLate),
            S::Expired | S::RefundPending => Err(out_of_order()),
        },
        OrderCommand::RecordPayment { payment, amount } => {
            if *amount <= Cents::ZERO {
                return Err(OrderError::PaymentNotPositive);
            }
            if *amount != r.total_cents {
                return Err(OrderError::AmountMismatch {
                    paid: *amount,
                    total: r.total_cents,
                });
            }
            if let Some(p) = r.payment {
                return if p.id == *payment {
                    none
                } else {
                    Err(OrderError::SecondPayment)
                };
            }
            match r.status {
                S::Placed => Ok(vec![OrderEvent::OrderPaid {
                    payment: *payment,
                    amount_cents: *amount,
                }]),
                // The compensating step: the money goes straight back.
                S::Expired | S::Cancelled => Ok(vec![
                    OrderEvent::OrderPaymentLate {
                        payment: *payment,
                        amount_cents: *amount,
                    },
                    OrderEvent::OrderRefundRequested {
                        payment: *payment,
                        amount_cents: *amount,
                        reason: RefundReason::PaymentLate,
                    },
                ]),
                _ => Err(out_of_order()),
            }
        }
        OrderCommand::Expire => {
            if r.payment.is_some() {
                return Err(OrderError::AlreadyPaid);
            }
            match r.status {
                S::Placed if ctx.now < r.held_until => Err(OrderError::NotDue),
                S::Placed => Ok(vec![OrderEvent::OrderExpired {
                    held_until: r.held_until,
                }]),
                S::Expired | S::Cancelled => none,
                _ => Err(out_of_order()),
            }
        }
        OrderCommand::StartProduction => match r.status {
            S::Confirmed => Ok(vec![OrderEvent::OrderProductionStarted {}]),
            S::InProduction => none,
            _ => Err(out_of_order()),
        },
        OrderCommand::MarkReady => match r.status {
            S::InProduction => Ok(vec![OrderEvent::OrderReady {}]),
            S::Ready => none,
            _ => Err(out_of_order()),
        },
        OrderCommand::MarkPickedUp => {
            if r.kind != OrderKind::Pickup {
                return Err(OrderError::NotAPickup);
            }
            match r.status {
                S::Ready => Ok(vec![OrderEvent::OrderPickedUp { at_stop: None }]),
                S::PickedUp => none,
                _ => Err(out_of_order()),
            }
        }
        OrderCommand::MarkOutForDelivery { route, stop } => {
            if r.kind != OrderKind::Delivery {
                return Err(OrderError::NotADelivery);
            }
            match r.status {
                S::Ready => Ok(vec![OrderEvent::OrderOutForDelivery {
                    route: route.clone(),
                    stop: *stop,
                }]),
                S::OutForDelivery if r.route.as_ref() == Some(&(route.clone(), *stop)) => none,
                _ => Err(out_of_order()),
            }
        }
        OrderCommand::MarkDelivered { stop } => {
            if r.kind != OrderKind::Delivery {
                return Err(OrderError::NotADelivery);
            }
            match r.status {
                S::OutForDelivery => Ok(vec![OrderEvent::OrderDelivered {
                    at_stop: Some(*stop),
                }]),
                S::Delivered => none,
                _ => Err(out_of_order()),
            }
        }
        OrderCommand::RefundOrder { amount, reason } => {
            match r.status {
                S::Confirmed
                | S::InProduction
                | S::Ready
                | S::PickedUp
                | S::Delivered
                | S::Closed => {}
                // Unpaid, ending, already being refunded, or in a van.
                S::Placed | S::Expired | S::Cancelled | S::RefundPending | S::OutForDelivery => {
                    return Err(out_of_order());
                }
            }
            let payment = r.payment.ok_or_else(out_of_order)?;
            if *amount <= Cents::ZERO {
                return Err(OrderError::RefundNotPositive);
            }
            let available = payment.amount.checked_sub(r.refund_requested)?;
            if *amount > available {
                return Err(OrderError::RefundExceedsPaid { available });
            }
            let requested = OrderEvent::OrderRefundRequested {
                payment: payment.id,
                amount_cents: *amount,
                reason: *reason,
            };
            // All that is left, before the day ends: the order is cancelled by staff.
            if *amount == available && r.status != S::Closed {
                return Ok(vec![
                    OrderEvent::OrderCancelled {
                        by: CancelledBy::Staff,
                    },
                    requested,
                ]);
            }
            Ok(vec![requested])
        }
        OrderCommand::RecordRefund { refund, amount } => {
            if r.refunds.contains(refund) {
                return none;
            }
            let outstanding = r.refund_requested.checked_sub(r.refunded)?;
            if *amount <= Cents::ZERO || *amount > outstanding {
                return Err(OrderError::UnknownRefund);
            }
            let refunded = r.refunded.checked_add(*amount)?;
            Ok(vec![OrderEvent::OrderRefunded {
                refund: *refund,
                amount_cents: *amount,
                full: refunded == r.paid(),
            }])
        }
        OrderCommand::Close => match r.status {
            S::PickedUp | S::Delivered => Ok(vec![OrderEvent::OrderClosed {
                total_cents: r.total_cents,
                refunded_cents: r.refunded,
                lines: None,
                customer: None,
                kind: None,
                slot: None,
                zone: None,
            }]),
            S::Closed => none,
            _ => Err(OrderError::NotFulfilled),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aggregate::{execute, replay};
    use crate::catalog::tests::fixture;
    use crate::free_text::FreeTextClass;
    use OrderStatus as S;
    use proptest::prelude::*;

    /// Every edge of the diagram in docs/domain.md, "Order", plus the ones this module adds:
    /// `cancelled --> refund_pending` (a payment after a cancellation), the self-loop of a
    /// partial refund issued while a refund is pending, a staff refund's self-loop in each paid
    /// state it is taken in (a partial refund requested, or any refund issued, leaves the state
    /// as it is; `out_for_delivery` only sees one issued), and a full staff refund's cancellation
    /// from `in_production`, `ready`, `picked_up` and `delivered` (from `confirmed` the diagram
    /// draws it already). `None` is `[*]`.
    const TRANSITIONS: &[(Option<OrderStatus>, OrderStatus)] = &[
        (None, S::Placed),
        (Some(S::Placed), S::Confirmed),
        (Some(S::Placed), S::Expired),
        (Some(S::Placed), S::Cancelled),
        (Some(S::Expired), S::RefundPending),
        (Some(S::Confirmed), S::RefundPending),
        (Some(S::Confirmed), S::InProduction),
        (Some(S::InProduction), S::Ready),
        (Some(S::Ready), S::PickedUp),
        (Some(S::Ready), S::OutForDelivery),
        (Some(S::OutForDelivery), S::Delivered),
        (Some(S::PickedUp), S::Closed),
        (Some(S::Delivered), S::Closed),
        (Some(S::RefundPending), S::Cancelled),
        (Some(S::Closed), S::Closed),
        (Some(S::Cancelled), S::RefundPending),
        (Some(S::RefundPending), S::RefundPending),
        (Some(S::Confirmed), S::Confirmed),
        (Some(S::InProduction), S::InProduction),
        (Some(S::Ready), S::Ready),
        (Some(S::OutForDelivery), S::OutForDelivery),
        (Some(S::PickedUp), S::PickedUp),
        (Some(S::Delivered), S::Delivered),
        (Some(S::InProduction), S::RefundPending),
        (Some(S::Ready), S::RefundPending),
        (Some(S::PickedUp), S::RefundPending),
        (Some(S::Delivered), S::RefundPending),
    ];

    fn at(text: &str) -> BusinessTime {
        text.parse().unwrap()
    }

    fn id(n: u128) -> Ulid {
        Ulid::from_parts(1_793_000_000_000, n)
    }

    // Tuesday morning, four days before a Saturday slot.
    const NOW: &str = "2026-11-03T08:00:00-07:00";
    const SLOT: &str = "2026-11-07T10:00:00-07:00";

    fn ctx_at(now: &str) -> DecideContext {
        DecideContext {
            now: at(now),
            id: id(99),
        }
    }

    fn place(kind: OrderKind, lines: &[(&str, u16)]) -> PlaceOrder {
        PlaceOrder {
            order: id(1),
            customer: id(2),
            kind,
            slot: at(SLOT),
            zone: (kind == OrderKind::Delivery).then(|| "z2".to_owned()),
            lines: lines
                .iter()
                .map(|&(variant, qty)| LineInput {
                    variant: variant.to_owned(),
                    qty,
                })
                .collect(),
            note: Some("Two candles, no message".into()),
            menu: fixture().menu_view(),
            tax_bp: DEFAULT_TAX_BP,
        }
    }

    #[test]
    fn an_order_pays_the_rate_it_was_placed_with() {
        let (cmd, now) = (
            {
                let mut p = place(OrderKind::Pickup, &[("fern-loaf/whole", 2)]);
                p.tax_bp = 850;
                placed_cmd(p)
            },
            NOW,
        );
        let state = step(OrderState::default(), cmd, now).unwrap();
        let text = serde_json::to_value(&state).unwrap().to_string();
        // 2 x 950 = 1,900 cents; 8.50% of it is 161.5, rounded half-up to 162.
        assert!(text.contains("\"subtotal_cents\":1900"), "{text}");
        assert!(text.contains("\"tax_cents\":162"), "{text}");
        assert!(text.contains("\"total_cents\":2062"), "{text}");
    }

    fn placed_cmd(p: PlaceOrder) -> OrderCommand {
        OrderCommand::PlaceOrder(Box::new(p))
    }

    fn step(state: OrderState, cmd: OrderCommand, now: &str) -> Result<OrderState, OrderError> {
        execute::<Order>(state, &cmd, &ctx_at(now)).map(|(s, _)| s)
    }

    fn placed(kind: OrderKind) -> OrderState {
        step(
            OrderState::default(),
            placed_cmd(place(kind, &[("fern-loaf/whole", 2)])),
            NOW,
        )
        .unwrap()
    }

    fn paid(kind: OrderKind) -> OrderState {
        step(
            placed(kind),
            OrderCommand::RecordPayment {
                payment: id(10),
                amount: Cents(2_090),
            },
            NOW,
        )
        .unwrap()
    }

    fn place_err(p: PlaceOrder) -> OrderError {
        Order::decide(&OrderState::default(), &placed_cmd(p), &ctx_at(NOW)).unwrap_err()
    }

    #[test]
    fn placing_prices_from_the_menu_and_taxes_the_subtotal() {
        let (state, events) = execute::<Order>(
            OrderState::default(),
            &placed_cmd(place(
                OrderKind::Pickup,
                &[
                    ("fern-loaf/whole", 1),
                    ("thyme-cake/slice", 1),
                    ("moss-tea/small", 1),
                ],
            )),
            &ctx_at(NOW),
        )
        .unwrap();
        // 950 + 650 + 300 = 1,900; 10.00% is 190, so the total is 2,090.
        let OrderEvent::OrderPlaced {
            subtotal_cents,
            tax_cents,
            total_cents,
            menu_version,
            held_until,
            lines,
            note,
            ..
        } = &events[0]
        else {
            panic!("{events:?}");
        };
        assert_eq!(
            (*subtotal_cents, *tax_cents, *total_cents),
            (Cents(1_900), Cents(190), Cents(2_090))
        );
        assert_eq!(*menu_version, 1);
        assert_eq!(held_until.to_string(), "2026-11-03T08:15:00-07:00");
        assert_eq!(lines[1].item, "thyme-cake");
        assert_eq!(lines[1].unit_cents, Cents(650));
        assert_eq!(note.as_deref(), Some("Two candles, no message"));
        assert_eq!(state.status(), Some(S::Placed));
    }

    #[test]
    fn placing_refuses_by_rule() {
        let p = |lines: &[(&str, u16)]| place(OrderKind::Pickup, lines);
        assert_eq!(place_err(p(&[])), OrderError::NoLines);
        let many: Vec<(&str, u16)> = (0..21).map(|_| ("moss-tea/small", 1)).collect();
        assert_eq!(place_err(p(&many)).rule(), "too-many-lines");
        assert_eq!(
            place_err(p(&[("moss-tea/small", 0)])).rule(),
            "qty-out-of-range"
        );
        assert_eq!(
            place_err(p(&[("moss-tea/small", 25)])).rule(),
            "qty-out-of-range"
        );
        assert_eq!(
            place_err(p(&[("thyme-cake/9-inch", 1)])),
            OrderError::NotOnMenu {
                variant: "thyme-cake/9-inch".into(),
                version: 1
            }
        );
        assert_eq!(
            place_err(place(OrderKind::Delivery, &[("moss-tea/small", 1)])).rule(),
            "pickup-only"
        );
        let mut no_zone = place(OrderKind::Delivery, &[("fern-loaf/half", 1)]);
        no_zone.zone = None;
        assert_eq!(place_err(no_zone), OrderError::ZoneRequired);
        let mut zoned = p(&[("fern-loaf/half", 1)]);
        zoned.zone = Some("z1".into());
        assert_eq!(place_err(zoned), OrderError::ZoneOnPickup);
        let mut phone = p(&[("fern-loaf/half", 1)]);
        phone.note = Some("call 555 0100".into());
        assert_eq!(
            place_err(phone),
            OrderError::Note(FreeTextError::Class(FreeTextClass::Phone))
        );
        let mut long = p(&[("fern-loaf/half", 1)]);
        long.note = Some("a".repeat(141));
        assert_eq!(
            place_err(long),
            OrderError::Note(FreeTextError::TooLong { max: 140 })
        );
        // The cake is baked Wednesday, Saturday and Sunday; a Friday slot refuses it.
        let mut friday = p(&[("thyme-cake/6-inch", 1)]);
        friday.slot = at("2026-11-06T10:00:00-07:00");
        assert_eq!(place_err(friday).rule(), "not-baked-that-day");
        // The knot's season is 10-15 to 03-15.
        let mut summer = p(&[("sorrel-knot/single", 1)]);
        summer.slot = at("2027-06-05T10:00:00-06:00");
        assert_eq!(place_err(summer).rule(), "out-of-season");
    }

    #[test]
    fn the_lead_time_is_the_longest_line_and_counts_the_bulk_rule() {
        // A 6-inch cake needs 48 h: a slot 47 h 59 min away is refused, 48 h is not.
        let mut cake = place(
            OrderKind::Pickup,
            &[("thyme-cake/6-inch", 1), ("moss-tea/small", 1)],
        );
        cake.slot = at("2026-11-07T07:59:00-07:00");
        let ctx = ctx_at("2026-11-05T08:00:00-07:00");
        assert_eq!(
            Order::decide(&OrderState::default(), &placed_cmd(cake.clone()), &ctx),
            Err(OrderError::LeadTimeNotMet {
                item: "thyme-cake".into(),
                name: "Thyme cake".into(),
                needed_minutes: 2_880,
                away_minutes: 2_879,
            })
        );
        let refused =
            Order::decide(&OrderState::default(), &placed_cmd(cake.clone()), &ctx).unwrap_err();
        assert_eq!(refused.rule(), "lead-time");
        assert_eq!(
            refused.to_string(),
            "Thyme cake needs 48 h; the slot is 47 h 59 min away"
        );
        cake.slot = at("2026-11-07T08:00:00-07:00");
        assert!(Order::decide(&OrderState::default(), &placed_cmd(cake), &ctx).is_ok());
        // Five of one loaf, split over two lines, need 12 h; four need 2 h.
        let mut loaves = place(
            OrderKind::Pickup,
            &[("fern-loaf/whole", 3), ("fern-loaf/whole", 2)],
        );
        loaves.slot = at("2026-11-07T10:00:00-07:00");
        let six_hours_before = ctx_at("2026-11-07T04:00:00-07:00");
        assert_eq!(
            Order::decide(
                &OrderState::default(),
                &placed_cmd(loaves.clone()),
                &six_hours_before
            ),
            Err(OrderError::LeadTimeNotMet {
                item: "fern-loaf".into(),
                name: "Fern loaf".into(),
                needed_minutes: 720,
                away_minutes: 360,
            })
        );
        assert_eq!(
            Order::decide(
                &OrderState::default(),
                &placed_cmd(loaves.clone()),
                &six_hours_before
            )
            .unwrap_err()
            .to_string(),
            "Fern loaf needs 12 h; the slot is 6 h away"
        );
        loaves.lines[1].qty = 1;
        assert!(
            Order::decide(
                &OrderState::default(),
                &placed_cmd(loaves),
                &six_hours_before
            )
            .is_ok()
        );
        // A drink needs no lead, but the slot cannot be in the past.
        let mut late = place(OrderKind::Pickup, &[("moss-tea/small", 1)]);
        late.slot = at("2026-11-03T07:59:59-07:00");
        let e = place_err(late);
        assert_eq!(e.rule(), "lead-time");
        assert_eq!(e.to_string(), "Moss tea needs 0 min; the slot has passed");
        // A lead that is not whole hours reads in hours and minutes.
        assert_eq!(
            lead_time_text("Scone", 90, 45),
            "Scone needs 1 h 30 min; the slot is 45 min away"
        );
    }

    #[test]
    fn a_paused_item_cannot_be_ordered() {
        let (catalog, _) = execute::<crate::catalog::Catalog>(
            fixture(),
            &crate::catalog::CatalogCommand::Pause {
                item: "fern-loaf".into(),
            },
            &ctx_at(NOW),
        )
        .unwrap();
        let mut p = place(OrderKind::Pickup, &[("fern-loaf/whole", 1)]);
        p.menu = catalog.menu_view();
        assert_eq!(place_err(p).rule(), "item-paused");
    }

    #[test]
    fn a_pickup_from_placed_to_closed() {
        let mut state = paid(OrderKind::Pickup);
        assert_eq!(state.status(), Some(S::Confirmed));
        for (cmd, status) in [
            (OrderCommand::StartProduction, S::InProduction),
            (OrderCommand::MarkReady, S::Ready),
            (OrderCommand::MarkPickedUp, S::PickedUp),
            (OrderCommand::Close, S::Closed),
        ] {
            state = step(state, cmd, SLOT).unwrap();
            assert_eq!(state.status(), Some(status));
        }
        // A partial refund after the day ends, then no more than what is left.
        let state = step(
            state,
            OrderCommand::RefundOrder {
                amount: Cents(500),
                reason: RefundReason::MissingItem,
            },
            SLOT,
        )
        .unwrap();
        assert_eq!(
            Order::decide(
                &state,
                &OrderCommand::RefundOrder {
                    amount: Cents(1_591),
                    reason: RefundReason::Goodwill
                },
                &ctx_at(SLOT)
            ),
            Err(OrderError::RefundExceedsPaid {
                available: Cents(1_590)
            })
        );
        let (state, events) = execute::<Order>(
            state,
            &OrderCommand::RecordRefund {
                refund: id(20),
                amount: Cents(500),
            },
            &ctx_at(SLOT),
        )
        .unwrap();
        assert_eq!(
            events,
            [OrderEvent::OrderRefunded {
                refund: id(20),
                amount_cents: Cents(500),
                full: false
            }]
        );
        assert_eq!(state.status(), Some(S::Closed));
        assert_eq!(
            Order::decide(
                &state,
                &OrderCommand::RecordRefund {
                    refund: id(21),
                    amount: Cents(1)
                },
                &ctx_at(SLOT)
            ),
            Err(OrderError::UnknownRefund)
        );
        // The same refund again is a no-op.
        assert_eq!(
            Order::decide(
                &state,
                &OrderCommand::RecordRefund {
                    refund: id(20),
                    amount: Cents(500)
                },
                &ctx_at(SLOT)
            ),
            Ok(vec![])
        );
    }

    #[test]
    fn a_delivery_goes_out_and_arrives() {
        let mut state = paid(OrderKind::Delivery);
        for cmd in [OrderCommand::StartProduction, OrderCommand::MarkReady] {
            state = step(state, cmd, SLOT).unwrap();
        }
        assert_eq!(
            Order::decide(&state, &OrderCommand::MarkPickedUp, &ctx_at(SLOT)),
            Err(OrderError::NotAPickup)
        );
        let out = OrderCommand::MarkOutForDelivery {
            route: "van-2".into(),
            stop: 7,
        };
        let state = step(state, out.clone(), SLOT).unwrap();
        assert_eq!(Order::decide(&state, &out, &ctx_at(SLOT)), Ok(vec![]));
        let (state, events) = execute::<Order>(
            state,
            &OrderCommand::MarkDelivered { stop: 7 },
            &ctx_at(SLOT),
        )
        .unwrap();
        assert_eq!(events, [OrderEvent::OrderDelivered { at_stop: Some(7) }]);
        let (state, events) = execute::<Order>(state, &OrderCommand::Close, &ctx_at(SLOT)).unwrap();
        assert_eq!(
            events,
            [OrderEvent::OrderClosed {
                total_cents: Cents(2_090),
                refunded_cents: Cents::ZERO,
                lines: None,
                customer: None,
                kind: None,
                slot: None,
                zone: None,
            }]
        );
        assert_eq!(
            Order::decide(&state, &OrderCommand::Close, &ctx_at(SLOT)),
            Ok(vec![])
        );
    }

    #[test]
    fn delivery_commands_refuse_a_pickup() {
        let state = paid(OrderKind::Pickup);
        for cmd in [
            OrderCommand::MarkOutForDelivery {
                route: "van-1".into(),
                stop: 1,
            },
            OrderCommand::MarkDelivered { stop: 1 },
        ] {
            assert_eq!(
                Order::decide(&state, &cmd, &ctx_at(SLOT)),
                Err(OrderError::NotADelivery)
            );
        }
    }

    #[test]
    fn an_unpaid_order_expires_after_fifteen_minutes() {
        let state = placed(OrderKind::Pickup);
        assert_eq!(
            Order::decide(
                &state,
                &OrderCommand::Expire,
                &ctx_at("2026-11-03T08:14:59-07:00")
            ),
            Err(OrderError::NotDue)
        );
        let state = step(state, OrderCommand::Expire, "2026-11-03T08:15:00-07:00").unwrap();
        assert_eq!(state.status(), Some(S::Expired));
        // The timer firing twice changes nothing.
        assert_eq!(
            Order::decide(&state, &OrderCommand::Expire, &ctx_at(SLOT)),
            Ok(vec![])
        );
        // Expiring a paid order is refused.
        assert_eq!(
            Order::decide(
                &paid(OrderKind::Pickup),
                &OrderCommand::Expire,
                &ctx_at(SLOT)
            ),
            Err(OrderError::AlreadyPaid)
        );
    }

    #[test]
    fn a_payment_after_expiry_is_late_and_refunded() {
        let state = step(placed(OrderKind::Pickup), OrderCommand::Expire, SLOT).unwrap();
        let (state, events) = execute::<Order>(
            state,
            &OrderCommand::RecordPayment {
                payment: id(10),
                amount: Cents(2_090),
            },
            &ctx_at(SLOT),
        )
        .unwrap();
        assert_eq!(
            events.iter().map(DomainEvent::name).collect::<Vec<_>>(),
            ["OrderPaymentLate", "OrderRefundRequested"]
        );
        assert_eq!(state.status(), Some(S::RefundPending));
        let state = step(
            state,
            OrderCommand::RecordRefund {
                refund: id(20),
                amount: Cents(2_090),
            },
            SLOT,
        )
        .unwrap();
        assert_eq!(state.status(), Some(S::Cancelled));
    }

    #[test]
    fn cancelling_a_paid_order_refunds_it_first() {
        let (state, events) = execute::<Order>(
            paid(OrderKind::Pickup),
            &OrderCommand::CancelOrder {
                by: CancelledBy::Staff,
            },
            &ctx_at(NOW),
        )
        .unwrap();
        assert_eq!(
            events,
            [
                OrderEvent::OrderCancelled {
                    by: CancelledBy::Staff
                },
                OrderEvent::OrderRefundRequested {
                    payment: id(10),
                    amount_cents: Cents(2_090),
                    reason: RefundReason::Cancelled
                }
            ]
        );
        assert_eq!(state.status(), Some(S::RefundPending));
        let (state, events) = execute::<Order>(
            state,
            &OrderCommand::RecordRefund {
                refund: id(20),
                amount: Cents(2_090),
            },
            &ctx_at(NOW),
        )
        .unwrap();
        assert!(matches!(
            events[0],
            OrderEvent::OrderRefunded { full: true, .. }
        ));
        assert_eq!(state.status(), Some(S::Cancelled));
    }

    #[test]
    fn cancelling_refuses_once_production_starts() {
        let state = step(paid(OrderKind::Pickup), OrderCommand::StartProduction, NOW).unwrap();
        assert_eq!(
            Order::decide(
                &state,
                &OrderCommand::CancelOrder {
                    by: CancelledBy::Customer
                },
                &ctx_at(NOW)
            ),
            Err(OrderError::CancelTooLate)
        );
        let unpaid = step(
            placed(OrderKind::Pickup),
            OrderCommand::CancelOrder {
                by: CancelledBy::Customer,
            },
            NOW,
        )
        .unwrap();
        assert_eq!(unpaid.status(), Some(S::Cancelled));
    }

    #[test]
    fn a_payment_for_another_amount_is_refused() {
        let state = placed(OrderKind::Pickup);
        assert_eq!(
            Order::decide(
                &state,
                &OrderCommand::RecordPayment {
                    payment: id(10),
                    amount: Cents(2_089)
                },
                &ctx_at(NOW)
            ),
            Err(OrderError::AmountMismatch {
                paid: Cents(2_089),
                total: Cents(2_090)
            })
        );
        assert_eq!(
            OrderError::AmountMismatch {
                paid: Cents(1),
                total: Cents(2)
            }
            .rule(),
            "amount-mismatch"
        );
    }

    fn refund(amount: i64) -> OrderCommand {
        OrderCommand::RefundOrder {
            amount: Cents(amount),
            reason: RefundReason::Quality,
        }
    }

    #[test]
    fn staff_refund_part_of_an_open_order_and_its_state_holds() {
        let states = [
            (vec![], S::Confirmed),
            (vec![OrderCommand::StartProduction], S::InProduction),
            (
                vec![OrderCommand::StartProduction, OrderCommand::MarkReady],
                S::Ready,
            ),
            (
                vec![
                    OrderCommand::StartProduction,
                    OrderCommand::MarkReady,
                    OrderCommand::MarkPickedUp,
                ],
                S::PickedUp,
            ),
        ];
        for (steps, status) in states {
            let mut state = paid(OrderKind::Pickup);
            for cmd in steps {
                state = step(state, cmd, SLOT).unwrap();
            }
            assert_eq!(state.status(), Some(status));
            let (state, events) = execute::<Order>(state, &refund(500), &ctx_at(SLOT)).unwrap();
            assert_eq!(
                events,
                [OrderEvent::OrderRefundRequested {
                    payment: id(10),
                    amount_cents: Cents(500),
                    reason: RefundReason::Quality
                }],
                "{status:?}"
            );
            assert_eq!(state.status(), Some(status));
            let (state, events) = execute::<Order>(
                state,
                &OrderCommand::RecordRefund {
                    refund: id(20),
                    amount: Cents(500),
                },
                &ctx_at(SLOT),
            )
            .unwrap();
            assert!(matches!(
                events.as_slice(),
                [OrderEvent::OrderRefunded { full: false, .. }]
            ));
            assert_eq!(state.status(), Some(status));
        }
    }

    #[test]
    fn a_full_staff_refund_before_close_cancels_the_order() {
        let state = step(paid(OrderKind::Pickup), OrderCommand::StartProduction, SLOT).unwrap();
        // A part first, then the rest: the rest is the full refund.
        let state = step(state, refund(90), SLOT).unwrap();
        let (state, events) = execute::<Order>(state, &refund(2_000), &ctx_at(SLOT)).unwrap();
        assert_eq!(
            events,
            [
                OrderEvent::OrderCancelled {
                    by: CancelledBy::Staff
                },
                OrderEvent::OrderRefundRequested {
                    payment: id(10),
                    amount_cents: Cents(2_000),
                    reason: RefundReason::Quality
                }
            ]
        );
        assert_eq!(state.status(), Some(S::RefundPending));
        // Nothing is left to refund, and a pending order takes no more.
        assert_eq!(
            Order::decide(&state, &refund(1), &ctx_at(SLOT)),
            Err(OrderError::OutOfOrder {
                command: "RefundOrder",
                status: S::RefundPending
            })
        );
        let state = step(
            state,
            OrderCommand::RecordRefund {
                refund: id(20),
                amount: Cents(90),
            },
            SLOT,
        )
        .unwrap();
        assert_eq!(state.status(), Some(S::RefundPending));
        let (state, events) = execute::<Order>(
            state,
            &OrderCommand::RecordRefund {
                refund: id(21),
                amount: Cents(2_000),
            },
            &ctx_at(SLOT),
        )
        .unwrap();
        assert!(matches!(
            events.as_slice(),
            [OrderEvent::OrderRefunded { full: true, .. }]
        ));
        assert_eq!(state.status(), Some(S::Cancelled));
    }

    #[test]
    fn a_full_refund_after_close_stays_closed() {
        let mut state = paid(OrderKind::Pickup);
        for cmd in [
            OrderCommand::StartProduction,
            OrderCommand::MarkReady,
            OrderCommand::MarkPickedUp,
            OrderCommand::Close,
        ] {
            state = step(state, cmd, SLOT).unwrap();
        }
        let (state, events) = execute::<Order>(state, &refund(2_090), &ctx_at(SLOT)).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(state.status(), Some(S::Closed));
        let state = step(
            state,
            OrderCommand::RecordRefund {
                refund: id(20),
                amount: Cents(2_090),
            },
            SLOT,
        )
        .unwrap();
        assert_eq!(state.status(), Some(S::Closed));
    }

    #[test]
    fn staff_cannot_refund_an_unpaid_or_moving_order() {
        assert_eq!(
            Order::decide(&placed(OrderKind::Pickup), &refund(100), &ctx_at(NOW)),
            Err(OrderError::OutOfOrder {
                command: "RefundOrder",
                status: S::Placed
            })
        );
        let mut state = paid(OrderKind::Delivery);
        for cmd in [
            OrderCommand::StartProduction,
            OrderCommand::MarkReady,
            OrderCommand::MarkOutForDelivery {
                route: "van-1".into(),
                stop: 1,
            },
        ] {
            state = step(state, cmd, SLOT).unwrap();
        }
        assert_eq!(
            Order::decide(&state, &refund(100), &ctx_at(SLOT)),
            Err(OrderError::OutOfOrder {
                command: "RefundOrder",
                status: S::OutForDelivery
            })
        );
        let state = step(state, OrderCommand::MarkDelivered { stop: 1 }, SLOT).unwrap();
        assert_eq!(
            Order::decide(&state, &refund(2_091), &ctx_at(SLOT)),
            Err(OrderError::RefundExceedsPaid {
                available: Cents(2_090)
            })
        );
        assert_eq!(
            Order::decide(&state, &refund(0), &ctx_at(SLOT)),
            Err(OrderError::RefundNotPositive)
        );
    }

    #[test]
    fn exactly_one_payment_counts() {
        let state = paid(OrderKind::Pickup);
        assert_eq!(
            Order::decide(
                &state,
                &OrderCommand::RecordPayment {
                    payment: id(10),
                    amount: Cents(2_090)
                },
                &ctx_at(NOW)
            ),
            Ok(vec![])
        );
        assert_eq!(
            Order::decide(
                &state,
                &OrderCommand::RecordPayment {
                    payment: id(11),
                    amount: Cents(2_090)
                },
                &ctx_at(NOW)
            ),
            Err(OrderError::SecondPayment)
        );
    }

    #[test]
    fn steps_out_of_order_are_refused() {
        let state = placed(OrderKind::Pickup);
        assert_eq!(
            Order::decide(&state, &OrderCommand::MarkReady, &ctx_at(NOW)),
            Err(OrderError::OutOfOrder {
                command: "MarkReady",
                status: S::Placed
            })
        );
        assert_eq!(
            Order::decide(&state, &OrderCommand::Close, &ctx_at(NOW)),
            Err(OrderError::NotFulfilled)
        );
        assert_eq!(
            Order::decide(
                &OrderState::default(),
                &OrderCommand::MarkReady,
                &ctx_at(NOW)
            ),
            Err(OrderError::NotPlaced)
        );
        assert_eq!(
            Order::decide(
                &state,
                &placed_cmd(place(OrderKind::Pickup, &[("moss-tea/small", 1)])),
                &ctx_at(NOW)
            ),
            Err(OrderError::AlreadyPlaced)
        );
    }

    // The property tests drive random command sequences from the fixture menu.

    fn variant() -> impl Strategy<Value = &'static str> {
        prop::sample::select(vec![
            "fern-loaf/whole",
            "fern-loaf/half",
            "sorrel-knot/single",
            "thyme-cake/6-inch",
            "thyme-cake/slice",
            "moss-tea/small",
            "nope/single",
        ])
    }

    fn place_strategy() -> impl Strategy<Value = OrderCommand> {
        (
            any::<bool>(),
            proptest::collection::vec((variant(), 0u16..30), 0..23),
            any::<bool>(),
        )
            .prop_map(|(delivery, lines, zoned)| {
                let kind = if delivery {
                    OrderKind::Delivery
                } else {
                    OrderKind::Pickup
                };
                let mut p = place(kind, &[]);
                p.lines = lines
                    .into_iter()
                    .map(|(v, qty)| LineInput {
                        variant: v.into(),
                        qty,
                    })
                    .collect();
                if !zoned {
                    p.zone = if delivery { None } else { Some("z1".into()) };
                }
                placed_cmd(p)
            })
    }

    /// A placement that passes every rule, so most sequences get past `placed`.
    fn valid_place() -> impl Strategy<Value = OrderCommand> {
        let sellable = prop::sample::select(vec![
            "fern-loaf/whole",
            "fern-loaf/half",
            "sorrel-knot/single",
            "thyme-cake/6-inch",
            "thyme-cake/slice",
        ]);
        (
            any::<bool>(),
            proptest::collection::vec((sellable, 1u16..=4), 1..=MAX_LINES),
        )
            .prop_map(|(delivery, lines)| {
                let kind = if delivery {
                    OrderKind::Delivery
                } else {
                    OrderKind::Pickup
                };
                let lines: Vec<(&str, u16)> = lines;
                placed_cmd(place(kind, &lines))
            })
    }

    /// Stands for the placed order's total in a generated `RecordPayment`, which the loop swaps
    /// in, so most payments match and some do not.
    const TOTAL: Cents = Cents(-7_777);
    /// Stands for all that is left to refund in a generated `RefundOrder`: a full refund.
    const REST: Cents = Cents(-8_888);

    fn command() -> impl Strategy<Value = OrderCommand> {
        let ids = || prop::sample::select(vec![10u128, 11, 20, 21, 22]).prop_map(id);
        // A few amounts, so refunds often sum exactly to a payment.
        let amount = || prop::sample::select(vec![-1i64, 0, 500, 1_000, 2_000]).prop_map(Cents);
        let paying = || prop::sample::select(vec![TOTAL, TOTAL, TOTAL, Cents(0), Cents(500)]);
        prop_oneof![
            1 => place_strategy(),
            1 => prop::sample::select(vec![CancelledBy::Customer, CancelledBy::Staff])
                .prop_map(|by| OrderCommand::CancelOrder { by }),
            2 => (ids(), paying()).prop_map(|(payment, amount)| OrderCommand::RecordPayment { payment, amount }),
            1 => Just(OrderCommand::Expire),
            2 => Just(OrderCommand::StartProduction),
            2 => Just(OrderCommand::MarkReady),
            1 => Just(OrderCommand::MarkPickedUp),
            1 => (0u16..3).prop_map(|stop| OrderCommand::MarkOutForDelivery { route: "van-1".into(), stop }),
            1 => (0u16..3).prop_map(|stop| OrderCommand::MarkDelivered { stop }),
            2 => prop::sample::select(vec![Cents(-1), Cents(500), Cents(1_000), REST, REST])
                .prop_map(|amount| OrderCommand::RefundOrder { amount, reason: RefundReason::Goodwill }),
            2 => (ids(), amount()).prop_map(|(refund, amount)| OrderCommand::RecordRefund { refund, amount }),
            2 => Just(OrderCommand::Close),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        #[test]
        fn no_sequence_reaches_an_undefined_state(
            first in valid_place(),
            steps in proptest::collection::vec((0i64..30, command()), 1..40),
        ) {
            let steps: Vec<(i64, OrderCommand)> =
                std::iter::once((0, first)).chain(steps).collect();
            let mut state = OrderState::default();
            let mut log: Vec<OrderEvent> = Vec::new();
            let mut now = at(NOW);
            let mut placed_lines: Option<Vec<Line>> = None;
            for (minutes, cmd) in &steps {
                let total = state.record().map_or(Cents(1), |r| r.total_cents);
                let cmd = &match cmd {
                    OrderCommand::RecordPayment { payment, amount } if *amount == TOTAL => {
                        OrderCommand::RecordPayment { payment: *payment, amount: total }
                    }
                    OrderCommand::RefundOrder { amount, reason } if *amount == REST => {
                        let rest = state.record().map_or(Cents(1), |r| {
                            Cents(r.paid().0 - r.refund_requested.0)
                        });
                        OrderCommand::RefundOrder { amount: rest, reason: *reason }
                    }
                    other => other.clone(),
                };
                now = now.plus_minutes(*minutes).unwrap();
                let ctx = DecideContext { now, id: id(99) };
                let before = state.status();
                let Ok((next, events)) = execute::<Order>(state.clone(), cmd, &ctx) else {
                    continue;
                };
                let after = next.status();
                if !events.is_empty() {
                    let edge = (before, after.unwrap());
                    prop_assert!(TRANSITIONS.contains(&edge), "{edge:?} by {cmd:?}");
                } else {
                    prop_assert_eq!(before, after);
                }
                for e in &events {
                    // Every event round-trips through an envelope's type and data.
                    prop_assert_eq!(&OrderEvent::from_parts(e.name(), &e.to_data()).unwrap(), e);
                }
                log.extend(events);
                state = next;
                if let Some(r) = state.record() {
                    // Prices are copied at placement and never change after.
                    let lines = placed_lines.get_or_insert_with(|| r.lines.clone());
                    prop_assert_eq!(&r.lines, lines);
                    // total = subtotal + tax, tax once on the subtotal, half-up.
                    let subtotal: i64 = r.lines.iter().map(|l| l.unit_cents.0 * i64::from(l.qty)).sum();
                    prop_assert_eq!(r.subtotal_cents, Cents(subtotal));
                    prop_assert_eq!(r.tax_cents, r.subtotal_cents.apply_bp(DEFAULT_TAX_BP).unwrap());
                    prop_assert_eq!(r.total_cents, r.subtotal_cents.checked_add(r.tax_cents).unwrap());
                    prop_assert!((1..=MAX_LINES).contains(&r.lines.len()));
                    // Refunds sum to at most what was paid.
                    prop_assert!(r.refunded <= r.refund_requested);
                    prop_assert!(r.refund_requested <= r.paid());
                    prop_assert!(r.refunded >= Cents::ZERO);
                }
            }
            // The state is the fold of its log.
            prop_assert_eq!(replay::<Order>(&log), state);
        }
    }
}
