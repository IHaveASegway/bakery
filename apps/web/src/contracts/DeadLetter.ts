/**
 * Generated from crates/contracts/schemas/DeadLetter.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * One message the Queue gave up on after 3 retries, from `GET /v1/sandboxes/{id}/dead-letters`
 * (an array of these), and the answer to a redrive.
 */
export interface DeadLetter {
  /**
   * When it was dead-lettered, a wall time.
   */
  at: string;
  /**
   * The last delivery error, as a reason code such as `Kitchen answered 503`.
   */
  error: string;
  /**
   * The event's ULID: the key a redrive sends it again with.
   */
  id: string;
  seq: number;
  /**
   * The producing object's name.
   */
  stream: string;
  /**
   * The event type, such as `OrderPlaced`.
   */
  type: string;
}
