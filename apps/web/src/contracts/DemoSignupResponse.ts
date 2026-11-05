/**
 * Generated from crates/contracts/schemas/DemoSignupResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `201` from `POST /v1/auth/demo`: the generated username, shown once.
 */
export interface DemoSignupResponse {
  /**
   * `baker-` and four characters, such as `baker-7f3k`.
   */
  username: string;
}
