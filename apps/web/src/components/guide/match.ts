// Which route a trace was and which entry explains it: shared by the live note and the recorder.
import { ALL_ENTRIES, ROUTE_SHAPES } from '../../guide';
import { pickEntry, routeMatcher, type GuideEntry, type ScreenId } from '../../lib/guide';
import type { Trace } from '../../lib/trace';

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
