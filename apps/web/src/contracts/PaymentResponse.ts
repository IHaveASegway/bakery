/**
 * Generated from crates/contracts/schemas/PaymentResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * Where a payment stands (docs/domain.md, the Billing rows).
 */
export type PaymentStatus = ('succeeded' | 'canceled') | 'created' | 'failed';

/**
 * `POST /v1/sandboxes/{id}/orders/{oid}/payment`: what the browser needs to mount Stripe's
 * Payment Element. `client_secret` is a one-time value for the browser: it is not stored, not
 * logged, and left out of this type's `Debug`.
 */
export interface PaymentResponse {
  amount_cents: number;
  /**
   * Stripe's `pi_..._secret_...`, for `<Elements options={{ clientSecret }}>`.
   */
  client_secret: string;
  /**
   * Billing's id for the payment, a ULID.
   */
  payment: string;
  /**
   * The sandbox's `pk_test_` key, when the API has one to give; the storefront's own build
   * value otherwise.
   */
  publishable_key?: string | null;
  status: PaymentStatus;
}
