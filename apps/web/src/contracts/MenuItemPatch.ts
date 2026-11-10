/**
 * Generated from crates/contracts/schemas/MenuItemPatch.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * What a staff edit may set on a menu item's status.
 */
export type MenuItemStatus = 'paused' | 'available';

/**
 * `PATCH /v1/sandboxes/{id}/menu/items/{slug}`, signed-in sessions only. A price is a draft
 * until `POST .../menu/publish`: with `variant`, that variant's price; without it, every variant
 * of the item gets the one price, as before `variant` was added. A pause or a resume publishes
 * that one item at once.
 */
export interface MenuItemPatch {
  price_cents?: number | null;
  status?: MenuItemStatus | null;
  /**
   * The one variant `price_cents` is for, by its slug, such as `country-loaf/half` (added
   * 2026-11-10, roadmap R86). It needs `price_cents` (422 `menu`, rule
   * `variant-without-price`), and a slug that is not one of this item's variants is refused
   * (422 `menu`, rule `unknown-variant`).
   */
  variant?: string | null;
}
