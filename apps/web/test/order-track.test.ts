// The order's status page (/order/): where a status puts the order on its tracker, how the page
// folds the order, the board's card and the socket's frames into one view, and when it gives its
// socket up (src/lib/order-track.ts, src/components/OrderStatus.tsx).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { OrderResponse } from '../src/contracts';
import type { Card, Envelope } from '../src/lib/kitchen';
import {
  SOCKET_LIMIT,
  finished,
  holdText,
  isAbout,
  movedText,
  needsRead,
  offTrack,
  shouldYield,
  stageOf,
  stagesFor,
  stepsTaken,
  trackFrom,
  withCard,
  withEvent,
  withOrder,
} from '../src/lib/order-track';
import { keptTimes } from '../src/components/OrderStatus';

const ID = '01JTESTORDERTRACK000000AA';
const order = (over: Partial<OrderResponse> = {}): OrderResponse => ({
  events_seq: 1,
  held_until: '2026-11-10T09:15:00-07:00',
  id: ID,
  kind: 'pickup',
  lines: [{ item: 'country-loaf', qty: 2, unit_cents: 900, variant: 'country-loaf/whole' }],
  menu_version: 1,
  placed_at: '2026-11-10T09:00:00-07:00',
  slot: '2026-11-10T14:00:00-07:00',
  status: 'placed',
  subtotal_cents: 1800,
  tax_cents: 180,
  total_cents: 1980,
  ...over,
});
const env = (type: string, seq: number, over: Partial<Envelope> = {}): Envelope => ({
  id: `evt-${seq}`,
  stream: `order:01JSANDBOXZZ000000000000AA:${ID}`,
  seq,
  type,
  at: `2026-11-10T09:0${seq}:00-07:00`,
  recorded_at: '2026-11-10T16:00:00Z',
  cause: null,
  data: {},
  ...over,
});
const card = (state: Card['state'], seq: number): Card => ({
  order: ID,
  state,
  lines: [],
  note: null,
  slot: '',
  kind: 'pickup',
  updated_seq: seq,
  cause: null,
  last: null,
  van: null,
  stop: null,
});

describe('the steps', () => {
  test('a pickup takes five, a delivery six', () => {
    expect(stagesFor('pickup')).toEqual(['placed', 'paid', 'in_production', 'ready', 'picked_up']);
    expect(stagesFor('delivery')).toEqual([
      'placed',
      'paid',
      'in_production',
      'ready',
      'out_for_delivery',
      'delivered',
    ]);
  });

  test('each status takes its steps, and a closed order has taken them all', () => {
    expect(stepsTaken('placed', 'pickup')).toBe(1);
    expect(stepsTaken('confirmed', 'pickup')).toBe(2);
    expect(stepsTaken('ready', 'delivery')).toBe(4);
    expect(stepsTaken('closed', 'pickup')).toBe(5);
    expect(stepsTaken('closed', 'delivery')).toBe(6);
    expect(stageOf('out_for_delivery', 'delivery')).toBe('out_for_delivery');
    expect(stageOf('picked_up', 'pickup')).toBe('picked_up');
  });

  test('expired, cancelled and refunding leave the track, and the page says so', () => {
    for (const status of ['expired', 'cancelled', 'refund_pending'] as const) {
      expect(offTrack(status)).toBe(status);
      expect(stepsTaken(status, 'pickup')).toBe(0);
      expect(stageOf(status, 'pickup')).toBeNull();
    }
    expect(offTrack('ready')).toBeNull();
  });

  test('the page stops listening once nothing the kitchen does moves the order', () => {
    expect(finished('placed')).toBe(false);
    expect(finished('ready')).toBe(false);
    expect(finished('out_for_delivery')).toBe(false);
    for (const status of ['picked_up', 'delivered', 'closed', 'expired', 'cancelled'] as const) {
      expect(finished(status)).toBe(true);
    }
  });
});

describe('folding what the page hears', () => {
  test('a fresh read starts the track, with the placing’s time', () => {
    const track = trackFrom(order());
    expect(track.status).toBe('placed');
    expect(track.seq).toBe(1);
    expect(track.times.placed).toBe('2026-11-10T09:00:00-07:00');
  });

  test('a frame moves the order and records the step’s time; a late or repeated one does not', () => {
    let track = trackFrom(order());
    track = withEvent(track, env('OrderPaid', 2));
    expect(track.status).toBe('confirmed');
    expect(track.times.paid).toBe('2026-11-10T09:02:00-07:00');
    track = withEvent(track, env('OrderProductionStarted', 3));
    expect(track.status).toBe('in_production');
    expect(withEvent(track, env('OrderPaid', 2))).toBe(track);
    expect(withEvent(track, env('OrderProductionStarted', 3))).toBe(track);
    expect(track.heard).toEqual({ type: 'OrderProductionStarted', at: env('x', 3).at });
  });

  test('an event that does not move the order only moves its seq, and asks for a read', () => {
    const track = withEvent(
      trackFrom(order({ status: 'ready', events_seq: 4 })),
      env('OrderRefundRequested', 5),
    );
    expect(track.status).toBe('ready');
    expect(track.seq).toBe(5);
    expect(needsRead(env('OrderRefundRequested', 5))).toBe(true);
    expect(needsRead(env('OrderCancelled', 5))).toBe(true);
    expect(needsRead(env('OrderReady', 5))).toBe(false);
  });

  test('the snapshot’s card counts when it is newer, and an older read never undoes a frame', () => {
    let track = trackFrom(order());
    track = withCard(track, card('in_production', 3));
    expect(track.status).toBe('in_production');
    expect(withCard(track, card('confirmed', 2))).toBe(track);
    expect(withOrder(track, order({ status: 'confirmed', events_seq: 2 }))).toBe(track);
    const newer = withOrder(track, order({ status: 'ready', events_seq: 4 }));
    expect(newer.status).toBe('ready');
  });

  test('only the order’s own stream is about it', () => {
    expect(isAbout(env('OrderPaid', 2), ID)).toBe(true);
    expect(
      isAbout(env('OrderPaid', 2, { stream: 'order:01JSANDBOXZZ000000000000AA:other' }), ID),
    ).toBe(false);
    expect(isAbout(env('SlotReserved', 2, { stream: `schedule:${ID}` }), ID)).toBe(false);
  });
});

describe('the socket', () => {
  test('the page gives its socket up when the board says four are open, its own included', () => {
    expect(SOCKET_LIMIT).toBe(4);
    expect(shouldYield(3)).toBe(false);
    expect(shouldYield(4)).toBe(true);
    expect(shouldYield(5)).toBe(true);
  });

  test('the page never sends a frame: the watch has no send and no command', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/lib/use-order-watch.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\.send\(/);
    expect(source).not.toContain('commandFrame');
    expect(source).not.toContain('heartbeat(');
  });
});

describe('words', () => {
  test('the hold is time left, said once', () => {
    const until = '2026-11-10T09:15:00-07:00';
    const at = (min: number) => Date.parse('2026-11-10T09:00:00-07:00') + min * 60_000;
    expect(holdText(until, at(1))).toBe('14 min left to pay.');
    expect(holdText(until, at(14.5))).toBe('Under a minute left to pay.');
    expect(holdText(until, at(16))).toMatch(/hold has ended/);
  });

  test('every status has one sentence for a screen reader', () => {
    expect(movedText('in_production', 'pickup')).toBe('Your order is in production.');
    expect(movedText('ready', 'pickup')).toMatch(/pick up/);
    expect(movedText('ready', 'delivery')).toMatch(/van/);
  });
});

describe('the status page', () => {
  test('renders a quiet loading state on the server, with no socket and no read', async () => {
    const { default: OrderStatus } = await import('../src/components/OrderStatus');
    const html = renderToStaticMarkup(createElement(OrderStatus));
    expect(html).toContain('Reading your order');
  });
});

describe('the times a tab saw for an order’s steps', () => {
  const store = (items: Record<string, string>) => ({ getItem: (k: string) => items[k] ?? null });
  test('survive a reload, read back as they were kept', () => {
    const kept = { placed: '2026-11-10T11:48:00-07:00', paid: '2026-11-10T11:49:00-07:00' };
    const read = keptTimes(
      'ord-one',
      store({ 'bakery.order-times.v1.ord-one': JSON.stringify(kept) }),
    );
    expect(read).toEqual(kept);
  });
  test('read as none when nothing was kept, the storage is blocked or the value is not times', () => {
    expect(keptTimes('ord-one', store({}))).toEqual({});
    expect(keptTimes('ord-one', null)).toEqual({});
    expect(keptTimes('ord-one', store({ 'bakery.order-times.v1.ord-one': 'not json' }))).toEqual(
      {},
    );
    expect(
      keptTimes('ord-one', store({ 'bakery.order-times.v1.ord-one': '{"paid":3,"placed":""}' })),
    ).toEqual({});
  });
});
