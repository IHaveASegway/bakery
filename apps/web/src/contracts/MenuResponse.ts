/**
 * Generated from crates/contracts/schemas/MenuResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * An item's stored lifecycle; the menu lists `available` and `paused` items.
 */
export type MenuItemState = 'draft' | 'available' | 'paused' | 'retired';

/**
 * `GET /v1/sandboxes/{id}/menu`: the published menu, with `ETag: "v<version>"`.
 */
export interface MenuResponse {
  categories: MenuCategory[];
  /**
   * The tax rate in basis points that an order placed against this version pays; staff set
   * it with `PATCH .../menu/tax-rate`. A menu cached before the field existed leaves it out,
   * which reads as the default, 1,000.
   */
  tax_bp?: number;
  version: number;
}
export interface MenuCategory {
  items: MenuItem[];
  name: string;
  slug: string;
}
export interface MenuItem {
  /**
   * From the nine major US allergens, such as `wheat` and `tree-nuts`.
   */
  allergens: string[];
  bulk_lead?: MenuBulkLead | null;
  daily_cap: number;
  /**
   * `mon` to `sun`.
   */
  days_baked: string[];
  name: string;
  pickup_only: boolean;
  season?: MenuSeason | null;
  slug: string;
  status: MenuItemState;
  variants: MenuVariant[];
}
/**
 * More than `over_qty` of one variant needs `lead_minutes`.
 */
export interface MenuBulkLead {
  lead_minutes: number;
  over_qty: number;
}
/**
 * A seasonal window, `MM-DD` to `MM-DD` inclusive, wrapping over the new year when `from` is
 * after `to`.
 */
export interface MenuSeason {
  from: string;
  to: string;
}
export interface MenuVariant {
  label: string;
  lead_minutes: number;
  price_cents: number;
  /**
   * `<item slug>/<suffix>`, such as `croissant/box-6`.
   */
  slug: string;
}
