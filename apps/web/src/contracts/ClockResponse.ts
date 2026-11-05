/**
 * Generated from crates/contracts/schemas/ClockResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * The business clock after an advance.
 */
export interface ClockResponse {
  /**
   * Business time now, such as `2026-11-07T09:42:10-07:00`.
   */
  business_now: string;
  clock_offset_s: number;
  clock_v: number;
}
