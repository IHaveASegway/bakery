/**
 * Generated from crates/contracts/schemas/DispatchResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * Who made a plan: the server's savings heuristic or the browser's VROOM solver.
 */
export type PlanSource = 'server' | 'browser';
/**
 * Where a delivery stop stands (ADR 0012; docs/domain.md, "Ubiquitous language": Stop).
 */
export type StopStatus = 'provisional' | 'confirmed' | 'out_for_delivery' | 'removed' | 'completed';

/**
 * `GET /v1/sandboxes/{id}/dispatch/{date}`, which any session of the sandbox reads, and the
 * answer to every dispatch command, which are staff only: one bakery day's stops and plans. It mirrors the Dispatch aggregate's state.
 */
export interface DispatchResponse {
  /**
   * Units a van carries: the last proposal's, 250 before any.
   */
  capacity: number;
  /**
   * Both plans' totals, when there are both; `null` while the browser's solver has not run
   * or cannot (the page then shows the server's plan alone and says why).
   */
  comparison?: ComparisonView | null;
  /**
   * The bakery day, `YYYY-MM-DD`.
   */
  date: string;
  /**
   * The published plan's version, 0 before the first publish.
   */
  plan_v: number;
  /**
   * The server's plan from the last `propose`.
   */
  proposed?: PlanView | null;
  /**
   * The record: what drivers, the kitchen board and the order status read.
   */
  published?: PlanView | null;
  /**
   * Every stop the day has seen, removed ones included, by order ULID.
   */
  stops: StopView[];
  /**
   * The browser's plan from the last `plan`, validated.
   */
  submitted?: PlanView | null;
  /**
   * The day's vans, 1 to 4: the last proposal's, 4 before any.
   */
  vans: number;
}
/**
 * The two plans' totals side by side.
 */
export interface ComparisonView {
  browser_minutes: number;
  /**
   * `(server − browser) / browser × 100`, to one decimal: positive when the heuristic drives
   * longer. `null` when the browser's plan drives 0 minutes and the server's does not.
   */
  gap_percent?: number | null;
  server_minutes: number;
}
/**
 * A plan as the dispatch screen shows it (ADR 0012, decision 5). Its minutes are the server's
 * own arithmetic over the matrix, whoever made the plan.
 */
export interface PlanView {
  /**
   * When the last van is back, a business time: the vans leave at 09:00, drive the matrix's
   * minutes, spend 3 minutes at each door and wait at a door they reach before its window
   * opens.
   */
  last_back: string;
  /**
   * Every van's drive summed.
   */
  minutes: number;
  /**
   * A published plan's version. A proposal or submission carries the version it would be
   * published as when it was made; one at or below the response's `plan_v` is stale.
   */
  plan_v: number;
  source: PlanSource;
  /**
   * Order ULIDs no van could take. A plan with any cannot be published.
   */
  unassigned: string[];
  /**
   * The vans used, by van; a plan may use fewer than the day has.
   */
  vans: VanPlanView[];
}
/**
 * One van of a plan.
 */
export interface VanPlanView {
  /**
   * The drive, bakery to bakery, from the travel-time matrix.
   */
  minutes: number;
  /**
   * Order ULIDs, in driving order.
   */
  stops: string[];
  /**
   * The stops' units summed; never over the day's capacity.
   */
  units: number;
  /**
   * 1 to the day's vans.
   */
  van: number;
}
/**
 * One stop of the day.
 */
export interface StopView {
  /**
   * The customer's ULID; the screen shows the persona's made-up address, never the place.
   */
  customer: string;
  /**
   * The order's ULID: what every plan names the stop by.
   */
  order: string;
  /**
   * The customer's place, an index into the travel-time matrix, 0 to 63.
   */
  place: number;
  /**
   * The place's label, `p1` to `p64`.
   */
  place_label: string;
  status: StopStatus;
  /**
   * The stop's number in the published plan, counted from 1 across the vans, van 1's stops
   * first; `null` when it is in no published plan.
   */
  stop?: number | null;
  /**
   * The order's line quantities summed: what the stop takes of a van's capacity.
   */
  units: number;
  /**
   * The van that carries it in the published plan; `null` when none does.
   */
  van?: number | null;
  /**
   * The delivery window's start, a business time (RFC 3339 with the bakery's offset). The
   * window is 2 hours long: it closes 120 minutes after this. A plan must reach the stop
   * between the two, waiting at the door when it is early (rule `window`).
   */
  window: string;
  /**
   * `z1`, `z2` or `z3`.
   */
  zone: string;
}
