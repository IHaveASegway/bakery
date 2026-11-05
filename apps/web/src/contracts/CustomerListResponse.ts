/**
 * Generated from crates/contracts/schemas/CustomerListResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `GET /v1/sandboxes/{id}/customers`: the 60 personas, by id.
 */
export interface CustomerListResponse {
  customers: CustomerResponse[];
}
/**
 * `GET /v1/sandboxes/{id}/customers/{cid}`, and the answer to a consent change: one persona as
 * Crm's projection holds it. Every field is synthetic; there is no contact of any kind.
 */
export interface CustomerResponse {
  /**
   * Catering inquiries.
   */
  catering: number;
  /**
   * The customer's ULID.
   */
  customer: string;
  /**
   * Two generic words, such as `Drizzle Trowel`.
   */
  display_name: string;
  /**
   * `z1` to `z3`.
   */
  home_zone: string;
  /**
   * The latest such order's slot, a business time.
   */
  last_order_at?: string | null;
  /**
   * Loyalty points: one per whole dollar paid, less refunds; never below zero.
   */
  loyalty_points: number;
  /**
   * Consent to marketing: a campaign goes only to customers for whom it is true at the send.
   */
  marketing: boolean;
  /**
   * Orders paid, or closed in the seed's history, and not cancelled.
   */
  orders: number;
  /**
   * `p1` to `p64`, a map label: the only address there is.
   */
  place: string;
  /**
   * One to three item slugs.
   */
  preferences: string[];
}
