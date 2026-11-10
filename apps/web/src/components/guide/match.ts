// Which route a trace was and which entry explains it: shared by the live note and the recorder.
import { ALL_ENTRIES, ROUTE_SHAPES } from '../../guide';
import { pickEntry, routeMatcher, type GuideEntry, type ScreenId } from '../../lib/guide';
import type { HeardEvent, Listening, Trace } from '../../lib/trace';

const routeOf = routeMatcher(ROUTE_SHAPES);

/** The route a trace was: the matcher's answer, or the kitchen socket for a socket command. */
export const routeIdOf = (trace: Trace): string | null =>
  trace.transport === 'socket' ? 'kitchen-socket' : routeOf(trace.method, trace.path);

/** The entry that explains what the visitor's traces did. */
export function entryForTraces(group: readonly Trace[], screen: ScreenId, anchor: unknown) {
  const first = group[0];
  if (first === undefined) return null;
  const types = group.flatMap((t) => t.events.map((e) => e.type));
  const inTarget = (target: string) =>
    typeof Element !== 'undefined' &&
    anchor instanceof Element &&
    anchor.closest(`[data-tour="${CSS.escape(target)}"]`) !== null;
  return pickEntry(ALL_ENTRIES, screen, routeIdOf(first), types, inTarget);
}

/** The element an entry explains, if the page is showing it. */
export const targetOf = (target: string) =>
  document.querySelector<HTMLElement>(`[data-tour="${CSS.escape(target)}"]`);

/** The one event each of the board's commands makes, when the Order object accepts it. */
const COMMAND_EVENT: Record<string, string> = {
  start_production: 'OrderProductionStarted',
  mark_ready: 'OrderReady',
  mark_picked_up: 'OrderPickedUp',
};

/**
 * The events a note expects for what the visitor did: a board command makes its one event; any
 * other action makes the entry's events.
 */
export function expectedFor(entry: GuideEntry | null, group: readonly Trace[]): string[] {
  const first = group[0];
  const one = first?.transport === 'socket' ? COMMAND_EVENT[first.action ?? ''] : undefined;
  if (one !== undefined) return [one];
  return entry?.events ?? [];
}

/**
 * Which of the visitor's actions opens a live note now, if any: the newest one made by a click,
 * once, while the guide is on and the recorder panel is closed. An action taken while the panel is
 * open becomes the panel's newest row instead, and one taken while the guide is off opens nothing;
 * either is marked seen, so neither opens late when the panel closes or the guide comes back on. `seen` is updated in place.
 */
export function noteToOpen(
  traces: readonly Trace[],
  seen: Set<number>,
  state: { on: boolean; panel: boolean },
): number | null {
  const gesture = traces.find((t) => t.gesture !== null)?.gesture ?? null;
  if (gesture === null || seen.has(gesture)) return null;
  seen.add(gesture);
  return state.on && !state.panel ? gesture : null;
}

/** How recent an action may be, when the layer mounts, and still open its note. */
export const MOUNT_GRACE_MS = 3_000;

/**
 * The actions already in the store when the layer mounts that are old news: those that began more
 * than MOUNT_GRACE_MS before `now`. A press made just before the layer finished loading (a quick
 * Place order) still opens its note; one made minutes ago, with the guide off, does not. A story
 * read is never old news: the menu's first load is the page's own story, however late the layer
 * comes to tell it.
 */
export const gesturesIn = (traces: readonly Trace[], now: number): Set<number> =>
  new Set(
    traces.flatMap((t) =>
      t.gesture === null || t.startedAt > now - MOUNT_GRACE_MS || t.read !== undefined
        ? []
        : [t.gesture],
    ),
  );

/** What a page watching an order has to tell: the newest event it heard, or its switch to reading. */
export type WatchNews =
  | { kind: 'heard'; key: string; event: HeardEvent }
  | { kind: 'reading'; key: string; listening: Listening };

/** The newest piece of watch news, if any: a heard event, or a fall back to reading. */
export function newestWatchNews(
  heard: readonly HeardEvent[],
  listening: Listening | null,
): WatchNews | null {
  const event = heard[0];
  const reading = listening !== null && listening.how === 'reading' ? listening : null;
  if (reading !== null && (event === undefined || reading.at >= event.at)) {
    return { kind: 'reading', key: `reading:${reading.why}:${reading.at}`, listening: reading };
  }
  return event === undefined ? null : { kind: 'heard', key: `heard:${event.id}`, event };
}

/**
 * Which watch news opens a note now: the newest, once, with the guide on and the recorder closed,
 * as for a click (noteToOpen). News from before the layer mounted, by more than MOUNT_GRACE_MS, is
 * old. `seen` is updated in place.
 */
export function watchToOpen(
  heard: readonly HeardEvent[],
  listening: Listening | null,
  seen: Set<string>,
  state: { on: boolean; panel: boolean },
): WatchNews | null {
  const news = newestWatchNews(heard, listening);
  if (news === null || seen.has(news.key)) return null;
  seen.add(news.key);
  return state.on && !state.panel ? news : null;
}

/** The watch news already old when the layer mounts. */
export function watchKeysBefore(
  heard: readonly HeardEvent[],
  listening: Listening | null,
  now: number,
): Set<string> {
  const keys = new Set<string>();
  for (const event of heard) if (event.at <= now - MOUNT_GRACE_MS) keys.add(`heard:${event.id}`);
  if (listening !== null && listening.how === 'reading' && listening.at <= now - MOUNT_GRACE_MS) {
    keys.add(`reading:${listening.why}:${listening.at}`);
  }
  return keys;
}
