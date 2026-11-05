/**
 * Generated from crates/contracts/schemas/RefundResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * The answer to a refund request: accepted, and on its way to Stripe.
 */
export interface RefundResponse {
  amount_cents: number;
  /**
   * The refund's ULID: the id of the order's `OrderRefundRequested` event, which Billing
   * keeps the refund under.
   */
  refund: string;
  /**
   * The order's status after the request: unchanged for a part, `refund_pending` for the
   * whole of an order not yet closed.
   */
  status:
    | 'placed'
    | 'confirmed'
    | 'expired'
    | 'cancelled'
    | 'refund_pending'
    | 'in_production'
    | 'ready'
    | 'picked_up'
    | 'out_for_delivery'
    | 'delivered'
    | 'closed';
}
