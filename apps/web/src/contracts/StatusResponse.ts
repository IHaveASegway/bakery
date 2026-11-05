/**
 * Generated from crates/contracts/schemas/StatusResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `GET /v1/status`: today's admission state, from the `Control` object.
 */
export interface StatusResponse {
  /**
   * Today's UTC date, `YYYY-MM-DD`: the key of the daily ledger.
   */
  day: string;
  /**
   * The demo's flag.
   */
  flag: 'live' | 'read-only' | 'off';
  /**
   * The most sandboxes admitted in one UTC day.
   */
  sandbox_cap: number;
  /**
   * Sandboxes admitted today.
   */
  sandboxes_today: number;
}
