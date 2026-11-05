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
   * What is left of the day's cap, 30 minutes (docs/cost.md, "Guardrails").
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
  /**
   * Orders a minute of the current or last run; 0 before the first start.
   */
  rate: number;
  running: boolean;
}
