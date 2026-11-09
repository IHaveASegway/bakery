/**
 * Generated from crates/contracts/schemas/TaxRateRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `PATCH /v1/sandboxes/{id}/menu/tax-rate`, signed-in sessions only: the tax rate every order
 * placed from the next version pays, 0 to 3,000 basis points (8.50% is 850). It is not a draft:
 * the Catalog publishes it at once as a version of its own, and any price drafts keep waiting.
 */
export interface TaxRateRequest {
  tax_bp: number;
}
