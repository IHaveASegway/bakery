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
   * Business time now, such as `2026-11-07T09:42:10-07:00`, shown at America/Denver's offset
   * at that instant (`-06:00` in summer).
   */
  business_now: string;
  /**
   * Seconds of business time ahead of wall time, 0 to 14 days.
   */
  clock_offset_s: number;
  /**
   * Counts the advances; a child that has not heard of the latest one is retried.
   */
  clock_v: number;
}
