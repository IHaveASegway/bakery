// The console's fourth-audit fixes (2026-11-10), the parts a unit can hold: the visitor's own card,
// a card's event chip and what a ready delivery waits for (G7, G9), who recorded a ledger line
// (G13), and the UTC form of a wall-clock moment on System (F18). The browser half is
// e2e/console-polish.spec.ts.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { CardView } from '../src/components/KitchenBoard';
import { chipText, eventWords, waitingFor, type Card } from '../src/lib/kitchen';
import { recordedBy } from '../src/lib/payment';
import {
  PLACED_ORDERS_ITEM,
  PLACED_ORDERS_MAX,
  placedOrders,
  rememberPlacedOrder,
} from '../src/lib/placed-orders';
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

/** A tab's storage in memory, as sessionStorage keeps strings. */
function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

/** A storage the browser refuses: every touch throws, as with blocked site data or a full quota. */
const refused = {
  getItem: (): string | null => {
    throw new Error('blocked');
  },
  setItem: (): void => {
    throw new Error('blocked');
  },
};

/** An order id of this test's own, n of them: synthetic, never a hex string. */
const idOf = (n: number) => `01JC8Z5R0T2B6Y8C4V1N3K${String(n).padStart(4, 'Q')}`;

describe('the visitor’s own order on the board (G7)', () => {
  test('the checkout remembers each order it places, newest first, once each', () => {
    const tab = memory();
    rememberPlacedOrder(idOf(1), tab);
    rememberPlacedOrder(idOf(2), tab);
    rememberPlacedOrder(idOf(1), tab);
    expect(JSON.parse(tab.data.get(PLACED_ORDERS_ITEM) ?? '')).toEqual([idOf(1), idOf(2)]);
    expect([...placedOrders(tab)]).toEqual([idOf(1), idOf(2)]);
  });

  test('the tab keeps at most 20 ids, dropping the oldest', () => {
    const tab = memory();
    for (let n = 1; n <= 25; n++) rememberPlacedOrder(idOf(n), tab);
    const kept = JSON.parse(tab.data.get(PLACED_ORDERS_ITEM) ?? '') as string[];
    expect(kept).toHaveLength(PLACED_ORDERS_MAX);
    expect(kept[0]).toBe(idOf(25));
    expect(kept).not.toContain(idOf(5));
    expect(kept).toContain(idOf(6));
  });

  test('bad JSON or entries that are not ids read as nothing, never a throw', () => {
    expect(placedOrders(memory({ [PLACED_ORDERS_ITEM]: '{not json' })).size).toBe(0);
    expect(placedOrders(memory({ [PLACED_ORDERS_ITEM]: '{"a":1}' })).size).toBe(0);
    expect([
      ...placedOrders(memory({ [PLACED_ORDERS_ITEM]: JSON.stringify([idOf(1), 7, null, '']) })),
    ]).toEqual([idOf(1)]);
    // A bad value is replaced, not kept, by the next order.
    const tab = memory({ [PLACED_ORDERS_ITEM]: '{not json' });
    rememberPlacedOrder(idOf(3), tab);
    expect([...placedOrders(tab)]).toEqual([idOf(3)]);
  });

  test('the key is named in the data inventory and the privacy page says what it keeps', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(read('../../../docs/security.md')).toContain(
      `| Placed order ids (\`sessionStorage\` \`${PLACED_ORDERS_ITEM}\`, added 2026-11-10) |`,
    );
    const privacy = read('../src/pages/privacy.astro');
    expect(privacy).toContain('Which orders you placed in this tab');
    expect(privacy).toContain('So the kitchen board can mark them as yours.');
  });

  test('missing or blocked storage marks nothing and never throws', () => {
    expect(placedOrders(null).size).toBe(0);
    expect(placedOrders(refused).size).toBe(0);
    expect(() => rememberPlacedOrder(idOf(1), refused)).not.toThrow();
    expect(() => rememberPlacedOrder(idOf(1), null)).not.toThrow();
  });

  test('a card the visitor placed says "Yours" in words; another does not', () => {
    expect(draw(card, true)).toMatch(/data-tone="yours"[^>]*>Yours</);
    expect(draw(card, true)).toContain('data-yours="true"');
    expect(draw(card)).not.toContain('Yours');
  });
});

describe('a card’s chip and its way forward (G9)', () => {
  test('an event’s type breaks only between its words, with a hyphen', () => {
    expect(eventWords('OrderProductionStarted')).toEqual(['Order', 'Production', 'Started']);
    expect(chipText('OrderOutForDelivery')).toBe('Order\u00ADOut\u00ADFor\u00ADDelivery');
    expect(chipText('OrderReady').replaceAll('\u00AD', '')).toBe('OrderReady');
    const html = draw({ ...card, state: 'in_production', last: 'OrderProductionStarted' });
    // No break without a hyphen: a soft hyphen between words, never a <wbr>.
    expect(html).not.toContain('<wbr/>');
    expect(html).toContain(
      'title="OrderProductionStarted">Order\u00ADProduction\u00ADStarted</span>',
    );
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
