// Which route a trace was and which entry explains it: shared by the live note and the recorder.
import { ALL_ENTRIES, ROUTE_SHAPES } from '../../guide';
import { pickEntry, routeMatcher, type GuideEntry, type ScreenId } from '../../lib/guide';
import { sandboxOf } from '../../lib/recorder';
import { traces, type HeardEvent, type Listening, type Trace } from '../../lib/trace';

const routeOf = routeMatcher(ROUTE_SHAPES);

/** The route a trace was: the matcher's answer, or the kitchen socket for a socket command. */
export const routeIdOf = (trace: Trace): string | null =>
  trace.transport === 'socket' ? 'kitchen-socket' : routeOf(trace.method, trace.path);

/** The entry that explains what the visitor's traces did. */
export function entryForTraces(group: readonly Trace[], screen: ScreenId, anchor: unknown) {
  const first = group[0];
  if (first === undefined) return null;
  // The board's command budget: a move refused with the rule rate-limit is that entry's story.
  if (first.transport === 'socket' && first.rule === 'rate-limit') {
    return ALL_ENTRIES.find((e) => e.id === 'kitchen-rate-limit') ?? null;
  }
  // The demo's flag (roadmap R85): a move refused with the rule read-only is that entry's story.
  if (first.transport === 'socket' && first.rule === 'read-only') {
    return ALL_ENTRIES.find((e) => e.id === 'kitchen-read-only') ?? null;
  }
  const types = group.flatMap((t) => t.events.map((e) => e.type));
  const inTarget = (target: string) =>
    typeof Element !== 'undefined' &&
    anchor instanceof Element &&
    anchor.closest(`[data-tour="${CSS.escape(target)}"]`) !== null;
  return pickEntry(ALL_ENTRIES, screen, routeIdOf(first), types, inTarget);
}

/**
 * The entry for a click's traces, as both the live note and the recorder panel choose it: by the
 * element the click pressed, which the store keeps. One choice, so the two expect the same events.
 */
export const entryForGroup = (group: readonly Trace[], screen: ScreenId) =>
  entryForTraces(group, screen, traces.anchorOf(group[0]?.gesture ?? null));

/** The visitor's traces grouped by the click that made them, newest click first. */
export function byGesture(traces: readonly Trace[]): Trace[][] {
  const groups = new Map<number, Trace[]>();
  for (const trace of traces) {
    if (trace.gesture === null) continue;
    groups.set(trace.gesture, [trace, ...(groups.get(trace.gesture) ?? [])]);
  }
  return [...groups.entries()].sort(([a], [b]) => b - a).map(([, group]) => group);
}

/** The element an entry explains, if the page is showing it. */
export const targetOf = (target: string) =>
  document.querySelector<HTMLElement>(`[data-tour="${CSS.escape(target)}"]`);

/** The one event each of the board's commands makes, when the Order object accepts it. */
export const COMMAND_EVENT: Record<string, string> = {
  start_production: 'OrderProductionStarted',
  mark_ready: 'OrderReady',
  mark_picked_up: 'OrderPickedUp',
};

/**
 * What a route's write writes by itself, where it is less than its entry's events (since
 * 2026-11-10): the rest comes later, from another hand. Paying makes a payment intent; Stripe's
 * webhook pays it after the card is confirmed, which is another press. Issuing a token at the same
 * version writes nothing; rotating it writes ApiTokenRotated. Starting traffic writes
 * TrafficStarted; its orders come a minute or more later. Scheduling a campaign writes
 * CampaignScheduled; it is sent at its time. Publishing a plan writes RoutePublished; an order on
 * it goes out for delivery when the kitchen makes it ready, a later press (LATER).
 */
export const ROUTE_WRITES: Record<string, readonly string[]> = {
  pay: ['PaymentIntentCreated'],
  'catering-deposit': ['PaymentIntentCreated'],
  'issue-token': [],
  'rotate-token': ['ApiTokenRotated'],
  'start-traffic': ['TrafficStarted'],
  'schedule-campaign': ['CampaignScheduled'],
  'publish-dispatch': ['RoutePublished'],
};

/**
 * An entry's event that a route's write does not make by itself, and what makes it, in words a
 * note shows under the events it waits for, so it waits for nothing the press did not start.
 */
export const LATER: Record<string, { type: string; when: string }> = {
  'publish-dispatch': {
    type: 'OrderOutForDelivery',
    when: 'goes out when its order is made ready on the board, a later press',
  },
};

/** The sandbox a write names in its path, or null (`/v1/sandboxes` itself, the auth routes). */
const sandboxIn = (path: string) =>
  /^\/v1\/sandboxes\/([^/?]+)\//.exec(path.split('?')[0] + '/')?.[1] ?? null;

/**
 * The events a note waits for after what the visitor did, each one the action writes and the
 * recorder can show. A board command makes its one event; a read makes none. A write
 * that names no sandbox (a new sandbox, a demo account) or is the sandbox's own wipe cannot be
 * followed on the recorder, which is read by sandbox and goes with it: it waits for none. Any other
 * write waits for what its route writes (ROUTE_WRITES), else its entry's events.
 */
export function expectedFor(entry: GuideEntry | null, group: readonly Trace[]): string[] {
  const first = group[0];
  // A read changes nothing, so it expects no event: the menu's events are its publisher's.
  if (first?.read !== undefined) return [];
  const one = first?.transport === 'socket' ? COMMAND_EVENT[first.action ?? ''] : undefined;
  if (one !== undefined) return [one];
  if (first !== undefined && first.transport !== 'socket') {
    const bare = first.path.split('?')[0] ?? first.path;
    if (/^\/v1\/sandboxes\/[^/]+$/.test(bare) || sandboxIn(bare) === null) return [];
    // A write whose answer named no cause (an API older than Bakery-Cause, a PATCH sent with no
    // key): its events name a cause this page never saw, so none is waited for.
    if (first.key === null) return [];
    const route = routeIdOf(first);
    const writes = route === null ? undefined : ROUTE_WRITES[route];
    if (writes !== undefined) return [...writes];
  }
  return entry?.events ?? [];
}

/**
 * Why a write's note waits for no event, in words, when it is one the recorder cannot follow; null
 * otherwise.
 */
export function unfollowable(group: readonly Trace[]): string | null {
  const first = group[0];
  if (first === undefined || first.transport === 'socket' || first.read !== undefined) return null;
  const bare = first.path.split('?')[0] ?? first.path;
  if (/^\/v1\/sandboxes\/[^/]+$/.test(bare)) {
    return 'The recorder is the sandbox’s own, so it goes with the sandbox: no event of this is shown here.';
  }
  if (first.key === null && first.method !== 'GET' && sandboxIn(bare) !== null) {
    const set = first.method === 'PATCH' || first.method === 'PUT';
    return `${set ? 'Setting a value twice leaves it as setting it once does, so this call needs no key to be safe to repeat. ' : ''}Its answer named no cause, so its events are not followed here; the Recorder panel lists them as they arrive.`;
  }
  if (sandboxIn(bare) === null && first.method !== 'GET') {
    return 'The recorder is read by sandbox and this call names none, so its events are not followed here; the Recorder panel shows them once the sandbox is yours.';
  }
  return null;
}

/**
 * Which of the visitor's writes to follow on the recorder now: each click's first request, once
 * answered, once. An answered write that is not a 2xx, a read, a socket command or a write to the
 * sandbox itself (its wipe, which takes the recorder with it) is marked done and not followed.
 * `followed` holds the clicks already decided and is updated in place.
 */
export function writesToFollow(
  traces: readonly Trace[],
  followed: Set<number>,
): { group: Trace[]; sandbox: string }[] {
  const out: { group: Trace[]; sandbox: string }[] = [];
  // Every click's, however many came after it: an old write answered late is followed too.
  for (const group of byGesture(traces)) {
    const head = group[0];
    if (head === undefined || head.gesture === null || followed.has(head.gesture)) continue;
    if (head.transport !== 'http' || head.read !== undefined || head.outcome === 'pending')
      continue;
    followed.add(head.gesture);
    if (head.outcome !== 'ok') continue;
    const sandbox = sandboxOf(head.path);
    if (sandbox === null || /^\/v1\/sandboxes\/[^/?]+$/.test(head.path)) continue;
    out.push({ group, sandbox });
  }
  return out;
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
