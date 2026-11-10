// The checkout's controls in the server's HTML wait for the island (2026-11-10): a press on
// Continue or the method choice before hydration did nothing, and slots.spec failed on it about
// one run in four. Since the gate (audit F1, later on 2026-11-10) the steps are drawn only once the
// island knows there is a live sandbox, so the server's HTML holds no choice at all: only the
// gate's frame, saying the page is looking. Nothing in it can be pressed before the island is live.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import Checkout from '../src/components/Checkout';

describe('the checkout before its island is live', () => {
  const html = renderToStaticMarkup(createElement(Checkout));

  test('holds no Continue and no method choice', () => {
    expect(html).not.toMatch(/<button[^>]*>Continue<\/button>/);
    expect(html).not.toMatch(/<input[^>]*name="kind"/);
    expect(html).not.toContain('Place order');
  });

  test('says it is looking for the sandbox, in the place the steps or the gate will take', () => {
    expect(html).toContain('Looking for your sandbox…');
    expect(html).toContain('class="checkout-steps"');
  });

  test('takes no choice before a sandbox exists: no pay step, no small type saying ordering is off', () => {
    expect(html).not.toContain('ordering is off');
    expect(html).not.toContain('Ordering needs a sandbox');
    expect(html).not.toContain('checkout-pay');
  });
});
