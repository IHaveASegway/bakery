// The catering components drawn once, statically: which controls each state shows, who sees the
// staff actions, and that the visitor's brief is text. Effects do not run in a static render, so
// these look at the first paint; the logic behind it is covered in catering.test.ts.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { CateringResponse, CateringState } from '../src/contracts';
import CateringDetail from '../src/components/CateringDetail';
import CateringFigures from '../src/components/CateringFigures';
import { QueueCard } from '../src/components/CateringQueue';

const event = (state: CateringState, extra: Partial<CateringResponse> = {}): CateringResponse => ({
  catering: '01JTESTCATERING00000000AA',
  state,
  date: '2026-11-20',
  headcount: 40,
  package: 'breakfast-spread',
  venue: 'v3',
  created_at: '2026-11-03T10:00:00-07:00',
  updated_at: '2026-11-03T10:00:00-07:00',
  reminders: [],
  ...(state === 'inquiry' || state === 'declined'
    ? {}
    : { total_cents: 58_000, deposit_cents: 14_500, balance_cents: 43_500 }),
  ...extra,
});

const detail = (e: CateringResponse) =>
  renderToStaticMarkup(
    createElement(CateringDetail, { sandboxId: 'S', event: e, onChange: () => undefined }),
  );
const card = (e: CateringResponse, isGuest = false) =>
  renderToStaticMarkup(
    createElement(QueueCard, {
      sandboxId: 'S',
      event: e,
      isGuest,
      onChange: () => undefined,
      onSettled: () => undefined,
    }),
  );

describe('the figures', () => {
  test('a quoted event shows the API’s total, deposit and balance and the quote’s deadline', () => {
    const html = renderToStaticMarkup(
      createElement(CateringFigures, {
        event: event('quoted', { valid_until: '2026-11-23T07:00:00-07:00' }),
        // A day in 2026, so the deadline prints without its year whatever the machine's year.
        now: Date.parse('2026-11-10T16:00:00Z'),
      }),
    );
    expect(html).toContain('$580.00');
    expect(html).toContain('$145.00');
    expect(html).toContain('$435.00');
    expect(html).toContain('Quote valid until');
    expect(html).toContain('Mon 23 Nov, 7:00 am');
    expect(html).toContain('Breakfast spread');
  });

  test('an inquiry shows an estimate, labelled as one', () => {
    const html = renderToStaticMarkup(createElement(CateringFigures, { event: event('inquiry') }));
    expect(html).toContain('Estimate');
    expect(html).toContain('$580.00 at the package price');
    expect(html).not.toContain('Deposit (25%)');
  });
});

describe('the customer’s event page by state', () => {
  test('quoted offers Accept and no payment', () => {
    const html = detail(event('quoted'));
    expect(html).toContain('Accept the quote');
    expect(html).not.toContain('Getting the payment form ready');
    expect(html).not.toContain('Cancel the event');
  });

  test('accepted offers the deposit step, with the deposit’s amount', () => {
    const html = detail(event('accepted'));
    expect(html).toContain('Pay the deposit');
    expect(html).toContain('$145.00');
    expect(html).toContain('Getting the payment form ready');
    expect(html).not.toContain('Accept the quote');
  });

  test('confirmed offers Cancel with the reasons', () => {
    const html = detail(event('confirmed'));
    expect(html).toContain('Cancel the event');
    expect(html).toContain('The venue fell through');
    expect(html).not.toContain('Pay balance');
  });

  test('invoiced offers Pay balance with the balance’s amount', () => {
    const html = detail(
      event('invoiced', { invoice: '01JINVOICE0000000000000AA', invoice_due: '2026-11-27' }),
    );
    expect(html).toContain('Pay balance');
    expect(html).toContain('$435.00');
    expect(html).toContain('01JINVOICE0000000000000AA');
  });

  test.each([
    'inquiry',
    'in_production',
    'delivered',
    'paid',
    'closed',
    'declined',
    'expired',
    'cancelled',
  ] as const)('%s offers the customer nothing to press', (state) => {
    const html = detail(event(state));
    expect(html).not.toContain('<button');
  });

  test('the brief is text: markup in it is escaped, never rendered', () => {
    const html = detail(event('quoted', { brief: '<img src=x onerror=alert(1)> <b>bold</b>' }));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>bold');
  });
});

describe('the staff queue’s card by state', () => {
  test('an inquiry offers Send quote (with the optional total) and Decline', () => {
    const html = card(event('inquiry'));
    expect(html).toContain('Send quote');
    expect(html).toContain('Total in dollars (optional)');
    expect(html).toContain('Decline');
    // The computed figures for the package price, as a preview.
    expect(html).toContain(
      'At the package price: $580.00, a deposit of $145.00 and a balance of $435.00',
    );
  });

  test('confirmed offers Start production and Cancel event', () => {
    const html = card(event('confirmed'));
    expect(html).toContain('Start production');
    expect(html).toContain('Cancel event');
    expect(html).not.toContain('Mark delivered');
  });

  test('in production offers Mark delivered; delivered says the invoice is on its way', () => {
    expect(card(event('in_production'))).toContain('Mark delivered');
    const delivered = card(event('delivered'));
    expect(delivered).toContain('raises the balance invoice');
    expect(delivered).not.toContain('<button');
  });

  test.each([
    'quoted',
    'accepted',
    'invoiced',
    'paid',
    'closed',
    'declined',
    'expired',
    'cancelled',
  ] as const)('%s has no staff button', (state) => {
    expect(card(event(state))).not.toContain('<button');
  });

  test('a guest reads the card and gets no button, whatever the state', () => {
    for (const state of ['inquiry', 'confirmed', 'in_production'] as const) {
      const html = card(event(state, { brief: 'Setup at 8' }), true);
      expect(html).not.toContain('<button');
      expect(html).toContain('Setup at 8');
    }
  });
});
