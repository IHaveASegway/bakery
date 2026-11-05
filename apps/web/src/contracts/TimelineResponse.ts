/**
 * Generated from crates/contracts/schemas/TimelineResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `GET /v1/sandboxes/{id}/customers/{cid}/timeline`: the customer's events in business-time
 * order. While a rebuild runs the timeline is partial; `GET .../crm/rebuild` says so.
 */
export interface TimelineResponse {
  customer: string;
  entries: TimelineEntry[];
}
/**
 * One line of a timeline.
 */
export interface TimelineEntry {
  /**
   * The event's business time.
   */
  at: string;
  /**
   * A short fixed sentence with the event's own figures, such as `Paid $22.00`.
   */
  label: string;
  /**
   * The ULID of the order, catering event, message or customer the line is about.
   */
  ref: string;
  /**
   * The event's catalog name, such as `OrderPaid`.
   */
  type: string;
}
