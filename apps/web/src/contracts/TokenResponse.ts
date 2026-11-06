/**
 * Generated from crates/contracts/schemas/TokenResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `POST /v1/sandboxes/{id}/token` (issue, or issue again at the same version) and
 * `POST /v1/sandboxes/{id}/token/rotate` (the Sandbox's token version goes up, `ApiTokenRotated`
 * is appended, and every token naming an older version stops at once): the token, shown this
 * once. It is never stored, logged, put in an event or printed by this type's `Debug`; the
 * console holds it in memory to copy it.
 */
export interface TokenResponse {
  /**
   * 24 h after `issued_at`, a wall time; the sandbox's wipe ends it sooner.
   */
  expires_at: string;
  /**
   * A wall time, such as `2026-11-05T12:00:00.000Z`.
   */
  issued_at: string;
  /**
   * For `Authorization: Bearer <token>`: `<payload>.<mac>`, both base64url, signed like the
   * session cookie. Never in a URL: a token in a query string is refused with 400.
   */
  token: string;
  /**
   * The Sandbox's token version the token names.
   */
  token_v: number;
}
