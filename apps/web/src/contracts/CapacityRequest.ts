/**
 * Generated from crates/contracts/schemas/CapacityRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `PATCH /v1/sandboxes/{id}/schedule/{date}/capacity`, signed-in sessions only: set one
 * capacity for the day. The answer is the day's `ScheduleResponse`.
 */
export interface CapacityRequest {
  /**
   * The new capacity. Places already taken stay; a cut below them only stops new ones.
   */
  capacity: number;
  /**
   * What to change, in the domain's grammar: `slot:HH:MM` (a slot start on the quarter hour,
   * such as `slot:14:45`), `zone:z1` (to `z3`), `item:<slug>` (such as `item:croissant`) or
   * `catering`.
   */
  target: string;
}
