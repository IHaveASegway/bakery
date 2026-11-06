// The tour's island drawn once, statically: the trigger of a closed tour, and the card of an open
// one at the first, a middle and the last step. Effects do not run in a static render, so the focus,
// the ring and the activity read are covered by the pure parts in tour.test.ts.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import Tour, { TourCard } from '../src/components/Tour';
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

  test('shows the progress, the title, what it is and the principle as names', () => {
    const html = card('menu', 0);
    expect(html).toContain(`1 of ${total}`);
    expect(html).toContain('Where the menu came from');
    expect(html).toContain('This is the demo’s seed menu');
    expect(html).toContain('Cache invalidation by version');
    expect(html).toContain('Cache Lab');
    expect(html).toContain('0003');
    // Names only: the links arrive in PR 12.
    expect(html).not.toMatch(/<a [^>]*href/);
  });

  test('announces the step in a polite live region and lets the heading take the focus', () => {
    const html = card('menu', 1);
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/<h2[^>]*tabindex="-1"/);
    expect(html).toContain('aria-label="Guided tour"');
  });

  test('names the events, shows the curl masked or with <your token>, and offers a copy', () => {
    const html = card('menu', 1);
    expect(card('menu', 2)).toContain('Events this action produces');
    expect(card('menu', 2)).toContain('<code>MenuPublished</code>');
    expect(html).toContain('curl -X POST');
    expect(html).toContain('Authorization: Bearer &lt;your token&gt;');
    expect(html).toContain('/v1/sandboxes/&lt;sandbox id&gt;/orders');
    expect(html).toContain('Copy the curl');
    expect(html).toContain('Route <code>place-order</code>');
  });

  test('a step that makes no event says so', () => {
    expect(card('menu', 1)).toContain('This action makes no new event of its own');
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
