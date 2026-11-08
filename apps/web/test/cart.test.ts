import { describe, expect, test } from 'vitest';
import {
  CART_KEY,
  EMPTY_CART,
  MAX_LINES,
  MAX_QTY,
  NOTE_MAX,
  addLine,
  loadCart,
  noteLength,
  parseCart,
  removeLine,
  saveCart,
  QTY_HINT,
  commitQty,
  setQty,
  validQty,
  totals,
  type CartStorage,
} from '../src/lib/cart';
import { STATIC_MENU } from '../src/lib/menu';
import { dollars, dollarsField, parseDollars, taxCents } from '../src/lib/money';

// Seed prices: country-loaf/whole 950, country-loaf/half 550.

describe('cart arithmetic, in cents', () => {
  test('subtotal, tax once on the subtotal, total', () => {
    const lines = [
      { variant: 'country-loaf/whole', qty: 2 },
      { variant: 'country-loaf/half', qty: 1 },
    ];
    expect(totals(lines, STATIC_MENU)).toEqual({
      subtotal_cents: 2450,
      tax_cents: 245,
      total_cents: 2695,
      missing: [],
    });
  });

  test('tax is 10.00% rounded half-up to the cent', () => {
    expect(taxCents(4)).toBe(0); // 0.4
    expect(taxCents(5)).toBe(1); // 0.5 rounds up
    expect(taxCents(14)).toBe(1); // 1.4
    expect(taxCents(15)).toBe(2); // 1.5 rounds up
    expect(taxCents(0)).toBe(0);
    expect(taxCents(2450)).toBe(245);
  });

  test('tax is computed once, not per line', () => {
    // Two lines of 5 cents: per line 1 + 1 = 2, once on 10 cents it is 1.
    expect(taxCents(10)).toBe(1);
  });

  test('a variant the menu does not list is named and not priced', () => {
    const sum = totals([{ variant: 'nothing/here', qty: 3 }], STATIC_MENU);
    expect(sum.missing).toEqual(['nothing/here']);
    expect(sum.total_cents).toBe(0);
  });

  test('money prints from cents', () => {
    expect(dollars(950)).toBe('$9.50');
    expect(dollars(5)).toBe('$0.05');
    expect(dollars(123456)).toBe('$1,234.56');
    expect(dollarsField(950)).toBe('9.50');
  });

  test('a price field reads dollars and cents, never zero or junk', () => {
    expect(parseDollars('9')).toBe(900);
    expect(parseDollars('9.5')).toBe(950);
    expect(parseDollars(' 9.50 ')).toBe(950);
    expect(parseDollars('0')).toBeNull();
    expect(parseDollars('0.00')).toBeNull();
    expect(parseDollars('-1')).toBeNull();
    expect(parseDollars('9.505')).toBeNull();
    expect(parseDollars('$9')).toBeNull();
    expect(parseDollars('')).toBeNull();
  });
});

describe('cart limits', () => {
  test('adding a variant again raises its quantity, to at most 24', () => {
    let cart = EMPTY_CART;
    for (let i = 0; i < 30; i++) cart = addLine(cart, 'country-loaf/whole').cart;
    expect(cart.lines).toEqual([{ variant: 'country-loaf/whole', qty: MAX_QTY }]);
  });

  test('a quantity is 1 to 24', () => {
    let cart = addLine(EMPTY_CART, 'a/b').cart;
    expect(setQty(cart, 'a/b', 0).lines[0]?.qty).toBe(1);
    expect(setQty(cart, 'a/b', 99).lines[0]?.qty).toBe(24);
    expect(setQty(cart, 'a/b', Number.NaN).lines[0]?.qty).toBe(1);
    expect(setQty(cart, 'a/b', 7).lines[0]?.qty).toBe(7);
    cart = removeLine(cart, 'a/b');
    expect(cart.lines).toEqual([]);
  });

  test('a 21st distinct line is refused', () => {
    let cart = EMPTY_CART;
    for (let i = 0; i < MAX_LINES; i++) cart = addLine(cart, `item-${i}/one`).cart;
    expect(cart.lines).toHaveLength(MAX_LINES);
    const over = addLine(cart, 'one-more/one');
    expect(over.refused).toBe('full');
    expect(over.cart.lines).toHaveLength(MAX_LINES);
    // A line already in the cart can still be raised.
    expect(addLine(cart, 'item-0/one').refused).toBeNull();
  });
});

describe('the note counter', () => {
  test('counts characters, 140 at most', () => {
    expect(NOTE_MAX).toBe(140);
    expect(noteLength('')).toBe(0);
    expect(noteLength('a'.repeat(140))).toBe(140);
    expect(noteLength('a'.repeat(141))).toBe(141);
  });

  test('counts Unicode scalar values, not UTF-16 units', () => {
    expect(noteLength('😀')).toBe(1);
    expect(noteLength('é')).toBe(1); // composes to one character under NFC
  });

  test('drops control characters but keeps a newline', () => {
    expect(noteLength('a\u0007b')).toBe(2);
    expect(noteLength('a\nb')).toBe(3);
  });
});

describe('the cart in sessionStorage', () => {
  const memory = (): CartStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
  };

  test('round trips, and holds only slugs, quantities, the note and the fulfilment', () => {
    const storage = memory();
    const cart = {
      ...EMPTY_CART,
      lines: [{ variant: 'country-loaf/whole', qty: 2 }],
      note: 'Crusty please',
      kind: 'delivery' as const,
      zone: 'z2' as const,
      slot: '2026-11-06T09:00:00-07:00',
    };
    saveCart(storage, cart);
    expect(Object.keys(JSON.parse(storage.data.get(CART_KEY)!))).toEqual([
      'lines',
      'note',
      'kind',
      'zone',
      'slot',
    ]);
    expect(loadCart(storage)).toEqual(cart);
  });

  test('an empty cart removes its entry', () => {
    const storage = memory();
    saveCart(storage, { ...EMPTY_CART, lines: [{ variant: 'a/b', qty: 1 }] });
    saveCart(storage, EMPTY_CART);
    expect(storage.data.size).toBe(0);
  });

  test('a blocked storage is an empty cart, and saving does not throw', () => {
    const blocked: CartStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadCart(blocked)).toEqual(EMPTY_CART);
    expect(() => saveCart(blocked, { ...EMPTY_CART, note: 'x' })).not.toThrow();
    expect(loadCart(null)).toEqual(EMPTY_CART);
  });

  test('anything off about a stored cart is checked away', () => {
    expect(parseCart('not json')).toEqual(EMPTY_CART);
    expect(parseCart('[1,2]')).toEqual(EMPTY_CART);
    const odd = parseCart(
      JSON.stringify({
        lines: [
          { variant: 'a/b', qty: 500 },
          { variant: 'a/b', qty: 2 },
          { variant: 7, qty: 1 },
          'junk',
        ],
        kind: 'teleport',
        zone: 'z9',
        note: 5,
        slot: 7,
      }),
    );
    expect(odd).toEqual({ ...EMPTY_CART, lines: [{ variant: 'a/b', qty: 24 }] });
  });
});

describe('the quantity field (audit P5)', () => {
  test('a whole number in range passes as typed; an emptied or half-typed field does not', () => {
    expect(validQty('7')).toBe(7);
    expect(validQty('24')).toBe(24);
    expect(validQty('')).toBeNull();
    expect(validQty('0')).toBeNull();
    expect(validQty('99')).toBeNull();
    expect(validQty('2.5')).toBeNull();
  });

  test('on blur the value settles into range and says so only when it moved', () => {
    expect(commitQty('7')).toEqual({ qty: 7, clamped: false });
    expect(commitQty('')).toEqual({ qty: 1, clamped: true });
    expect(commitQty('0')).toEqual({ qty: 1, clamped: true });
    expect(commitQty('99')).toEqual({ qty: 24, clamped: true });
    expect(commitQty('2.5')).toEqual({ qty: 2, clamped: true });
    expect(QTY_HINT).toBe('Quantities run from 1 to 24.');
  });
});
