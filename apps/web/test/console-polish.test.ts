// The console's fourth-audit fixes (2026-11-10), the parts a unit can hold: the visitor's own card,
// a card's event chip and what a ready delivery waits for (G7, G9), who recorded a ledger line
// (G13), and the UTC form of a wall-clock moment on System (F18). The browser half is
// e2e/console-polish.spec.ts.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { CardView } from '../src/components/KitchenBoard';
import {
  FOLLOWED_KEY_PREFIX,
  eventWords,
  followedOrders,
  waitingFor,
  type Card,
} from '../src/lib/kitchen';
import { recordedBy } from '../src/lib/payment';
import { utcMomentText } from '../src/lib/when';

const ORDER = '01JC8Z5R0T2B6Y8C4V1N3K7QXE';
const NOW = Date.parse('2026-11-10T16:00:00Z');

const card: Card = {
  order: ORDER,
  state: 'ready',
  lines: [{ variant: 'country-loaf/whole', qty: 1 }],
  note: null,
  slot: '2026-11-10T11:00:00-07:00',
  kind: 'delivery',
  updated_seq: 4,
  cause: null,
  last: null,
  van: null,
  stop: null,
};

const draw = (c: Card, yours = false) =>
  renderToStaticMarkup(
    createElement(CardView, {
      card: c,
      sandboxId: '01JC8YV2D4QK7S1M9E3PZ6W8AN',
      canRefund: false,
      open: true,
      yours,
      onAct: () => undefined,
      onRefunded: () => undefined,
    }),
  );

/** A storage with these keys, as the browser's sessionStorage lists them. */
const store = (keys: string[]): Pick<Storage, 'length' | 'key'> => ({
  length: keys.length,
  key: (i: number) => keys[i] ?? null,
});

describe('the visitor’s own order on the board (G7)', () => {
  test('the orders this tab followed are read from the keys the order’s page keeps', () => {
    const seen = followedOrders(
      store([`${FOLLOWED_KEY_PREFIX}${ORDER}`, 'bakery.cart.v1', FOLLOWED_KEY_PREFIX]),
    );
    expect([...seen]).toEqual([ORDER]);
    expect(followedOrders(null).size).toBe(0);
    const blocked = {
      get length(): number {
        throw new Error('blocked');
      },
      key: () => null,
    };
    expect(followedOrders(blocked).size).toBe(0);
  });

  test('the key is the one the order’s page writes, so the two cannot drift apart', () => {
    const page = readFileSync(
      new URL('../src/components/OrderStatus.tsx', import.meta.url),
      'utf8',
    );
    expect(page).toContain(`\`${FOLLOWED_KEY_PREFIX}\${id}\``);
  });

  test('a card the visitor placed says "Yours" in words; another does not', () => {
    expect(draw(card, true)).toMatch(/data-tone="yours"[^>]*>Yours</);
    expect(draw(card, true)).toContain('data-yours="true"');
    expect(draw(card)).not.toContain('Yours');
  });
});

describe('a card’s chip and its way forward (G9)', () => {
  test('an event’s type breaks between its words', () => {
    expect(eventWords('OrderProductionStarted')).toEqual(['Order', 'Production', 'Started']);
    expect(eventWords('OrderOutForDelivery')).toEqual(['Order', 'Out', 'For', 'Delivery']);
    const html = draw({ ...card, state: 'in_production', last: 'OrderProductionStarted' });
    expect(html).toContain('Order<wbr/>');
    expect(html).toContain('class="badge card-event"');
  });

  test('a ready delivery says it waits for a van and links to Dispatch', () => {
    expect(waitingFor(card)).toEqual({
      text: 'Waits for a van: it goes out when the day’s plan is published on',
      dispatch: true,
    });
    const html = draw(card);
    expect(html).toContain('Waits for a van');
    expect(html).toContain('<a href="/app/dispatch/">Dispatch</a>.');
    expect(waitingFor({ ...card, van: 'van-1' })?.dispatch).toBe(false);
    expect(waitingFor({ ...card, kind: 'pickup' })).toBeNull();
    expect(waitingFor({ ...card, state: 'in_production' })).toBeNull();
  });
});

describe('who recorded a ledger line (G13)', () => {
  test('a refund of a seeded payment is not called seeded', () => {
    expect(recordedBy({ stripe_id: 'seed:01JC8Z6K3W9QF2N4T7XRB5MREF', kind: 'refund' }).text).toBe(
      'Billing, no Stripe call',
    );
    expect(recordedBy({ stripe_id: 'seed:01JC8Z6K3W9QF2N4T7XRB5MPAY', kind: 'payment' }).text).toBe(
      'Billing (seeded)',
    );
    expect(recordedBy({ stripe_id: 're_test_refund', kind: 'refund' }).text).toBe('Stripe');
  });
});

describe('a wall-clock moment set in UTC (F18)', () => {
  test('reads in the console’s form, with UTC after it', () => {
    expect(utcMomentText('2026-11-11T10:00:00Z', { now: NOW })).toBe('Wed 11 Nov, 10:00 am UTC');
    expect(utcMomentText('2026-11-10T12:04:09.5Z', { now: NOW })).toBe('Tue 10 Nov, 12:04 pm UTC');
    expect(utcMomentText('2027-01-01T10:00:00Z', { now: NOW })).toBe(
      'Fri 1 Jan 2027, 10:00 am UTC',
    );
    expect(utcMomentText('soon')).toBe('soon');
  });
});
