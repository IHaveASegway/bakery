// The geometry behind the axe helper's one exception (apps/web/e2e/cover.ts): a control under the
// page's own bars counts for target-size only when no scroll can bring it out between them.
import { describe, expect, test } from 'vitest';
import { freeable } from '../e2e/cover';

describe('a control under the page’s own bars', () => {
  const bands = { top: 56, bottom: 720 };
  test('one scrolled up under the top bar can be scrolled back out: freeable', () => {
    // A card's Start at document 300..340, the page scrolled 270 down, 1 500 px of scroll.
    expect(freeable({ docTop: 300, docBottom: 340 }, bands, 1500)).toBe(true);
  });
  test('one at the very end of the page under a fixed bottom nav cannot be: not freeable', () => {
    // A 720 px window whose foot 72 px is a fixed nav; the page scrolls 1 000 px at most; the
    // control sits in the document's last 60 px, so at the deepest scroll it is still under the nav.
    const phone = { top: 56, bottom: 648 };
    expect(freeable({ docTop: 1660, docBottom: 1700 }, phone, 1000)).toBe(false);
    // A little higher, it can be freed.
    expect(freeable({ docTop: 1500, docBottom: 1540 }, phone, 1000)).toBe(true);
  });
  test('one taller than the room between the bars is never freed', () => {
    expect(freeable({ docTop: 100, docBottom: 800 }, bands, 5000)).toBe(false);
  });
  test('one under the top bar of a page that does not scroll is not freed', () => {
    expect(freeable({ docTop: 20, docBottom: 50 }, bands, 0)).toBe(false);
  });
});
