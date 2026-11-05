/**
 * Generated from crates/contracts/schemas/WipedResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `DELETE /v1/sandboxes/{id}`, "Wipe now": the sandbox is gone when this answers.
 */
export interface WipedResponse {
  id: string;
  /**
   * Always `wiped`.
   */
  state: ('seeding' | 'live' | 'wiped') | 'wiping';
}
