/**
 * Generated from crates/contracts/schemas/StatusResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `GET /v1/status`: today's admission state, from the `Control` object.
 *
 * The field order is fixed and is the wire order: the day and the sandbox count and cap
 * (PR 2), then the guest and demo-account counts and caps (PR 3), then the flag. Readers go
 * by name, so PR 2's smoke check still passes; a new field is added before `flag`.
 */
export interface StatusResponse {
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
