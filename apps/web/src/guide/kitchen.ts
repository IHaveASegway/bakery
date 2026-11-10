// The console's kitchen board and the money beside it. The board is a panel of the console, not a
// screen of its own, so its entries belong to the console's list.
import type { GuideEntry } from '../lib/guide';
import { CQRS, PAYMENTS, QUEUE, RAFT } from './principles';

export const KITCHEN: GuideEntry[] = [
  {
    id: 'kitchen-board',
    screen: 'console',
    target: 'kitchen-board',
    title: 'The kitchen board',
    what: 'Paid orders arrive as cards and move from confirmed to in production to ready. Each button sends a command frame over the socket, and its id is the idempotency key.',
    why: 'Each order is its own object, so two tabs cannot disagree and nothing needs a lock.',
    whenNot: 'Not for a question across orders, such as the day’s totals: that needs a projection.',
    events: ['OrderProductionStarted', 'OrderReady', 'OrderPickedUp'],
    principle: RAFT,
    triggers: ['kitchen-socket', 'OrderProductionStarted', 'OrderReady', 'OrderPickedUp'],
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
    what: 'Staff pick a reason and, if they like, an amount. Billing asks Stripe, and only Stripe’s webhook makes the order record the refund.',
    why: 'The refund’s key is built from the order and an attempt number, so pressing twice asks Stripe once.',
    whenNot:
      'Not for a refund that must show at once: the order changes only when the webhook lands.',
    events: ['OrderRefundRequested', 'RefundIssued', 'OrderRefunded'],
    principle: PAYMENTS,
    triggers: ['refund', 'OrderRefundRequested', 'RefundIssued', 'OrderRefunded'],
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
    what: 'The day’s bake list, worked out by the Schedule from the places that are paid for. The board keeps the highest version it has seen, so a late message changes nothing.',
    why: 'A projection lets the kitchen read one ready-made list instead of adding up orders on every view.',
    whenNot:
      'Not when a reader must see its own write at once: the list trails the payment by a moment.',
    events: ['BakeListChanged', 'SlotReserved', 'SlotReleased'],
    principle: CQRS,
    triggers: [],
    facts: [
      'The Schedule sends each day’s plan as BakeListChanged with a version, so a late or repeated message changes nothing.',
      'A day gets a plan when an order or a catering deposit for that day is paid, and the plan changes when another is paid or a place is released.',
      'Moving the clock makes none: it only changes which day is today.',
    ],
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
    what: 'An event a subscriber keeps refusing is retried three times, then parked here. Redrive delivers it again, and the idempotent consumer makes the repeat harmless.',
    why: 'A dead-letter queue keeps a failing event instead of losing it, until someone fixes the cause.',
    whenNot:
      'Not a fix by itself: until a person redrives it, the kitchen does not have that card.',
    events: [],
    principle: QUEUE,
    triggers: ['redrive'],
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
    title: 'The payments record',
    what: 'Every payment, refund and invoice the Billing object has recorded, newest first. It is written from Stripe’s own events.',
    why: 'Writing the ledger from the provider’s events means it can be checked line by line against Stripe.',
    whenNot: 'Not a live balance: a payment shows here only after its webhook arrives.',
    events: ['PaymentIntentCreated', 'PaymentSucceeded', 'RefundIssued', 'InvoiceIssued'],
    principle: PAYMENTS,
    triggers: [],
    api: {
      routeId: 'ledger',
      method: 'GET',
      path: '/v1/sandboxes/{id}/billing/ledger',
      note: 'Amounts are integer US cents.',
    },
  },
];
