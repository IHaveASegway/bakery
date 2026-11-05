/**
 * Generated from crates/contracts/schemas/CateringCancelRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * Why a confirmed catering event is cancelled: a choice from a list, never free text.
 */
export type CateringCancelReason = 'customer_change' | 'venue_lost' | 'other';

/**
 * `POST /v1/sandboxes/{id}/catering/{cid}/cancel`, by the customer or staff, as the session
 * is. Only a `confirmed` event is cancelled: `200` with the `CateringResponse`, `cancelled`,
 * its `refund_deposit` true when the event day is more than 7 days away; `409` problem of type
 * `catering` naming the rule (`out-of-order`) in any other state.
 */
export interface CateringCancelRequest {
  reason: CateringCancelReason;
}
