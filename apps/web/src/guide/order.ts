// The order's own page, /order/?id=: the order followed live, as the kitchen moves it. The page
// listens on the kitchen's socket and never sends on it (lib/use-order-watch.ts); the receipt and
// the cancel moved here from the checkout on 2026-11-09.
import type { GuideEntry } from '../lib/guide';
import { ADMISSION, LEASE, PAYMENTS, QUEUE } from './principles';

export const ORDER: GuideEntry[] = [
  {
    id: 'order-tracker',
    screen: 'order',
    target: 'order-tracker',
    title: 'Your order, step by step',
    what: 'Each step your order has taken, with its time. The page reads the order once, then follows the kitchen’s socket, so a step lights up as the kitchen makes it.',
    why: 'A socket pushes each change as it happens, so the page shows the kitchen’s move without asking again.',
    whenNot:
      'Not when the socket is lost or taken: then the page reads the order every 10 seconds instead, which is slower and always works.',
    events: ['OrderPaid', 'OrderProductionStarted', 'OrderReady', 'OrderPickedUp'],
    principle: QUEUE,
    api: {
      routeId: 'get-order',
      method: 'GET',
      path: '/v1/sandboxes/{id}/orders/{oid}',
      note: 'What the page reads first, and every 10 seconds when it has no socket.',
    },
    triggers: [],
  },
  {
    id: 'order-watch',
    screen: 'order',
    target: 'order-tracker',
    title: 'A guest on the kitchen’s socket',
    what: 'This page listens on the socket the board uses and never sends on it: no command, no heartbeat. When the board reports four sockets open, it gives its own up and reads instead.',
    why: 'Giving the socket up keeps the four places for the board’s screens, which need them to move cards.',
    whenNot:
      'Not for a page that must act or only looks now and then: moves are made on the kitchen board, and an occasional look is simpler as a plain read.',
    events: [],
    principle: ADMISSION,
    api: {
      routeId: 'get-order',
      method: 'GET',
      path: '/v1/sandboxes/{id}/orders/{oid}',
      note: 'The read the page falls back to every 10 seconds.',
    },
    triggers: [],
  },
  {
    id: 'order-pay',
    screen: 'order',
    target: 'order-pay',
    title: 'Paying later',
    what: 'An order placed and not paid is held for 15 minutes of bakery time. The link goes back to the checkout’s payment step for this same order.',
    why: 'The order’s id is the payment’s idempotency key, so coming back to pay never makes a second payment.',
    whenNot:
      'Not past the hold: once it lapses the places are released and the order is cancelled, so a new order is needed.',
    events: ['PaymentIntentCreated', 'PaymentSucceeded', 'OrderPaid'],
    principle: PAYMENTS,
    api: {
      routeId: 'pay',
      method: 'POST',
      path: '/v1/sandboxes/{id}/orders/{oid}/payment',
      note: 'The call the payment step makes for this order; asking twice gets the same intent.',
    },
    triggers: [],
  },
  {
    id: 'checkout-receipt',
    screen: 'order',
    target: 'checkout-receipt',
    title: 'The receipt is the order, read back',
    what: 'The page asks the API for the order until it is paid. What you read is the order object’s own state, not a guess made by this page.',
    why: 'Reading the order itself means the receipt cannot claim a payment the webhook has not confirmed.',
    whenNot:
      'Not for long waits or many readers: polling repeats a request a socket would push once.',
    events: ['OrderPaid'],
    principle: PAYMENTS,
    triggers: [],
    api: {
      routeId: 'get-order',
      method: 'GET',
      path: '/v1/sandboxes/{id}/orders/{oid}',
      note: 'The order with its lines, totals and state.',
    },
  },
  {
    id: 'checkout-cancel',
    screen: 'order',
    target: 'checkout-receipt',
    title: 'A hold is a lease',
    what: 'A place held for an unpaid order is released when its lease runs out or the order is cancelled. The storefront has no cancel button yet; the API has.',
    why: 'A lease with its end written down frees a place nobody paid for without anyone having to remember it.',
    whenNot:
      'Not for a hold that must never lapse, such as a paid order: there a release would be a refund.',
    events: ['OrderCancelled', 'SlotReleased'],
    principle: LEASE,
    triggers: ['cancel-order'],
    api: {
      routeId: 'cancel-order',
      method: 'POST',
      path: '/v1/sandboxes/{id}/orders/{oid}/cancel',
      note: 'Releases the held places. An order that is already paid or closed answers 409.',
    },
  },
];
