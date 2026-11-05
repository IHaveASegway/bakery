/**
 * Generated from crates/contracts/schemas/RefundRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * Why staff give money back: a choice from a list, never free text (docs/domain.md, "Free
 * text and personal data"). The other two reasons the domain knows, `cancelled` and
 * `payment_late`, are the system's own.
 */
export type RefundReason = 'missing_item' | 'quality' | 'goodwill';

/**
 * `POST /v1/sandboxes/{id}/orders/{oid}/refund`, staff only. No `amount_cents` refunds all
 * that is left; refunding all that is left of an order not yet closed cancels it.
 */
export interface RefundRequest {
  amount_cents?: number | null;
  reason: RefundReason;
}
