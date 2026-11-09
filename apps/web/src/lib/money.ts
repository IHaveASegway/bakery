// Money is an integer count of US cents everywhere (docs/domain.md, "Money and time"). The
// storefront shows a total it computed only as a preview; the API's answer is the one that counts.

/** The demo tax rate, 1,000 basis points or 10.00%, until staff change it in the console. */
export const DEFAULT_TAX_BP = 1_000;
/** The highest rate staff may set, 3,000 basis points or 30.00% (the Catalog's bound). */
export const MAX_TAX_BP = 3_000;

/** A rate in basis points as a percentage with two decimals: 850 is "8.50". Integer math only. */
export function taxPercent(bp: number): string {
  return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;
}

/**
 * Basis points from what a person typed in a percent field: "8", "8.5", "8.50" or "8.50%", 0 to
 * 30 with at most two decimals. Null for anything else.
 */
export function parseTaxPercent(text: string): number | null {
  const match = /^\s*(\d{1,2})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(text);
  if (match === null) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bp <= MAX_TAX_BP ? bp : null;
}

/** "$9.50" for 950. Cents are an integer; anything else is a bug upstream. */
export function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** Tax on a subtotal in basis points, rounded half-up to the cent, computed once. */
export function taxCents(subtotalCents: number, bp: number = DEFAULT_TAX_BP): number {
  return Math.floor((subtotalCents * bp + 5_000) / 10_000);
}

/**
 * Cents from what a person typed in a dollars field: "9", "9.5" or "9.50", up to $9,999.99.
 * Null for anything else, and for zero, since a price is positive (docs/domain.md, "MenuItem
 * availability").
 */
export function parseDollars(text: string): number | null {
  const match = /^\s*(\d{1,4})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (match === null) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

/** A price in a dollars field: 950 is "9.50". */
export function dollarsField(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
