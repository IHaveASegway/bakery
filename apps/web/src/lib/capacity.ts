// The staff capacity editor's pure parts: the target grammar the API's `CapacityRequest` takes,
// and the words for its refusals. The grammar is the domain's (`Target`, docs/domain.md): `slot:HH:MM`
// on the quarter hour, `zone:z1` to `z3`, `item:<slug>` and `catering`. The form builds a target
// from choices, so it is well formed by construction; the API still checks it and its 422
// `bad-target` is shown as it came.
import type { CapacityRequest, ScheduleResponse } from '../contracts';
import { ApiError } from './api';
import { describeError, type Message } from './messages';
import { pollUntil, type PollOptions, type Polled } from './payment';
import { mountainLocal, ZONES } from './slots';

/**
 * After a publish, reads the day until it reports the menu version that was published. The
 * Schedule takes the new item caps from the `MenuPublished` event, a moment after the publish
 * answers, so the first look can still show the old version. A bounded wait, not a loop that
 * goes on: `paid` here means "the day has caught up", `timeout` means it had not in the limit.
 */
export const catchUpToMenu = (
  read: () => Promise<number | null>,
  version: number,
  options: PollOptions,
): Promise<Polled<number>> =>
  pollUntil(
    async () => (await read()) ?? 0,
    (seen) => (seen >= version ? 'paid' : null),
    { limitMs: 8_000, ...options },
  );

export type TargetKind = 'slot' | 'zone' | 'item' | 'catering';

export const KINDS: { kind: TargetKind; label: string }[] = [
  { kind: 'slot', label: 'A pickup slot' },
  { kind: 'zone', label: 'A delivery zone' },
  { kind: 'item', label: 'An item’s daily cap' },
  { kind: 'catering', label: 'Catering events a day' },
];

/** A capacity is a `u16` on the wire. */
export const MAX_CAPACITY = 65_535;

const two = (n: number) => String(n).padStart(2, '0');

/** `HH:MM` of a slot's start, the way the target names it: "14:45". */
export function slotTime(start: string): string {
  const l = mountainLocal(Date.parse(start));
  return `${two(l.hour)}:${two(l.minute)}`;
}

export type Built = { ok: true; target: string } | { ok: false; reason: string };

/** The target string for a kind and a value, or why the form cannot build one. */
export function buildTarget(kind: TargetKind, value: string): Built {
  const v = value.trim();
  switch (kind) {
    case 'catering':
      return { ok: true, target: 'catering' };
    case 'slot': {
      const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
      if (m === null || Number(m[2]) % 15 !== 0) {
        return {
          ok: false,
          reason: 'A slot is named by its start on the quarter hour, such as 14:45.',
        };
      }
      return { ok: true, target: `slot:${v}` };
    }
    case 'zone':
      return (ZONES as readonly string[]).includes(v)
        ? { ok: true, target: `zone:${v}` }
        : { ok: false, reason: 'A zone is z1, z2 or z3.' };
    case 'item':
      return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)
        ? { ok: true, target: `item:${v}` }
        : { ok: false, reason: 'An item is named by its slug, such as croissant or country-loaf.' };
  }
}

/** Whole numbers from 0 to 65,535; anything else is not worth sending. */
export function parseCapacity(text: string): number | null {
  if (!/^\d{1,5}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n <= MAX_CAPACITY ? n : null;
}

export function capacityRequest(target: string, capacity: number): CapacityRequest {
  return { target, capacity };
}

/** What the day says about one target after a change: capacity and taken, for the answer's line. */
export function standing(
  schedule: ScheduleResponse,
  target: string,
): { capacity: number | null; taken: number } | null {
  if (target === 'catering') {
    return { capacity: schedule.catering.capacity, taken: schedule.catering.taken };
  }
  const [kind, ...rest] = target.split(':');
  const name = rest.join(':');
  if (kind === 'slot') {
    const slot = schedule.slots.find((s) => slotTime(s.start) === name);
    return slot ? { capacity: slot.capacity, taken: slot.taken } : null;
  }
  if (kind === 'zone') {
    const zone = schedule.zones.find((z) => z.zone === name);
    return zone ? { capacity: zone.capacity, taken: zone.taken } : null;
  }
  if (kind === 'item') {
    const item = schedule.items.find((i) => i.item === name);
    return item ? { capacity: item.daily_cap ?? null, taken: item.used } : null;
  }
  return null;
}

/** The line after a change. A lowered capacity never drops a reservation, and the line says so. */
export function changedText(target: string, capacity: number, schedule: ScheduleResponse): string {
  const now = standing(schedule, target);
  const base = `Capacity for ${target} is now ${capacity}.`;
  if (now === null) return base;
  return now.taken > capacity
    ? `${base} ${now.taken} already taken stay: a lowered capacity never drops a reservation, it only stops new ones.`
    : `${base} ${now.taken} taken, ${capacity - now.taken} free. A lowered capacity never drops a reservation.`;
}

/** The words for a refused capacity change: `guest-scope` (403), `unknown-item` and `bad-target` (422), the rest as usual. */
export function describeCapacityError(error: unknown): Message {
  if (error instanceof ApiError) {
    const text = `${error.detail ?? ''} ${error.slug}`.toLowerCase();
    if (error.status === 403 && text.includes('guest-scope')) {
      return {
        title: 'Guests cannot change capacities',
        detail: 'Sign in to set a capacity. A guest sees the schedule and nothing more.',
      };
    }
    if (error.status === 422 && text.includes('unknown-item')) {
      return {
        title: 'That item is not on the day’s menu',
        detail:
          'An item cap names an item the published menu sells, by its slug as the day’s list shows it. Nothing was changed.' +
          (error.detail ? ` It said: ${error.detail}` : ''),
      };
    }
    if (error.status === 422 && text.includes('bad-target')) {
      return {
        title: 'The API did not accept that target',
        detail:
          'A target is slot:HH:MM on the quarter hour, zone:z1 to z3, item:<slug> or catering.' +
          (error.detail ? ` It said: ${error.detail}` : ''),
      };
    }
  }
  return describeError(error);
}
