import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { OrderResponse } from '../src/contracts';
import Receipt from '../src/components/Receipt';
import { STATIC_MENU } from '../src/lib/menu';
import {
  billingDetails,
  declineMessage,
  isClosed,
  isPaid,
  parseRefundAmount,
  publishableKeyFor,
  returnUrl,
  waitForPaid,
} from '../src/lib/payment';

const testKey = 'pk_test_not_a_key';
// Assembled, never written out: CI greps the tree for the live prefixes.
const liveShaped = ['pk', 'live', 'fake000'].join('_');

const order = (status: OrderResponse['status']): OrderResponse => ({
  events_seq: 3,
  held_until: '2026-11-05T12:15:00Z',
  id: '01JTESTORDER000000000000AA',
  kind: 'pickup',
  lines: [{ item: 'country-loaf', qty: 2, unit_cents: 900, variant: 'country-loaf/whole' }],
  menu_version: 1,
  placed_at: '2026-11-05T12:00:00Z',
  slot: '2026-11-06T16:00:00Z',
  status,
  subtotal_cents: 1800,
  tax_cents: 180,
  total_cents: 1980,
});

describe('publishableKeyFor', () => {
  test('the build’s key wins; the response’s is the fallback', () => {
    expect(publishableKeyFor(testKey, 'pk_test_other')).toBe(testKey);
    expect(publishableKeyFor('', 'pk_test_other')).toBe('pk_test_other');
    expect(publishableKeyFor(undefined, 'pk_test_other')).toBe('pk_test_other');
  });

  test('no key at all is null, so no Stripe script loads', () => {
    expect(publishableKeyFor('', null)).toBeNull();
    expect(publishableKeyFor(undefined, undefined)).toBeNull();
    expect(publishableKeyFor('  ', '')).toBeNull();
  });

  test('a key that is not a sandbox key is never used, whoever supplied it', () => {
    expect(publishableKeyFor('', liveShaped)).toBeNull();
    expect(publishableKeyFor(liveShaped, null)).toBeNull();
    expect(publishableKeyFor('sk_test_not_a_key', null)).toBeNull();
  });
});

describe('billing details and return URL', () => {
  test('exactly the fields the Element would have collected', () => {
    const address = {
      line1: 'Maple Street Corner, unit 4 (synthetic)',
      city: 'Salt Lake City',
      state: 'UT',
      postal_code: '84101',
      country: 'US',
    };
    expect(billingDetails({ name: 'Sample Customer', address })).toEqual({
      name: 'Sample Customer',
      address,
    });
  });

  test('the return URL is the checkout page itself, without query or fragment', () => {
    expect(returnUrl({ origin: 'https://bakery.example', pathname: '/checkout/' })).toBe(
      'https://bakery.example/checkout/',
    );
  });
});

describe('order statuses', () => {
  test('paid means the webhook has moved it on; placed is not paid', () => {
    expect(isPaid('confirmed')).toBe(true);
    expect(isPaid('in_production')).toBe(true);
    expect(isPaid('placed')).toBe(false);
    expect(isClosed('expired')).toBe(true);
    expect(isClosed('placed')).toBe(false);
  });
});

describe('waitForPaid', () => {
  const instant = async () => {};

  test('looks every second and stops when the order is confirmed', async () => {
    const seen: number[] = [];
    const slept: number[] = [];
    const statuses: OrderResponse['status'][] = ['placed', 'placed', 'confirmed'];
    const result = await waitForPaid(async () => order(statuses[seen.push(1) - 1]!), {
      sleep: async (ms) => void slept.push(ms),
    });
    expect(result).toEqual({ kind: 'paid', order: order('confirmed') });
    expect(seen).toHaveLength(3);
    expect(slept).toEqual([1000, 1000]);
  });

  test('gives up after 30 seconds with a timeout, having looked 31 times', async () => {
    let looks = 0;
    let slept = 0;
    const result = await waitForPaid(
      async () => {
        looks += 1;
        return order('placed');
      },
      { sleep: async (ms) => void (slept += ms) },
    );
    expect(result).toEqual({ kind: 'timeout' });
    expect(looks).toBe(31);
    expect(slept).toBe(31_000);
  });

  test('a failed look is a missed look, not the end', async () => {
    let looks = 0;
    const result = await waitForPaid(
      async () => {
        looks += 1;
        if (looks < 3) throw new Error('offline');
        return order('confirmed');
      },
      { sleep: instant },
    );
    expect(result.kind).toBe('paid');
  });

  test('an order that expired or was cancelled ends the wait', async () => {
    expect((await waitForPaid(async () => order('expired'), { sleep: instant })).kind).toBe(
      'closed',
    );
  });

  test('a page that went away stops it', async () => {
    let looks = 0;
    const result = await waitForPaid(
      async () => {
        looks += 1;
        return order('placed');
      },
      { sleep: instant, stopped: () => looks >= 2 },
    );
    expect(result).toEqual({ kind: 'stopped' });
    expect(looks).toBe(2);
  });
});

describe('parseRefundAmount', () => {
  test('dollars become cents', () => {
    expect(parseRefundAmount('4', 1980)).toEqual({ ok: true, cents: 400 });
    expect(parseRefundAmount('4.5', 1980)).toEqual({ ok: true, cents: 450 });
    expect(parseRefundAmount('19.80', 1980)).toEqual({ ok: true, cents: 1980 });
  });

  test('more than the total, zero and words are refused with a sentence', () => {
    const over = parseRefundAmount('19.81', 1980);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toContain('$19.80');
    for (const text of ['0', '', 'abc', '-3', '1.234']) {
      expect(parseRefundAmount(text, 1980).ok, text).toBe(false);
    }
  });
});

describe('the decline message', () => {
  test('is the Element’s own, with a plain fallback', () => {
    expect(declineMessage({ message: 'Your card was declined.' })).toBe('Your card was declined.');
    expect(declineMessage({})).toMatch(/Try another test card/);
    expect(declineMessage({ message: '   ' })).toMatch(/Try another test card/);
  });
});

describe('the receipt', () => {
  const menu = { menu: STATIC_MENU } as Parameters<typeof Receipt>[0]['menu'];
  const html = (paid: boolean) =>
    renderToStaticMarkup(createElement(Receipt, { order: order('confirmed'), menu, paid }));

  test('a paid receipt shows the id, the lines, the total and “paid in Stripe’s sandbox”', () => {
    const text = html(true);
    expect(text).toContain('01JTESTORDER000000000000AA');
    expect(text).toContain('$19.80');
    expect(text).toContain('× 2');
    expect(text).toContain('Paid in Stripe’s sandbox');
  });

  test('an unpaid one does not claim it', () => {
    expect(html(false)).not.toContain('Paid in Stripe’s sandbox');
  });
});
