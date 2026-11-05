/**
 * Generated from crates/contracts/schemas/HealthResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

export type HealthStatus = 'ok';

/**
 * `GET /v1/health`: the Worker answers, and which build it is. Touches no object.
 */
export interface HealthResponse {
  /**
   * The commit the bundle was built from; `dev` on a laptop.
   */
  commit: string;
  status: HealthStatus;
  /**
   * The API's version.
   */
  version: string;
}
