/**
 * Generated from crates/contracts/schemas/ScheduleResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `GET /v1/sandboxes/{id}/schedule/{date}`, and the answer to a capacity change: one bakery
 * day's places, caps and bake list. It mirrors the Schedule aggregate's state.
 */
export interface ScheduleResponse {
  bake_list: BakeListView;
  catering: CateringView;
  /**
   * The bakery day, `YYYY-MM-DD`.
   */
  date: string;
  /**
   * The items with a cap or a use that day, by slug; an item with no entry is uncapped.
   */
  items: ItemCapView[];
  /**
   * The menu version the item caps came from; 0 before the first refresh.
   */
  menu_version: number;
  /**
   * Whether the bakery opens that day (Tuesday to Sunday); a closed day refuses every hold.
   */
  open: boolean;
  /**
   * The 32 pickup slots, 07:00 to 14:45, in time order.
   */
  slots: SlotView[];
  /**
   * The three delivery zones, `z1` to `z3`.
   */
  zones: ZoneView[];
}
/**
 * The day's production plan, from the reserved and fulfilled places only; a held place waiting
 * for payment is not on it.
 */
export interface BakeListView {
  lines: BakeLineView[];
  /**
   * Counts the plan's changes; 0 before the first reservation.
   */
  version: number;
}
/**
 * One line of the bake list.
 */
export interface BakeLineView {
  /**
   * The item's slug.
   */
  item: string;
  /**
   * Quantity to bake for this start, variants summed.
   */
  qty: number;
  /**
   * The slot or window start the quantity is for; an item ordered for two starts has two lines.
   */
  start: string;
}
/**
 * The day's catering capacity.
 */
export interface CateringView {
  /**
   * Events the bakery takes in a day.
   */
  capacity: number;
  /**
   * Events held, reserved or fulfilled.
   */
  taken: number;
}
/**
 * One item's daily cap and use.
 */
export interface ItemCapView {
  /**
   * The most the kitchen bakes of it in a day; `null` when the item has no cap.
   */
  daily_cap?: number | null;
  /**
   * The item's slug.
   */
  item: string;
  /**
   * Quantity on the day's places that count (held, reserved or fulfilled), variants summed.
   */
  used: number;
}
/**
 * One pickup slot of a day's schedule.
 */
export interface SlotView {
  /**
   * Places in the slot.
   */
  capacity: number;
  /**
   * `capacity` minus `taken`, 0 when over-booked after a capacity cut.
   */
  free: number;
  /**
   * The slot's start, a business time such as `2026-07-14T14:45:00-06:00`.
   */
  start: string;
  /**
   * Places held, reserved or fulfilled; released places do not count. Capped at 65,535.
   */
  taken: number;
}
/**
 * One delivery zone of a day's schedule. A zone's stops are shared by its three windows.
 */
export interface ZoneView {
  /**
   * Stops in the zone for the day.
   */
  capacity: number;
  /**
   * `capacity` minus `taken`, 0 when over-booked.
   */
  free: number;
  /**
   * Stops held, reserved or fulfilled.
   */
  taken: number;
  /**
   * The zone's window starts, 09:00, 11:00 and 13:00, business times.
   */
  windows: string[];
  /**
   * `z1`, `z2` or `z3`.
   */
  zone: string;
}
