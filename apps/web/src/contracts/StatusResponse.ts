/**
 * Generated from crates/contracts/schemas/StatusResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `GET /v1/status`: today's admission state, from the `Control` object.
 *
 * The field order is fixed and is the wire order: the day and the sandbox count and cap
 * (PR 2), then the guest and demo-account counts and caps (PR 3), then the status page's
 * counters with their time and state (PR 13), then the flag. Readers go by name, so PR 2's
 * smoke check still passes; a new field is added before `flag`.
 *
 * The counters are a snapshot of the kept Analytics Engine queries that the 15-minute cron
 * refreshes, never a query per request (docs/operations.md, "Observability").
 */
export interface StatusResponse {
  /**
   * The last snapshot of the kept queries; `null` until the first refresh succeeds.
   */
  counters: StatusCounters | null;
  /**
   * When that snapshot was taken, an RFC 3339 UTC time such as `2026-11-06T10:15:02.114Z`;
   * `null` with `counters`.
   */
  counters_as_of: string | null;
  /**
   * Whether the counters are fresh: `live`, `stale` or `unavailable`.
   */
  counters_state: 'live' | 'stale' | 'unavailable';
  /**
   * Today's UTC date, `YYYY-MM-DD`: the key of the daily ledger.
   */
  day: string;
  /**
   * The most demo accounts created in one UTC day.
   */
  demo_account_cap: number;
  /**
   * Demo accounts created today.
   */
  demo_accounts_today: number;
  /**
   * The demo's flag.
   */
  flag: 'live' | 'read-only' | 'off';
  /**
   * The guests' share of the day's sandboxes.
   */
  guest_cap: number;
  /**
   * Guest sandboxes admitted today.
   */
  guests_today: number;
  /**
   * The most sandboxes admitted in one UTC day.
   */
  sandbox_cap: number;
  /**
   * Sandboxes admitted today, guests' included.
   */
  sandboxes_today: number;
}
/**
 * The status page's counters: the kept Analytics Engine queries over the last 24 hours, and
 * the last nightly wipe (docs/operations.md, "Observability"). Counts are sums of the points'
 * sample intervals, so they stay counts when Analytics Engine samples.
 */
export interface StatusCounters {
  /**
   * `dlq` points in the last 24 hours: messages the dead-letter writer kept.
   */
  dlq_24h: number;
  /**
   * The latest `wipe` point; `null` when none is in the dataset.
   */
  last_wipe: LastWipe | null;
  /**
   * `order_placed` points in the last 24 hours.
   */
  orders_24h: number;
  /**
   * `payment_failed` points in the last 24 hours.
   */
  payment_failures_24h: number;
  /**
   * `payment_succeeded` points in the last 24 hours.
   */
  payments_24h: number;
  /**
   * `refund_issued` points in the last 24 hours.
   */
  refunds_24h: number;
  /**
   * `sandbox_created` points in the last 24 hours, to read against the daily cap.
   */
  sandboxes_24h: number;
}
/**
 * One nightly wipe, as its `wipe` point recorded it.
 */
export interface LastWipe {
  /**
   * When the point was written, at the wipe's end: an RFC 3339 UTC time such as
   * `2026-11-06T10:00:04Z`.
   */
  at: string;
  /**
   * Milliseconds from the 10:00 UTC cron to the wipe's last run.
   */
  ms: number;
  /**
   * Objects those sandboxes emptied, each Sandbox and its children.
   */
  objects: number;
  /**
   * Sandboxes the wipe ended.
   */
  sandboxes: number;
}
