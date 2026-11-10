// The capacity card's day as compact tables (2026-11-10): one row a slot, a zone or an item, the
// numbers in their own cells, and a bar of how full drawn by a class, never a style attribute.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Day } from '../src/components/CapacityEditor';
import { scheduleFor } from './support';

describe('the capacity card’s day', () => {
  const html = renderToStaticMarkup(
    createElement(Day, {
      schedule: scheduleFor('2026-11-10', { capacity: 6, taken: { '10:00': 3, '10:15': 6 } }),
    }),
  );

  test('is a table of slots: time, taken of capacity, free, and how full', () => {
    expect(html).toContain('<caption>Pickup slots</caption>');
    expect(html).toMatch(
      /<th scope="row">10:00 am<\/th><td class="num">3 of 6<\/td><td class="num">3<\/td>/,
    );
    expect(html).toContain('<span class="bar-fill bar-5"></span>');
    expect(html).toContain('<span class="bar-fill bar-10"></span>');
  });

  test('draws its bars with classes and hides them from assistive technology', () => {
    expect(html).not.toMatch(/\sstyle=/);
    for (const track of html.match(/<span class="bar-track"[^>]*>/g) ?? []) {
      expect(track).toContain('aria-hidden="true"');
    }
  });
});
