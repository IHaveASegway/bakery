// The cart: variant slugs and quantities, an order note, and how the visitor wants to receive it.
// It lives in sessionStorage, which is the visitor's own choice of items and nothing personal;
// checkout clears it (docs/security.md, the storefront's data; docs/domain.md, "Free text").
// Everything here is pure except the two storage functions, which take the storage as an argument.
import { taxCents } from './money';
import { findVariant, inSeason, taxBpOf, type ItemView, type MenuView } from './menu';
import { type Local } from './slots';

/** An order holds 1 to 20 lines, each a quantity of 1 to 24 (docs/domain.md, "Order"). */
export const MAX_LINES = 20;
export const MAX_QTY = 24;
/** The order note's cap in characters (docs/domain.md, "Free text and personal data"). */
export const NOTE_MAX = 140;

export interface CartLine {
  variant: string;
  qty: number;
}

export interface Cart {
  lines: CartLine[];
  note: string;
  kind: 'pickup' | 'delivery';
  /** The business time chosen, or empty while none is. */
  slot: string;
}

export const EMPTY_CART: Cart = { lines: [], note: '', kind: 'pickup', slot: '' };

export const clampQty = (qty: number) => Math.min(MAX_QTY, Math.max(1, Math.trunc(qty) || 1));

/** The sentence shown, once, when a typed quantity had to be moved into range. */
export const QTY_HINT = `Quantities run from 1 to ${MAX_QTY}.`;

/** A typed quantity that is already a whole number in range, else null (the field is mid-edit). */
export function validQty(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= MAX_QTY ? n : null;
}

/**
 * What a quantity field settles to when the visitor is done with it (blur or Enter): the number
 * moved into range, and whether it had to be, so the page can say the range once.
 */
export function commitQty(text: string): { qty: number; clamped: boolean } {
  const valid = validQty(text);
  if (valid !== null) return { qty: valid, clamped: false };
  const n = text.trim() === '' ? Number.NaN : Number(text);
  return { qty: clampQty(n), clamped: true };
}

/** Adds one of a variant, or raises its line; a 21st distinct line is refused. */
export function addLine(cart: Cart, variant: string): { cart: Cart; refused: 'full' | null } {
  const existing = cart.lines.find((l) => l.variant === variant);
  if (existing) {
    return {
      cart: {
        ...cart,
        lines: cart.lines.map((l) => (l === existing ? { ...l, qty: clampQty(l.qty + 1) } : l)),
      },
      refused: null,
    };
  }
  if (cart.lines.length >= MAX_LINES) return { cart, refused: 'full' };
  return { cart: { ...cart, lines: [...cart.lines, { variant, qty: 1 }] }, refused: null };
}

export function setQty(cart: Cart, variant: string, qty: number): Cart {
  return {
    ...cart,
    lines: cart.lines.map((l) => (l.variant === variant ? { ...l, qty: clampQty(qty) } : l)),
  };
}

export function removeLine(cart: Cart, variant: string): Cart {
  return { ...cart, lines: cart.lines.filter((l) => l.variant !== variant) };
}

/** The note's length the way the API counts it: Unicode scalar values after NFC, no controls. */
export function normalizeNote(text: string): string {
  // Controls first, then NFC, as the Worker does: a control between a letter and its accent
  // cannot then keep them apart.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '').normalize('NFC');
}

export const noteLength = (text: string) => Array.from(normalizeNote(text)).length;

export interface Totals {
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  /** Variants the menu in hand does not list: not priced, and a reason not to order. */
  missing: string[];
}

/**
 * Subtotal, tax once on the subtotal (half-up) and total, all as cents. The rate is the menu's own
 * unless the caller names one.
 */
export function totals(lines: CartLine[], menu: MenuView, taxBp: number = taxBpOf(menu)): Totals {
  let subtotal = 0;
  const missing: string[] = [];
  for (const line of lines) {
    const found = findVariant(menu, line.variant);
    if (found === null) missing.push(line.variant);
    else subtotal += found.variant.price_cents * line.qty;
  }
  const tax = taxCents(subtotal, taxBp);
  return { subtotal_cents: subtotal, tax_cents: tax, total_cents: subtotal + tax, missing };
}

/** The items the cart's lines belong to, once each. */
export function cartItems(lines: CartLine[], menu: MenuView): ItemView[] {
  const items = new Map<string, ItemView>();
  for (const line of lines) {
    const found = findVariant(menu, line.variant);
    if (found) items.set(found.item.slug, found.item);
  }
  return [...items.values()];
}

/**
 * How far ahead the slot must be: the longest variant lead time, or the bulk lead when more than
 * `over_qty` of one variant is ordered (the domain's rule, applied per variant).
 */
export function leadMinutesFor(lines: CartLine[], menu: MenuView): number {
  let needed = 0;
  for (const line of lines) {
    const found = findVariant(menu, line.variant);
    if (found === null) continue;
    needed = Math.max(needed, found.variant.lead_minutes);
    const bulk = found.item.bulk_lead;
    if (bulk && line.qty > bulk.over_qty) needed = Math.max(needed, bulk.lead_minutes);
  }
  return needed;
}

/** The days the bakery bakes anything at all: the union of every item's days. */
export function openDays(menu: MenuView): Set<string> {
  return new Set(menu.categories.flatMap((c) => c.items.flatMap((i) => i.days_baked)));
}

/** Whether a day suits the bakery and every item in the cart: open, baked that day, in season. */
export function dayAccepts(menu: MenuView, lines: CartLine[]): (local: Local) => boolean {
  const open = openDays(menu);
  const items = cartItems(lines, menu);
  return (l) =>
    open.has(l.weekday) &&
    items.every((i) => i.days_baked.includes(l.weekday) && inSeason(i.season, l.month, l.day));
}

/** The reason delivery is not on offer for this cart, if there is one. */
export function deliveryBlocker(lines: CartLine[], menu: MenuView): string | null {
  const only = cartItems(lines, menu).find((i) => i.pickup_only);
  return only ? `${only.name} is pickup only. Choose pickup, or take it out of the cart.` : null;
}

// Storage ----------------------------------------------------------------------------------

export const CART_KEY = 'bakery.cart.v1';

/** The slice of Storage the cart needs, so tests pass a plain object. */
export interface CartStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A stored cart, checked field by field; anything off about it is an empty cart. */
export function parseCart(text: string | null): Cart {
  if (text === null) return EMPTY_CART;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object') return EMPTY_CART;
    const raw = value as Record<string, unknown>;
    const lines: CartLine[] = [];
    if (Array.isArray(raw['lines'])) {
      for (const entry of raw['lines'] as unknown[]) {
        if (entry === null || typeof entry !== 'object') continue;
        const { variant, qty } = entry as Record<string, unknown>;
        if (typeof variant === 'string' && typeof qty === 'number' && lines.length < MAX_LINES) {
          if (!lines.some((l) => l.variant === variant))
            lines.push({ variant, qty: clampQty(qty) });
        }
      }
    }
    return {
      lines,
      note: typeof raw['note'] === 'string' ? raw['note'].slice(0, 400) : '',
      kind: raw['kind'] === 'delivery' ? 'delivery' : 'pickup',
      slot: typeof raw['slot'] === 'string' ? raw['slot'] : '',
    };
  } catch {
    return EMPTY_CART;
  }
}

/** Reads the cart; a blocked or empty storage is an empty cart. */
export function loadCart(storage: CartStorage | null): Cart {
  try {
    return parseCart(storage?.getItem(CART_KEY) ?? null);
  } catch {
    return EMPTY_CART;
  }
}

/** Saves the cart, or removes the entry when it is empty. A blocked storage is not an error. */
export function saveCart(storage: CartStorage | null, cart: Cart): void {
  try {
    if (cart.lines.length === 0 && cart.note === '') storage?.removeItem(CART_KEY);
    else storage?.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    // Private windows and blocked site data: the cart then lasts as long as the page.
  }
}

/** The browser's sessionStorage, or null where touching it throws. */
export function browserStorage(): CartStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
