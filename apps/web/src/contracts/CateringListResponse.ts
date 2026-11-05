/**
 * Generated from crates/contracts/schemas/CateringListResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * A catering reminder: what it is for.
 */
export type ReminderKind = 'follow_up' | 'event_soon' | 'invoice_due';
/**
 * A catering event's state (docs/domain.md, "CateringEvent", the diagram). `paid` is passed
 * through in the same step as `closed`, so a response never shows it today; it is listed
 * because the diagram has it.
 */
export type CateringState =
  | (
      | 'inquiry'
      | 'quoted'
      | 'confirmed'
      | 'in_production'
      | 'delivered'
      | 'invoiced'
      | 'paid'
      | 'closed'
      | 'declined'
      | 'expired'
      | 'cancelled'
    )
  | 'accepted';

/**
 * `GET /v1/sandboxes/{id}/catering`: the sandbox's catering events, the seeded eight and any
 * since, by date.
 */
export interface CateringListResponse {
  events: CateringResponse[];
}
/**
 * `GET /v1/sandboxes/{id}/catering/{cid}`, and the answer to every catering command: the
 * inquiry, `quote`, `decline`, `accept`, `cancel`, and staff's `production` and `delivered`.
 * It mirrors the CateringEvent aggregate's state. A refused step is `409` problem of type
 * `catering` naming the rule (`out-of-order`, `quote-expired`); an `accept` when the day's two
 * catering places are taken is `409` `slot-full`.
 */
export interface CateringResponse {
  /**
   * `total_cents - deposit_cents`.
   */
  balance_cents?: number | null;
  /**
   * The brief, shown back to its own sandbox only, as text.
   */
  brief?: string | null;
  /**
   * The catering event's ULID.
   */
  catering: string;
  /**
   * The inquiry's business time.
   */
  created_at: string;
  /**
   * The event day, `YYYY-MM-DD`.
   */
  date: string;
  /**
   * 25% of the total, rounded half-up.
   */
  deposit_cents?: number | null;
  /**
   * The deposit's payment ULID, once paid.
   */
  deposit_payment?: string | null;
  headcount: number;
  /**
   * The balance invoice's ULID, once issued.
   */
  invoice?: string | null;
  /**
   * The balance invoice's due date, `YYYY-MM-DD`, 7 days after delivery.
   */
  invoice_due?: string | null;
  package: string;
  /**
   * Set on a cancellation: whether the deposit goes back.
   */
  refund_deposit?: boolean | null;
  /**
   * The reminders still to come, earliest first; empty once the event ends.
   */
  reminders: CateringReminder[];
  state: CateringState;
  /**
   * From the quote on.
   */
  total_cents?: number | null;
  /**
   * The business time of the latest change.
   */
  updated_at: string;
  /**
   * When the quote stops being accepted, a business time: 07:00 on the 14th business day
   * after the quote.
   */
  valid_until?: string | null;
  venue: string;
}
/**
 * A reminder still to come, and when.
 */
export interface CateringReminder {
  /**
   * A business time, such as `2026-11-19T07:00:00-07:00`.
   */
  at: string;
  kind: ReminderKind;
}
