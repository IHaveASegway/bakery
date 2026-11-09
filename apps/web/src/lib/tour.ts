// The old tour's own parts, kept only until the tour's component goes (the guide replaces it,
// lib/guide.ts). Everything the guide shares (the screens, the principle, the curl) lives there.
import type { ActivityEntry } from '../contracts';
import type { GuideApi, GuideEntry, ScreenId } from './guide';
import { SCREENS } from './guide';

export * from './guide';
export type TourApi = GuideApi;
export type TourStep = GuideEntry;

// ---- Moving through a tour ----

export interface TourState {
  open: boolean;
  index: number;
}

export type TourAction =
  | { type: 'open'; index?: number }
  | { type: 'close' }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'first' }
  | { type: 'last' };

export const CLOSED: TourState = { open: false, index: 0 };

/** The next state. "Next" on the last step ends the tour; "back" on the first stays put. */
export function tourReduce(state: TourState, action: TourAction, total: number): TourState {
  const last = Math.max(0, total - 1);
  switch (action.type) {
    case 'open':
      return { open: total > 0, index: Math.min(Math.max(0, action.index ?? 0), last) };
    case 'close':
      return { open: false, index: state.index };
    case 'next':
      if (!state.open) return state;
      return state.index >= last
        ? { open: false, index: state.index }
        : { ...state, index: state.index + 1 };
    case 'back':
      return state.open ? { ...state, index: Math.max(0, state.index - 1) } : state;
    case 'first':
      return state.open ? { ...state, index: 0 } : state;
    case 'last':
      return state.open ? { ...state, index: last } : state;
  }
}

/** "3 of 9", counting from one. */
export function progressText(index: number, total: number): string {
  return `${index + 1} of ${total}`;
}

/**
 * What a key does inside the open card. Arrows move (right and down go forward), Home and End
 * jump, Escape closes, and Enter goes forward only when the focus is on the card itself: on a
 * button or a link, Enter belongs to that control.
 */
export function keyAction(key: string, onControl: boolean): TourAction | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return { type: 'next' };
    case 'ArrowLeft':
    case 'ArrowUp':
      return { type: 'back' };
    case 'Home':
      return { type: 'first' };
    case 'End':
      return { type: 'last' };
    case 'Escape':
      return { type: 'close' };
    case 'Enter':
      return onControl ? null : { type: 'next' };
    default:
      return null;
  }
}

// ---- "Seen", the one thing the tour remembers (localStorage, per viewer, never read by the API) ----

export const SEEN_KEY = 'bakery-tour-seen';

/** The screens recorded as seen, from the stored text; anything unreadable is "none seen". */
export function parseSeen(raw: string | null): Partial<Record<ScreenId, true>> {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const seen: Partial<Record<ScreenId, true>> = {};
    for (const screen of SCREENS) {
      if ((value as Record<string, unknown>)[screen] === true) seen[screen] = true;
    }
    return seen;
  } catch {
    return {};
  }
}

export function withSeen(
  seen: Partial<Record<ScreenId, true>>,
  screen: ScreenId,
): Partial<Record<ScreenId, true>> {
  return { ...seen, [screen]: true };
}

// ---- The events of the last action ----

/** How far back "the last action" reaches. */
export const RECENT_MS = 60_000;

/**
 * The activity entries of the step's event types from the last minute, newest first as the feed
 * is. `nowMs` is business time (wall time plus the sandbox's clock offset), because the feed's
 * times are business times; an entry a few seconds ahead of `nowMs` still counts.
 */
export function recentEvents(
  entries: readonly ActivityEntry[],
  types: readonly string[],
  nowMs: number,
  windowMs: number = RECENT_MS,
): ActivityEntry[] {
  return entries.filter((entry) => {
    if (!types.includes(entry.type)) return false;
    const age = nowMs - Date.parse(entry.at);
    return Number.isFinite(age) && age >= -5_000 && age <= windowMs;
  });
}
