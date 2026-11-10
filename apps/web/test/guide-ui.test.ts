// The guide's island drawn statically: the bar of every screen before hydration, and an entry's
// standing body (what a hotspot's note and the recorder show). Effects do not run in a static
// render, so the trace, the placement and the focus are covered by the pure parts in
// guide-notes.test.ts and trace.test.ts, and in a browser by e2e/guide.spec.ts.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import Guide from '../src/components/Guide';
import { EntryBody, tokenHint } from '../src/components/guide/Views';
import { ENTRIES } from '../src/guide';
import { ESSAYS, ESSAY_PAGES } from '../src/lib/links';
import { SCREENS, type ScreenId } from '../src/lib/guide';

const body = (screen: ScreenId, index: number) =>
  renderToStaticMarkup(createElement(EntryBody, { entry: ENTRIES[screen][index]! }));

describe('the bar, before anything is done', () => {
  test.each(SCREENS)('%s draws the switch on, the recorder closed, and no note', (screen) => {
    const html = renderToStaticMarkup(createElement(Guide, { screen }));
    expect(html).toContain('Under the hood');
    expect(html).toMatch(/role="switch" aria-checked="true"/);
    expect(html).toContain('>Recorder<');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('guide-note');
    expect(html).not.toContain('style=');
    // A polite live region is there from the start, so the first announcement is heard.
    expect(html).toMatch(/role="status" aria-live="polite"/);
  });

  test.each(SCREENS)('%s draws its buttons disabled until the island has hydrated', (screen) => {
    const html = renderToStaticMarkup(createElement(Guide, { screen }));
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*disabled=""[^>]*>Recorder</);
  });

  test('a screen with a short path offers “Show me around”, one without does not', () => {
    expect(renderToStaticMarkup(createElement(Guide, { screen: 'console' }))).toContain(
      'Show me around',
    );
    expect(renderToStaticMarkup(createElement(Guide, { screen: 'status' }))).not.toContain(
      'Show me around',
    );
  });
});

describe('an entry’s standing body', () => {
  const how = ENTRIES.menu.findIndex((s) => s.id === 'menu-how');

  test('shows what it is, why this tool, when not, and the principle', () => {
    const html = body('menu', how);
    expect(html).toContain('the menu comes from its own Catalog');
    expect(html).toContain('Why this tool');
    expect(html).toContain('When not');
    expect(html).toContain(ENTRIES.menu[how]!.whenNot.replaceAll('’', '’'));
    expect(html).toContain('Cache invalidation by version');
  });

  test('links the principle’s lab page and its ADR, both with rel="noopener"', () => {
    const html = body('menu', how);
    expect(html).toContain(
      '<a href="https://ihaveasegway.com/lab/cache/" rel="noopener">Cache Lab</a>',
    );
    expect(html).toContain(
      '<a href="https://github.com/IHaveASegway/bakery/blob/main/docs/adr/0003-durable-objects-as-the-system-of-record.md" rel="noopener">ADR 0003</a>',
    );
    // A lab principle's body adds its essay, by title, and not its section of How it's built.
    expect(html).toContain(
      '<a href="/how-its-built/cache/">Why the menu is cached by version, not by time</a>',
    );
    expect(html).not.toContain('/how-its-built/#');
  });

  test('a principle with no lab page links its How it’s built section and its ADR', () => {
    const i = ENTRIES.checkout.findIndex((s) => s.principle.id === 'idempotency-keys');
    const html = body('checkout', i);
    expect(html).toContain('<a href="/how-its-built/#idempotency-keys">How it’s built</a>');
    expect(html).toContain('/docs/adr/0004-queues-between-objects-and-alarms-for-time.md');
    expect(html).not.toContain('ihaveasegway.com/lab/');
    expect(html).toContain(
      '<a href="/how-its-built/idempotency/">Why pressing the button twice never orders twice</a>',
    );
  });

  test('the Raft entry links the lab page, the ADR and the essay', () => {
    const i = ENTRIES.console.findIndex((s) => s.principle.id === 'raft');
    const html = body('console', i);
    expect(html).toContain('href="https://ihaveasegway.com/lab/raft/"');
    expect(html).toContain(
      '<a href="/how-its-built/single-writer/">Why a single-writer object needs no consensus</a>',
    );
    expect(html).toContain('ADR 0003');
  });

  test('every body of a principle with an essay links it by its title, and every essay has one', () => {
    const linked = new Set<string>();
    for (const screen of SCREENS) {
      ENTRIES[screen].forEach((entry, i) => {
        const html = body(screen, i);
        const essay = ESSAYS[entry.principle.id as keyof typeof ESSAYS];
        if (essay === undefined) return;
        expect(html, entry.id).toContain(`<a href="${essay.path}">${essay.title}</a>`);
        linked.add(essay.path);
      });
    }
    expect([...linked].sort()).toEqual(ESSAY_PAGES.map((e) => e.path).sort());
  });

  test('every body holds a principle link, an ADR link, a why and a when-not', () => {
    for (const screen of SCREENS) {
      ENTRIES[screen].forEach((entry, i) => {
        const html = body(screen, i);
        expect(html, entry.id).toContain(`href="${entry.principle.adrUrl}"`);
        expect(html, entry.id).toContain(
          `href="${entry.principle.labUrl ?? entry.principle.howUrl}"`,
        );
        expect(html, entry.id).toContain('Why this tool');
        expect(html, entry.id).toContain('When not');
      });
    }
  });

  test('names the events, shows the curl masked or with <your token>, and offers a copy', () => {
    const cart = ENTRIES.menu.findIndex((e) => e.id === 'menu-cart');
    const list = ENTRIES.menu.findIndex((e) => e.id === 'menu-list');
    const html = body('menu', cart);
    expect(body('menu', list)).toContain('MenuPublished');
    expect(html).toContain('curl -X POST');
    expect(html).toContain('Authorization: Bearer &lt;your token&gt;');
    expect(html).toContain('/v1/sandboxes/&lt;sandbox id&gt;/orders');
    expect(html).toContain('Copy the curl');
    expect(html).toContain('Route <code>place-order</code>');
  });

  test('an entry that makes no event says so', () => {
    const cart = ENTRIES.menu.findIndex((e) => e.id === 'menu-cart');
    expect(body('menu', cart)).toContain('This makes no event of its own');
  });

  test('every entry of every screen draws', () => {
    for (const screen of SCREENS) {
      ENTRIES[screen].forEach((entry, i) => {
        expect(body(screen, i), entry.id).toContain(entry.why.replaceAll('’', '’'));
      });
    }
  });
});

describe('what a body says about the token', () => {
  test('tells a signed-in account where to issue one, not to sign in', () => {
    const text = tokenHint({ name: 'live', id: 'sandbox-x', kind: 'google', clockOffsetS: 0 });
    expect(text).toContain('API token panel');
    expect(text).not.toContain('Sign in');
  });
  test('tells a guest that a guest cannot issue one', () => {
    expect(tokenHint({ name: 'live', id: 'sandbox-x', kind: 'guest', clockOffsetS: 0 })).toContain(
      'A guest cannot issue one',
    );
  });
  test('tells a visitor with no session to sign in', () => {
    expect(tokenHint({ name: 'nosession' })).toContain('Sign in and issue one');
  });
});

describe('the console’s entries', () => {
  test('run down the page from the top to the actions, in the order the sections render', () => {
    expect(ENTRIES.console.map((entry) => entry.target)).toEqual([
      'console-sandbox',
      'console-token',
      'kitchen-board',
      'kitchen-refund',
      'kitchen-bake',
      'kitchen-ledger',
      'controls-traffic',
      'controls-traffic',
      'controls-menu',
      'controls-menu',
      'controls-tax',
      'controls-capacity',
      ...Array<string>(5).fill('crm-catering-queue'),
      'crm-customers',
      'crm-segments',
      ...Array<string>(4).fill('crm-campaigns'),
      'crm-leads',
      'crm-activity',
      'crm-rebuild',
      'controls-faults',
      'kitchen-dead-letters',
      'controls-clock',
      'controls-actions',
      'controls-actions',
    ]);
  });
});
