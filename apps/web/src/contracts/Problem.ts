/**
 * Generated from crates/contracts/schemas/Problem.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * An error body, `application/problem+json` (RFC 9457).
 */
export interface Problem {
  /**
   * What went wrong this time, for a person to read.
   */
  detail?: string | null;
  /**
   * The request path this occurrence concerns.
   */
  instance?: string | null;
  /**
   * The HTTP status code.
   */
  status: number;
  /**
   * A short summary that does not change between occurrences.
   */
  title: string;
  /**
   * A URI reference naming the problem type; `about:blank` when the status says it all.
   */
  type: string;
}
