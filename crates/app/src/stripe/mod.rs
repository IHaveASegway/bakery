//! Stripe, as data (ADR 0007; docs/security.md, "Payments safety"). Platform-free: the Worker's
//! adapter in `workers/api` sends what this module builds and hands back what it receives.
//!
//! - [`form`]: bodies in bracket notation.
//! - [`wire`]: the objects read from responses and webhooks.
//! - [`request`]: the five calls, their idempotency keys and the readers of their answers.
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
    create_intent, create_refund, idempotency_key, parse, read_intent, read_intent_created,
    read_refund, retrieve_intent, snapshot,
};
pub use webhook::{TOLERANCE_S, WebhookError, parse_event, signature_header, verify_signature};
pub use wire::{
    Charge, ErrorBody, EventData, EventObject, Metadata, PaymentError, PaymentIntent, Refund,
    RefundStatus, StripeError, StripeEvent, StripeIntentStatus,
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
}
