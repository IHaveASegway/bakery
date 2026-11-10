// The orders placed in this browser tab, so the kitchen board can mark the visitor's own "Yours"
// (G7, 2026-11-10). The kitchen's snapshot does not say which cards a visitor placed: a card
// carries a `cause` only for an event the board saw live, and a seeded order and a visitor's look
// alike in it. So the checkout remembers each order it places, here, and the board reads them.
//
// One sessionStorage entry, `bakery.placed-orders.v1`: a JSON array of order ids, newest first, at
// most 20, and nothing else. It lives as long as the tab and is never sent anywhere
// (docs/security.md, the data inventory; the privacy page's table).

export const PLACED_ORDERS_ITEM = 'bakery.placed-orders.v1';

/** How many ids the tab keeps: far more than a visit places, and the entry stays small. */
export const PLACED_ORDERS_MAX = 20;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** The tab's sessionStorage, or null where touching it throws (blocked site data). */
function tabStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The ids as kept, newest first: only strings, no duplicates. Empty for anything unreadable. */
function readIds(store: Store | null): string[] {
  try {
    const raw = store?.getItem(PLACED_ORDERS_ITEM);
    const read: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(read)) return [];
    const ids = read.filter((id): id is string => typeof id === 'string' && id !== '');
    return [...new Set(ids)].slice(0, PLACED_ORDERS_MAX);
  } catch {
    return [];
  }
}

/**
 * Remembers an order placed in this tab: newest first, once, at most 20. Never throws: without
 * storage (missing, blocked or full) the board simply marks nothing.
 */
export function rememberPlacedOrder(id: string, store: Store | null = tabStore()): void {
  if (id === '' || store === null) return;
  const ids = [id, ...readIds(store).filter((other) => other !== id)].slice(0, PLACED_ORDERS_MAX);
  try {
    store.setItem(PLACED_ORDERS_ITEM, JSON.stringify(ids));
  } catch {
    // Full or blocked: a per-tab convenience only.
  }
}

/** The orders placed in this tab, as a set. Empty when storage is missing, blocked or unreadable. */
export function placedOrders(store: Store | null = tabStore()): Set<string> {
  return new Set(readIds(store));
}
