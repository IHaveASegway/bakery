// Focus the console keeps after an action, after the audit of 2026-11-08 (afternoon): the catering
// queue after Send quote and a refused Start production, the wiped view after Wipe now.
// Static renders show the first paint; effects do not run in them, so the e2e step in
// e2e/console-polish.spec.ts and e2e/wipe.spec.ts presses the keys.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { CateringResponse } from '../src/contracts';
import { QueueCard } from '../src/components/CateringQueue';
import { Gone } from '../src/components/Console';

const inquiry: CateringResponse = {
  catering: '01JTESTCATERING00000000AA',
  state: 'inquiry',
  date: '2026-11-20',
  headcount: 40,
  package: 'breakfast-spread',
  venue: 'v3',
  created_at: '2026-11-03T10:00:00-07:00',
  updated_at: '2026-11-03T10:00:00-07:00',
  reminders: [],
};

describe('the catering queue keeps the keyboard', () => {
  const html = renderToStaticMarkup(
    createElement(QueueCard, {
      sandboxId: 'S',
      event: inquiry,
      isGuest: false,
      onChange: () => undefined,
      onSettled: () => undefined,
    }),
  );

  test('the card can take focus when the button that had it is gone', () => {
    expect(html).toMatch(/<li id="catering-card-01JTESTCATERING00000000AA" tabindex="-1">/);
  });

  test('an idle button is never disabled; busy is aria-disabled so focus stays', () => {
    const sendQuote = html.match(/<button[^>]*>Send quote<\/button>/)?.[0] ?? '';
    expect(sendQuote).not.toBe('');
    expect(sendQuote).not.toContain('disabled=""');
  });
});

describe('the wiped view takes the focus', () => {
  test('its heading can be focused', () => {
    const out = renderToStaticMarkup(
      createElement(Gone, { wiped: true, header: null, another: null, error: null }),
    );
    expect(out).toContain('<h3 id="gone-heading" tabindex="-1">Your sandbox is wiped</h3>');
  });
});
