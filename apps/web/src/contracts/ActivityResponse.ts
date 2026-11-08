/**
 * Generated from crates/contracts/schemas/ActivityResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `GET /v1/sandboxes/{id}/activity`: the sandbox's logged events (clock moves, faults,
 * menu and capacity changes, payment intents, orders paid, catering steps, routes, traffic,
 * token rotations, campaigns sent and rebuilds finished), newest first
 * by business time (ties by event id); `?limit=` keeps the newest that many (50 when left out,
 * at most 500). Any session of the sandbox reads it.
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
