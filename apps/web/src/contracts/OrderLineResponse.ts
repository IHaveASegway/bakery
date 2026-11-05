/**
 * Generated from crates/contracts/schemas/OrderLineResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * A placed line, priced from the menu version the order names; never repriced.
 */
export interface OrderLineResponse {
  item: string;
  qty: number;
  unit_cents: number;
  variant: string;
}
