// The checkout's controls in the server's HTML wait for the island (2026-11-10): a press on
// Continue or the method choice before hydration did nothing, and slots.spec failed on it about
// one run in four. They render disabled and marked data-hydrating, drawn as they will be once
// live, as the menu's Add buttons are (src/lib/use-mounted.ts).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import Checkout from '../src/components/Checkout';

describe('the checkout before its island is live', () => {
  const html = renderToStaticMarkup(createElement(Checkout));

  test('Continue is disabled and marked as waiting for the island', () => {
    const button = html.match(/<button[^>]*>Continue<\/button>/)?.[0] ?? '';
    expect(button).not.toBe('');
    expect(button).toContain('disabled=""');
    expect(button).toContain('data-hydrating=""');
  });

  test('the method choice is disabled until then too', () => {
    const radios = [...html.matchAll(/<input[^>]*name="kind"[^>]*>/g)].map((m) => m[0]);
    expect(radios).toHaveLength(2);
    for (const radio of radios) {
      expect(radio).toContain('disabled=""');
      expect(radio).toContain('data-hydrating=""');
    }
  });
});
