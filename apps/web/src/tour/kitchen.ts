// The console's kitchen board and the money beside it. The board is a panel of the console, not a
// screen of its own, so its steps belong to the console's tour.
import type { TourStep } from '../lib/tour';
import { HOW } from './how';
import { CQRS, PAYMENTS, QUEUE, RAFT } from './principles';

export const KITCHEN: TourStep[] = [
  {
    id: 'kitchen-board',
    screen: 'console',
    target: 'kitchen-board',
    title: 'The kitchen board',
    what: 'Paid orders arrive as cards and move from new to in production to ready to picked up. The board is live over a WebSocket; each button sends a command frame with its own id, which the Kitchen uses as an idempotency key, and the order object makes the move. One writer owns each order, so two tabs pressing the same button cannot disagree.',
    events: ['OrderProductionStarted', 'OrderReady', 'OrderPickedUp'],
    principle: RAFT,
    api: {
      routeId: 'heartbeat',
      method: 'POST',
      path: '/v1/sandboxes/{id}/heartbeat',
      note: 'The board’s own moves go over the kitchen socket, whose frames are on this site’s API reference. This is the one REST call the board makes: a console without a socket says it is still open so simulated traffic keeps running.',
    },
  },
  {
    id: 'kitchen-refund',
    screen: 'console',
    target: 'kitchen-refund',
    title: 'Refunding an order',
    what: 'Staff pick a reason and, optionally, an amount; with no amount, whatever is left is refunded. The Billing object asks Stripe, Stripe’s webhook confirms, and only then does the order record the refund and reverse the loyalty points.',
    events: ['OrderRefundRequested', 'RefundIssued', 'OrderRefunded'],
    principle: PAYMENTS,
    api: {
      routeId: 'refund',
      method: 'POST',
      path: '/v1/sandboxes/{id}/orders/{oid}/refund',
      body: { reason: 'goodwill', amount_cents: 200 },
      note: 'Signed-in sandboxes only. A guest’s refund is 403 guest-scope.',
    },
  },
  {
    id: 'kitchen-bake',
    screen: 'console',
    target: 'kitchen-bake',
    title: 'The bake list',
    what: HOW.bake,
    events: ['BakeListChanged', 'SlotReserved', 'SlotReleased'],
    principle: CQRS,
    api: {
      routeId: 'get-schedule',
      method: 'GET',
      path: '/v1/sandboxes/{id}/schedule/{date}',
      note: 'The day’s places, caps and bake list. The date is a bakery day, YYYY-MM-DD.',
    },
  },
  {
    id: 'kitchen-dead-letters',
    screen: 'console',
    target: 'kitchen-dead-letters',
    title: 'Dead letters',
    what: 'When a subscriber keeps failing, an event is retried three times and then parked here instead of being lost. Turn on a fault below, place an order, watch the retries, then redrive: the same event is delivered again, and the idempotent consumer makes the repeat harmless.',
    events: [],
    principle: QUEUE,
    api: {
      routeId: 'redrive',
      method: 'POST',
      path: '/v1/sandboxes/{id}/dead-letters/{eventId}/redrive',
      note: 'Signed-in sandboxes only. List the parked events first with GET /v1/sandboxes/{id}/dead-letters.',
    },
  },
  {
    id: 'kitchen-ledger',
    screen: 'console',
    target: 'kitchen-ledger',
    title: 'The ledger',
    what: 'Every payment, refund and invoice the Billing object has recorded, newest first. It is written from Stripe’s own events, so it can be checked against what Stripe says happened.',
    events: ['PaymentIntentCreated', 'PaymentSucceeded', 'RefundIssued', 'InvoiceIssued'],
    principle: PAYMENTS,
    api: {
      routeId: 'ledger',
      method: 'GET',
      path: '/v1/sandboxes/{id}/billing/ledger',
      note: 'Amounts are integer US cents.',
    },
  },
];
