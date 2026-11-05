/**
 * Generated from crates/contracts/schemas/SessionResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * How a session signed in. A guest has no account.
 */
export type SessionKind = 'guest' | 'google' | 'github' | 'demo';

/**
 * `GET /v1/session`, and the answer to a demo sign-in: what the cookie says, read without an
 * object call.
 */
export interface SessionResponse {
  /**
   * The account id, 64 hex characters; `null` for a guest.
   */
  account?: string | null;
  /**
   * When the cookie stops being accepted, a wall time such as `2026-11-05T12:00:00.000Z`.
   */
  expires_at: string;
  kind: SessionKind;
  /**
   * The current sandbox's ULID, if any.
   */
  sandbox?: string | null;
}
