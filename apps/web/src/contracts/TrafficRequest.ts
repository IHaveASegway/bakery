/**
 * Generated from crates/contracts/schemas/TrafficRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `POST /v1/sandboxes/{id}/traffic`, signed-in sessions only: simulated orders a minute.
 */
export interface TrafficRequest {
  /**
   * 1 to 6.
   */
  rate: number;
}
