/**
 * Generated from crates/contracts/schemas/DeclineRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * Why staff decline an inquiry: a choice from a list, never free text.
 */
export type DeclineReason = 'too_soon' | 'over_capacity' | 'other';

/**
 * `POST /v1/sandboxes/{id}/catering/{cid}/decline`, staff only, while the inquiry is an
 * `inquiry`. `200` with the `CateringResponse`, `declined`; `409` problem of type `catering`
 * naming the rule (`out-of-order`) once it is quoted.
 */
export interface DeclineRequest {
  reason: DeclineReason;
}
