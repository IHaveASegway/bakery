/**
 * Generated from crates/contracts/schemas/FaultRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * The faults a visitor may set.
 */
export type FaultName = 'inbox' | 'kitchen';

/**
 * `POST /v1/sandboxes/{id}/faults`, signed-in sessions only.
 */
export interface FaultRequest {
  fault: FaultName;
  on: boolean;
}
