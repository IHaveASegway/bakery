//! Fakes for the ports, deterministic so a test can state exact times and ids.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use bakery_domain::{BusinessTime, Cents, Ulid, WallTime};

use crate::ports::{
    CancelRequest, ConfirmRequest, CustomerCreated, CustomerRequest, IntentCreated, IntentRequest,
    IntentSnapshot, IntentStatus, InvoiceCreated, InvoiceRequest, InvoiceSnapshot, InvoiceStatus,
    Mailbox, Note, PaymentGateway, PortError, RefundCreated, RefundIntentRequest, TestCard,
};
use crate::{Clock, IdGen};

/// Runs a future that never waits, such as a call on [`FakeGateway`], to its end. Panics on one
/// that would wait: a fake that suspends is a test's bug.
pub fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut cx) {
        Poll::Ready(out) => out,
        Poll::Pending => panic!("a fake's future waited"),
    }
}

/// A clock that stands still until told to move. Business time is wall time plus an offset.
#[derive(Debug)]
pub struct FixedClock {
    wall_ms: Cell<i64>,
    business_offset_ms: Cell<i64>,
    utc_offset_minutes: i16,
}

impl FixedClock {
    /// Panics on a time outside 0000 to 9999: a test's typo, not a case to handle.
    pub fn at(wall: &str, utc_offset_minutes: i16) -> FixedClock {
        let wall: WallTime = wall.parse().expect("a canonical wall time");
        FixedClock {
            wall_ms: Cell::new(wall.unix_ms()),
            business_offset_ms: Cell::new(0),
            utc_offset_minutes,
        }
    }

    /// Moves wall time, and business time with it.
    pub fn advance_wall_ms(&self, ms: i64) {
        self.wall_ms.set(self.wall_ms.get() + ms);
    }

    /// Moves business time alone, as "Advance time" does.
    pub fn advance_business_ms(&self, ms: i64) {
        self.business_offset_ms
            .set(self.business_offset_ms.get() + ms);
    }
}

impl Clock for FixedClock {
    fn now_wall(&self) -> WallTime {
        WallTime::from_unix_ms(self.wall_ms.get()).expect("wall time in range")
    }

    fn now_business(&self) -> BusinessTime {
        let ms = self.wall_ms.get() + self.business_offset_ms.get();
        BusinessTime::new(ms, self.utc_offset_minutes).expect("business time in range")
    }
}

/// ULIDs whose time part is a fixed millisecond and whose random part counts up from 1.
#[derive(Debug)]
pub struct SequentialIds {
    unix_ms: u64,
    next: Cell<u128>,
}

impl SequentialIds {
    pub fn starting_at(unix_ms: u64) -> SequentialIds {
        SequentialIds {
            unix_ms,
            next: Cell::new(1),
        }
    }
}

impl IdGen for SequentialIds {
    fn ulid(&self) -> Ulid {
        let n = self.next.get();
        self.next.set(n + 1);
        Ulid::from_parts(self.unix_ms, n)
    }
}

/// One call the gateway was asked to make, as it was asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayCall {
    Create(IntentRequest),
    Confirm(ConfirmRequest),
    Cancel(CancelRequest),
    Refund(RefundIntentRequest),
    Retrieve(String),
    CreateCustomer(CustomerRequest),
    DeleteCustomer(String),
    CreateInvoice(InvoiceRequest),
    /// `(invoice, idempotency key)`.
    VoidInvoice(String, String),
    PayInvoice(String, String),
}

impl GatewayCall {
    fn idempotency_key(&self) -> Option<&str> {
        match self {
            GatewayCall::Create(r) => Some(&r.idempotency_key),
            GatewayCall::Confirm(r) => Some(&r.idempotency_key),
            GatewayCall::Cancel(r) => Some(&r.idempotency_key),
            GatewayCall::Refund(r) => Some(&r.idempotency_key),
            GatewayCall::CreateCustomer(r) => Some(&r.idempotency_key),
            GatewayCall::CreateInvoice(r) => Some(&r.idempotency_key),
            GatewayCall::VoidInvoice(_, key) | GatewayCall::PayInvoice(_, key) => Some(key),
            GatewayCall::Retrieve(_) | GatewayCall::DeleteCustomer(_) => None,
        }
    }
}

#[derive(Debug, Clone)]
enum Answer {
    Created(IntentCreated),
    Snapshot(IntentSnapshot),
    Refund(RefundCreated),
    Customer(CustomerCreated),
    Deleted,
    Invoice(InvoiceSnapshot),
}

#[derive(Debug, Clone)]
struct FakeInvoice {
    customer: String,
    amount: Cents,
    status: InvoiceStatus,
}

impl FakeInvoice {
    fn snapshot(&self, id: &str) -> InvoiceSnapshot {
        InvoiceSnapshot {
            provider_id: id.to_owned(),
            status: self.status,
            amount_due: self.amount,
            amount_paid: if self.status == InvoiceStatus::Paid {
                self.amount
            } else {
                Cents::ZERO
            },
        }
    }
}

#[derive(Debug, Clone)]
struct FakeIntent {
    amount: Cents,
    status: IntentStatus,
    failure: Option<String>,
    refunded: Cents,
}

/// A gateway that behaves like Stripe's sandbox in miniature: ids `pi_fake_<n>`, `re_fake_<n>`,
/// `cus_fake_<n>` and `in_fake_<n>`, `pm_card_visa` succeeds and `pm_card_chargeDeclined`
/// declines with `card_declined`, a refund past what is left is `amount_too_large`, an invoice
/// is raised open (finalized) for a customer it knows, paid or voided only while open, and an
/// idempotency key returns its first answer, or `idempotency_error` with a different request.
/// It records every call, and [`FakeGateway::fail_next`] scripts an error for the next one.
#[derive(Debug, Default)]
pub struct FakeGateway {
    calls: RefCell<Vec<GatewayCall>>,
    failures: RefCell<VecDeque<PortError>>,
    intents: RefCell<BTreeMap<String, FakeIntent>>,
    customers: RefCell<BTreeMap<String, CustomerRequest>>,
    invoices: RefCell<BTreeMap<String, FakeInvoice>>,
    answers: RefCell<BTreeMap<String, (GatewayCall, Answer)>>,
    next: Cell<u32>,
}

impl FakeGateway {
    pub fn new() -> FakeGateway {
        FakeGateway::default()
    }

    /// Every call so far, in order, including the ones that failed.
    pub fn calls(&self) -> Vec<GatewayCall> {
        self.calls.borrow().clone()
    }

    /// The next call answers `error` and changes nothing; several queue up.
    pub fn fail_next(&self, error: PortError) {
        self.failures.borrow_mut().push_back(error);
    }

    /// An intent's status, as a test reads it.
    pub fn status(&self, intent: &str) -> Option<IntentStatus> {
        self.intents.borrow().get(intent).map(|i| i.status)
    }

    /// An invoice's status, as a test reads it.
    pub fn invoice_status(&self, invoice: &str) -> Option<InvoiceStatus> {
        self.invoices.borrow().get(invoice).map(|i| i.status)
    }

    /// The customers that exist, as a test reads them.
    pub fn customers(&self) -> Vec<String> {
        self.customers.borrow().keys().cloned().collect()
    }

    fn with_invoice(
        &self,
        invoice: &str,
        f: impl FnOnce(&mut FakeInvoice) -> Result<(), PortError>,
    ) -> Result<Answer, PortError> {
        let mut invoices = self.invoices.borrow_mut();
        let i = invoices
            .get_mut(invoice)
            .ok_or_else(|| PortError::Rejected("resource_missing".into()))?;
        f(i)?;
        Ok(Answer::Invoice(i.snapshot(invoice)))
    }

    fn id(&self, prefix: &str) -> String {
        let n = self.next.get() + 1;
        self.next.set(n);
        format!("{prefix}_fake_{n}")
    }

    fn snapshot(id: &str, i: &FakeIntent) -> IntentSnapshot {
        IntentSnapshot {
            provider_id: id.to_owned(),
            status: i.status,
            amount: i.amount,
            failure_code: i.failure.clone(),
        }
    }

    /// Records the call, plays a scripted failure or a stored answer, or else runs `act` and
    /// stores its answer under the call's key.
    fn call(
        &self,
        call: GatewayCall,
        act: impl FnOnce(&FakeGateway) -> Result<Answer, PortError>,
    ) -> Result<Answer, PortError> {
        self.calls.borrow_mut().push(call.clone());
        if let Some(error) = self.failures.borrow_mut().pop_front() {
            return Err(error);
        }
        let key = call.idempotency_key().map(str::to_owned);
        if let Some(key) = &key
            && let Some((first, answer)) = self.answers.borrow().get(key)
        {
            return if *first == call {
                Ok(answer.clone())
            } else {
                Err(PortError::Rejected("idempotency_error".into()))
            };
        }
        let answer = act(self)?;
        if let Some(key) = key {
            self.answers
                .borrow_mut()
                .insert(key, (call, answer.clone()));
        }
        Ok(answer)
    }

    fn with_intent<T>(
        &self,
        intent: &str,
        f: impl FnOnce(&mut FakeIntent) -> Result<T, PortError>,
    ) -> Result<T, PortError> {
        let mut intents = self.intents.borrow_mut();
        let i = intents
            .get_mut(intent)
            .ok_or_else(|| PortError::Rejected("resource_missing".into()))?;
        f(i)
    }
}

fn invoice_of(answer: Answer) -> InvoiceSnapshot {
    match answer {
        Answer::Invoice(s) => s,
        other => panic!("not an invoice: {other:?}"),
    }
}

fn snapshot_of(answer: Answer) -> IntentSnapshot {
    match answer {
        Answer::Snapshot(s) => s,
        other => panic!("not a snapshot: {other:?}"),
    }
}

impl PaymentGateway for FakeGateway {
    async fn create_intent(&self, request: IntentRequest) -> Result<IntentCreated, PortError> {
        let amount = request.amount;
        let answer = self.call(GatewayCall::Create(request), |g| {
            let id = g.id("pi");
            g.intents.borrow_mut().insert(
                id.clone(),
                FakeIntent {
                    amount,
                    status: IntentStatus::AwaitingPayment,
                    failure: None,
                    refunded: Cents::ZERO,
                },
            );
            Ok(Answer::Created(IntentCreated {
                client_secret: format!("{id}_secret_fake"),
                provider_id: id,
                status: IntentStatus::AwaitingPayment,
            }))
        })?;
        match answer {
            Answer::Created(c) => Ok(c),
            other => panic!("not a created intent: {other:?}"),
        }
    }

    async fn confirm_intent(&self, request: ConfirmRequest) -> Result<IntentSnapshot, PortError> {
        let (intent, card) = (request.intent.clone(), request.card);
        self.call(GatewayCall::Confirm(request), |g| {
            g.with_intent(&intent, |i| {
                if i.status != IntentStatus::AwaitingPayment {
                    return Err(PortError::Rejected(
                        "payment_intent_unexpected_state".into(),
                    ));
                }
                match card {
                    TestCard::Visa => {
                        i.status = IntentStatus::Succeeded;
                        i.failure = None;
                    }
                    TestCard::ChargeDeclined => i.failure = Some("card_declined".into()),
                }
                Ok(Answer::Snapshot(FakeGateway::snapshot(&intent, i)))
            })
        })
        .map(snapshot_of)
    }

    async fn cancel_intent(&self, request: CancelRequest) -> Result<IntentSnapshot, PortError> {
        let intent = request.intent.clone();
        self.call(GatewayCall::Cancel(request), |g| {
            g.with_intent(&intent, |i| {
                if i.status == IntentStatus::Succeeded {
                    return Err(PortError::Rejected(
                        "payment_intent_unexpected_state".into(),
                    ));
                }
                i.status = IntentStatus::Canceled;
                Ok(Answer::Snapshot(FakeGateway::snapshot(&intent, i)))
            })
        })
        .map(snapshot_of)
    }

    async fn refund(&self, request: RefundIntentRequest) -> Result<RefundCreated, PortError> {
        let (intent, amount) = (request.intent.clone(), request.amount);
        let answer = self.call(GatewayCall::Refund(request), |g| {
            g.with_intent(&intent, |i| {
                if i.status != IntentStatus::Succeeded {
                    return Err(PortError::Rejected("charge_not_found".into()));
                }
                let left = Cents(i.amount.0 - i.refunded.0);
                if left == Cents::ZERO {
                    return Err(PortError::Rejected("charge_already_refunded".into()));
                }
                if amount > left {
                    return Err(PortError::Rejected("amount_too_large".into()));
                }
                i.refunded = Cents(i.refunded.0 + amount.0);
                Ok(())
            })?;
            Ok(Answer::Refund(RefundCreated {
                provider_id: g.id("re"),
                amount,
                succeeded: true,
            }))
        })?;
        match answer {
            Answer::Refund(r) => Ok(r),
            other => panic!("not a refund: {other:?}"),
        }
    }

    async fn retrieve_intent(&self, intent: &str) -> Result<IntentSnapshot, PortError> {
        self.call(GatewayCall::Retrieve(intent.to_owned()), |g| {
            g.with_intent(intent, |i| {
                Ok(Answer::Snapshot(FakeGateway::snapshot(intent, i)))
            })
        })
        .map(snapshot_of)
    }

    async fn create_customer(
        &self,
        request: CustomerRequest,
    ) -> Result<CustomerCreated, PortError> {
        let answer = self.call(GatewayCall::CreateCustomer(request.clone()), |g| {
            let id = g.id("cus");
            g.customers.borrow_mut().insert(id.clone(), request);
            Ok(Answer::Customer(CustomerCreated { provider_id: id }))
        })?;
        match answer {
            Answer::Customer(c) => Ok(c),
            other => panic!("not a customer: {other:?}"),
        }
    }

    async fn delete_customer(&self, customer: &str) -> Result<(), PortError> {
        self.call(GatewayCall::DeleteCustomer(customer.to_owned()), |g| {
            // Gone already is no error, as `stripe::read_deleted` reads Stripe's 404.
            g.customers.borrow_mut().remove(customer);
            Ok(Answer::Deleted)
        })
        .map(|_| ())
    }

    async fn create_invoice(&self, request: InvoiceRequest) -> Result<InvoiceCreated, PortError> {
        let (customer, amount) = (request.customer.clone(), request.amount);
        let answer = self.call(GatewayCall::CreateInvoice(request), |g| {
            if !g.customers.borrow().contains_key(&customer) {
                return Err(PortError::Rejected("resource_missing".into()));
            }
            if amount <= Cents::ZERO {
                return Err(PortError::Rejected("parameter_invalid_integer".into()));
            }
            let id = g.id("in");
            let invoice = FakeInvoice {
                customer,
                amount,
                status: InvoiceStatus::Open,
            };
            let snapshot = invoice.snapshot(&id);
            g.invoices.borrow_mut().insert(id, invoice);
            Ok(Answer::Invoice(snapshot))
        })?;
        let s = invoice_of(answer);
        Ok(InvoiceCreated {
            provider_id: s.provider_id,
            status: s.status,
        })
    }

    async fn void_invoice(
        &self,
        invoice: &str,
        idempotency_key: &str,
    ) -> Result<InvoiceSnapshot, PortError> {
        let call = GatewayCall::VoidInvoice(invoice.to_owned(), idempotency_key.to_owned());
        self.call(call, |g| {
            g.with_invoice(invoice, |i| {
                if i.status != InvoiceStatus::Open {
                    return Err(PortError::Rejected("invoice_not_editable".into()));
                }
                i.status = InvoiceStatus::Void;
                Ok(())
            })
        })
        .map(invoice_of)
    }

    async fn pay_invoice_test(
        &self,
        invoice: &str,
        idempotency_key: &str,
    ) -> Result<InvoiceSnapshot, PortError> {
        let call = GatewayCall::PayInvoice(invoice.to_owned(), idempotency_key.to_owned());
        self.call(call, |g| {
            let known = |c: &str| g.customers.borrow().contains_key(c);
            g.with_invoice(invoice, |i| {
                if i.status != InvoiceStatus::Open {
                    return Err(PortError::Rejected("invoice_unexpected_state".into()));
                }
                if !known(&i.customer) {
                    return Err(PortError::Rejected("resource_missing".into()));
                }
                i.status = InvoiceStatus::Paid;
                Ok(())
            })
        })
        .map(invoice_of)
    }
}

/// A mailbox for one sandbox that keeps what it delivers. Like every implementation, it refuses
/// a recipient outside its sandbox before delivering anything.
#[derive(Debug)]
pub struct FakeMailbox {
    sandbox: Ulid,
    delivered: RefCell<Vec<Note>>,
}

impl FakeMailbox {
    pub fn for_sandbox(sandbox: Ulid) -> FakeMailbox {
        FakeMailbox {
            sandbox,
            delivered: RefCell::new(Vec::new()),
        }
    }

    pub fn delivered(&self) -> Vec<Note> {
        self.delivered.borrow().clone()
    }
}

impl Mailbox for FakeMailbox {
    fn sandbox(&self) -> Ulid {
        self.sandbox
    }

    async fn send(&self, note: Note) -> Result<(), PortError> {
        if !self.admits(note.to) {
            return Err(PortError::Rejected("recipient-outside-sandbox".into()));
        }
        self.delivered.borrow_mut().push(note);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakery_domain::billing::Purpose;
    use bakery_domain::order::RefundReason;

    #[test]
    fn fixed_clock_moves_only_when_told() {
        let clock = FixedClock::at("2026-11-04T19:12:10.318Z", -420);
        assert_eq!(clock.now_wall().to_string(), "2026-11-04T19:12:10.318Z");
        assert_eq!(
            clock.now_business().to_string(),
            "2026-11-04T12:12:10-07:00"
        );

        clock.advance_business_ms(3 * 86_400_000);
        assert_eq!(clock.now_wall().to_string(), "2026-11-04T19:12:10.318Z");
        assert_eq!(
            clock.now_business().to_string(),
            "2026-11-07T12:12:10-07:00"
        );

        clock.advance_wall_ms(1_000);
        assert_eq!(clock.now_wall().to_string(), "2026-11-04T19:12:11.318Z");
        assert_eq!(
            clock.now_business().to_string(),
            "2026-11-07T12:12:11-07:00"
        );
    }

    #[test]
    fn sequential_ids_are_ordered_and_distinct() {
        let ids = SequentialIds::starting_at(1_793_819_530_318);
        let a = ids.ulid();
        let b = ids.ulid();
        assert!(a < b);
        assert_eq!(a.unix_ms(), 1_793_819_530_318);
        assert_eq!(b.as_u128() - a.as_u128(), 1);
    }

    #[test]
    fn fakes_serve_through_the_ports() {
        fn stamp(clock: &impl Clock, ids: &impl IdGen) -> String {
            format!("{} {}", ids.ulid(), clock.now_wall())
        }
        let clock = FixedClock::at("2026-11-04T00:00:00.000Z", 0);
        let ids = SequentialIds::starting_at(0);
        assert_eq!(
            stamp(&clock, &ids),
            "00000000000000000000000001 2026-11-04T00:00:00.000Z"
        );
    }

    fn intent_request(key: &str, amount: i64) -> IntentRequest {
        IntentRequest {
            sandbox: Ulid::from_parts(1, 1),
            payment: Ulid::from_parts(1, 2),
            purpose: Purpose::Order,
            reference: Ulid::from_parts(1, 3),
            amount: Cents(amount),
            idempotency_key: key.into(),
        }
    }

    #[test]
    fn the_fake_gateway_pays_declines_refunds_and_replays_keys() {
        let g = FakeGateway::new();
        let created = block_on(g.create_intent(intent_request("k1", 2_090))).unwrap();
        assert_eq!(created.provider_id, "pi_fake_1");
        assert_eq!(created.client_secret, "pi_fake_1_secret_fake");
        // The same key returns the first intent; with another body it is refused.
        assert_eq!(
            block_on(g.create_intent(intent_request("k1", 2_090))).unwrap(),
            created
        );
        assert_eq!(
            block_on(g.create_intent(intent_request("k1", 2_091))),
            Err(PortError::Rejected("idempotency_error".into()))
        );
        let confirm = |card, key: &str| ConfirmRequest {
            intent: "pi_fake_1".into(),
            card,
            idempotency_key: key.into(),
        };
        let declined = block_on(g.confirm_intent(confirm(TestCard::ChargeDeclined, "k2"))).unwrap();
        assert_eq!(declined.status, IntentStatus::AwaitingPayment);
        assert_eq!(declined.failure_code.as_deref(), Some("card_declined"));
        let paid = block_on(g.confirm_intent(confirm(TestCard::Visa, "k3"))).unwrap();
        assert_eq!(paid.status, IntentStatus::Succeeded);
        let refund = |amount: i64, key: &str| RefundIntentRequest {
            sandbox: Ulid::from_parts(1, 1),
            payment: Ulid::from_parts(1, 2),
            refund: Ulid::from_parts(1, 4),
            purpose: Purpose::Order,
            reference: Ulid::from_parts(1, 3),
            intent: "pi_fake_1".into(),
            amount: Cents(amount),
            reason: RefundReason::Goodwill,
            idempotency_key: key.into(),
        };
        assert_eq!(
            block_on(g.refund(refund(2_091, "k4"))),
            Err(PortError::Rejected("amount_too_large".into()))
        );
        let first = block_on(g.refund(refund(500, "k5"))).unwrap();
        assert_eq!(
            (first.provider_id.as_str(), first.amount),
            ("re_fake_2", Cents(500))
        );
        // A retried refund is the same refund, not a second one.
        assert_eq!(block_on(g.refund(refund(500, "k5"))).unwrap(), first);
        block_on(g.refund(refund(1_590, "k6"))).unwrap();
        assert_eq!(
            block_on(g.refund(refund(1, "k7"))),
            Err(PortError::Rejected("charge_already_refunded".into()))
        );
        g.fail_next(PortError::Unavailable("timeout".into()));
        assert_eq!(
            block_on(g.retrieve_intent("pi_fake_1")),
            Err(PortError::Unavailable("timeout".into()))
        );
        assert_eq!(
            block_on(g.retrieve_intent("pi_fake_1")).unwrap().status,
            IntentStatus::Succeeded
        );
        assert_eq!(
            block_on(g.cancel_intent(CancelRequest {
                intent: "pi_fake_1".into(),
                idempotency_key: "k8".into()
            })),
            Err(PortError::Rejected(
                "payment_intent_unexpected_state".into()
            ))
        );
        assert_eq!(g.calls().len(), 13);
        assert!(matches!(g.calls()[0], GatewayCall::Create(_)));
    }

    #[test]
    fn the_fake_gateway_raises_pays_and_voids_invoices() {
        let g = FakeGateway::new();
        let persona = Ulid::from_parts(1, 7);
        let customer_request = |key: &str| CustomerRequest {
            sandbox: Ulid::from_parts(1, 1),
            persona,
            idempotency_key: key.into(),
        };
        let customer = block_on(g.create_customer(customer_request("kc"))).unwrap();
        assert_eq!(customer.provider_id, "cus_fake_1");
        // The same key, the same customer.
        assert_eq!(
            block_on(g.create_customer(customer_request("kc"))).unwrap(),
            customer
        );
        let invoice = |key: &str, customer: &str| InvoiceRequest {
            sandbox: Ulid::from_parts(1, 1),
            invoice: Ulid::from_parts(1, 6),
            customer: customer.into(),
            reference: Ulid::from_parts(1, 5),
            amount: Cents(43_500),
            due: "2026-11-28".parse().unwrap(),
            today: "2026-11-21".parse().unwrap(),
            idempotency_key: key.into(),
        };
        assert_eq!(
            block_on(g.create_invoice(invoice("ki0", "cus_fake_9"))),
            Err(PortError::Rejected("resource_missing".into()))
        );
        let first = block_on(g.create_invoice(invoice("ki1", "cus_fake_1"))).unwrap();
        assert_eq!(
            first,
            InvoiceCreated {
                provider_id: "in_fake_2".into(),
                status: InvoiceStatus::Open
            }
        );
        assert_eq!(
            block_on(g.create_invoice(invoice("ki1", "cus_fake_1"))).unwrap(),
            first
        );
        let paid = block_on(g.pay_invoice_test("in_fake_2", "kp")).unwrap();
        assert_eq!(paid.status, InvoiceStatus::Paid);
        assert_eq!(paid.amount_paid, Cents(43_500));
        // A retried payment is the first answer; a paid invoice cannot be voided.
        assert_eq!(
            block_on(g.pay_invoice_test("in_fake_2", "kp")).unwrap(),
            paid
        );
        assert_eq!(
            block_on(g.void_invoice("in_fake_2", "kv")),
            Err(PortError::Rejected("invoice_not_editable".into()))
        );
        let second = block_on(g.create_invoice(invoice("ki2", "cus_fake_1"))).unwrap();
        let voided = block_on(g.void_invoice(&second.provider_id, "kv2")).unwrap();
        assert_eq!(voided.status, InvoiceStatus::Void);
        assert_eq!(
            g.invoice_status(&second.provider_id),
            Some(InvoiceStatus::Void)
        );
        assert_eq!(
            block_on(g.pay_invoice_test(&second.provider_id, "kp2")),
            Err(PortError::Rejected("invoice_unexpected_state".into()))
        );
        // The wipe deletes the customer, and a second delete is no error.
        block_on(g.delete_customer("cus_fake_1")).unwrap();
        block_on(g.delete_customer("cus_fake_1")).unwrap();
        assert!(g.customers().is_empty());
    }

    #[test]
    fn no_mailbox_can_address_a_recipient_outside_its_sandbox() {
        use crate::ports::Recipient;
        let ours = Ulid::from_parts(1_793_000_000_000, 7);
        let theirs = Ulid::from_parts(1_793_000_000_000, 8);
        let customer = Ulid::from_parts(1_793_000_000_000, 1);
        let mailbox = FakeMailbox::for_sandbox(ours);
        let note = |to| Note {
            to,
            subject: "Your order is ready".into(),
            body: "Your order of 2 items is ready at the counter.".into(),
        };
        // Another sandbox's customer, even one with the same customer id: refused, and nothing
        // delivered.
        let foreign = Recipient::new(theirs, customer);
        assert!(!mailbox.admits(foreign));
        assert_eq!(
            block_on(mailbox.send(note(foreign))),
            Err(PortError::Rejected("recipient-outside-sandbox".into()))
        );
        assert!(mailbox.delivered().is_empty());
        // Its own customer: delivered.
        let own = Recipient::new(ours, customer);
        block_on(mailbox.send(note(own))).unwrap();
        assert_eq!(mailbox.delivered(), [note(own)]);
        assert_eq!(own.customer(), customer);
        // The shape: a note's recipient is a `Recipient`, two ids, never a string; the
        // compile-fail examples on `Recipient` prove it cannot be built from text.
        let to: Recipient = note(own).to;
        let _: (Ulid, Ulid) = (to.sandbox(), to.customer());
    }
}
