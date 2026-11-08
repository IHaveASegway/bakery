// The tour's island drawn once, statically: the trigger of a closed tour, and the card of an open
// one at the first, a middle and the last step. Effects do not run in a static render, so the focus,
// the ring and the activity read are covered by the pure parts in tour.test.ts.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import Tour, { TourCard, revealDelta, tokenHint } from '../src/components/Tour';
import { ESSAYS, ESSAY_PAGES } from '../src/lib/links';
import { SCREENS } from '../src/lib/tour';
import { TOURS } from '../src/tour';

const card = (screen: (typeof SCREENS)[number], index: number) =>
  renderToStaticMarkup(
    createElement(TourCard, {
      step: TOURS[screen][index]!,
      index,
      total: TOURS[screen].length,
      dispatch: () => undefined,
    }),
  );

describe('the closed tour', () => {
  test.each(SCREENS)('%s draws one button and no card', (screen) => {
    const html = renderToStaticMarkup(createElement(Tour, { screen }));
    expect(html).toContain('Take the tour');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('tour-card');
    expect(html).not.toContain('style=');
  });
});

describe('the open card', () => {
  const total = TOURS.menu.length;
  // The menu's note on where it came from is the last step, as it is the last thing on the page.
  const how = TOURS.menu.findIndex((s) => s.id === 'menu-how');

  test('shows the progress, the title, what it is and the principle', () => {
    const html = card('menu', how);
    expect(html).toContain(`${how + 1} of ${total}`);
    expect(html).toContain('Where the menu came from');
    expect(html).toContain('This is the demo’s seed menu');
    expect(html).toContain('Cache invalidation by version');
  });

  test('links the principle’s lab page and its ADR, both with rel="noopener"', () => {
    const html = card('menu', how);
    expect(html).toContain('Read how it works:');
    expect(html).toContain(
      '<a href="https://ihaveasegway.com/lab/cache/" rel="noopener">Cache Lab</a>',
    );
    expect(html).toContain(
      '<a href="https://github.com/IHaveASegway/bakery/blob/main/docs/adr/0003-durable-objects-as-the-system-of-record.md" rel="noopener">ADR 0003</a>',
    );
    // A lab principle's card adds its essay, by title, and not its section of How it's built.
    expect(html).toContain(
      '<a href="/how-its-built/cache/">Why the menu is cached by version, not by time</a>',
    );
    expect(html).not.toContain('/how-its-built/#');
  });

  test('a principle with no lab page links its How it’s built section and its ADR', () => {
    const step = TOURS.checkout.findIndex((s) => s.principle.id === 'idempotency-keys');
    const html = card('checkout', step);
    expect(html).toContain('<a href="/how-its-built/#idempotency-keys">How it’s built</a>');
    expect(html).toContain('/docs/adr/0004-queues-between-objects-and-alarms-for-time.md');
    expect(html).not.toContain('ihaveasegway.com/lab/');
    // It has an essay of its own, which the payment-keys card links too.
    expect(html).toContain(
      '<a href="/how-its-built/idempotency/">Why pressing the button twice never orders twice</a>',
    );
  });

  test('the Raft step links the lab page, the ADR and the essay', () => {
    const step = TOURS.console.findIndex((s) => s.principle.id === 'raft');
    const html = card('console', step);
    expect(html).toContain('href="https://ihaveasegway.com/lab/raft/"');
    expect(html).toContain(
      '<a href="/how-its-built/single-writer/">Why a single-writer object needs no consensus</a>',
    );
    expect(html).toContain('ADR 0003');
  });

  test('every card of a principle with an essay links it by its title, and every essay has a card', () => {
    const linked = new Set<string>();
    for (const screen of SCREENS) {
      TOURS[screen].forEach((step, i) => {
        const html = card(screen, i);
        const essay = ESSAYS[step.principle.id as keyof typeof ESSAYS];
        if (essay === undefined) {
          expect(html, step.id).not.toMatch(/href="\/how-its-built\/[a-z-]+\/"/);
          return;
        }
        expect(html, step.id).toContain(`<a href="${essay.path}">${essay.title}</a>`);
        linked.add(essay.path);
      });
    }
    expect([...linked].sort()).toEqual(ESSAY_PAGES.map((e) => e.path).sort());
  });

  test('every card holds a principle link and an ADR link', () => {
    for (const screen of SCREENS) {
      TOURS[screen].forEach((step, i) => {
        const html = card(screen, i);
        expect(html, step.id).toContain(`href="${step.principle.adrUrl}"`);
        expect(html, step.id).toContain(`href="${step.principle.labUrl ?? step.principle.howUrl}"`);
      });
    }
  });

  test('announces the step in a polite live region and lets the heading take the focus', () => {
    const html = card('menu', 1);
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/<h2[^>]*tabindex="-1"/);
    expect(html).toContain('aria-label="Guided tour"');
  });

  test('names the events, shows the curl masked or with <your token>, and offers a copy', () => {
    const html = card('menu', 0);
    expect(card('menu', 1)).toContain('Events this action produces');
    expect(card('menu', 1)).toContain('<code>MenuPublished</code>');
    expect(html).toContain('curl -X POST');
    expect(html).toContain('Authorization: Bearer &lt;your token&gt;');
    expect(html).toContain('/v1/sandboxes/&lt;sandbox id&gt;/orders');
    expect(html).toContain('Copy the curl');
    expect(html).toContain('Route <code>place-order</code>');
  });

  test('a step that makes no event says so', () => {
    expect(card('menu', 0)).toContain('This action makes no new event of its own');
  });

  test('back is off on the first step, and the last step says Done', () => {
    expect(card('menu', 0)).toMatch(/<button[^>]*disabled[^>]*>Back</);
    expect(card('menu', 1)).not.toMatch(/<button[^>]*disabled[^>]*>Back</);
    expect(card('menu', total - 1)).toContain('>Done<');
    expect(card('menu', 0)).toContain('>Next<');
    expect(card('menu', 0)).toContain('Skip the tour');
  });

  test('every step of every screen draws', () => {
    for (const screen of SCREENS) {
      TOURS[screen].forEach((step, i) => {
        expect(card(screen, i), step.id).toContain(step.title.replaceAll('’', '’'));
      });
    }
  });
});

describe('the trigger before the island has hydrated', () => {
  test.each(SCREENS)('%s draws it disabled, with its text', (screen) => {
    const html = renderToStaticMarkup(createElement(Tour, { screen }));
    expect(html).toMatch(/<button[^>]*class="tour-trigger"[^>]*disabled=""[^>]*>Take the tour</);
  });
});

describe('where the page scrolls to show a step’s target', () => {
  // The window's free part is 16 to 400 (the bar starts at 416 with a 16 px gap).
  test('leaves a target already in the free part where it is', () => {
    expect(revealDelta(100, 200, 16, 400)).toBe(0);
  });
  test('brings a target above the free part down to its top', () => {
    expect(revealDelta(-300, -200, 16, 400)).toBe(-316);
  });
  test('brings a target below the free part up to the bar, so the bar is under it', () => {
    expect(revealDelta(500, 600, 16, 400)).toBe(200);
  });
  test('shows a target taller than the free part from its top', () => {
    expect(revealDelta(300, 4000, 16, 400)).toBe(284);
    expect(revealDelta(-900, 2000, 16, 400)).toBe(-916);
  });
});

describe('what the card says about the token', () => {
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

describe('the console tour', () => {
  test('walks the page from the top to the actions, in the order the sections render', () => {
    expect(TOURS.console.map((step) => step.target)).toEqual([
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
