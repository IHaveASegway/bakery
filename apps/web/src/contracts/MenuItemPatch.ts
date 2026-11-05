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
 * `PATCH /v1/sandboxes/{id}/menu/items/{slug}`, signed-in sessions only. A price is a draft,
 * set on every variant of the item, until `POST .../menu/publish`; a pause or a resume
 * publishes that one item at once.
 */
export interface MenuItemPatch {
  price_cents?: number | null;
  status?: MenuItemStatus | null;
}
