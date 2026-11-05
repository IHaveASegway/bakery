// Pickup slots and delivery windows, in the bakery's time. The bakery day is a date in
// America/Denver, so a slot is a Mountain wall-clock time and travels as a business time with
// its offset: `-07:00` in standard time, `-06:00` in summer (docs/domain.md, "Money and time").
// Pickup runs on the quarter hour from 07:00 to 15:00; delivery windows are two hours long and
// start at 09:00, 11:00 or 13:00. The API checks every rule again; this picker only offers slots
// it would accept.
import type { Weekday } from './menu';

const ZONE = 'America/Denver';
const QUARTER_MS = 15 * 60_000;

/** The first pickup slot of the day, in minutes after midnight. */
export const OPENS = 7 * 60;
/** The bakery closes at 15:00, so the last quarter hour a pickup can start is 14:45. */
export const LAST_PICKUP = 14 * 60 + 45;
/** Delivery windows start here and last two hours. */
export const DELIVERY_STARTS = [9 * 60, 11 * 60, 13 * 60];
export const ZONES = ['z1', 'z2', 'z3'] as const;
export type Zone = (typeof ZONES)[number];

const WEEKDAYS: Record<string, Weekday> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

/** A moment as the bakery's wall clock reads it. */
export interface Local {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: Weekday;
}

export function mountainLocal(ms: number): Local {
  const get: Record<string, string> = {};
  for (const part of parts.formatToParts(ms)) get[part.type] = part.value;
  return {
    year: Number(get['year']),
    month: Number(get['month']),
    day: Number(get['day']),
    hour: Number(get['hour']),
    minute: Number(get['minute']),
    second: Number(get['second']),
    weekday: WEEKDAYS[get['weekday'] ?? ''] ?? 'mon',
  };
}

/** Minutes east of UTC at that moment: -420 in standard time, -360 in summer. */
export function mountainOffsetMinutes(ms: number): number {
  const l = mountainLocal(ms);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

const two = (n: number) => String(n).padStart(2, '0');
export const dateOf = (l: Local) => `${l.year}-${two(l.month)}-${two(l.day)}`;
export const clockOf = (l: Local) => `${two(l.hour)}:${two(l.minute)}`;

/** `2026-11-07T09:45:00-07:00`: the wire form of a business time. */
export function businessTime(ms: number): string {
  const l = mountainLocal(ms);
  const offset = mountainOffsetMinutes(ms);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${dateOf(l)}T${clockOf(l)}:${two(l.second)}${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

/** The instant a Mountain wall-clock time names. Two passes settle the offset across a change. */
export function mountainToMs(date: string, minutesAfterMidnight: number): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, 0, minutesAfterMidnight);
  let ms = wall;
  for (let i = 0; i < 2; i++) ms = wall - mountainOffsetMinutes(ms) * 60_000;
  return ms;
}

/** "9:45 am". */
export function clockLabel(minutesAfterMidnight: number): string {
  const h = Math.floor(minutesAfterMidnight / 60);
  const m = minutesAfterMidnight % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${two(m)} ${h < 12 ? 'am' : 'pm'}`;
}

const DAY_NAMES: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export interface Slot {
  /** The instant, in Unix milliseconds. */
  ms: number;
  /** The business time to send. */
  value: string;
  /** The Mountain calendar date, `YYYY-MM-DD`. */
  date: string;
  weekday: Weekday;
  /** "9:45 am", or "9:00 am to 11:00 am" for a window. */
  label: string;
}

/** "Saturday 2026-11-07". */
export const dayLabel = (slot: Pick<Slot, 'date' | 'weekday'>) =>
  `${DAY_NAMES[slot.weekday]} ${slot.date}`;

/** Which slots to offer: what the menu is baked on, and what the cart's items allow. */
export interface SlotRules {
  /** The longest lead time among the cart's lines, in minutes. */
  leadMinutes: number;
  /** Whether the bakery bakes what is in the cart on this day. */
  accept?: (local: Local) => boolean;
  /** How many calendar days ahead to look. */
  days?: number;
}

/** The first quarter hour strictly after now plus the lead time. */
export function firstQuarter(nowMs: number, leadMinutes: number): number {
  return (Math.floor((nowMs + leadMinutes * 60_000) / QUARTER_MS) + 1) * QUARTER_MS;
}

/** Pickup slots on the quarter hour, inside opening hours, on days the rules accept. */
export function pickupSlots(nowMs: number, rules: SlotRules): Slot[] {
  const end = nowMs + (rules.days ?? 7) * 86_400_000;
  const out: Slot[] = [];
  for (let ms = firstQuarter(nowMs, rules.leadMinutes); ms <= end; ms += QUARTER_MS) {
    const l = mountainLocal(ms);
    const minutes = l.hour * 60 + l.minute;
    if (minutes < OPENS || minutes > LAST_PICKUP) continue;
    if (rules.accept && !rules.accept(l)) continue;
    out.push({
      ms,
      value: businessTime(ms),
      date: dateOf(l),
      weekday: l.weekday,
      label: clockLabel(minutes),
    });
  }
  return out;
}

/** Delivery windows at 09:00, 11:00 and 13:00, two hours each, whose start is not too soon. */
export function deliveryWindows(nowMs: number, rules: SlotRules): Slot[] {
  const earliest = nowMs + rules.leadMinutes * 60_000;
  const out: Slot[] = [];
  const first = mountainLocal(nowMs);
  for (let day = 0; day <= (rules.days ?? 7); day++) {
    // Noon of each day is far from any clock change, so adding whole days to it is safe.
    const noon = mountainToMs(dateOf(first), 12 * 60) + day * 86_400_000;
    const l = mountainLocal(noon);
    for (const start of DELIVERY_STARTS) {
      const ms = mountainToMs(dateOf(l), start);
      if (ms <= earliest) continue;
      if (rules.accept && !rules.accept({ ...l, hour: Math.floor(start / 60), minute: 0 }))
        continue;
      out.push({
        ms,
        value: businessTime(ms),
        date: dateOf(l),
        weekday: l.weekday,
        label: `${clockLabel(start)} to ${clockLabel(start + 120)}`,
      });
    }
  }
  return out;
}

/** Slots grouped by calendar date, in order. */
export function byDate(slots: Slot[]): { date: string; label: string; slots: Slot[] }[] {
  const groups: { date: string; label: string; slots: Slot[] }[] = [];
  for (const slot of slots) {
    const last = groups[groups.length - 1];
    if (last && last.date === slot.date) last.slots.push(slot);
    else groups.push({ date: slot.date, label: dayLabel(slot), slots: [slot] });
  }
  return groups;
}
