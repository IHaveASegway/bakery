/**
 * Generated from crates/contracts/schemas/QuoteRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `POST /v1/sandboxes/{id}/catering/{cid}/quote`, staff only. `200` with the
 * `CateringResponse`, now `quoted`; `409` problem of type `catering` naming the rule
 * (`out-of-order`) once the inquiry is past `inquiry`; `422` `quote-total` for a total under 1
 * cent.
 */
export interface QuoteRequest {
  /**
   * A staff override of the total, in cents, at least 1. Absent: the package's price per
   * head times the headcount. The deposit is 25% of the total, rounded half-up.
   */
  total_cents?: number | null;
}
