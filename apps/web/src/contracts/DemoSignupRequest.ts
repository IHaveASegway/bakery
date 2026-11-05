/**
 * Generated from crates/contracts/schemas/DemoSignupRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `POST /v1/auth/demo`. The password never reaches an object, a log or this type's `Debug`.
 */
export interface DemoSignupRequest {
  /**
   * 12 to 128 characters, no composition rules.
   */
  password: string;
  turnstile_token: string;
}
