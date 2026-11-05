/**
 * Generated from crates/contracts/schemas/ClockRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * How far one clock advance moves business time.
 */
export type ClockStep = '15m' | '1h' | '1d' | 'next-opening';

/**
 * `POST /v1/sandboxes/{id}/clock`, signed-in sessions only: move business time forward. The
 * offset only grows, at most 14 days in total.
 *
 * Give exactly one of `step` and `minutes`: `step` is the named step, `minutes` the older form
 * (a positive count). The Worker answers 422 `clock` with rule `not-positive` for no
 * advance or for both fields, and rule `offset-cap` when the 14 days would be passed.
 */
export interface ClockRequest {
  /**
   * The compatible older form: minutes to advance, 1 or more.
   */
  minutes?: number | null;
  /**
   * `15m`, `1h`, `1d` or `next-opening`.
   */
  step?: ClockStep | null;
}
