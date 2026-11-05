/**
 * Generated from crates/contracts/schemas/ClockRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `POST /v1/sandboxes/{id}/clock`, signed-in sessions only: move business time forward. The
 * offset only grows, at most 14 days in total.
 */
export interface ClockRequest {
  minutes: number;
}
