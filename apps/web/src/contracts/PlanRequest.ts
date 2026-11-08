/**
 * Generated from crates/contracts/schemas/PlanRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `POST /v1/sandboxes/{id}/dispatch/{date}/plan`, staff only: the plan VROOM made in the
 * browser. It carries no minutes: the server computes them from the matrix. Refused with 422
 * `stop-missing`, `stop-twice`, `stop-unknown`, `over-capacity`, `route-ends`, `vans`,
 * `window` or `no-stops`. `window`: the vans leave the bakery at 09:00, a van early at a door
 * waits for the stop's window to open and spends 3 minutes there, and each stop must be
 * reached by its window's close (`StopView.window` plus 120 minutes).
 */
export interface PlanRequest {
  vans: PlanRouteRequest[];
}
/**
 * One van of the browser's plan.
 */
export interface PlanRouteRequest {
  /**
   * The place the van comes back to; the same rule.
   */
  end?: number | null;
  /**
   * The place the van leaves from, as the solver reports it; it must be the bakery, and is
   * taken to be when left out.
   */
  start?: number | null;
  /**
   * Order ULIDs, in driving order. An empty list is a van left at the bakery.
   */
  stops: string[];
  /**
   * 1 to the day's vans, each once.
   */
  van: number;
}
