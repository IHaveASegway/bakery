//! The CateringEvent aggregate, hosted by `CateringEvent`, one object per inquiry
//! (`catering:<sandbox>:<ulid>`; docs/domain.md, "CateringEvent"). It protects the job's quote,
//! the money due and the lifecycle, and runs the saga by alarm (docs/architecture.md, "The
//! catering saga"): every step is one `decide`, started by a person, an event or a timer, and the
//! timers the object arms are a pure function of the state ([`timers`], [`reminders`]).
//!
//! The commands, events and rules follow the doc's table and diagram. Where the doc leaves a
//! step open, the choice is written at the step:
//!
//! - **Business days are open days**, Tuesday to Sunday, counted from the day after the one in
//!   question ([`BakeryDate::nth_open_day_after`]). The 7-day lead is "the date is at least the
//!   7th open day after the inquiry's day"; a quote is valid until the opening (07:00) of the
//!   14th open day after the quote's day; the follow-up is due at the opening of the 3rd.
//! - **The deposit hold** lapses 15 minutes of business time after `AcceptQuote`, the
//!   Schedule's own hold time. `LapseDeposit` then moves `accepted` back to `quoted` and emits
//!   `CateringDepositLapsed`, a row this module adds to the catalog (subscriber: Schedule, which
//!   releases the place). A later `AcceptQuote`, while the quote is still valid, holds again.
//! - **A deposit after the lapse still confirms**: the money moved. `RecordDeposit` is taken in
//!   `accepted` and in `quoted` once the quote was accepted, the edge `quoted --> confirmed` the
//!   diagram does not draw; the Worker then holds the day again (Schedule's `Confirm` revives a
//!   released place, past capacity if need be). A deposit that lands after the quote expired is
//!   refused (`out-of-order`): see the questions in the PR's report.
//! - **Timers that no longer apply are no-ops.** `LapseDeposit`, `ExpireQuote` and
//!   `FireReminder` emit nothing when their condition does not hold, including when they run
//!   early, so a stale timer row is harmless; the object re-arms from [`timers`] after every
//!   commit. A reminder is recorded once: firing it again emits nothing.
//! - **Repeats are no-ops**: the same payment or invoice recorded again, a second
//!   `AcceptQuote`, `StartProduction`, `MarkDelivered` or `Decline` in the state it leads to.
//! - **Cancellation** is taken from `confirmed` only, as the diagram draws it. The deposit is
//!   refunded when the event day is more than 7 calendar days after the cancellation's day.
//! - **The invoice falls due 7 days after delivery** ([`INVOICE_DUE_DAYS`]), so the
//!   `invoice_due` reminder, "when the invoice is 7 days old", is due at the opening of the due
//!   date. The `event_soon` reminder is due at the opening of the day two calendar days before
//!   the event.
//!
//! Fields beyond the catalog's rows, all additions in envelope v1:
//! `CateringQuoteSent.follow_up_at` and `CateringQuoteAccepted.lapses_at` (the timers' times, so
//! `evolve` needs no clock), `CateringDelivered.customer`, `.balance_cents` and `.due` (what
//! Billing needs to raise the balance invoice, since it subscribes to that event), and
//! `CateringCancelled.by` and `.reason`. `CateringDeclined.reason` is a choice from a list, not
//! free text. The brief rides only in `CateringInquiryReceived`, and the consumer strips it for
//! every subscriber (`bakery-app`'s `routing::strip_for`).
//!
//! The response's `created_at` and `updated_at` are the business times of the object's first
//! and last envelope, which the object reads from its own log; nothing in this state needs them.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::aggregate::{Aggregate, DecideContext, DomainEvent};
use crate::calendar::{BakeryDate, plus_elapsed_minutes};
use crate::free_text::{FreeTextClass, FreeTextError, check_brief};
use crate::order::CancelledBy;
use crate::schedule::{HoldKind, HoldRequest, ItemQty};
use crate::{BusinessTime, Cents, DomainError, Ulid};

/// A catering event feeds 10 to 200 people (docs/domain.md, "CateringEvent").
pub const MIN_HEADCOUNT: u16 = 10;
pub const MAX_HEADCOUNT: u16 = 200;
/// The date is at least 7 business days after the inquiry (Q16 · Q-catering).
pub const LEAD_BUSINESS_DAYS: u32 = 7;
/// A quote is valid for 14 business days (docs/domain.md, "Ubiquitous language": Quote).
pub const QUOTE_VALID_BUSINESS_DAYS: u32 = 14;
/// The follow-up reminder, 3 business days after a quote.
pub const FOLLOW_UP_BUSINESS_DAYS: u32 = 3;
/// The deposit, 2,500 bp of the quote's total (docs/domain.md, "Money and time").
pub const DEPOSIT_BP: u32 = 2_500;
/// The deposit hold: 15 minutes of business time, the Schedule's hold time.
pub const DEPOSIT_HOLD_MINUTES: i64 = 15;
/// The `event_soon` reminder, this many calendar days before the event.
pub const EVENT_SOON_DAYS: i64 = 2;
/// The balance invoice falls due this many calendar days after delivery.
pub const INVOICE_DUE_DAYS: i64 = 7;
/// A cancellation more than this many calendar days before the date refunds the deposit.
pub const REFUND_CUTOFF_DAYS: i64 = 7;
/// What `ExpireQuote` gives as its reason.
pub const EXPIRY_REASON: &str = "14 business days";

/// The six made-up venues, by id; each is pinned to a place in the seed.
pub const VENUES: [&str; 6] = ["v1", "v2", "v3", "v4", "v5", "v6"];

/// A catering package and its price per head: the seed's `PACKAGES`, which a test in
/// `bakery-seed` holds equal to these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Package {
    pub slug: &'static str,
    pub per_head_cents: Cents,
}

pub const PACKAGES: [Package; 4] = [
    Package {
        slug: "pastry-platter",
        per_head_cents: Cents(950),
    },
    Package {
        slug: "breakfast-spread",
        per_head_cents: Cents(1_450),
    },
    Package {
        slug: "lunch-boxes",
        per_head_cents: Cents(1_850),
    },
    Package {
        slug: "celebration-cake-and-coffee",
        per_head_cents: Cents(1_250),
    },
];

/// The package with this slug.
pub fn package(slug: &str) -> Option<Package> {
    PACKAGES.into_iter().find(|p| p.slug == slug)
}

/// The states of the diagram in docs/domain.md, "CateringEvent".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CateringStatus {
    Inquiry,
    Quoted,
    Accepted,
    Confirmed,
    InProduction,
    Delivered,
    Invoiced,
    Paid,
    Closed,
    Declined,
    Expired,
    Cancelled,
}

impl CateringStatus {
    pub const ALL: [CateringStatus; 12] = [
        CateringStatus::Inquiry,
        CateringStatus::Quoted,
        CateringStatus::Accepted,
        CateringStatus::Confirmed,
        CateringStatus::InProduction,
        CateringStatus::Delivered,
        CateringStatus::Invoiced,
        CateringStatus::Paid,
        CateringStatus::Closed,
        CateringStatus::Declined,
        CateringStatus::Expired,
        CateringStatus::Cancelled,
    ];

    /// The diagram's `[*]` exits: nothing follows these.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            CateringStatus::Closed
                | CateringStatus::Declined
                | CateringStatus::Expired
                | CateringStatus::Cancelled
        )
    }
}

/// The three reminders (docs/domain.md, "CateringEvent", invariants).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReminderKind {
    /// 3 business days after the quote, while it is still quoted.
    FollowUp,
    /// 2 days before the event, while it is confirmed or in production.
    EventSoon,
    /// When the balance invoice is 7 days old, while it is unpaid.
    InvoiceDue,
}

/// Why staff decline an inquiry: a choice from a list, never free text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeclineReason {
    TooSoon,
    OverCapacity,
    Other,
}

/// Why a confirmed event is cancelled: a choice from a list, never free text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    CustomerChange,
    VenueLost,
    Other,
}

/// Everything `SubmitInquiry` needs. The catering id is the one the Sandbox registered for the
/// client's key (docs/domain.md, "Aggregates and their objects": creating an aggregate), and the
/// customer is the sandbox's persona.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitInquiry {
    pub catering: Ulid,
    pub customer: Ulid,
    pub date: BakeryDate,
    pub headcount: u16,
    pub package: String,
    pub venue: String,
    pub brief: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CateringCommand {
    /// The customer's inquiry.
    SubmitInquiry(Box<SubmitInquiry>),
    /// Staff. `None` prices the package per head times the headcount; `Some` is a staff
    /// override of at least 1 cent.
    SendQuote { total: Option<Cents> },
    /// Staff.
    Decline { reason: DeclineReason },
    /// The customer, while the quote is valid.
    AcceptQuote,
    /// The deposit hold's timer, at `lapses_at`.
    LapseDeposit,
    /// From `PaymentSucceeded` with purpose `deposit`.
    RecordDeposit { payment: Ulid, amount: Cents },
    /// A reminder's timer.
    FireReminder { kind: ReminderKind },
    /// The quote's timer, at `valid_until`.
    ExpireQuote,
    /// Staff.
    StartProduction,
    /// Staff.
    MarkDelivered,
    /// From `InvoiceIssued`.
    RecordInvoice {
        invoice: Ulid,
        amount: Cents,
        due: BakeryDate,
    },
    /// From `PaymentSucceeded` with purpose `balance`.
    RecordBalance { payment: Ulid, amount: Cents },
    /// The customer or staff.
    Cancel {
        by: CancelledBy,
        reason: CancelReason,
    },
}

impl CateringCommand {
    pub fn name(&self) -> &'static str {
        match self {
            CateringCommand::SubmitInquiry(_) => "SubmitInquiry",
            CateringCommand::SendQuote { .. } => "SendQuote",
            CateringCommand::Decline { .. } => "Decline",
            CateringCommand::AcceptQuote => "AcceptQuote",
            CateringCommand::LapseDeposit => "LapseDeposit",
            CateringCommand::RecordDeposit { .. } => "RecordDeposit",
            CateringCommand::FireReminder { .. } => "FireReminder",
            CateringCommand::ExpireQuote => "ExpireQuote",
            CateringCommand::StartProduction => "StartProduction",
            CateringCommand::MarkDelivered => "MarkDelivered",
            CateringCommand::RecordInvoice { .. } => "RecordInvoice",
            CateringCommand::RecordBalance { .. } => "RecordBalance",
            CateringCommand::Cancel { .. } => "Cancel",
        }
    }
}

/// The CateringEvent's rows in docs/domain.md, "The event catalog", with the additions the
/// module doc lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum CateringEvent {
    CateringInquiryReceived {
        catering: Ulid,
        customer: Ulid,
        date: BakeryDate,
        headcount: u16,
        package: String,
        venue: String,
        /// Stripped by the consumer for every subscriber; staff read it from the aggregate.
        #[serde(default)]
        brief: Option<String>,
    },
    CateringQuoteSent {
        total_cents: Cents,
        deposit_cents: Cents,
        valid_until: BusinessTime,
        follow_up_at: BusinessTime,
    },
    CateringQuoteAccepted {
        /// When the deposit hold lapses.
        lapses_at: BusinessTime,
    },
    /// No deposit within the hold: back to `quoted`. Added by PR 7; subscriber Schedule.
    CateringDepositLapsed {},
    CateringQuoteExpired {
        reason: Option<String>,
    },
    CateringDeclined {
        reason: DeclineReason,
    },
    CateringDepositPaid {
        payment: Ulid,
        amount_cents: Cents,
    },
    CateringReminderDue {
        kind: ReminderKind,
    },
    CateringProductionStarted {},
    CateringDelivered {
        customer: Ulid,
        balance_cents: Cents,
        due: BakeryDate,
    },
    CateringBalanceInvoiced {
        invoice: Ulid,
        amount_cents: Cents,
        due: BakeryDate,
    },
    CateringBalancePaid {
        payment: Ulid,
    },
    CateringClosed {
        payment: Option<Ulid>,
    },
    CateringCancelled {
        refund_deposit: bool,
        by: CancelledBy,
        reason: CancelReason,
    },
}

impl DomainEvent for CateringEvent {
    const NAMES: &'static [&'static str] = &[
        "CateringInquiryReceived",
        "CateringQuoteSent",
        "CateringQuoteAccepted",
        "CateringDepositLapsed",
        "CateringQuoteExpired",
        "CateringDeclined",
        "CateringDepositPaid",
        "CateringReminderDue",
        "CateringProductionStarted",
        "CateringDelivered",
        "CateringBalanceInvoiced",
        "CateringBalancePaid",
        "CateringClosed",
        "CateringCancelled",
    ];

    fn name(&self) -> &'static str {
        match self {
            CateringEvent::CateringInquiryReceived { .. } => "CateringInquiryReceived",
            CateringEvent::CateringQuoteSent { .. } => "CateringQuoteSent",
            CateringEvent::CateringQuoteAccepted { .. } => "CateringQuoteAccepted",
            CateringEvent::CateringDepositLapsed {} => "CateringDepositLapsed",
            CateringEvent::CateringQuoteExpired { .. } => "CateringQuoteExpired",
            CateringEvent::CateringDeclined { .. } => "CateringDeclined",
            CateringEvent::CateringDepositPaid { .. } => "CateringDepositPaid",
            CateringEvent::CateringReminderDue { .. } => "CateringReminderDue",
            CateringEvent::CateringProductionStarted {} => "CateringProductionStarted",
            CateringEvent::CateringDelivered { .. } => "CateringDelivered",
            CateringEvent::CateringBalanceInvoiced { .. } => "CateringBalanceInvoiced",
            CateringEvent::CateringBalancePaid { .. } => "CateringBalancePaid",
            CateringEvent::CateringClosed { .. } => "CateringClosed",
            CateringEvent::CateringCancelled { .. } => "CateringCancelled",
        }
    }
}

/// The rule a catering command broke. [`CateringError::rule`] names it: a refused inquiry is a
/// 422 naming the rule, a refused transition a 409 `catering` with the rule. The brief's error
/// carries only the matched class, never the text.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CateringError {
    #[error("a catering event is for {MIN_HEADCOUNT} to {MAX_HEADCOUNT} people")]
    Headcount,
    #[error("{0} is not one of the catering packages")]
    UnknownPackage(String),
    #[error("{0} is not one of the venues v1 to v6")]
    UnknownVenue(String),
    #[error("the bakery is closed that day")]
    ClosedDay,
    /// `earliest` is the first date the 7-business-day rule allows.
    #[error(
        "a catering event needs {LEAD_BUSINESS_DAYS} business days' notice (Tuesday to Sunday); the earliest date is {earliest}"
    )]
    Lead { earliest: BakeryDate },
    #[error("the brief was refused: {}", brief_rule(*.0))]
    Brief(FreeTextError),
    #[error("a quote's total is at least 1 cent")]
    QuoteTotal,
    #[error("the quote expired at {valid_until}")]
    QuoteExpired { valid_until: BusinessTime },
    #[error("the payment is {paid:?} cents and {expected:?} is due")]
    AmountMismatch { paid: Cents, expected: Cents },
    #[error("{command} does not apply to a catering event that is {}", status_text(*.status))]
    OutOfOrder {
        command: &'static str,
        /// `None` before the inquiry.
        status: Option<CateringStatus>,
    },
    #[error("amount out of range")]
    Overflow,
}

fn status_text(status: Option<CateringStatus>) -> String {
    status.map_or_else(
        || "not yet submitted".to_owned(),
        |s| {
            serde_json::to_value(s)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default()
        },
    )
}

fn brief_rule(e: FreeTextError) -> &'static str {
    match e {
        FreeTextError::TooLong { .. } => "brief-too-long",
        FreeTextError::Class(FreeTextClass::Email) => "brief-email",
        FreeTextError::Class(FreeTextClass::Phone) => "brief-phone",
        FreeTextError::Class(FreeTextClass::CardNumber) => "brief-card-number",
        FreeTextError::Class(FreeTextClass::Url) => "brief-url",
    }
}

impl CateringError {
    /// The slug a problem document names the rule by.
    pub fn rule(&self) -> &'static str {
        match self {
            CateringError::Headcount => "headcount",
            CateringError::UnknownPackage(_) => "unknown-package",
            CateringError::UnknownVenue(_) => "unknown-venue",
            CateringError::ClosedDay => "closed-day",
            CateringError::Lead { .. } => "catering-lead",
            CateringError::Brief(e) => brief_rule(*e),
            CateringError::QuoteTotal => "quote-total",
            CateringError::QuoteExpired { .. } => "quote-expired",
            CateringError::AmountMismatch { .. } => "amount-mismatch",
            CateringError::OutOfOrder { .. } => "out-of-order",
            CateringError::Overflow => "overflow",
        }
    }

    /// Whether the Worker answers 422 (a refused inquiry) rather than 409 (a refused step).
    pub fn is_inquiry_rule(&self) -> bool {
        matches!(
            self,
            CateringError::Headcount
                | CateringError::UnknownPackage(_)
                | CateringError::UnknownVenue(_)
                | CateringError::ClosedDay
                | CateringError::Lead { .. }
                | CateringError::Brief(_)
                | CateringError::QuoteTotal
        )
    }
}

impl From<DomainError> for CateringError {
    fn from(_: DomainError) -> CateringError {
        CateringError::Overflow
    }
}

/// The staff's priced offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quote {
    pub total: Cents,
    /// 25% of the total, rounded half-up.
    pub deposit: Cents,
    /// `total - deposit`, so the two always sum to the total.
    pub balance: Cents,
    pub valid_until: BusinessTime,
    pub follow_up_at: BusinessTime,
}

/// A payment that counted, by Billing's id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paid {
    pub payment: Ulid,
    pub amount: Cents,
}

/// The balance invoice, by Billing's id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invoice {
    pub invoice: Ulid,
    pub amount: Cents,
    pub due: BakeryDate,
}

/// A submitted inquiry: what `CateringInquiryReceived` fixed, and what has happened since.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CateringRecord {
    pub id: Ulid,
    pub customer: Ulid,
    pub date: BakeryDate,
    pub headcount: u16,
    pub package: String,
    pub venue: String,
    /// Shown back to its sandbox only, on the staff and customer screens.
    pub brief: Option<String>,
    pub status: CateringStatus,
    pub quote: Option<Quote>,
    /// When the deposit hold lapses, while `accepted`.
    pub lapses_at: Option<BusinessTime>,
    /// Whether the quote was ever accepted: a deposit can then land, even after a lapse.
    pub accepted_once: bool,
    pub deposit: Option<Paid>,
    pub invoice: Option<Invoice>,
    pub balance_payment: Option<Ulid>,
    /// The reminders already recorded, each once.
    pub reminders_fired: BTreeSet<ReminderKind>,
    pub declined: Option<DeclineReason>,
    /// Set on cancellation.
    pub refund_deposit: Option<bool>,
    pub cancelled: Option<(CancelledBy, CancelReason)>,
}

/// A catering event's state: nothing before the inquiry, then its record.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CateringState {
    record: Option<CateringRecord>,
}

impl CateringState {
    pub fn record(&self) -> Option<&CateringRecord> {
        self.record.as_ref()
    }

    pub fn status(&self) -> Option<CateringStatus> {
        self.record.as_ref().map(|r| r.status)
    }
}

/// One timer the object keeps armed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Reminder {
    pub kind: ReminderKind,
    pub at: BusinessTime,
}

/// What a timer row runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum TimerKind {
    /// `FireReminder { kind }`.
    Reminder(ReminderKind),
    /// `ExpireQuote`, at `valid_until`, while quoted.
    QuoteExpiry,
    /// `LapseDeposit`, at `lapses_at`, while accepted.
    DepositLapse,
}

impl TimerKind {
    /// The command the timer runs.
    pub fn command(self) -> CateringCommand {
        match self {
            TimerKind::Reminder(kind) => CateringCommand::FireReminder { kind },
            TimerKind::QuoteExpiry => CateringCommand::ExpireQuote,
            TimerKind::DepositLapse => CateringCommand::LapseDeposit,
        }
    }

    /// A stable name for the `timers` row: `reminder:follow_up`, `quote-expiry`,
    /// `deposit-lapse`.
    pub fn row_name(self) -> String {
        match self {
            TimerKind::Reminder(kind) => {
                let name = serde_json::to_value(kind)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default();
                format!("reminder:{name}")
            }
            TimerKind::QuoteExpiry => "quote-expiry".to_owned(),
            TimerKind::DepositLapse => "deposit-lapse".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Timer {
    pub kind: TimerKind,
    pub at: BusinessTime,
}

/// The reminders still to come, earliest first: the pure function the Worker arms reminder
/// timers from. Empty in every terminal state, and a reminder already recorded is not listed.
pub fn reminders(state: &CateringState) -> Vec<Reminder> {
    let Some(r) = state.record() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut add = |kind: ReminderKind, at: BusinessTime| {
        if !r.reminders_fired.contains(&kind) {
            out.push(Reminder { kind, at });
        }
    };
    match r.status {
        CateringStatus::Quoted => {
            if let Some(q) = r.quote {
                add(ReminderKind::FollowUp, q.follow_up_at);
            }
        }
        CateringStatus::Confirmed | CateringStatus::InProduction => {
            add(
                ReminderKind::EventSoon,
                r.date.plus_days(-EVENT_SOON_DAYS).opening(),
            );
        }
        CateringStatus::Invoiced => {
            if let Some(i) = r.invoice {
                add(ReminderKind::InvoiceDue, i.due.opening());
            }
        }
        _ => {}
    }
    out.sort_by_key(|x| (x.at, x.kind));
    out
}

/// Every timer the object keeps armed, earliest first: the reminders, the quote's expiry while
/// quoted and the deposit hold's lapse while accepted.
pub fn timers(state: &CateringState) -> Vec<Timer> {
    let mut out: Vec<Timer> = reminders(state)
        .into_iter()
        .map(|r| Timer {
            kind: TimerKind::Reminder(r.kind),
            at: r.at,
        })
        .collect();
    if let Some(r) = state.record() {
        match (r.status, r.quote, r.lapses_at) {
            (CateringStatus::Quoted, Some(q), _) => out.push(Timer {
                kind: TimerKind::QuoteExpiry,
                at: q.valid_until,
            }),
            (CateringStatus::Accepted, _, Some(at)) => out.push(Timer {
                kind: TimerKind::DepositLapse,
                at,
            }),
            _ => {}
        }
    }
    out.sort_by_key(|t| (t.at, t.kind));
    out
}

/// The Schedule hold an accepted quote asks for (schedule.rs's module doc): the event day's
/// opening, one line of the package's slug times the headcount, expiring when the deposit hold
/// lapses. `None` in any state but `accepted`.
pub fn hold_request(state: &CateringState) -> Option<HoldRequest> {
    let r = state.record()?;
    if r.status != CateringStatus::Accepted {
        return None;
    }
    Some(HoldRequest {
        reference: r.id,
        kind: HoldKind::Catering,
        start: r.date.opening(),
        zone: None,
        lines: vec![ItemQty {
            item: r.package.clone(),
            qty: u32::from(r.headcount),
        }],
        expires_at: r.lapses_at?,
    })
}

/// The first date the 7-business-day lead allows for an inquiry made at `now`.
pub fn earliest_date(now: BusinessTime) -> BakeryDate {
    BakeryDate::of(now).nth_open_day_after(LEAD_BUSINESS_DAYS)
}

/// A quote for `total`: the deposit is 25% rounded half-up and the balance the rest, valid
/// until the opening of the 14th business day after `now`'s day.
pub fn quote(total: Cents, now: BusinessTime) -> Result<Quote, CateringError> {
    if total < Cents(1) {
        return Err(CateringError::QuoteTotal);
    }
    let (deposit, balance) = total.split(DEPOSIT_BP)?;
    let day = BakeryDate::of(now);
    Ok(Quote {
        total,
        deposit,
        balance,
        valid_until: day.nth_open_day_after(QUOTE_VALID_BUSINESS_DAYS).opening(),
        follow_up_at: day.nth_open_day_after(FOLLOW_UP_BUSINESS_DAYS).opening(),
    })
}

/// The aggregate hosted by `CateringEvent`.
pub struct Catering;

impl Aggregate for Catering {
    type State = CateringState;
    type Command = CateringCommand;
    type Event = CateringEvent;
    type Error = CateringError;

    fn decide(
        state: &CateringState,
        cmd: &CateringCommand,
        ctx: &DecideContext,
    ) -> Result<Vec<CateringEvent>, CateringError> {
        match (state.record(), cmd) {
            (None, CateringCommand::SubmitInquiry(s)) => submit(s, ctx).map(|e| vec![e]),
            (None, _) => Err(CateringError::OutOfOrder {
                command: cmd.name(),
                status: None,
            }),
            (Some(r), _) => decide_submitted(r, cmd, ctx),
        }
    }

    fn evolve(mut state: CateringState, event: &CateringEvent) -> CateringState {
        if let CateringEvent::CateringInquiryReceived {
            catering,
            customer,
            date,
            headcount,
            package,
            venue,
            brief,
        } = event
        {
            if state.record.is_none() {
                state.record = Some(CateringRecord {
                    id: *catering,
                    customer: *customer,
                    date: *date,
                    headcount: *headcount,
                    package: package.clone(),
                    venue: venue.clone(),
                    brief: brief.clone(),
                    status: CateringStatus::Inquiry,
                    quote: None,
                    lapses_at: None,
                    accepted_once: false,
                    deposit: None,
                    invoice: None,
                    balance_payment: None,
                    reminders_fired: BTreeSet::new(),
                    declined: None,
                    refund_deposit: None,
                    cancelled: None,
                });
            }
            return state;
        }
        let Some(r) = state.record.as_mut() else {
            return state;
        };
        use CateringStatus as S;
        match event {
            CateringEvent::CateringInquiryReceived { .. } => {}
            CateringEvent::CateringQuoteSent {
                total_cents,
                deposit_cents,
                valid_until,
                follow_up_at,
            } => {
                r.quote = Some(Quote {
                    total: *total_cents,
                    deposit: *deposit_cents,
                    balance: Cents(total_cents.0 - deposit_cents.0),
                    valid_until: *valid_until,
                    follow_up_at: *follow_up_at,
                });
                r.status = S::Quoted;
            }
            CateringEvent::CateringQuoteAccepted { lapses_at } => {
                r.lapses_at = Some(*lapses_at);
                r.accepted_once = true;
                r.status = S::Accepted;
            }
            CateringEvent::CateringDepositLapsed {} => {
                r.lapses_at = None;
                r.status = S::Quoted;
            }
            CateringEvent::CateringQuoteExpired { .. } => r.status = S::Expired,
            CateringEvent::CateringDeclined { reason } => {
                r.declined = Some(*reason);
                r.status = S::Declined;
            }
            CateringEvent::CateringDepositPaid {
                payment,
                amount_cents,
            } => {
                r.deposit = Some(Paid {
                    payment: *payment,
                    amount: *amount_cents,
                });
                r.lapses_at = None;
                r.status = S::Confirmed;
            }
            CateringEvent::CateringReminderDue { kind } => {
                r.reminders_fired.insert(*kind);
            }
            CateringEvent::CateringProductionStarted {} => r.status = S::InProduction,
            CateringEvent::CateringDelivered { .. } => r.status = S::Delivered,
            CateringEvent::CateringBalanceInvoiced {
                invoice,
                amount_cents,
                due,
            } => {
                r.invoice = Some(Invoice {
                    invoice: *invoice,
                    amount: *amount_cents,
                    due: *due,
                });
                r.status = S::Invoiced;
            }
            CateringEvent::CateringBalancePaid { payment } => {
                r.balance_payment = Some(*payment);
                r.status = S::Paid;
            }
            CateringEvent::CateringClosed { .. } => r.status = S::Closed,
            CateringEvent::CateringCancelled {
                refund_deposit,
                by,
                reason,
            } => {
                r.refund_deposit = Some(*refund_deposit);
                r.cancelled = Some((*by, *reason));
                r.status = S::Cancelled;
            }
        }
        state
    }
}

fn submit(s: &SubmitInquiry, ctx: &DecideContext) -> Result<CateringEvent, CateringError> {
    if !(MIN_HEADCOUNT..=MAX_HEADCOUNT).contains(&s.headcount) {
        return Err(CateringError::Headcount);
    }
    // Slugs and ids are short; a refusal names at most 40 characters of what was sent.
    let clip = |text: &str| text.chars().take(40).collect::<String>();
    if package(&s.package).is_none() {
        return Err(CateringError::UnknownPackage(clip(&s.package)));
    }
    if !VENUES.contains(&s.venue.as_str()) {
        return Err(CateringError::UnknownVenue(clip(&s.venue)));
    }
    if !s.date.is_open() {
        return Err(CateringError::ClosedDay);
    }
    let earliest = earliest_date(ctx.now);
    if s.date < earliest {
        return Err(CateringError::Lead { earliest });
    }
    let brief = match &s.brief {
        None => None,
        Some(text) => {
            let checked = check_brief(text).map_err(CateringError::Brief)?;
            (!checked.trim().is_empty()).then_some(checked)
        }
    };
    Ok(CateringEvent::CateringInquiryReceived {
        catering: s.catering,
        customer: s.customer,
        date: s.date,
        headcount: s.headcount,
        package: s.package.clone(),
        venue: s.venue.clone(),
        brief,
    })
}

fn decide_submitted(
    r: &CateringRecord,
    cmd: &CateringCommand,
    ctx: &DecideContext,
) -> Result<Vec<CateringEvent>, CateringError> {
    use CateringStatus as S;
    let out_of_order = || CateringError::OutOfOrder {
        command: cmd.name(),
        status: Some(r.status),
    };
    let none = Ok(Vec::new());
    match cmd {
        CateringCommand::SubmitInquiry(_) => Err(out_of_order()),
        CateringCommand::SendQuote { total } => {
            if r.status != S::Inquiry {
                return Err(out_of_order());
            }
            let total = match total {
                Some(t) => *t,
                None => {
                    let p = package(&r.package).ok_or_else(out_of_order)?;
                    p.per_head_cents
                        .0
                        .checked_mul(i64::from(r.headcount))
                        .map(Cents)
                        .ok_or(CateringError::Overflow)?
                }
            };
            let q = quote(total, ctx.now)?;
            Ok(vec![CateringEvent::CateringQuoteSent {
                total_cents: q.total,
                deposit_cents: q.deposit,
                valid_until: q.valid_until,
                follow_up_at: q.follow_up_at,
            }])
        }
        CateringCommand::Decline { reason } => match r.status {
            S::Inquiry => Ok(vec![CateringEvent::CateringDeclined { reason: *reason }]),
            S::Declined => none,
            _ => Err(out_of_order()),
        },
        CateringCommand::AcceptQuote => match (r.status, r.quote) {
            (S::Quoted, Some(q)) if ctx.now >= q.valid_until => Err(CateringError::QuoteExpired {
                valid_until: q.valid_until,
            }),
            (S::Quoted, Some(_)) => Ok(vec![CateringEvent::CateringQuoteAccepted {
                lapses_at: plus_elapsed_minutes(ctx.now, DEPOSIT_HOLD_MINUTES)?,
            }]),
            (S::Expired, Some(q)) => Err(CateringError::QuoteExpired {
                valid_until: q.valid_until,
            }),
            (S::Accepted, _) => none,
            _ => Err(out_of_order()),
        },
        CateringCommand::LapseDeposit => match (r.status, r.lapses_at) {
            (S::Accepted, Some(at)) if ctx.now >= at => {
                Ok(vec![CateringEvent::CateringDepositLapsed {}])
            }
            _ => none,
        },
        CateringCommand::RecordDeposit { payment, amount } => {
            let q = r.quote.ok_or_else(out_of_order)?;
            if *amount != q.deposit {
                return Err(CateringError::AmountMismatch {
                    paid: *amount,
                    expected: q.deposit,
                });
            }
            if let Some(d) = r.deposit {
                return if d.payment == *payment {
                    none
                } else {
                    Err(out_of_order())
                };
            }
            match r.status {
                // After a lapse the quote is `quoted` again, but the money moved: it confirms.
                S::Accepted | S::Quoted if r.accepted_once => {
                    Ok(vec![CateringEvent::CateringDepositPaid {
                        payment: *payment,
                        amount_cents: *amount,
                    }])
                }
                _ => Err(out_of_order()),
            }
        }
        CateringCommand::FireReminder { kind } => {
            let due = reminders(&CateringState {
                record: Some(r.clone()),
            })
            .into_iter()
            .any(|x| x.kind == *kind && x.at <= ctx.now);
            if due {
                Ok(vec![CateringEvent::CateringReminderDue { kind: *kind }])
            } else {
                none
            }
        }
        CateringCommand::ExpireQuote => match (r.status, r.quote) {
            (S::Quoted, Some(q)) if ctx.now >= q.valid_until => {
                Ok(vec![CateringEvent::CateringQuoteExpired {
                    reason: Some(EXPIRY_REASON.to_owned()),
                }])
            }
            _ => none,
        },
        CateringCommand::StartProduction => match r.status {
            S::Confirmed => Ok(vec![CateringEvent::CateringProductionStarted {}]),
            S::InProduction => none,
            _ => Err(out_of_order()),
        },
        CateringCommand::MarkDelivered => match (r.status, r.quote) {
            (S::InProduction, Some(q)) => Ok(vec![CateringEvent::CateringDelivered {
                customer: r.customer,
                balance_cents: q.balance,
                due: BakeryDate::of(ctx.now).plus_days(INVOICE_DUE_DAYS),
            }]),
            (S::Delivered, _) => none,
            _ => Err(out_of_order()),
        },
        CateringCommand::RecordInvoice {
            invoice,
            amount,
            due,
        } => {
            if let Some(i) = r.invoice {
                return if i.invoice == *invoice {
                    none
                } else {
                    Err(out_of_order())
                };
            }
            let q = r.quote.ok_or_else(out_of_order)?;
            if r.status != S::Delivered {
                return Err(out_of_order());
            }
            if *amount != q.balance {
                return Err(CateringError::AmountMismatch {
                    paid: *amount,
                    expected: q.balance,
                });
            }
            Ok(vec![CateringEvent::CateringBalanceInvoiced {
                invoice: *invoice,
                amount_cents: *amount,
                due: *due,
            }])
        }
        CateringCommand::RecordBalance { payment, amount } => {
            let q = r.quote.ok_or_else(out_of_order)?;
            if *amount != q.balance {
                return Err(CateringError::AmountMismatch {
                    paid: *amount,
                    expected: q.balance,
                });
            }
            if let Some(p) = r.balance_payment {
                return if p == *payment {
                    none
                } else {
                    Err(out_of_order())
                };
            }
            if r.status != S::Invoiced {
                return Err(out_of_order());
            }
            Ok(vec![
                CateringEvent::CateringBalancePaid { payment: *payment },
                CateringEvent::CateringClosed {
                    payment: Some(*payment),
                },
            ])
        }
        CateringCommand::Cancel { by, reason } => {
            if r.status != S::Confirmed {
                return Err(out_of_order());
            }
            let ahead = BakeryDate::of(ctx.now).days_until(r.date);
            Ok(vec![CateringEvent::CateringCancelled {
                refund_deposit: ahead > REFUND_CUTOFF_DAYS,
                by: *by,
                reason: *reason,
            }])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aggregate::{execute, replay};
    use crate::{Envelope, WallTime};
    use CateringStatus as S;
    use proptest::prelude::*;

    /// Every edge of the diagram in docs/domain.md, "CateringEvent", one per event folded, plus
    /// the ones this module adds: `quoted --> confirmed` (a deposit after the hold lapsed) and a
    /// reminder's self-loop in each state that has one. `None` is `[*]`.
    const TRANSITIONS: &[(Option<CateringStatus>, CateringStatus)] = &[
        (None, S::Inquiry),
        (Some(S::Inquiry), S::Quoted),
        (Some(S::Inquiry), S::Declined),
        (Some(S::Quoted), S::Accepted),
        (Some(S::Quoted), S::Expired),
        (Some(S::Accepted), S::Quoted),
        (Some(S::Accepted), S::Confirmed),
        (Some(S::Confirmed), S::Cancelled),
        (Some(S::Confirmed), S::InProduction),
        (Some(S::InProduction), S::Delivered),
        (Some(S::Delivered), S::Invoiced),
        (Some(S::Invoiced), S::Paid),
        (Some(S::Paid), S::Closed),
        // Added here.
        (Some(S::Quoted), S::Confirmed),
        (Some(S::Quoted), S::Quoted),
        (Some(S::Confirmed), S::Confirmed),
        (Some(S::InProduction), S::InProduction),
        (Some(S::Invoiced), S::Invoiced),
    ];

    fn at(text: &str) -> BusinessTime {
        text.parse().unwrap()
    }

    fn date(text: &str) -> BakeryDate {
        text.parse().unwrap()
    }

    fn id(n: u128) -> Ulid {
        Ulid::from_parts(1_793_000_000_000, n)
    }

    /// A Tuesday morning; the event is on Saturday 2026-11-21.
    const NOW: &str = "2026-11-03T10:00:00-07:00";
    const DATE: &str = "2026-11-21";
    const ACCEPTED_AT: &str = "2026-11-04T09:00:00-07:00";
    const PAID_AT: &str = "2026-11-04T09:05:00-07:00";
    const EVENT_MORNING: &str = "2026-11-21T05:00:00-07:00";
    const DELIVERED_AT: &str = "2026-11-21T11:00:00-07:00";
    // 40 people at $14.50: $580.00, a $145.00 deposit and a $435.00 balance.
    const TOTAL: Cents = Cents(58_000);
    const DEPOSIT: Cents = Cents(14_500);
    const BALANCE: Cents = Cents(43_500);

    fn ctx_at(now: &str) -> DecideContext {
        DecideContext {
            now: at(now),
            id: id(99),
        }
    }

    fn inquiry() -> SubmitInquiry {
        SubmitInquiry {
            catering: id(1),
            customer: id(2),
            date: date(DATE),
            headcount: 40,
            package: "breakfast-spread".into(),
            venue: "v3".into(),
            brief: Some("Two trays without nuts, please".into()),
        }
    }

    fn submit_cmd(s: SubmitInquiry) -> CateringCommand {
        CateringCommand::SubmitInquiry(Box::new(s))
    }

    fn step(
        state: CateringState,
        cmd: CateringCommand,
        now: &str,
    ) -> Result<CateringState, CateringError> {
        execute::<Catering>(state, &cmd, &ctx_at(now)).map(|(s, _)| s)
    }

    fn decide(state: &CateringState, cmd: CateringCommand, now: &str) -> DecideResult {
        Catering::decide(state, &cmd, &ctx_at(now))
    }

    type DecideResult = Result<Vec<CateringEvent>, CateringError>;

    fn submitted() -> CateringState {
        step(CateringState::default(), submit_cmd(inquiry()), NOW).unwrap()
    }

    fn quoted() -> CateringState {
        step(submitted(), CateringCommand::SendQuote { total: None }, NOW).unwrap()
    }

    fn accepted() -> CateringState {
        step(quoted(), CateringCommand::AcceptQuote, ACCEPTED_AT).unwrap()
    }

    fn deposit(payment: u128) -> CateringCommand {
        CateringCommand::RecordDeposit {
            payment: id(payment),
            amount: DEPOSIT,
        }
    }

    fn confirmed() -> CateringState {
        step(accepted(), deposit(10), PAID_AT).unwrap()
    }

    fn delivered() -> CateringState {
        let s = step(confirmed(), CateringCommand::StartProduction, EVENT_MORNING).unwrap();
        step(s, CateringCommand::MarkDelivered, DELIVERED_AT).unwrap()
    }

    fn invoice_cmd(invoice: u128) -> CateringCommand {
        CateringCommand::RecordInvoice {
            invoice: id(invoice),
            amount: BALANCE,
            due: date("2026-11-28"),
        }
    }

    fn invoiced() -> CateringState {
        step(delivered(), invoice_cmd(20), "2026-11-21T12:00:00-07:00").unwrap()
    }

    fn balance(payment: u128) -> CateringCommand {
        CateringCommand::RecordBalance {
            payment: id(payment),
            amount: BALANCE,
        }
    }

    fn closed() -> CateringState {
        step(invoiced(), balance(20), "2026-11-25T10:00:00-07:00").unwrap()
    }

    /// Runs commands from `state`, folding each event on its own, and returns every edge taken.
    fn edges(
        mut state: CateringState,
        cmds: &[(CateringCommand, &str)],
    ) -> Vec<(Option<CateringStatus>, CateringStatus)> {
        let mut out = Vec::new();
        for (cmd, now) in cmds {
            let events = Catering::decide(&state, cmd, &ctx_at(now))
                .unwrap_or_else(|e| panic!("{cmd:?} at {now}: {e}"));
            assert!(!events.is_empty(), "{cmd:?} at {now} emitted nothing");
            for e in &events {
                let before = state.status();
                state = Catering::evolve(state, e);
                out.push((before, state.status().unwrap()));
            }
        }
        out
    }

    #[test]
    fn every_edge_of_the_diagram_is_walked() {
        use CateringCommand as C;
        let mut walked = BTreeSet::new();
        let happy = [
            (submit_cmd(inquiry()), NOW),
            (C::SendQuote { total: None }, NOW),
            (
                C::FireReminder {
                    kind: ReminderKind::FollowUp,
                },
                "2026-11-06T07:00:00-07:00",
            ),
            (C::AcceptQuote, ACCEPTED_AT),
            (deposit(10), PAID_AT),
            (
                C::FireReminder {
                    kind: ReminderKind::EventSoon,
                },
                "2026-11-19T07:00:00-07:00",
            ),
            (C::StartProduction, EVENT_MORNING),
            (C::MarkDelivered, DELIVERED_AT),
            (invoice_cmd(20), "2026-11-21T12:00:00-07:00"),
            (
                C::FireReminder {
                    kind: ReminderKind::InvoiceDue,
                },
                "2026-11-28T07:00:00-07:00",
            ),
            (balance(20), "2026-11-29T10:00:00-07:00"),
        ];
        let happy_edges = edges(CateringState::default(), &happy);
        assert_eq!(
            happy_edges.last(),
            Some(&(Some(S::Paid), S::Closed)),
            "paid, then closed in the same decide"
        );
        walked.extend(happy_edges);
        walked.extend(edges(
            submitted(),
            &[(
                C::Decline {
                    reason: DeclineReason::OverCapacity,
                },
                NOW,
            )],
        ));
        walked.extend(edges(
            quoted(),
            &[(C::ExpireQuote, "2026-11-19T07:00:00-07:00")],
        ));
        walked.extend(edges(
            accepted(),
            &[
                (C::LapseDeposit, "2026-11-04T09:15:00-07:00"),
                (C::AcceptQuote, "2026-11-05T09:00:00-07:00"),
                (deposit(11), "2026-11-05T09:01:00-07:00"),
                (
                    C::Cancel {
                        by: CancelledBy::Customer,
                        reason: CancelReason::CustomerChange,
                    },
                    "2026-11-06T09:00:00-07:00",
                ),
            ],
        ));
        // The deposit lands after the hold lapsed: it still confirms.
        walked.extend(edges(
            accepted(),
            &[
                (C::LapseDeposit, "2026-11-04T09:20:00-07:00"),
                (deposit(10), "2026-11-04T09:21:00-07:00"),
            ],
        ));
        // A reminder in production: production started before event_soon was due.
        let early = step(confirmed(), C::StartProduction, "2026-11-18T05:00:00-07:00").unwrap();
        walked.extend(edges(
            early,
            &[(
                C::FireReminder {
                    kind: ReminderKind::EventSoon,
                },
                "2026-11-19T07:00:00-07:00",
            )],
        ));
        let expected: BTreeSet<_> = TRANSITIONS.iter().copied().collect();
        assert_eq!(walked, expected);
    }

    #[test]
    fn an_inquiry_is_received_with_its_brief() {
        let (state, events) = execute::<Catering>(
            CateringState::default(),
            &submit_cmd(inquiry()),
            &ctx_at(NOW),
        )
        .unwrap();
        assert_eq!(
            events,
            [CateringEvent::CateringInquiryReceived {
                catering: id(1),
                customer: id(2),
                date: date(DATE),
                headcount: 40,
                package: "breakfast-spread".into(),
                venue: "v3".into(),
                brief: Some("Two trays without nuts, please".into()),
            }]
        );
        assert_eq!(state.status(), Some(S::Inquiry));
        // A blank brief is no brief.
        let mut blank = inquiry();
        blank.brief = Some("  \n ".into());
        let s = step(CateringState::default(), submit_cmd(blank), NOW).unwrap();
        assert_eq!(s.record().unwrap().brief, None);
        // A second inquiry into the same object is out of order.
        assert_eq!(
            decide(&state, submit_cmd(inquiry()), NOW)
                .unwrap_err()
                .rule(),
            "out-of-order"
        );
        assert_eq!(
            decide(&CateringState::default(), CateringCommand::AcceptQuote, NOW),
            Err(CateringError::OutOfOrder {
                command: "AcceptQuote",
                status: None
            })
        );
    }

    fn refused(edit: impl FnOnce(&mut SubmitInquiry)) -> CateringError {
        let mut s = inquiry();
        edit(&mut s);
        decide(&CateringState::default(), submit_cmd(s), NOW).unwrap_err()
    }

    #[test]
    fn an_inquiry_is_refused_by_rule() {
        assert_eq!(refused(|s| s.headcount = 9).rule(), "headcount");
        assert_eq!(refused(|s| s.headcount = 201).rule(), "headcount");
        assert!(
            decide(
                &CateringState::default(),
                submit_cmd(SubmitInquiry {
                    headcount: 10,
                    ..inquiry()
                }),
                NOW
            )
            .is_ok()
        );
        assert!(
            decide(
                &CateringState::default(),
                submit_cmd(SubmitInquiry {
                    headcount: 200,
                    ..inquiry()
                }),
                NOW
            )
            .is_ok()
        );
        assert_eq!(
            refused(|s| s.package = "wedding-cake".into()),
            CateringError::UnknownPackage("wedding-cake".into())
        );
        assert_eq!(refused(|s| s.venue = "v7".into()).rule(), "unknown-venue");
        // Monday 2026-11-23.
        assert_eq!(
            refused(|s| s.date = date("2026-11-23")),
            CateringError::ClosedDay
        );
        let long = refused(|s| s.brief = Some("a".repeat(501)));
        assert_eq!(long.rule(), "brief-too-long");
        assert!(
            decide(
                &CateringState::default(),
                submit_cmd(SubmitInquiry {
                    brief: Some("a".repeat(500)),
                    ..inquiry()
                }),
                NOW
            )
            .is_ok()
        );
        for (text, rule) in [
            ("write to fern@example.com about it", "brief-email"),
            ("call 555 0100 at the door", "brief-phone"),
            ("pay with 4242 4242 4242 4242", "brief-card-number"),
            ("the menu is at www.example.org", "brief-url"),
        ] {
            let e = refused(|s| s.brief = Some(text.into()));
            assert_eq!(e.rule(), rule, "{text}");
            assert!(e.is_inquiry_rule());
            // The refusal names the class and never echoes the text.
            assert!(!e.to_string().contains(text), "{e}");
        }
    }

    #[test]
    fn the_lead_is_seven_business_days_across_a_monday() {
        // From Tuesday 2026-11-03: Wed to Sun are 5, Monday is closed, Tue 10 and Wed 11 make 7.
        assert_eq!(earliest_date(at(NOW)), date("2026-11-11"));
        let six_days_out = refused(|s| s.date = date("2026-11-10"));
        assert_eq!(
            six_days_out,
            CateringError::Lead {
                earliest: date("2026-11-11")
            }
        );
        assert_eq!(six_days_out.rule(), "catering-lead");
        assert_eq!(
            six_days_out.to_string(),
            "a catering event needs 7 business days' notice (Tuesday to Sunday); the earliest date is 2026-11-11"
        );
        assert!(
            decide(
                &CateringState::default(),
                submit_cmd(SubmitInquiry {
                    date: date("2026-11-11"),
                    ..inquiry()
                }),
                NOW
            )
            .is_ok()
        );
        // From Saturday 2026-11-07 the Monday falls inside the count: Sunday the 15th is the 7th.
        assert_eq!(
            earliest_date(at("2026-11-07T12:00:00-07:00")),
            date("2026-11-15")
        );
        // From the closed Monday itself, the count starts on the Tuesday.
        assert_eq!(
            earliest_date(at("2026-11-09T12:00:00-07:00")),
            date("2026-11-17")
        );
    }

    #[test]
    fn the_lead_reads_denvers_day_across_the_daylight_transitions() {
        // 23:30 on Friday 2026-10-30 in Denver (daylight time) is already Saturday in UTC. The
        // count is from Friday: Sat 31, Sun 1 (the clocks go back), Tue 3 to Sat 7.
        let late_friday = at("2026-10-31T05:30:00+00:00");
        assert_eq!(BakeryDate::of(late_friday), date("2026-10-30"));
        assert_eq!(earliest_date(late_friday), date("2026-11-07"));
        let q = quote(Cents(10_000), late_friday).unwrap();
        // The quote is valid until 07:00 standard time, two weeks of open days on.
        assert_eq!(q.valid_until.to_string(), "2026-11-15T07:00:00-07:00");
        assert_eq!(q.follow_up_at.to_string(), "2026-11-03T07:00:00-07:00");
        // Spring forward, Sunday 2027-03-14: from Friday the 12th, Sat 13, Sun 14, Tue 16 ...
        // Sat 20 is the 7th, and the quote runs to 07:00 daylight time on Sunday the 28th.
        let friday = at("2027-03-12T16:00:00-07:00");
        assert_eq!(earliest_date(friday), date("2027-03-20"));
        let q = quote(Cents(10_000), friday).unwrap();
        assert_eq!(q.valid_until.to_string(), "2027-03-28T07:00:00-06:00");
        // The deposit hold is 15 minutes of elapsed time, whatever the clock shows.
        let s = step(
            CateringState::default(),
            submit_cmd(SubmitInquiry {
                date: date("2026-11-14"),
                ..inquiry()
            }),
            "2026-10-25T10:00:00-06:00",
        )
        .unwrap();
        let s = step(
            s,
            CateringCommand::SendQuote { total: None },
            "2026-10-25T10:00:00-06:00",
        )
        .unwrap();
        let s = step(s, CateringCommand::AcceptQuote, "2026-11-01T01:50:00-06:00").unwrap();
        assert_eq!(
            s.record().unwrap().lapses_at.unwrap().to_string(),
            "2026-11-01T01:05:00-07:00"
        );
    }

    #[test]
    fn a_quote_prices_the_package_and_splits_the_deposit() {
        let (state, events) = execute::<Catering>(
            submitted(),
            &CateringCommand::SendQuote { total: None },
            &ctx_at(NOW),
        )
        .unwrap();
        assert_eq!(
            events,
            [CateringEvent::CateringQuoteSent {
                total_cents: TOTAL,
                deposit_cents: DEPOSIT,
                valid_until: at("2026-11-19T07:00:00-07:00"),
                follow_up_at: at("2026-11-06T07:00:00-07:00"),
            }]
        );
        let q = state.record().unwrap().quote.unwrap();
        assert_eq!(q.balance, BALANCE);
        // A staff override: $123.50, a $30.88 deposit (30.875 rounded half-up) and the rest.
        let s = step(
            submitted(),
            CateringCommand::SendQuote {
                total: Some(Cents(12_350)),
            },
            NOW,
        )
        .unwrap();
        let q = s.record().unwrap().quote.unwrap();
        assert_eq!((q.deposit, q.balance), (Cents(3_088), Cents(9_262)));
        for bad in [Cents(0), Cents(-5)] {
            assert_eq!(
                decide(
                    &submitted(),
                    CateringCommand::SendQuote { total: Some(bad) },
                    NOW
                ),
                Err(CateringError::QuoteTotal)
            );
        }
        // Quoted once: a second quote is out of order.
        assert_eq!(
            decide(&state, CateringCommand::SendQuote { total: None }, NOW)
                .unwrap_err()
                .rule(),
            "out-of-order"
        );
        assert_eq!(
            decide(
                &state,
                CateringCommand::Decline {
                    reason: DeclineReason::Other
                },
                NOW
            )
            .unwrap_err()
            .rule(),
            "out-of-order"
        );
    }

    #[test]
    fn a_quote_is_accepted_until_it_expires() {
        let s = quoted();
        let valid_until = "2026-11-19T07:00:00-07:00";
        assert!(
            decide(
                &s,
                CateringCommand::AcceptQuote,
                "2026-11-19T06:59:59-07:00"
            )
            .is_ok()
        );
        assert_eq!(
            decide(&s, CateringCommand::AcceptQuote, valid_until),
            Err(CateringError::QuoteExpired {
                valid_until: at(valid_until)
            })
        );
        // The quote's timer: early, nothing; on time, expired; again, nothing.
        assert_eq!(
            decide(
                &s,
                CateringCommand::ExpireQuote,
                "2026-11-18T07:00:00-07:00"
            ),
            Ok(vec![])
        );
        let (expired, events) =
            execute::<Catering>(s, &CateringCommand::ExpireQuote, &ctx_at(valid_until)).unwrap();
        assert_eq!(
            events,
            [CateringEvent::CateringQuoteExpired {
                reason: Some("14 business days".into())
            }]
        );
        assert_eq!(expired.status(), Some(S::Expired));
        assert_eq!(
            decide(&expired, CateringCommand::ExpireQuote, valid_until),
            Ok(vec![])
        );
        assert_eq!(
            decide(&expired, CateringCommand::AcceptQuote, valid_until)
                .unwrap_err()
                .rule(),
            "quote-expired"
        );
        // An accepted quote does not expire, and a second accept is a no-op.
        let a = accepted();
        assert_eq!(
            decide(&a, CateringCommand::ExpireQuote, valid_until),
            Ok(vec![])
        );
        assert_eq!(
            decide(&a, CateringCommand::AcceptQuote, PAID_AT),
            Ok(vec![])
        );
    }

    #[test]
    fn accepting_asks_for_the_days_place() {
        let a = accepted();
        let r = a.record().unwrap();
        assert_eq!(
            r.lapses_at.unwrap().to_string(),
            "2026-11-04T09:15:00-07:00"
        );
        assert_eq!(
            hold_request(&a),
            Some(HoldRequest {
                reference: id(1),
                kind: HoldKind::Catering,
                start: at("2026-11-21T07:00:00-07:00"),
                zone: None,
                lines: vec![ItemQty {
                    item: "breakfast-spread".into(),
                    qty: 40
                }],
                expires_at: at("2026-11-04T09:15:00-07:00"),
            })
        );
        assert_eq!(hold_request(&quoted()), None);
        assert_eq!(hold_request(&confirmed()), None);
        assert_eq!(
            timers(&a),
            [Timer {
                kind: TimerKind::DepositLapse,
                at: at("2026-11-04T09:15:00-07:00")
            }]
        );
    }

    #[test]
    fn the_deposit_hold_lapses_and_a_late_deposit_still_confirms() {
        let a = accepted();
        // Early, nothing.
        assert_eq!(
            decide(
                &a,
                CateringCommand::LapseDeposit,
                "2026-11-04T09:14:59-07:00"
            ),
            Ok(vec![])
        );
        let (lapsed, events) = execute::<Catering>(
            a,
            &CateringCommand::LapseDeposit,
            &ctx_at("2026-11-04T09:15:00-07:00"),
        )
        .unwrap();
        assert_eq!(events, [CateringEvent::CateringDepositLapsed {}]);
        assert_eq!(lapsed.status(), Some(S::Quoted));
        assert_eq!(hold_request(&lapsed), None);
        // Quoted again: the quote's expiry and the follow-up are armed again.
        let kinds: Vec<TimerKind> = timers(&lapsed).into_iter().map(|t| t.kind).collect();
        assert_eq!(
            kinds,
            [
                TimerKind::Reminder(ReminderKind::FollowUp),
                TimerKind::QuoteExpiry
            ]
        );
        assert_eq!(
            decide(
                &lapsed,
                CateringCommand::LapseDeposit,
                "2026-11-04T09:30:00-07:00"
            ),
            Ok(vec![])
        );
        // The deposit lands after the lapse: the money moved, so it confirms.
        let late = step(lapsed.clone(), deposit(10), "2026-11-04T09:30:00-07:00").unwrap();
        assert_eq!(late.status(), Some(S::Confirmed));
        assert_eq!(
            late.record().unwrap().deposit,
            Some(Paid {
                payment: id(10),
                amount: DEPOSIT
            })
        );
        // Or it is accepted again and held again, with a new lapse.
        let again = step(
            lapsed,
            CateringCommand::AcceptQuote,
            "2026-11-05T09:00:00-07:00",
        )
        .unwrap();
        assert_eq!(
            hold_request(&again).unwrap().expires_at.to_string(),
            "2026-11-05T09:15:00-07:00"
        );
        // A quote never accepted takes no deposit.
        assert_eq!(
            decide(&quoted(), deposit(10), NOW).unwrap_err().rule(),
            "out-of-order"
        );
        // Nor does an expired one, even after an acceptance (a question for the report).
        let expired = step(
            step(
                accepted(),
                CateringCommand::LapseDeposit,
                "2026-11-04T09:20:00-07:00",
            )
            .unwrap(),
            CateringCommand::ExpireQuote,
            "2026-11-19T07:00:00-07:00",
        )
        .unwrap();
        assert_eq!(
            decide(&expired, deposit(10), "2026-11-19T08:00:00-07:00")
                .unwrap_err()
                .rule(),
            "out-of-order"
        );
    }

    #[test]
    fn a_deposit_delivered_twice_is_recorded_once() {
        let c = confirmed();
        assert_eq!(decide(&c, deposit(10), PAID_AT), Ok(vec![]));
        assert_eq!(
            decide(&c, deposit(11), PAID_AT).unwrap_err().rule(),
            "out-of-order"
        );
        assert_eq!(
            decide(
                &accepted(),
                CateringCommand::RecordDeposit {
                    payment: id(10),
                    amount: Cents(14_499)
                },
                PAID_AT
            ),
            Err(CateringError::AmountMismatch {
                paid: Cents(14_499),
                expected: DEPOSIT
            })
        );
    }

    #[test]
    fn production_delivery_invoice_and_balance_close_the_event() {
        let c = confirmed();
        let p = step(c, CateringCommand::StartProduction, EVENT_MORNING).unwrap();
        assert_eq!(
            decide(&p, CateringCommand::StartProduction, EVENT_MORNING),
            Ok(vec![])
        );
        let (d, events) =
            execute::<Catering>(p, &CateringCommand::MarkDelivered, &ctx_at(DELIVERED_AT)).unwrap();
        // Billing raises the invoice from this event: the balance, due a week later.
        assert_eq!(
            events,
            [CateringEvent::CateringDelivered {
                customer: id(2),
                balance_cents: BALANCE,
                due: date("2026-11-28")
            }]
        );
        assert_eq!(
            decide(&d, CateringCommand::MarkDelivered, DELIVERED_AT),
            Ok(vec![])
        );
        assert_eq!(
            decide(
                &d,
                CateringCommand::RecordInvoice {
                    invoice: id(20),
                    amount: Cents(1),
                    due: date("2026-11-28")
                },
                DELIVERED_AT
            )
            .unwrap_err()
            .rule(),
            "amount-mismatch"
        );
        let i = step(d, invoice_cmd(20), DELIVERED_AT).unwrap();
        assert_eq!(i.status(), Some(S::Invoiced));
        // InvoiceIssued redelivered: one invoice.
        assert_eq!(decide(&i, invoice_cmd(20), DELIVERED_AT), Ok(vec![]));
        assert_eq!(
            decide(&i, invoice_cmd(21), DELIVERED_AT)
                .unwrap_err()
                .rule(),
            "out-of-order"
        );
        assert_eq!(
            decide(
                &i,
                CateringCommand::RecordBalance {
                    payment: id(20),
                    amount: DEPOSIT
                },
                DELIVERED_AT
            )
            .unwrap_err()
            .rule(),
            "amount-mismatch"
        );
        let (closed, events) =
            execute::<Catering>(i, &balance(20), &ctx_at("2026-11-25T10:00:00-07:00")).unwrap();
        assert_eq!(
            events,
            [
                CateringEvent::CateringBalancePaid { payment: id(20) },
                CateringEvent::CateringClosed {
                    payment: Some(id(20))
                }
            ]
        );
        assert_eq!(closed.status(), Some(S::Closed));
        // The balance's PaymentSucceeded again: nothing; another payment: refused.
        assert_eq!(decide(&closed, balance(20), DELIVERED_AT), Ok(vec![]));
        assert_eq!(
            decide(&closed, balance(21), DELIVERED_AT)
                .unwrap_err()
                .rule(),
            "out-of-order"
        );
        // Deposit plus balance is the quote.
        let r = closed.record().unwrap();
        let q = r.quote.unwrap();
        assert_eq!(
            r.deposit.unwrap().amount.0 + r.invoice.unwrap().amount.0,
            q.total.0
        );
    }

    #[test]
    fn a_cancellation_refunds_the_deposit_only_more_than_seven_days_out() {
        let cancel = CateringCommand::Cancel {
            by: CancelledBy::Staff,
            reason: CancelReason::VenueLost,
        };
        // The 21st is 8 days after the 13th: refunded. From the 14th, 7 days: kept.
        let (s, events) =
            execute::<Catering>(confirmed(), &cancel, &ctx_at("2026-11-13T23:59:00-07:00"))
                .unwrap();
        assert_eq!(
            events,
            [CateringEvent::CateringCancelled {
                refund_deposit: true,
                by: CancelledBy::Staff,
                reason: CancelReason::VenueLost
            }]
        );
        assert_eq!(s.status(), Some(S::Cancelled));
        assert_eq!(s.record().unwrap().refund_deposit, Some(true));
        assert_eq!(
            decide(&confirmed(), cancel.clone(), "2026-11-14T07:00:00-07:00"),
            Ok(vec![CateringEvent::CateringCancelled {
                refund_deposit: false,
                by: CancelledBy::Staff,
                reason: CancelReason::VenueLost
            }])
        );
        // From any other state, out of order.
        for state in [
            submitted(),
            quoted(),
            accepted(),
            delivered(),
            invoiced(),
            closed(),
            s,
        ] {
            assert_eq!(
                decide(&state, cancel.clone(), NOW).unwrap_err().rule(),
                "out-of-order",
                "{:?}",
                state.status()
            );
        }
        let in_production =
            step(confirmed(), CateringCommand::StartProduction, EVENT_MORNING).unwrap();
        assert_eq!(
            decide(&in_production, cancel, EVENT_MORNING).unwrap_err(),
            CateringError::OutOfOrder {
                command: "Cancel",
                status: Some(S::InProduction)
            }
        );
        assert_eq!(
            CateringError::OutOfOrder {
                command: "Cancel",
                status: Some(S::InProduction)
            }
            .to_string(),
            "Cancel does not apply to a catering event that is in_production"
        );
    }

    #[test]
    fn reminders_are_due_by_state_and_recorded_once() {
        assert_eq!(
            reminders(&quoted()),
            [Reminder {
                kind: ReminderKind::FollowUp,
                at: at("2026-11-06T07:00:00-07:00")
            }]
        );
        let follow_up = CateringCommand::FireReminder {
            kind: ReminderKind::FollowUp,
        };
        // Early: nothing.
        assert_eq!(
            decide(&quoted(), follow_up.clone(), "2026-11-06T06:59:00-07:00"),
            Ok(vec![])
        );
        let (s, events) =
            execute::<Catering>(quoted(), &follow_up, &ctx_at("2026-11-06T07:00:00-07:00"))
                .unwrap();
        assert_eq!(
            events,
            [CateringEvent::CateringReminderDue {
                kind: ReminderKind::FollowUp
            }]
        );
        // Fired twice, recorded once, and no longer listed.
        assert_eq!(
            decide(&s, follow_up.clone(), "2026-11-06T07:01:00-07:00"),
            Ok(vec![])
        );
        assert_eq!(reminders(&s), []);
        // A reminder whose condition no longer holds: the follow-up of an accepted quote.
        assert_eq!(
            decide(&accepted(), follow_up, "2026-11-07T07:00:00-07:00"),
            Ok(vec![])
        );
        assert_eq!(
            reminders(&confirmed()),
            [Reminder {
                kind: ReminderKind::EventSoon,
                at: at("2026-11-19T07:00:00-07:00")
            }]
        );
        assert_eq!(
            reminders(&invoiced()),
            [Reminder {
                kind: ReminderKind::InvoiceDue,
                at: at("2026-11-28T07:00:00-07:00")
            }]
        );
        assert_eq!(reminders(&delivered()), []);
        assert_eq!(reminders(&submitted()), []);
        assert_eq!(
            TimerKind::Reminder(ReminderKind::FollowUp).row_name(),
            "reminder:follow_up"
        );
        assert_eq!(
            TimerKind::QuoteExpiry.command(),
            CateringCommand::ExpireQuote
        );
    }

    #[test]
    fn every_terminal_state_has_no_reminders_and_no_timers() {
        let declined = step(
            submitted(),
            CateringCommand::Decline {
                reason: DeclineReason::TooSoon,
            },
            NOW,
        )
        .unwrap();
        assert_eq!(
            decide(
                &declined,
                CateringCommand::Decline {
                    reason: DeclineReason::TooSoon
                },
                NOW
            ),
            Ok(vec![])
        );
        let expired = step(
            quoted(),
            CateringCommand::ExpireQuote,
            "2026-11-19T07:00:00-07:00",
        )
        .unwrap();
        let cancelled = step(
            confirmed(),
            CateringCommand::Cancel {
                by: CancelledBy::Customer,
                reason: CancelReason::Other,
            },
            NOW,
        )
        .unwrap();
        for s in [declined, expired, cancelled, closed()] {
            assert!(s.status().unwrap().is_terminal());
            assert_eq!(reminders(&s), [], "{:?}", s.status());
            assert_eq!(timers(&s), [], "{:?}", s.status());
            for kind in [
                ReminderKind::FollowUp,
                ReminderKind::EventSoon,
                ReminderKind::InvoiceDue,
            ] {
                assert_eq!(
                    decide(
                        &s,
                        CateringCommand::FireReminder { kind },
                        "2027-01-01T07:00:00-07:00"
                    ),
                    Ok(vec![])
                );
            }
        }
    }

    fn envelope(seq: u64, event: &CateringEvent) -> Envelope {
        Envelope {
            v: 1,
            id: id(50_000 + u128::from(seq)),
            sandbox: id(7),
            stream: format!("catering:{}:{}", id(7), id(1)),
            seq,
            event_type: event.name().to_owned(),
            at: at(NOW),
            recorded_at: WallTime::from_unix_ms(1_793_000_000_000).unwrap(),
            data: event.to_data(),
            cause: None,
        }
    }

    #[test]
    fn every_event_round_trips_through_an_envelope() {
        let events = [
            CateringEvent::CateringInquiryReceived {
                catering: id(1),
                customer: id(2),
                date: date(DATE),
                headcount: 40,
                package: "lunch-boxes".into(),
                venue: "v1".into(),
                brief: None,
            },
            CateringEvent::CateringQuoteSent {
                total_cents: TOTAL,
                deposit_cents: DEPOSIT,
                valid_until: at("2026-11-19T07:00:00-07:00"),
                follow_up_at: at("2026-11-06T07:00:00-07:00"),
            },
            CateringEvent::CateringQuoteAccepted {
                lapses_at: at("2026-11-04T09:15:00-07:00"),
            },
            CateringEvent::CateringDepositLapsed {},
            CateringEvent::CateringQuoteExpired {
                reason: Some(EXPIRY_REASON.into()),
            },
            CateringEvent::CateringDeclined {
                reason: DeclineReason::TooSoon,
            },
            CateringEvent::CateringDepositPaid {
                payment: id(10),
                amount_cents: DEPOSIT,
            },
            CateringEvent::CateringReminderDue {
                kind: ReminderKind::InvoiceDue,
            },
            CateringEvent::CateringProductionStarted {},
            CateringEvent::CateringDelivered {
                customer: id(2),
                balance_cents: BALANCE,
                due: date("2026-11-28"),
            },
            CateringEvent::CateringBalanceInvoiced {
                invoice: id(20),
                amount_cents: BALANCE,
                due: date("2026-11-28"),
            },
            CateringEvent::CateringBalancePaid { payment: id(20) },
            CateringEvent::CateringClosed { payment: None },
            CateringEvent::CateringCancelled {
                refund_deposit: true,
                by: CancelledBy::Customer,
                reason: CancelReason::CustomerChange,
            },
        ];
        let names: BTreeSet<&str> = events.iter().map(DomainEvent::name).collect();
        assert_eq!(names.len(), CateringEvent::NAMES.len());
        for (seq, e) in events.iter().enumerate() {
            let env = envelope(seq as u64 + 1, e);
            let text = serde_json::to_string(&env).unwrap();
            let back: Envelope = serde_json::from_str(&text).unwrap();
            assert_eq!(CateringEvent::from_envelope(&back).unwrap(), *e);
        }
        // The wire names, as the catalog writes them.
        assert_eq!(
            envelope(1, &events[7]).data,
            serde_json::json!({ "kind": "invoice_due" })
        );
        assert_eq!(
            envelope(1, &events[13]).data,
            serde_json::json!({ "refund_deposit": true, "by": "customer", "reason": "customer_change" })
        );
        assert_eq!(envelope(1, &events[3]).data, serde_json::json!({}));
        // An inquiry written without a brief reads back with none.
        let mut data = events[0].to_data();
        data.as_object_mut().unwrap().remove("brief");
        assert_eq!(
            CateringEvent::from_parts("CateringInquiryReceived", &data).unwrap(),
            events[0]
        );
    }

    #[test]
    fn the_packages_and_venues_are_the_seeds() {
        assert_eq!(
            package("breakfast-spread").unwrap().per_head_cents,
            Cents(1_450)
        );
        assert_eq!(package("Breakfast-spread"), None);
        assert_eq!(VENUES.len(), 6);
    }

    proptest! {
        #[test]
        fn deposit_plus_balance_is_the_total(total in 1i64..=1_000_000_000) {
            let q = quote(Cents(total), at(NOW)).unwrap();
            prop_assert_eq!(q.deposit.0 + q.balance.0, total);
            prop_assert!(q.deposit >= Cents::ZERO && q.balance >= Cents::ZERO);
            // 25% rounded half-up: within half a cent of the exact quarter.
            prop_assert!((i128::from(q.deposit.0) * 4 - i128::from(total)).abs() <= 2);
            prop_assert_eq!(q.deposit, Cents(total).apply_bp(DEPOSIT_BP).unwrap());
        }
    }

    // The state-machine property test: random commands at random business times.

    /// Stand in for the quote's deposit and balance in generated payments, swapped in by the
    /// loop, so most payments match and some do not.
    const THE_DEPOSIT: Cents = Cents(-7_777);
    const THE_BALANCE: Cents = Cents(-8_888);

    fn command() -> impl Strategy<Value = CateringCommand> {
        use CateringCommand as C;
        let ids = || prop::sample::select(vec![10u128, 11, 20, 21]).prop_map(id);
        let deposit =
            || prop::sample::select(vec![THE_DEPOSIT, THE_DEPOSIT, THE_BALANCE, Cents(1)]);
        let balance =
            || prop::sample::select(vec![THE_BALANCE, THE_BALANCE, THE_DEPOSIT, Cents(1)]);
        let kind = prop::sample::select(vec![
            ReminderKind::FollowUp,
            ReminderKind::EventSoon,
            ReminderKind::InvoiceDue,
        ]);
        prop_oneof![
            1 => (5u16..210, any::<bool>()).prop_map(|(headcount, venue_ok)| submit_cmd(SubmitInquiry {
                headcount,
                venue: if venue_ok { "v2".into() } else { "v9".into() },
                ..inquiry()
            })),
            4 => prop::option::of(prop::sample::select(vec![Cents(0), Cents(1), Cents(12_350)]))
                .prop_map(|total| C::SendQuote { total }),
            1 => Just(C::Decline { reason: DeclineReason::Other }),
            4 => Just(C::AcceptQuote),
            2 => Just(C::LapseDeposit),
            5 => (ids(), deposit()).prop_map(|(payment, amount)| C::RecordDeposit { payment, amount }),
            2 => kind.prop_map(|kind| C::FireReminder { kind }),
            1 => Just(C::ExpireQuote),
            4 => Just(C::StartProduction),
            4 => Just(C::MarkDelivered),
            4 => (ids(), balance()).prop_map(|(invoice, amount)| C::RecordInvoice {
                invoice,
                amount,
                due: date("2026-11-28"),
            }),
            4 => (ids(), balance()).prop_map(|(payment, amount)| C::RecordBalance { payment, amount }),
            1 => prop::sample::select(vec![CancelledBy::Customer, CancelledBy::Staff])
                .prop_map(|by| C::Cancel { by, reason: CancelReason::Other }),
        ]
    }

    fn swap_amounts(cmd: &CateringCommand, state: &CateringState) -> CateringCommand {
        let q = state.record().and_then(|r| r.quote);
        let real = |a: Cents| match (a, q) {
            (THE_DEPOSIT, Some(q)) => q.deposit,
            (THE_BALANCE, Some(q)) => q.balance,
            (THE_DEPOSIT | THE_BALANCE, None) => Cents(1),
            (a, _) => a,
        };
        match cmd {
            CateringCommand::RecordDeposit { payment, amount } => CateringCommand::RecordDeposit {
                payment: *payment,
                amount: real(*amount),
            },
            CateringCommand::RecordInvoice {
                invoice,
                amount,
                due,
            } => CateringCommand::RecordInvoice {
                invoice: *invoice,
                amount: real(*amount),
                due: *due,
            },
            CateringCommand::RecordBalance { payment, amount } => CateringCommand::RecordBalance {
                payment: *payment,
                amount: real(*amount),
            },
            other => other.clone(),
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        #[test]
        fn no_sequence_reaches_an_undefined_state(
            steps in proptest::collection::vec(
                (prop::sample::select(vec![0i64, 0, 1, 1, 10, 60, 1_440, 4_320, 10_080]), command()),
                1..80,
            ),
        ) {
            let first = (0i64, submit_cmd(inquiry()));
            let steps: Vec<(i64, CateringCommand)> = std::iter::once(first).chain(steps).collect();
            let mut state = CateringState::default();
            let mut log: Vec<CateringEvent> = Vec::new();
            let mut now = at(NOW);
            let mut seen = BTreeSet::new();
            for (minutes, cmd) in &steps {
                now = plus_elapsed_minutes(now, *minutes).unwrap();
                let cmd = swap_amounts(cmd, &state);
                let ctx = DecideContext { now, id: id(99) };
                let Ok(events) = Catering::decide(&state, &cmd, &ctx) else {
                    continue;
                };
                let mut next = state.clone();
                for e in &events {
                    let before = next.status();
                    next = Catering::evolve(next, e);
                    let edge = (before, next.status().unwrap());
                    prop_assert!(TRANSITIONS.contains(&edge), "{edge:?} by {cmd:?}");
                    // Every event round-trips through an envelope's type and data.
                    prop_assert_eq!(&CateringEvent::from_parts(e.name(), &e.to_data()).unwrap(), e);
                }
                if events.is_empty() {
                    prop_assert_eq!(&next, &state, "an empty decide changed the state");
                }
                // A repeat of the same command, at the same time, changes nothing or is refused.
                if let Ok(again) = Catering::decide(&next, &cmd, &ctx) {
                    let unchanged = again.iter().fold(next.clone(), Catering::evolve);
                    prop_assert!(again.is_empty() || matches!(cmd, CateringCommand::SubmitInquiry(_)),
                        "{cmd:?} repeated emitted {again:?}");
                    prop_assert_eq!(unchanged, next.clone());
                }
                log.extend(events);
                state = next;
                if let Some(r) = state.record() {
                    seen.insert(r.status);
                    if let Some(q) = r.quote {
                        // Deposit plus balance is the quote.
                        prop_assert_eq!(q.deposit.0 + q.balance.0, q.total.0);
                    }
                    if let Some(d) = r.deposit {
                        prop_assert_eq!(Some(d.amount), r.quote.map(|q| q.deposit));
                    }
                    if r.status.is_terminal() {
                        prop_assert!(reminders(&state).is_empty());
                        prop_assert!(timers(&state).is_empty());
                    }
                    if matches!(r.status, S::Confirmed | S::InProduction | S::Delivered | S::Invoiced | S::Paid | S::Closed) {
                        prop_assert!(r.deposit.is_some());
                    }
                    prop_assert_eq!(hold_request(&state).is_some(), r.status == S::Accepted);
                }
            }
            // Every reachable state is one of the diagram's, and the state is the fold of its log.
            let in_diagram: BTreeSet<CateringStatus> = TRANSITIONS.iter().map(|(_, to)| *to).collect();
            prop_assert!(seen.is_subset(&in_diagram));
            prop_assert_eq!(replay::<Catering>(&log), state);
        }
    }
}
