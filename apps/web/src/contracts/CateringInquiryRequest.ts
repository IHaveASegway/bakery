/**
 * Generated from crates/contracts/schemas/CateringInquiryRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `POST /v1/sandboxes/{id}/catering`, the customer's inquiry; the customer is the sandbox's
 * persona. `201` with the `CateringResponse` (`200` with `Idempotent-Replayed: true` for the
 * same key again). A refused inquiry is `422` problem+json naming its rule: `headcount`,
 * `unknown-package`, `unknown-venue`, `closed-day`, `catering-lead` (its detail names the
 * 7-business-day rule and the earliest date allowed), `catering-too-far` (since 2026-11-10:
 * its detail names the 365-day bound and the latest date allowed), or `brief-too-long`,
 * `brief-email`, `brief-phone`, `brief-card-number` or `brief-url`, which never echo the brief.
 */
export interface CateringInquiryRequest {
  /**
   * At most 500 characters, with no email address, phone number, card number or URL.
   */
  brief?: string | null;
  /**
   * The event day, `YYYY-MM-DD`: an open day (Tuesday to Sunday) at least 7 business days
   * after today and at most 365 days after it.
   */
  date: string;
  /**
   * 10 to 200 people.
   */
  headcount: number;
  /**
   * A package slug, such as `breakfast-spread` (`pastry-platter`, `breakfast-spread`,
   * `lunch-boxes`, `celebration-cake-and-coffee`).
   */
  package: string;
  /**
   * A venue, `v1` to `v6`.
   */
  venue: string;
}
