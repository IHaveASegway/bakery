import { readFileSync } from 'node:fs';
import { inGamut, wcagContrast, type Color } from 'culori';
import { describe, expect, test } from 'vitest';
import { SELECTORS, block, stripComments, themeBlocks, themeColors } from '../src/lib/tokens';

// The contrast claim belongs to this test, not to a comment. It reads tokens.css, resolves every
// color token in both themes, and checks each text and non-text token against every surface: the
// cross product, not a hand-picked list. The bakery owns its copy of tokens.css; the site's lab and
// map tokens ride along until a later pull request prunes them.

const SURFACES = ['background', 'surface-1', 'surface-2', 'ground'];
/** Text: 4.5:1 on every surface (SC 1.4.3). */
const TEXT = [
  'foreground',
  'muted-foreground',
  'subtle-foreground',
  'primary',
  'primary-strong',
  'signal',
  'destructive',
];
/** Non-text: focus outlines and functional borders, 3:1 on every surface (SC 1.4.11). */
const NON_TEXT = ['ring', 'input'];
/** Text drawn on an accent fill, such as a button label, against each fill it sits on. */
const ON_FILL: Record<string, string[]> = { 'primary-foreground': ['primary', 'primary-strong'] };

const source = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
const css = stripComments(source);
const blocks = themeBlocks(source);
const themes = { dark: themeColors(source, 'dark'), light: themeColors(source, 'light') };

describe('the theme blocks', () => {
  test('dark from the OS is the same block as dark by choice, so the copy cannot drift', () => {
    expect(Object.fromEntries(blocks.darkFromOs)).toEqual(Object.fromEntries(blocks.dark));
  });

  test('dark redeclares every color token light declares, so dark never inherits a light value', () => {
    expect([...blocks.dark.keys()].sort()).toEqual([...blocks.light.keys()].sort());
  });

  test('the contrast and print blocks come last, and name [data-theme] so they outrank every theme', () => {
    const contrast = css.indexOf('@media (prefers-contrast: more)');
    const print = css.indexOf('@media print');
    for (const at of [contrast, print]) {
      expect(at).toBeGreaterThan(css.indexOf(SELECTORS.darkMedia));
      expect(at).toBeGreaterThan(css.indexOf(SELECTORS.dark));
    }
    for (const media of ['@media (prefers-contrast: more)', '@media print']) {
      expect(() => block(block(css, media), ':root, :root[data-theme]'), media).not.toThrow();
    }
  });
});

for (const [themeName, colors] of Object.entries(themes)) {
  describe(`${themeName} theme`, () => {
    const get = (name: string): Color => {
      const color = colors.get(name);
      if (!color) throw new Error(`--${name} is missing or not a color`);
      return color;
    };

    test('every value is inside sRGB, so no browser clips it', () => {
      const outside = [...colors]
        .filter(([, color]) => !inGamut('rgb')(color))
        .map(([name]) => name);
      expect(outside).toEqual([]);
    });

    for (const surface of SURFACES) {
      for (const name of TEXT) {
        test(`${name} on ${surface} reaches 4.5:1`, () => {
          expect(wcagContrast(get(name), get(surface))).toBeGreaterThanOrEqual(4.5);
        });
      }
      for (const name of NON_TEXT) {
        test(`${name} on ${surface} reaches 3:1`, () => {
          expect(wcagContrast(get(name), get(surface))).toBeGreaterThanOrEqual(3);
        });
      }
    }

    for (const [name, fills] of Object.entries(ON_FILL)) {
      for (const fill of fills) {
        test(`${name} on ${fill} reaches 4.5:1`, () => {
          expect(wcagContrast(get(name), get(fill))).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  });
}
