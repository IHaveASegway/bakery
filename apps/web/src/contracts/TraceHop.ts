/**
 * Generated from crates/contracts/schemas/TraceHop.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * Where one subscriber stands after one delivery attempt of an event.
 */
export type TraceOutcome = 'delivered' | 'retried' | 'dead_lettered';

/**
 * One hop: one envelope through the Queue's consumer, once. It carries the envelope's
 * identifiers, type, sequence number and times, and never its `data`: no note, no name, no
 * amount reaches the recorder.
 */
export interface TraceHop {
  /**
   * The event's business time.
   */
  at: string;
  /**
   * The recorder's own count of the hops it recorded for the event, from 1, in the order they
   * arrived: a lower bound on the Queue's attempts, not the Queue's number. A retry made with
   * the flag `off` builds no hop, and a hop whose recording was lost is not counted. A dead hop
   * repeats the event's last count (1 when it held none), since it is no attempt of its own.
   */
  attempt: number;
  /**
   * The command's `Idempotency-Key`, or for a reaction the id of the event that caused it;
   * absent when the event has none.
   */
  cause?: string | null;
  /**
   * When the consumer had decided this attempt's deliveries, a wall time.
   */
  delivered_at: string;
  /**
   * Each subscriber class the event was routed to, in the routing table's order; empty for an
   * event no class consumes.
   */
  deliveries: TraceDelivery[];
  /**
   * The event's ULID.
   */
  id: string;
  /**
   * `delivered_at` less `recorded_at` in milliseconds, 0 when the clocks disagree.
   */
  lag_ms: number;
  /**
   * When the event was written, a wall time.
   */
  recorded_at: string;
  seq: number;
  /**
   * The producing object's name, such as `order:<sandbox>:<ulid>`.
   */
  stream: string;
  /**
   * The event type, such as `OrderPlaced`.
   */
  type: string;
}
/**
 * One subscriber class an event was routed to, and how its delivery went.
 */
export interface TraceDelivery {
  outcome: TraceOutcome;
  /**
   * The subscriber's class, such as `Kitchen`, `Crm` or `Schedule` (one entry a class, however
   * many of its objects got the event).
   */
  to: string;
}
