/**
 * Generated from crates/contracts/schemas/OrderRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * Pickup at the counter, or delivery to a zone.
 */
export type OrderKind = 'pickup' | 'delivery';

/**
 * `POST /v1/sandboxes/{id}/orders`. The customer is the sandbox's persona; the prices come
 * from the menu version the Catalog publishes when the order is placed.
 */
export interface OrderRequest {
  kind: OrderKind;
  /**
   * 1 to 20 lines.
   */
  lines: OrderLineRequest[];
  /**
   * At most 140 characters, with no email address, phone number, card number or URL.
   */
  note?: string | null;
  /**
   * The pickup slot's or delivery window's start, a business time such as
   * `2026-11-07T09:45:00-07:00`.
   */
  slot: string;
  /**
   * `z1`, `z2` or `z3` for a delivery; absent for a pickup.
   */
  zone?: string | null;
}
/**
 * One line of an order as the customer asks for it.
 */
export interface OrderLineRequest {
  /**
   * 1 to 24.
   */
  qty: number;
  /**
   * A variant slug from the menu, such as `croissant/box-6`.
   */
  variant: string;
}
