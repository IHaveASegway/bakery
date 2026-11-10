// The checkout's slot picker, as pure functions: which of a day's slots to offer and which to grey
// out. Everything here is a hint. The Schedule and the Order decide (docs/domain.md, "Schedule
// reservation"); a hint that is wrong costs a refusal from the API, never a wrong booking.
import type { ScheduleResponse } from '../contracts';
import { ApiError } from './api';
import { clockLabel, dateOf, dayLabel, mountainLocal, mountainToMs, type Zone } from './slots';

/** How many bakery days, today included, the picker lets a visitor look at. */
export const HORIZON_DAYS = 7;

/** Why a choice is greyed out. `lead` and `not-baked` are the page's guess; the others are the API's. */
export type Blocker = 'closed' | 'full' | 'not-baked' | 'lead';

export interface Choice {
  /** The business time to send as `slot`, exactly as the API wrote it. */
  start: string;
  ms: number;
  /** "9:45 am", or "9:00 am to 11:00 am" for a window. */
  label: string;
  /** Places left (a zone's stops for a window). */
  free: number;
  capacity: number;
  blocked: Blocker | null;
}

/** What the picker knows about the cart and the clock. */
export interface PickContext {
  /** Business now, in Unix milliseconds. */
  nowMs: number;
  /** The longest lead among the cart's variants, bulk included, in minutes (a hint). */
  leadMinutes: number;
  /** Whether the cart's items are baked on this day, from the menu (a hint). */
  baked: boolean;
}

/** The bakery dates the picker offers, today first. Noon is far from any clock change. */
export function horizonDates(nowMs: number, days: number = HORIZON_DAYS): string[] {
  const noon = mountainToMs(dateOf(mountainLocal(nowMs)), 12 * 60);
  return Array.from({ length: days }, (_, i) => dateOf(mountainLocal(noon + i * 86_400_000)));
}

/** The bakery date a business time falls on. */
export function dateOfStart(start: string): string {
  const ms = Date.parse(start);
  return Number.isNaN(ms) ? '' : dateOf(mountainLocal(ms));
}

function minutesOf(ms: number): number {
  const l = mountainLocal(ms);
  return l.hour * 60 + l.minute;
}

function blockerFor(
  schedule: ScheduleResponse,
  ms: number,
  free: number,
  ctx: PickContext,
): Blocker | null {
  if (!schedule.open) return 'closed';
  if (free <= 0) return 'full';
  if (!ctx.baked) return 'not-baked';
  if (ms - ctx.nowMs < ctx.leadMinutes * 60_000) return 'lead';
  return null;
}

/** The day's 32 pickup slots, with the free count the API gave each. */
export function pickupChoices(schedule: ScheduleResponse, ctx: PickContext): Choice[] {
  return schedule.slots.map((slot) => {
    const ms = Date.parse(slot.start);
    return {
      start: slot.start,
      ms,
      label: clockLabel(minutesOf(ms)),
      free: slot.free,
      capacity: slot.capacity,
      blocked: blockerFor(schedule, ms, slot.free, ctx),
    };
  });
}

/** The chosen zone's three windows. A zone's stops are shared by its windows, so they share a count. */
export function windowChoices(
  schedule: ScheduleResponse,
  zone: Zone | string,
  ctx: PickContext,
): Choice[] {
  const view = schedule.zones.find((z) => z.zone === zone);
  if (!view) return [];
  return view.windows.map((start) => {
    const ms = Date.parse(start);
    const from = minutesOf(ms);
    return {
      start,
      ms,
      label: `${clockLabel(from)} to ${clockLabel(from + 120)}`,
      free: view.free,
      capacity: view.capacity,
      blocked: blockerFor(schedule, ms, view.free, ctx),
    };
  });
}

/** Words for a greyed-out choice, never colour alone. */
export function blockerText(blocker: Blocker): string {
  switch (blocker) {
    case 'closed':
      return 'closed';
    case 'full':
      return 'full';
    case 'not-baked':
      return 'not baked that day';
    case 'lead':
      return 'too soon';
  }
}

/** "3 left", "1 left", "full". */
export function freeText(choice: Choice): string {
  return choice.free <= 0 ? 'full' : `${choice.free} left`;
}

/**
 * Whether a choice may be picked. Only the API's own refusals (closed, full) stop the page; the
 * lead-time and baking-day guesses grey a choice out in the list but do not forbid an order
 * the API might accept, so a slot the API itself offered (its `next_free`) can still be taken.
 */
export const pickable = (choice: Choice): boolean =>
  choice.blocked !== 'closed' && choice.blocked !== 'full';

/** What a 409 `slot-full` told the page. */
export interface SlotConflict {
  /** The next free start the problem named, or null when nothing later that day is free. */
  next_free: string | null;
}

/** The conflict a failed order carries, or null when the failure was something else. */
export function slotConflict(error: unknown): SlotConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const named =
    error.slug === 'slot-full' || /(^|[^a-z-])slot-full($|[^a-z-])/.test(error.detail ?? '');
  return named || error.next_free !== null ? { next_free: error.next_free } : null;
}

/** The sentence under the picker for a `slot-full`. */
export function conflictText(conflict: SlotConflict): string {
  return conflict.next_free === null
    ? 'That time filled up first, and nothing later that day is free. Choose another day.'
    : 'That time filled up first. The next free place is offered below.';
}

/** "Saturday 2026-11-07" for a bakery date. */
export function dateLabel(date: string): string {
  return dayLabel({ date, weekday: mountainLocal(mountainToMs(date, 12 * 60)).weekday });
}

/** "10:15 am on Saturday 2026-11-07" for a business time. */
export function startText(start: string): string {
  const ms = Date.parse(start);
  return `${clockLabel(minutesOf(ms))} on ${dateLabel(dateOfStart(start))}`;
}
