/**
 * Generated from crates/contracts/schemas/CreateSandboxRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `POST /v1/sandboxes`. A guest needs `turnstile_token`; an account that already has a live
 * sandbox gets it back unless `replace` is true.
 */
export interface CreateSandboxRequest {
  replace?: boolean;
  turnstile_token?: string | null;
}
