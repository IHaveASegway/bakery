/**
 * Generated from crates/contracts/schemas/ConsentRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `POST /v1/sandboxes/{id}/customers/{cid}/consent`, by that customer's persona or by staff:
 * `200` with the `CustomerResponse`; the same value again changes nothing and answers `200`.
 */
export interface ConsentRequest {
  marketing: boolean;
}
