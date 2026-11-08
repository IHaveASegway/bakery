/**
 * Generated from crates/contracts/schemas/CompleteStopRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `POST /v1/sandboxes/{id}/dispatch/{date}/complete`, staff only: a stop of the published plan
 * is delivered. Again for a delivered stop changes nothing. Refused 409 `not-ready` while the
 * stop's order is still confirmed or in production: the kitchen marks it ready first.
 */
export interface CompleteStopRequest {
  /**
   * The stop's number in the published plan, from 1.
   */
  stop: number;
}
