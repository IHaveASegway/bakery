// The tax rate published with the menu (docs/domain.md, "Money and time"): the console's field in
// percent, the basis points it sends, and the storefront's preview at a rate other than the default.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { totals } from '../src/lib/cart';
import { STATIC_MENU, taxBpOf, taxRateSaid, type MenuView } from '../src/lib/menu';
import { DEFAULT_TAX_BP, MAX_TAX_BP, parseTaxPercent, taxPercent } from '../src/lib/money';

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

// Seed prices: country-loaf/whole 950, country-loaf/half 550.
const lines = [
  { variant: 'country-loaf/whole', qty: 2 },
  { variant: 'country-loaf/half', qty: 1 },
];

describe('the rate in percent', () => {
  test('prints two decimals from basis points', () => {
    expect(taxPercent(1_000)).toBe('10.00');
    expect(taxPercent(850)).toBe('8.50');
    expect(taxPercent(5)).toBe('0.05');
    expect(taxPercent(0)).toBe('0.00');
    expect(taxPercent(MAX_TAX_BP)).toBe('30.00');
  });

  test('reads what staff type, 0 to 30 with at most two decimals', () => {
    expect(parseTaxPercent('8.5')).toBe(850);
    expect(parseTaxPercent('8.50')).toBe(850);
    expect(parseTaxPercent(' 8.50% ')).toBe(850);
    expect(parseTaxPercent('10')).toBe(1_000);
    expect(parseTaxPercent('0')).toBe(0);
    expect(parseTaxPercent('30')).toBe(3_000);
    expect(parseTaxPercent('30.00')).toBe(3_000);
  });

  test('refuses more than 30, a comma, signs and words', () => {
    for (const text of ['30.01', '31', '100', '8,5', '-1', '+5', 'ten', '', '.5', '8.']) {
      expect(parseTaxPercent(text), text).toBeNull();
    }
  });

  test('round-trips every rate the Catalog accepts', () => {
    for (let bp = 0; bp <= MAX_TAX_BP; bp += 7) {
      expect(parseTaxPercent(taxPercent(bp))).toBe(bp);
    }
  });
});

describe('the menu carries its rate', () => {
  const at850: MenuView = { ...STATIC_MENU, version: 4, tax_bp: 850 };

  test('a menu without one reads as the default', () => {
    expect(taxBpOf(STATIC_MENU)).toBe(DEFAULT_TAX_BP);
    expect(taxBpOf(at850)).toBe(850);
  });

  test('totals use the menu’s rate, or the one named', () => {
    // 2,450 cents at 8.50% is 208.25, rounded half-up to 208.
    expect(totals(lines, at850)).toEqual({
      subtotal_cents: 2450,
      tax_cents: 208,
      total_cents: 2658,
      missing: [],
    });
    expect(totals(lines, STATIC_MENU, 850).tax_cents).toBe(208);
    expect(totals(lines, at850, 0).total_cents).toBe(2450);
    expect(totals(lines, STATIC_MENU).tax_cents).toBe(245);
  });
});

describe('the console field', () => {
  test('says the rate was published at once, or that nothing was', () => {
    expect(taxRateSaid(850, 3, 4)).toBe(
      'Tax is now 8.50%. That was published at once as version 4: the next order pays it, and orders already placed keep their rate. Price drafts still wait for Publish.',
    );
    expect(taxRateSaid(1_000, 3, 3)).toBe('Tax is already 10.00%. Nothing was published.');
  });

  test('the editor sends the rate through the route and shows the published one', () => {
    const editor = source('../src/components/MenuEditor.tsx');
    expect(editor).toContain('setTaxRate(sandboxId, bp)');
    expect(editor).toContain('Tax rate, in percent');
    expect(editor).toContain('data-tour="controls-tax"');
    expect(editor).toContain('parseTaxPercent(');
    expect(editor).toContain('Published: ${taxPercent(publishedRate)}%');
  });

  test('checkout shows the menu’s rate, not the constant', () => {
    const checkout = source('../src/components/Checkout.tsx');
    expect(checkout).toContain('Tax at {taxPercent(taxBp)}%');
    expect(checkout).toContain('totals(cart.lines, menu.menu, taxBp)');
    expect(checkout).not.toContain('DEFAULT_TAX_BP');
  });
});
