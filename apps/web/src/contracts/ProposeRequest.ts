/**
 * Generated from crates/contracts/schemas/ProposeRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `POST /v1/sandboxes/{id}/dispatch/{date}/propose`, staff only: the server's plan for the
 * confirmed stops. The vans and capacity become the day's.
 */
export interface ProposeRequest {
  /**
   * Units a van carries, at least 1.
   */
  capacity: number;
  /**
   * 1 to 4.
   */
  vans: number;
}
