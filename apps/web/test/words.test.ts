import { describe, expect, test } from 'vitest';
import { buildTarget, changedText } from '../src/lib/capacity';
import { bakeLineText } from '../src/lib/kitchen';
import {
  FORMATTERS,
  hhmmText,
  itemName,
  likesText,
  targetText,
  variantName,
} from '../src/lib/words';
import { scheduleFor } from './support';

// The console prints a person's word where one exists, never the API's key for it: no slug, no
// slot key, no target string in a status line, an activity row, a customer's card, the capacity
// form or the bake list. Each formatter is listed in FORMATTERS and held to that here.

/** An internal key's shapes: `slot:07:45`, `zone:z2`, `item:x`, a slug with a hyphen, `a/b`. */
const KEY = /\b(slot|zone|item):|\b[a-z0-9]+-[a-z0-9-]+\b|\/|\bz\d\b/;
const SAMPLES: Record<(typeof FORMATTERS)[keyof typeof FORMATTERS]['takes'], string[]> = {
  slug: ['country-loaf', 'seeded-rye', 'croissant', 'box-6', 'a/b', ''],
  variant: ['country-loaf/half', 'croissant/box-6', 'seeded-rye', ''],
  time: ['07:45', '13:15', '00:00', '7:5', 'slot:07:45', ''],
  target: ['slot:07:45', 'zone:z2', 'item:country-loaf', 'catering', 'slot:7', 'what', ''],
  slugs: ['seeded-rye,country-loaf', 'croissant', ''],
};

describe('every formatter says a word, not a key', () => {
  test('the list is the module’s formatters', () => {
    expect(Object.keys(FORMATTERS).sort()).toEqual(
      ['hhmmText', 'itemName', 'likesText', 'targetText', 'variantName'].sort(),
    );
  });

  for (const [name, { format, takes }] of Object.entries(FORMATTERS)) {
    test(`${name} never prints a key`, () => {
      for (const sample of SAMPLES[takes]) {
        const out = format(sample);
        expect(out, `${name}(${JSON.stringify(sample)}) = ${out}`).not.toMatch(KEY);
        expect(out.trim()).not.toBe('');
      }
    });
  }
});

describe('the words themselves', () => {
  test('items and variants by name', () => {
    expect(itemName('country-loaf')).toBe('Country loaf');
    expect(itemName('seeded-rye')).toBe('Seeded rye');
    expect(variantName('country-loaf/half')).toBe('Country loaf, half');
    expect(variantName('croissant/box-6')).toBe('Croissant, box 6');
    expect(likesText(['seeded-rye', 'croissant'])).toBe('Seeded rye, Croissant');
    expect(likesText([])).toBe('nothing yet');
  });

  test('times and targets as the console says them', () => {
    expect(hhmmText('07:45')).toBe('7:45 am');
    expect(hhmmText('12:00')).toBe('12:00 pm');
    expect(hhmmText('00:15')).toBe('12:15 am');
    expect(hhmmText('13:15')).toBe('1:15 pm');
    expect(targetText('slot:07:45')).toBe('the 7:45 am slot');
    expect(targetText('zone:z2')).toBe('zone 2');
    expect(targetText('item:country-loaf')).toBe('Country loaf’s daily cap');
    expect(targetText('catering')).toBe('catering events');
  });

  test('the capacity line and the bake list use them', () => {
    const day = scheduleFor('2026-11-07');
    const line = changedText('slot:07:45', 3, day);
    expect(line.startsWith('Capacity for the 7:45 am slot is now 3.')).toBe(true);
    expect(line).not.toMatch(KEY);
    expect(bakeLineText({ item: 'country-loaf', qty: 12 })).toBe('12 × Country loaf');
    for (const kind of ['slot', 'zone', 'item'] as const) {
      const built = buildTarget(kind, '');
      if (!built.ok) expect(built.reason).not.toMatch(/\bz\d\b/);
    }
  });
});
