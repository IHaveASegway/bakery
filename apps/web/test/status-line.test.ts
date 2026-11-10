// The shared sandbox line: the default signed-out sentence stays for the storefront pages, and a
// screen with nothing to order can say what is true for it (audit P4).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import StatusLine, { LIVE_DEFAULT, ORDERS_LIVE } from '../src/components/StatusLine';

const html = (props: Parameters<typeof StatusLine>[0]) =>
  renderToStaticMarkup(createElement(StatusLine, props));

describe('StatusLine signed out', () => {
  test('defaults to the seed-menu sentence', () => {
    const out = html({ phase: { name: 'nosession' } });
    expect(out).toContain('this is the demo’s seed menu and ordering is off');
    expect(out).toContain('href="/signin/"');
  });

  test('a screen can give its own sentence, and keeps the sign-in link', () => {
    const out = html({
      phase: { name: 'nosandbox' },
      signedOut: 'You have no sandbox yet, so the inbox is empty.',
    });
    expect(out).toContain('so the inbox is empty.');
    expect(out).not.toContain('ordering is off');
    expect(out).toContain('Sign in or try it as a guest');
  });

  test('the sentence is not used for other phases', () => {
    expect(html({ phase: { name: 'loading' }, signedOut: 'x' })).not.toContain('>x');
  });
});

describe('StatusLine live, a true sentence per page (2026-11-10)', () => {
  const live = { name: 'live', id: 'sandbox', kind: 'guest', clockOffsetS: 0 } as const;

  test('says only that the sandbox is live where a page names nothing more', () => {
    const out = html({ phase: live });
    expect(LIVE_DEFAULT).toBe('Your sandbox is live.');
    expect(out).toContain('Your sandbox is live.');
    // The catering page and the inbox take orders from nowhere, so they never say so.
    expect(out).not.toContain('Orders you place here');
  });

  test('the menu and the checkout say where an order placed there goes', () => {
    const out = html({ phase: live, live: ORDERS_LIVE });
    expect(out).toContain('Your sandbox is live. Orders you place here go to it.');
  });

  test('the page’s own live sentence is not used for other phases', () => {
    expect(html({ phase: { name: 'seeding', id: 's', kind: 'guest' }, live: 'y' })).not.toContain(
      '>y',
    );
    expect(html({ phase: { name: 'nosession' }, live: 'y' })).not.toContain('>y');
  });
});
