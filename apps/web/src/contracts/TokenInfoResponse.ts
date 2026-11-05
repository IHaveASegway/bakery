/**
 * Generated from crates/contracts/schemas/TokenInfoResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `GET /v1/sandboxes/{id}/token`: what the console shows about the token without the token.
 */
export interface TokenInfoResponse {
  /**
   * When that token stops being accepted, a wall time.
   */
  expires_at?: string | null;
  /**
   * When the last token at this version was issued, a wall time; absent before the first
   * issue and after a rotation until the next.
   */
  issued_at?: string | null;
  /**
   * That token's first 6 and last 4 characters around `…`, such as `eyJ2Ij…x7Qk`: enough
   * to tell two tokens apart, never enough to use one.
   */
  masked?: string | null;
  /**
   * The Sandbox's token version: a token naming an older one is refused.
   */
  token_v: number;
}
