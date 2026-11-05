/**
 * Generated from crates/contracts/schemas/LedgerResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

export type LedgerKind = 'payment' | 'refund';
/**
 * What a payment pays for.
 */
export type PaymentPurpose = 'order' | 'deposit' | 'balance';

/**
 * `GET /v1/sandboxes/{id}/billing/ledger`: every entry in order, and the totals.
 */
export interface LedgerResponse {
  entries: LedgerEntry[];
  /**
   * `paid_cents - refunded_cents`.
   */
  net_cents: number;
  paid_cents: number;
  /**
   * A positive amount.
   */
  refunded_cents: number;
}
/**
 * One line of the ledger: a payment's success or a refund issued.
 */
export interface LedgerEntry {
  /**
   * Signed: positive for a payment, negative for a refund.
   */
  amount_cents: number;
  /**
   * The business time of the event that made it.
   */
  at: string;
  kind: LedgerKind;
  purpose: PaymentPurpose;
  /**
   * The order or catering job's ULID.
   */
  ref: string;
  /**
   * Stripe's id: the intent's `pi_...` for a payment, the refund's `re_...` for a refund.
   */
  stripe_id: string;
}
