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
 * The sandbox's fault switches: the Queue Lab's broken subscriber, live. `kitchen` makes the
 * Kitchen refuse every delivery with 503, so a message retries three times and lands in the
 * dead-letter queue (PR 4); `inbox` does the same to the Inbox when it arrives (PR 8).
 */
export interface Faults {
  inbox: boolean;
  kitchen: boolean;
}
