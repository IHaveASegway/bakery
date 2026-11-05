/**
 * Generated from crates/contracts/schemas/FaultRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * The faults a visitor may set. PR 3 ships one.
 */
export type FaultName = 'inbox';

/**
 * `POST /v1/sandboxes/{id}/faults`, signed-in sessions only.
 */
export interface FaultRequest {
  fault: FaultName;
  on: boolean;
}
