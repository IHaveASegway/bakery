//! Stripe, as data (ADR 0007; docs/security.md, "Payments safety"). Platform-free: the Worker's
//! adapter in `workers/api` sends what this module builds and hands back what it receives.
//!
//! - [`form`]: bodies in bracket notation.
//! - [`wire`]: the objects read from responses and webhooks.
//! - [`request`]: the calls, their idempotency keys and the readers of their answers: the
//!   intents and refunds (PR 5), and the customer and the balance invoice (PR 7).
//! - [`webhook`]: the signature check, the parse, the mode check and the Billing command.
//! - [`keys`]: what a key is, from its prefix.
//!
//! The facts it is written against are Stripe's documentation as of 2026-11-05
//! (https://docs.stripe.com/api); spike S3 confirms them against the real sandbox.

pub mod form;
pub mod keys;
pub mod request;
pub mod webhook;
pub mod wire;

pub use form::Form;
pub use keys::{KeyKind, KeyRole, is_sandbox_secret_key, is_webhook_secret, key_role};
pub use request::{
    API_BASE, CURRENCY, Call, Method, StripeFailure, StripeRequest, cancel_intent, confirm_intent,
    create_customer, create_intent, create_invoice_draft, create_refund, customer_key,
    days_until_due, delete_customer, finalize_invoice, idempotency_key, invoice_item, parse,
    pay_invoice_test, read_customer, read_deleted, read_intent, read_intent_created, read_invoice,
    read_invoice_created, read_invoice_item, read_refund, retrieve_intent, retrieve_invoice,
    snapshot, void_invoice,
};
pub use webhook::{TOLERANCE_S, WebhookError, parse_event, signature_header, verify_signature};
pub use wire::{
    Charge, Customer, Deleted, ErrorBody, EventData, EventObject, Invoice, InvoiceItem, Metadata,
    PaymentError, PaymentIntent, Refund, RefundStatus, StripeError, StripeEvent,
    StripeIntentStatus, StripeInvoiceStatus,
};

/// The whole path with the fake gateway in Stripe's place: what the Worker's `Billing` object
/// does, in order, without the platform.
#[cfg(test)]
mod flow_tests {
    use bakery_domain::billing::{
        Billing, BillingCommand, BillingEvent, BillingState, Ledger, Purpose, WebhookOutcome,
    };
    use bakery_domain::order::RefundReason;
    use bakery_domain::{Cents, DecideContext, Ulid, execute};

    use super::*;
    use crate::ports::{
        ConfirmRequest, IntentRequest, PaymentGateway, RefundIntentRequest, TestCard,
    };
    use crate::test_support::{FakeGateway, block_on};

    const SECRET: &str = "whsec_fake0000000000000000000000000000";
    const NOW_S: i64 = 1_793_900_000;

    fn ulid(n: u128) -> Ulid {
        Ulid::from_parts(1_793_819_530_318, n)
    }

    fn ctx(n: u128) -> DecideContext {
        DecideContext {
            now: "2026-11-07T09:00:00-07:00".parse().unwrap(),
            id: ulid(n),
        }
    }

    fn webhook_body(event: &str, event_type: &str, object: &str) -> String {
        format!(
            r#"{{"id":"{event}","object":"event","type":"{event_type}","livemode":false,"created":{NOW_S},"data":{{"object":{object}}}}}"#
        )
    }

    /// Signs, verifies, parses and applies one webhook, as the route and Billing do.
    fn deliver(state: &BillingState, body: &str, n: u128) -> (BillingState, Vec<BillingEvent>) {
        let header = signature_header(SECRET, NOW_S - 30, body.as_bytes());
        verify_signature(&header, body.as_bytes(), SECRET, NOW_S, TOLERANCE_S).unwrap();
        let event = parse_event(body.as_bytes()).unwrap();
        event.require_test().unwrap();
        assert_eq!(event.sandbox(), Some(ulid(1)));
        let cmd = event.billing_command().unwrap();
        execute::<Billing>(state.clone(), &cmd, &ctx(n)).unwrap()
    }

    #[test]
    fn pay_replay_refund_and_net_to_zero() {
        let gateway = FakeGateway::new();
        let (sandbox, order, payment) = (ulid(1), ulid(2), ulid(3));
        let mut log = Vec::new();

        // Create the payment, then the intent at Stripe under the payment's key.
        let (state, events) = execute::<Billing>(
            BillingState::default(),
            &BillingCommand::CreateIntent {
                payment,
                purpose: Purpose::Order,
                reference: order,
                amount: Cents(2_090),
            },
            &ctx(90),
        )
        .unwrap();
        log.extend(events);
        let p = state.payment(payment).unwrap();
        let created = block_on(gateway.create_intent(IntentRequest {
            sandbox,
            payment,
            purpose: p.purpose,
            reference: p.reference,
            amount: p.amount,
            idempotency_key: idempotency_key(Call::Create, order, Purpose::Order, p.attempt),
        }))
        .unwrap();
        let (state, events) = execute::<Billing>(
            state,
            &BillingCommand::RecordIntent {
                payment,
                stripe_id: created.provider_id.clone(),
                client_secret_seen: !created.client_secret.is_empty(),
            },
            &ctx(91),
        )
        .unwrap();
        log.extend(events);

        // The browser (here the server-side test card) pays; Stripe posts the webhook.
        let intent = created.provider_id.clone();
        block_on(gateway.confirm_intent(ConfirmRequest {
            intent: intent.clone(),
            card: TestCard::Visa,
            idempotency_key: idempotency_key(Call::Confirm, order, Purpose::Order, 1),
        }))
        .unwrap();
        let succeeded = webhook_body(
            "evt_fake_1",
            "payment_intent.succeeded",
            &format!(
                r#"{{"id":"{intent}","object":"payment_intent","amount":2090,"currency":"usd","status":"succeeded","livemode":false,"metadata":{{"sandbox":"{sandbox}","payment":"{payment}","purpose":"order","ref":"{order}"}}}}"#
            ),
        );
        let (mut state, events) = deliver(&state, &succeeded, 92);
        assert!(matches!(
            events.as_slice(),
            [BillingEvent::PaymentSucceeded { .. }]
        ));
        log.extend(events);

        // Delivered five more times, it changes nothing.
        for n in 0..5 {
            let event = parse_event(succeeded.as_bytes()).unwrap();
            let BillingCommand::ApplyEvent { event_id, kind } = event.billing_command().unwrap()
            else {
                unreachable!()
            };
            assert_eq!(
                Billing::apply_webhook(&state, &event_id, &kind, &ctx(100 + n)),
                Ok(WebhookOutcome::Replayed)
            );
            let (again, events) = deliver(&state, &succeeded, 100 + n);
            assert!(events.is_empty());
            assert_eq!(again, state);
        }

        // A partial refund, then the rest; the gateway answers each, and Stripe's webhook for
        // the second arrives too.
        for (n, amount) in [(30u128, Some(Cents(500))), (40, None)] {
            let (next, events) = execute::<Billing>(
                state,
                &BillingCommand::RequestRefund {
                    payment,
                    amount,
                    reason: RefundReason::Goodwill,
                },
                &ctx(n),
            )
            .unwrap();
            log.extend(events);
            let r = next.refund(ulid(n)).unwrap().clone();
            let p = next.payment(payment).unwrap();
            let issued = block_on(gateway.refund(RefundIntentRequest {
                sandbox,
                payment,
                refund: ulid(n),
                purpose: p.purpose,
                reference: p.reference,
                intent: intent.clone(),
                amount: r.amount,
                reason: RefundReason::Goodwill,
                idempotency_key: idempotency_key(Call::Refund, order, Purpose::Order, r.ordinal),
            }))
            .unwrap();
            let (next, events) = execute::<Billing>(
                next,
                &BillingCommand::RecordRefund {
                    payment,
                    refund: ulid(n),
                    stripe_refund: issued.provider_id.clone(),
                    amount: issued.amount,
                },
                &ctx(n + 1),
            )
            .unwrap();
            assert_eq!(events.len(), 1);
            log.extend(events);
            let refunded = webhook_body(
                &format!("evt_fake_refund_{n}"),
                "refund.created",
                &format!(
                    r#"{{"id":"{}","object":"refund","amount":{},"status":"succeeded","payment_intent":"{intent}","metadata":{{"sandbox":"{sandbox}","refund":"{}"}}}}"#,
                    issued.provider_id,
                    issued.amount.0,
                    ulid(n)
                ),
            );
            let (next, events) = deliver(&next, &refunded, n + 2);
            assert!(events.is_empty(), "the refund was recorded already");
            state = next;
        }

        let ledger = Ledger::from_events(
            log.iter()
                .map(|e| ("2026-11-07T09:00:00-07:00".parse().unwrap(), e)),
        );
        assert_eq!(ledger.paid(order), Cents(2_090));
        assert_eq!(ledger.net(order), Cents::ZERO);
        assert_eq!(state.payment(payment).unwrap().refunded, Cents(2_090));
        // Create, confirm, two refunds.
        assert_eq!(gateway.calls().len(), 4);
    }

    /// The balance: delivered, invoiced at Stripe against a customer with no email, paid on the
    /// test path, and the webhook closes the catering job. Redelivered, it changes nothing.
    #[test]
    fn a_balance_invoice_from_delivery_to_closed() {
        use crate::ports::{CustomerRequest, InvoiceRequest, InvoiceStatus};
        use bakery_domain::BakeryDate;
        use bakery_domain::catering::{
            Catering, CateringCommand, CateringEvent, CateringState, CateringStatus, SubmitInquiry,
        };

        let gateway = FakeGateway::new();
        let (sandbox, job, persona, invoice) = (ulid(1), ulid(5), ulid(7), ulid(8));
        let at = |t: &str| DecideContext {
            now: t.parse().unwrap(),
            id: ulid(99),
        };
        // The job, walked to delivered.
        let mut job_state = CateringState::default();
        let mut delivered = None;
        for (cmd, t) in [
            (
                CateringCommand::SubmitInquiry(Box::new(SubmitInquiry {
                    catering: job,
                    customer: persona,
                    date: "2026-11-21".parse().unwrap(),
                    headcount: 40,
                    package: "breakfast-spread".into(),
                    venue: "v3".into(),
                    brief: None,
                })),
                "2026-11-03T10:00:00-07:00",
            ),
            (
                CateringCommand::SendQuote { total: None },
                "2026-11-03T10:00:00-07:00",
            ),
            (CateringCommand::AcceptQuote, "2026-11-04T09:00:00-07:00"),
            (
                CateringCommand::RecordDeposit {
                    payment: ulid(10),
                    amount: Cents(14_500),
                },
                "2026-11-04T09:05:00-07:00",
            ),
            (
                CateringCommand::StartProduction,
                "2026-11-21T05:00:00-07:00",
            ),
            (CateringCommand::MarkDelivered, "2026-11-21T11:00:00-07:00"),
        ] {
            let (next, events) = execute::<Catering>(job_state, &cmd, &at(t)).unwrap();
            delivered = events.into_iter().last();
            job_state = next;
        }
        let Some(CateringEvent::CateringDelivered {
            customer,
            balance_cents,
            due,
        }) = delivered
        else {
            panic!("{delivered:?}");
        };
        assert_eq!(due, "2026-11-28".parse::<BakeryDate>().unwrap());

        // Billing, on CateringDelivered: the check, the customer, the invoice, the record.
        let now = at("2026-11-21T11:00:05-07:00");
        let create = BillingCommand::CreateInvoice {
            invoice,
            customer,
            reference: job,
            amount: balance_cents,
            due,
        };
        let (billing, none) = execute::<Billing>(BillingState::default(), &create, &now).unwrap();
        assert!(none.is_empty());
        let cus = block_on(gateway.create_customer(CustomerRequest {
            sandbox,
            persona: customer,
            idempotency_key: customer_key(sandbox, customer),
        }))
        .unwrap();
        let made = block_on(gateway.create_invoice(InvoiceRequest {
            sandbox,
            invoice,
            customer: cus.provider_id.clone(),
            reference: job,
            amount: balance_cents,
            due,
            today: "2026-11-21".parse().unwrap(),
            idempotency_key: idempotency_key(Call::Invoice, job, Purpose::Balance, 1),
        }))
        .unwrap();
        assert_eq!(made.status, InvoiceStatus::Open);
        let (billing, issued) = execute::<Billing>(
            billing,
            &BillingCommand::RecordInvoice {
                invoice,
                customer,
                reference: job,
                amount: balance_cents,
                due,
                stripe_id: made.provider_id.clone(),
                stripe_customer: cus.provider_id.clone(),
            },
            &now,
        )
        .unwrap();
        let [
            BillingEvent::InvoiceIssued {
                invoice: issued_id,
                amount_cents,
                due: issued_due,
                ..
            },
        ] = issued.as_slice()
        else {
            panic!("{issued:?}");
        };
        // The job records it.
        let (job_state, _) = execute::<Catering>(
            job_state,
            &CateringCommand::RecordInvoice {
                invoice: *issued_id,
                amount: *amount_cents,
                due: *issued_due,
            },
            &now,
        )
        .unwrap();
        assert_eq!(job_state.status(), Some(CateringStatus::Invoiced));

        // Paid on the test path; Stripe posts invoice.paid with the invoice's metadata.
        let key = idempotency_key(Call::Pay, job, Purpose::Balance, 1);
        let paid = block_on(gateway.pay_invoice_test(&made.provider_id, &key)).unwrap();
        let body = webhook_body(
            "evt_fake_invoice_1",
            "invoice.paid",
            &format!(
                r#"{{"id":"{}","object":"invoice","status":"paid","amount_due":{},"amount_paid":{},"customer":"{}","metadata":{{"sandbox":"{sandbox}","invoice":"{invoice}","purpose":"balance","ref":"{job}"}},"livemode":false}}"#,
                made.provider_id, paid.amount_due.0, paid.amount_paid.0, cus.provider_id
            ),
        );
        let (billing, events) = deliver(&billing, &body, 100);
        let [
            BillingEvent::PaymentSucceeded {
                payment,
                purpose: Purpose::Balance,
                reference,
                amount_cents,
                ..
            },
        ] = events.as_slice()
        else {
            panic!("{events:?}");
        };
        assert_eq!((*payment, *reference), (invoice, job));
        let (again, more) = deliver(&billing, &body, 101);
        assert!(more.is_empty());
        assert_eq!(again, billing);
        // The job, by purpose: paid, then closed.
        let (closed, events) = execute::<Catering>(
            job_state,
            &CateringCommand::RecordBalance {
                payment: *payment,
                amount: *amount_cents,
            },
            &at("2026-11-22T09:00:00-07:00"),
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(closed.status(), Some(CateringStatus::Closed));
        // The wipe has nothing open to void, and one customer to delete.
        assert!(billing.open_invoices().is_empty());
        assert_eq!(billing.stripe_customers(), [cus.provider_id.as_str()]);
    }
}
