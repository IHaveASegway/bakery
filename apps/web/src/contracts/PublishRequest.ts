/**
 * Generated from crates/contracts/schemas/PublishRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * Which stored plan to publish.
 */
export type PlanChoice = 'proposed' | 'submitted';

/**
 * `POST /v1/sandboxes/{id}/dispatch/{date}/publish`, staff only: make a stored plan the record.
 * Checked again against the day's stops; a repeat with the same `Idempotency-Key` publishes
 * nothing more.
 */
export interface PublishRequest {
  plan: PlanChoice;
}
