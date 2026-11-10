/**
 * Generated from crates/contracts/schemas/OrderResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * Pickup at the counter, or delivery to a zone.
 */
export type OrderKind = 'pickup' | 'delivery';
/**
 * An order's state (docs/domain.md, "Order", the diagram).
 */
export type OrderStatus =
  | 'placed'
  | 'confirmed'
  | 'expired'
  | 'cancelled'
  | 'refund_pending'
  | 'in_production'
  | 'ready'
  | 'picked_up'
  | 'out_for_delivery'
  | 'delivered'
  | 'closed';

/**
 * `201` from placing an order (`200` with `Idempotent-Replayed: true` for the same key again),
 * `GET /v1/sandboxes/{id}/orders/{oid}`, and the answer to a cancel.
 */
export interface OrderResponse {
  /**
   * The `seq` of the order's latest event.
   */
  events_seq: number;
  /**
   * When an unpaid order expires, 15 minutes of business time after `placed_at`.
   */
  held_until: string;
  /**
   * The order's ULID.
   */
  id: string;
  kind: OrderKind;
  lines: OrderLineResponse[];
  /**
   * The published menu version the prices came from.
   */
  menu_version: number;
  note?: string | null;
  /**
   * When the order was placed, a business time.
   */
  placed_at: string;
  /**
   * A business time.
   */
  slot: string;
  status: OrderStatus;
  step_times?: OrderStepTimes;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  zone?: string | null;
}
/**
 * A placed line, priced from the menu version the order names; never repriced.
 */
export interface OrderLineResponse {
  item: string;
  qty: number;
  unit_cents: number;
  variant: string;
}
/**
 * When each step of the order happened, a business time as `placed_at` is, read from the
 * order's own events; `null` for a step it has not taken (added 2026-11-10, roadmap R94).
 */
export interface OrderStepTimes {
  delivered?: string | null;
  in_production?: string | null;
  out_for_delivery?: string | null;
  paid?: string | null;
  picked_up?: string | null;
  placed?: string | null;
  ready?: string | null;
}
