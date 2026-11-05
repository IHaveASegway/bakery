/**
 * Generated from crates/contracts/schemas/TrafficResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `GET /v1/sandboxes/{id}/traffic`, and the answer to starting or stopping it.
 */
export interface TrafficResponse {
  /**
   * Of the day's 30.
   */
  minutes_left: number;
  /**
   * Minutes of traffic this sandbox used today, UTC.
   */
  minutes_used: number;
  /**
   * Orders the simulator placed today.
   */
  orders: number;
  rate: number;
  running: boolean;
}
