// The shared sandbox line: the default signed-out sentence stays for the storefront pages, and a
// screen with nothing to order can say what is true for it (audit P4).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import StatusLine, {
  LIVE_DEFAULT,
  OFFLINE,
  OFFLINE_DEFAULT,
  ORDERS_LIVE,
  offlineFor,
} from '../src/components/StatusLine';

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

describe('StatusLine offline, a true sentence per page (2026-11-10)', () => {
  test('the menu keeps its sentence; the other pages say what cannot be done there', () => {
    expect(offlineFor('/menu/')).toContain('the demo’s own menu is shown');
    for (const page of ['/checkout/', '/catering/', '/inbox/', '/app/'] as const) {
      expect(offlineFor(page), page).not.toContain('menu');
      expect(offlineFor(page), page).toMatch(/^The API is unreachable, so /);
    }
    expect(OFFLINE['/catering/']).toContain('no event can be asked about');
    expect(OFFLINE['/inbox/']).toContain('your messages cannot be shown');
    expect(OFFLINE['/checkout/']).toContain('nothing can be ordered or paid for');
  });

  test('a page not on the list gets the general sentence', () => {
    expect(offlineFor(null)).toBe(OFFLINE_DEFAULT);
    expect(OFFLINE_DEFAULT).not.toContain('menu');
  });

  test('before the page is known, the line says the general sentence, never the menu’s', () => {
    expect(html({ phase: { name: 'offline' } })).toContain(OFFLINE_DEFAULT);
  });
});
