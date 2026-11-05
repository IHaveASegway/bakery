/**
 * Generated from crates/contracts/schemas/MenuEditResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * The answer to a staff edit or a publish: the published version and the items with drafts
 * still waiting for a publish.
 */
export interface MenuEditResponse {
  pending: string[];
  version: number;
}
