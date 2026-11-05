// The catering page: a saga by alarm, seen from the customer's side.
import type { TourStep } from '../lib/tour';
import { HOW } from './how';
import { IDEMPOTENCY, LEASE, PAYMENTS, SAGA } from './principles';

export const CATERING: TourStep[] = [
  {
    id: 'catering-events',
    screen: 'catering',
    target: 'catering-events',
    title: 'Your events',
    what: HOW.catering,
    events: ['CateringInquiryReceived'],
    principle: SAGA,
    api: {
      routeId: 'list-catering',
      method: 'GET',
      path: '/v1/sandboxes/{id}/catering',
      note: 'Your events, newest first. One event: GET /v1/sandboxes/{id}/catering/{cid}.',
    },
  },
  {
    id: 'catering-inquiry',
    screen: 'catering',
    target: 'catering-inquiry',
    title: 'Asking about an event',
    what: 'Pick a day, a headcount, a package and a venue; the brief is optional. The page checks what it can, but the API decides: a day must be open and at least seven business days ahead, and the brief may hold no email, phone number, card number or link.',
    events: ['CateringInquiryReceived'],
    principle: IDEMPOTENCY,
    api: {
      routeId: 'create-catering',
      method: 'POST',
      path: '/v1/sandboxes/{id}/catering',
      body: { date: '2026-11-20', headcount: 40, package: 'breakfast-spread', venue: 'v3' },
      note: '201 with the event. A refused inquiry is 422 catering, naming the rule and never echoing the brief.',
    },
  },
  {
    id: 'catering-accept',
    screen: 'catering',
    target: 'catering-detail',
    title: 'Accepting the quote',
    what: 'Accepting holds one of the day’s two catering places, for 15 minutes of bakery time, until the deposit arrives. If the deposit lapses, the place is released and the quote is open again.',
    events: ['CateringQuoteAccepted', 'SlotHeld'],
    principle: LEASE,
    api: {
      routeId: 'accept-quote',
      method: 'POST',
      path: '/v1/sandboxes/{id}/catering/{cid}/accept',
      note: 'No body.',
    },
  },
  {
    id: 'catering-deposit',
    screen: 'catering',
    target: 'catering-detail',
    title: 'Paying the deposit',
    what: 'The deposit is paid with Stripe’s test card, exactly like an order. The place is only confirmed when Stripe’s webhook says it succeeded.',
    events: ['PaymentIntentCreated', 'PaymentSucceeded', 'CateringDepositPaid'],
    principle: PAYMENTS,
    api: {
      routeId: 'catering-deposit',
      method: 'POST',
      path: '/v1/sandboxes/{id}/catering/{cid}/deposit',
      note: 'Returns the client secret for the Payment Element. The catering id is the idempotency key.',
    },
  },
  {
    id: 'catering-balance',
    screen: 'catering',
    target: 'catering-detail',
    title: 'Paying the balance',
    what: 'After delivery the balance invoice arrives in the inbox. Paying it uses the same test card; the answer is 202, and the page then asks until the event is paid and closed.',
    events: ['CateringBalancePaid', 'CateringClosed'],
    principle: PAYMENTS,
    api: {
      routeId: 'pay-balance',
      method: 'POST',
      path: '/v1/sandboxes/{id}/catering/{cid}/pay-balance',
      note: 'The catering id is the idempotency key. Poll the event until it is closed.',
    },
  },
  {
    id: 'catering-cancel',
    screen: 'catering',
    target: 'catering-detail',
    title: 'Cancelling',
    what: 'A customer can cancel a confirmed event. The deposit is refunded when the event day is more than seven days away.',
    events: ['CateringCancelled'],
    principle: SAGA,
    api: {
      routeId: 'cancel-catering',
      method: 'POST',
      path: '/v1/sandboxes/{id}/catering/{cid}/cancel',
      body: { reason: 'customer_change' },
      note: 'Only a confirmed event can be cancelled; any other state is 409 out-of-order.',
    },
  },
];
