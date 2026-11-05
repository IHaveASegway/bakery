/**
 * Generated from crates/contracts/schemas/FaultsResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * The answer to a fault change: every switch as it now stands.
 */
export interface FaultsResponse {
  faults: Faults;
}
/**
 * The sandbox's fault switches. `inbox` makes the broken-subscriber demo's Inbox fail (PR 4).
 */
export interface Faults {
  inbox: boolean;
}
