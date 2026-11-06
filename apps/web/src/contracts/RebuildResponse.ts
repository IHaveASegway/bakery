/**
 * Generated from crates/contracts/schemas/RebuildResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

export type RebuildState = 'idle' | 'rebuilding' | 'finished';

/**
 * `GET /v1/sandboxes/{id}/rebuild`, which any session of the sandbox reads, and `202` from
 * `POST` to it, staff only (a guest gets `403` `guest-scope`): "Rebuild projections" drops
 * Crm's projections and replays its log, 200 events per alarm. A second `POST` (with a new
 * `Idempotency-Key`) while one runs is `409` problem of type `rebuild` and starts nothing; the
 * same key again replays the first `202`. Nothing else is refused during a rebuild: other
 * commands run, reads answer the partial projection with `Projection-State: rebuilding`, and a
 * campaign send that falls due is deferred (logged as `sends_deferred`) until it ends. `GET`
 * says how far the running one is, and `finished` with its `ms` until the next start.
 */
export interface RebuildResponse {
  /**
   * Log entries replayed so far.
   */
  applied: number;
  /**
   * Once finished: the wall-clock milliseconds the rebuild took.
   */
  ms?: number | null;
  state: RebuildState;
  /**
   * The log's length.
   */
  total: number;
}
