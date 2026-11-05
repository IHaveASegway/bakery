/**
 * Generated from crates/contracts/schemas/DemoSigninRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `POST /v1/auth/demo/signin`.
 */
export interface DemoSigninRequest {
  password: string;
  username: string;
}
