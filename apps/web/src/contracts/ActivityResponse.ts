/**
 * Generated from crates/contracts/schemas/ActivityResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `GET /v1/sandboxes/{id}/activity`: the sandbox's logged events (clock moves, faults,
 * menu and capacity changes, payment intents, routes, traffic, token rotations), newest first;
 * `?limit=` keeps the newest that many.
 */
export interface ActivityResponse {
  entries: ActivityEntry[];
}
/**
 * One line of the activity log.
 */
export interface ActivityEntry {
  at: string;
  /**
   * A short fixed sentence from the event's named fields.
   */
  summary: string;
  type: string;
}
