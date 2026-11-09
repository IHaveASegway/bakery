import { readFileSync } from 'node:fs';
import { wcagContrast, type Color } from 'culori';
import { describe, expect, test } from 'vitest';
import { block, declarations, resolve, stripComments, themeColors } from '../src/lib/tokens';

// The guide's dark layer (src/styles/guide.css) against itself and against the page. Its colours
// are its own, scoped to .guide-layer, and the same in both colour schemes: the guide never reads
// as part of the bakery. Text 4.5 to 1 on each of the layer's surfaces (SC 1.4.3); the edge of
// anything that floats over the page, and the hotspot's ring and fill, 3 to 1 against the page's
// background in each scheme (SC 1.4.11), so a note, the bar and a mark can always be told apart.

const guideCss = readFileSync(new URL('../src/styles/guide.css', import.meta.url), 'utf8');
const pageCss = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
const ownBlock = declarations(block(stripComments(guideCss), '.guide-layer'));
const guide = resolve(new Map([...ownBlock].filter(([name]) => name !== 'guide-shadow')));
const get = (name: string): Color => {
  const color = guide.get(name);
  if (!color) throw new Error(`--${name} is missing from .guide-layer`);
  return color;
};

const SURFACES = ['guide-surface', 'guide-raised'];
const TEXT = ['guide-text', 'guide-muted', 'guide-accent', 'guide-bad'];

describe('the guide’s layer', () => {
  test('declares its colours on its own root, and nowhere for one scheme only', () => {
    expect(ownBlock.size).toBeGreaterThan(8);
    expect(stripComments(guideCss)).not.toContain('prefers-color-scheme');
  });

  for (const surface of SURFACES) {
    for (const name of TEXT) {
      test(`${name} on ${surface} reaches 4.5:1`, () => {
        expect(wcagContrast(get(name), get(surface))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  test('ink on the accent (the switch and an open hotspot) reaches 4.5:1', () => {
    expect(wcagContrast(get('guide-accent-ink'), get('guide-accent'))).toBeGreaterThanOrEqual(4.5);
  });

  test('a focus ring on the layer’s surfaces reaches 3:1', () => {
    for (const surface of SURFACES) {
      expect(wcagContrast(get('guide-accent'), get(surface))).toBeGreaterThanOrEqual(3);
    }
  });
});

for (const scheme of ['light', 'dark'] as const) {
  describe(`over the page, ${scheme}`, () => {
    const page = themeColors(pageCss, scheme).get('background') as Color;

    test('a note’s and the bar’s edge, or their surface, reaches 3:1 on the page', () => {
      const best = Math.max(
        wcagContrast(get('guide-edge'), page),
        wcagContrast(get('guide-surface'), page),
      );
      expect(best).toBeGreaterThanOrEqual(3);
    });

    test('a hotspot’s ring or its fill reaches 3:1 on the page', () => {
      const best = Math.max(
        wcagContrast(get('guide-accent'), page),
        wcagContrast(get('guide-surface'), page),
      );
      expect(best).toBeGreaterThanOrEqual(3);
    });

    test('the dark layer differs from the page in this scheme', () => {
      expect(wcagContrast(get('guide-surface'), page)).toBeGreaterThan(1);
    });
  });
}
