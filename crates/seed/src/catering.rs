//! The command sequence that rebuilds each seeded catering event through the aggregate's own
//! `decide` (docs/domain.md, "The seed": 8 catering events across the lifecycle). The Worker
//! seeds a `CateringEvent` object by running these, so its log is one the aggregate could have
//! written, and the seed's record is never a second source of truth.
//!
//! Every time comes from the record: the inquiry at `created_at`, the quote at `quoted_at`, the
//! acceptance at `accepted_at`, the deposit five minutes later, production at 05:00 on the event
//! day, delivery at `delivered_at`, the invoice an hour after it and, for a closed event, the
//! balance three days after the invoice. A reminder that falls due between two steps, in the
//! state it is due in, is fired between them; one due after the last step is left for the
//! Worker's first alarm, so a sandbox can be born with a reminder already due.

use bakery_domain::calendar::plus_elapsed_minutes;
use bakery_domain::catering::{
    Catering, CateringCommand, CateringState as Saga, DeclineReason, SubmitInquiry, reminders,
};
use bakery_domain::{BakeryDate, BusinessTime, Cents, DecideContext, Ulid, execute};

use crate::{CateringEvent, CateringState};

fn later(t: BusinessTime, minutes: i64) -> BusinessTime {
    plus_elapsed_minutes(t, minutes).expect("seed times are far inside the year range")
}

/// The commands, in business-time order, that take an empty `CateringEvent` to the state the
/// seed's record describes, reminders included.
pub fn seed_commands(e: &CateringEvent) -> Vec<(BusinessTime, CateringCommand)> {
    let date: BakeryDate = e.date.parse().expect("the seed writes YYYY-MM-DD");
    let mut steps = vec![(
        e.created_at,
        CateringCommand::SubmitInquiry(Box::new(SubmitInquiry {
            catering: e.id,
            customer: e.customer,
            date,
            headcount: u16::try_from(e.headcount).expect("10 to 200"),
            package: e.package.to_owned(),
            venue: e.venue.clone(),
            brief: e.brief.clone(),
        })),
    )];
    if e.state == CateringState::Declined {
        steps.push((
            later(e.created_at, 120),
            CateringCommand::Decline {
                reason: DeclineReason::Other,
            },
        ));
    }
    if let Some(t) = e.quoted_at {
        // The package's price per head: the quote the seed already computed.
        steps.push((t, CateringCommand::SendQuote { total: None }));
    }
    if let Some(t) = e.accepted_at {
        steps.push((t, CateringCommand::AcceptQuote));
    }
    if let (Some(t), Some(payment), Some(amount)) =
        (e.accepted_at, e.deposit_payment, e.deposit_cents)
    {
        steps.push((
            later(t, 5),
            CateringCommand::RecordDeposit { payment, amount },
        ));
    }
    if let (Some(delivered), Some(invoice), Some(due), Some(balance)) =
        (e.delivered_at, e.invoice, e.invoice_due, e.balance_cents)
    {
        steps.push((date.at_local(5 * 60), CateringCommand::StartProduction));
        steps.push((delivered, CateringCommand::MarkDelivered));
        let invoiced = later(delivered, 60);
        steps.push((
            invoiced,
            CateringCommand::RecordInvoice {
                invoice,
                amount: balance,
                due,
            },
        ));
        if e.state == CateringState::Closed {
            steps.push((later(invoiced, 3 * 24 * 60), balance_paid(invoice, balance)));
        }
    }
    with_reminders(steps)
}

/// `Billing` keys a balance's payment by its invoice.
fn balance_paid(invoice: Ulid, amount: Cents) -> CateringCommand {
    CateringCommand::RecordBalance {
        payment: invoice,
        amount,
    }
}

/// `steps` with each reminder that falls due before the next step fired just before it.
fn with_reminders(
    steps: Vec<(BusinessTime, CateringCommand)>,
) -> Vec<(BusinessTime, CateringCommand)> {
    let mut out = Vec::with_capacity(steps.len() + 3);
    let mut state = Saga::default();
    let run = |state: Saga, t: BusinessTime, cmd: &CateringCommand| {
        let ctx = DecideContext {
            now: t,
            id: Ulid::from_parts(0, 0),
        };
        execute::<Catering>(state.clone(), cmd, &ctx).map_or(state, |(s, _)| s)
    };
    for (t, cmd) in steps {
        for r in reminders(&state) {
            if r.at <= t {
                let fire = CateringCommand::FireReminder { kind: r.kind };
                state = run(state, r.at, &fire);
                out.push((r.at, fire));
            }
        }
        state = run(state, t, &cmd);
        out.push((t, cmd));
    }
    out
}
