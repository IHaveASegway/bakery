import type { TraceHop } from '../contracts';

// The guide's evidence (docs/architecture.md, "The guide"; ADR 0014): a small store in the page
// that keeps what the visitor's own actions did, as traces. Evidence arrives from sources behind
// one interface: the page's own calls (lib/api.ts), the kitchen socket's frames where the page
// holds it (lib/use-kitchen.ts), a page watching one order (lib/use-order-watch.ts), the activity
// feed the console already reads (lib/activity-feed.ts), and the server's flight recorder, whose
// hops lib/recorder.ts reads after a write, or follows while the recorder panel is open, and turns
// into evidence here (`fromHop`). The store keeps no response body: a call is its method, path,
// status, time and key; an event is its envelope's id, type, stream, sequence and cause, which the
// board already shows. Beside the traces, a few values a page read (`observations`, such as the
// status page's flag) are kept so a note can show them as observed. Nothing is stored outside
// memory.

/** Where a piece of evidence came from. */
export type SourceKind = 'page' | 'socket' | 'feed' | 'recorder';

/** One delivery of an event to a subscriber class, as the server's flight recorder reported it. */
export interface Delivery {
  /** The subscriber's class, such as "Kitchen" or "Crm". */
  to: string;
  /** Delivered on this attempt; retried (the message went back to the Queue); dead-lettered. */
  outcome: 'ok' | 'retry' | 'dead';
  /** The recorder's own count for the event: a lower bound on the Queue's attempts (ADR 0015). */
  attempt: number;
}

/**
 * The reads a page's story needs, by name. Most reads change nothing and are not traced (a page that
 * looks again every ten seconds would flood the recorder); one named here is, with what its answer
 * said, and it opens its note when it happens, click or no click.
 */
export const STORY_READS = ['menu'] as const;
export type ReadName = (typeof STORY_READS)[number];

/** What a story read's answer said: the cache's header, the ETag, and the ETag the page sent. */
export interface ReadFacts {
  name: ReadName;
  /** `Bakery-Cache`: `hit` or `miss`, or null when the API sent none. */
  cache: string | null;
  etag: string | null;
  /** The `If-None-Match` the page sent, or null for a first read. */
  asked: string | null;
}

/**
 * How far the recorder's reads for a write have got (lib/recorder.ts, followWrite): none yet, under
 * way, past the first three (late), or finished. Kept on the trace, so a note and the recorder
 * panel say the same of an event not yet seen.
 */
export type Reading = 'idle' | 'reading' | 'late' | 'done';

/** One piece of evidence, whichever source saw it. Times are wall-clock milliseconds. */
export type Evidence =
  | {
      kind: 'call';
      /** The cause its events carry (Bakery-Cause), else the Idempotency-Key sent, else null. */
      key: string | null;
      method: string;
      /** The path as sent, query string included. */
      path: string;
      /** The answer's status, or null when no answer came (offline, blocked). */
      status: number | null;
      ms: number;
      at: number;
      /** For a story read: what its answer said. */
      read?: ReadFacts;
    }
  | { kind: 'command'; key: string; action: string; order: string; at: number }
  | {
      kind: 'answer';
      key: string;
      outcome: 'ack' | 'nack' | 'lost';
      rule: string | null;
      at: number;
    }
  | {
      kind: 'event';
      source: Exclude<SourceKind, 'page'>;
      id: string | null;
      type: string;
      stream: string | null;
      seq: number | null;
      cause: string | null;
      at: number;
      /** From the recorder: how long after it was written the event was delivered. */
      lagMs?: number;
      deliveries?: Delivery[];
      /** From the recorder: its own count of this event's hops (ADR 0015), a lower bound. */
      attempt?: number;
    }
  | { kind: 'reads'; key: string; state: Reading };

/**
 * A page that watches one order (the order's status page, lib/use-order-watch.ts) reports what it
 * hears about that order and how it is listening. Neither is a click's: the kitchen moves the card,
 * and the page only listens, so these are kept apart from the traces.
 */
export type WatchEvidence =
  | {
      kind: 'heard';
      id: string;
      type: string;
      stream: string;
      seq: number;
      cause: string | null;
      at: number;
    }
  | {
      kind: 'listening';
      /** On the kitchen socket, reading every 10 s, paused while hidden, or finished. */
      how: Listening['how'];
      /** Why it reads instead of listening: it gave its socket up, was refused one, or lost it. */
      why: Listening['why'];
      at: number;
    };

/** How a page watching an order hears about it. */
export interface Listening {
  how: 'socket' | 'reading' | 'paused' | 'done';
  why: 'yielded' | 'limit' | 'unavailable' | null;
  at: number;
}

/** An event a watching page heard about its order. */
export interface HeardEvent {
  id: string;
  type: string;
  stream: string;
  seq: number;
  cause: string | null;
  at: number;
}

/** Where a source sends what it sees. */
export interface TraceSink {
  record(evidence: Evidence | WatchEvidence): void;
}

/** A source of evidence: connected to a sink, it delivers until the returned function stops it. */
export interface TraceSource {
  readonly kind: SourceKind;
  connect(sink: TraceSink): () => void;
}

/**
 * A source the page pushes into: the page's calls, the socket and the feed each own one and call
 * `emit` where they see something. Evidence emitted while nothing is connected is dropped.
 */
export function pushSource(
  kind: SourceKind,
): TraceSource & { emit(evidence: Evidence | WatchEvidence): void } {
  const sinks = new Set<TraceSink>();
  return {
    kind,
    connect(sink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    emit(evidence) {
      for (const sink of sinks) sink.record(evidence);
    },
  };
}

const OUTCOME = { delivered: 'ok', retried: 'retry', dead_lettered: 'dead' } as const;

/**
 * A flight-recorder hop (crates/contracts, `TraceHop`; ADR 0015) as evidence: the event the Queue's
 * consumer took, with its lag and each subscriber class's outcome on that attempt. A hop carries
 * identifiers, types and times only, never an event's data.
 */
export function fromHop(hop: TraceHop, at: number): Evidence {
  return {
    kind: 'event',
    source: 'recorder',
    id: hop.id,
    type: hop.type,
    stream: hop.stream,
    seq: hop.seq,
    cause: hop.cause ?? null,
    at,
    lagMs: hop.lag_ms,
    attempt: hop.attempt,
    deliveries: hop.deliveries.map((d) => ({
      to: d.to,
      outcome: OUTCOME[d.outcome],
      attempt: hop.attempt,
    })),
  };
}

/** How far a delivery got: a dead letter is final, else the higher attempt is the later news. */
export const deliveryRank = (deliveries: readonly Delivery[] | undefined): number =>
  deliveries === undefined || deliveries.length === 0
    ? -1
    : (deliveries.some((d) => d.outcome === 'dead') ? 1_000 : 0) +
      Math.max(...deliveries.map((d) => d.attempt));

/** The server's flight recorder: hops read by lib/recorder.ts, from its read or its socket. */
export const recorderSource = pushSource('recorder');

// ---- Traces ----

/** An event the store has tied to a trace. */
export interface TracedEvent {
  id: string | null;
  type: string;
  stream: string | null;
  seq: number | null;
  source: Exclude<SourceKind, 'page'>;
  at: number;
  /** The id of the event or the key that caused it. */
  cause: string | null;
  lagMs?: number;
  deliveries?: Delivery[];
}

/** One thing the page did, with what came back and what it caused. */
export interface Trace {
  /** The Idempotency-Key, or the command's id; a made-up id for a call that sent no key. */
  id: string;
  key: string | null;
  /** The visitor's click this followed, or null for the page's own call (a heartbeat, a poll). */
  gesture: number | null;
  transport: 'http' | 'socket';
  method: string;
  /** The path as sent, or `cmd` for a socket command. */
  path: string;
  /** The socket command's action and order. */
  action: string | null;
  order: string | null;
  status: number | null;
  ms: number | null;
  outcome: 'pending' | 'ok' | 'refused' | 'failed';
  /** The rule a refused command named. */
  rule: string | null;
  startedAt: number;
  events: TracedEvent[];
  /** The recorder's reads for this write; `idle` for a trace nobody follows. */
  reading: Reading;
  /** A story read's facts; absent on every other trace. */
  read?: ReadFacts;
}

/**
 * A hop the flight recorder reported, as the recorder panel lists it, one line an event at its
 * furthest hop. `trace` is the visitor's trace that holds the event, by the store's one rule
 * (the trace's events include it), else null: the panel and a note cannot disagree on it.
 */
export interface RecorderHop {
  id: string;
  type: string;
  stream: string | null;
  cause: string | null;
  attempt: number;
  lagMs: number;
  deliveries: readonly Delivery[];
  at: number;
  trace: string | null;
}

/** A feed entry that arrived after the feed was first read: its type and when the page saw it. */
export interface FeedArrival {
  type: string;
  arrivedAt: number;
}

export interface TraceSnapshot {
  /** Newest first. */
  traces: readonly Trace[];
  feed: readonly FeedArrival[];
  /** What a page watching an order heard about it, newest first. */
  heard: readonly HeardEvent[];
  /** How that page is listening, or null on a page that watches no order. */
  listening: Listening | null;
  /** The recorder's hops this page has heard, newest first, whoever caused them. */
  hops: readonly RecorderHop[];
  version: number;
}

/** A click the visitor made: its number, when, and the element they pressed (opaque here). */
export interface Gesture {
  seq: number;
  at: number;
  anchor: unknown;
}

/** How long after a click a request still counts as the visitor's. */
export const GESTURE_MS = 2_000;
/**
 * How far before its click a request may seem to start and still be the click's. The click is
 * stamped with Date.now(), which counts whole milliseconds; a request's start is its answer's
 * Date.now() less its performance.now() duration, so a request sent in the click's own handler can
 * seem to start up to a millisecond before the click did.
 */
export const SKEW_MS = 5;
/** How many traces and orphan events are kept. */
export const KEEP_TRACES = 20;
/** How many events one trace keeps: its own, then their reactions. */
export const KEEP_EVENTS = 12;
const KEEP_ORPHANS = 100;
const KEEP_FEED = 50;
/** How many of the recorder's hops are kept for the panel, one an event. */
export const KEEP_HOPS = 40;

export interface TraceStore extends TraceSink {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TraceSnapshot;
  /** Records a click the visitor made, so the next request within GESTURE_MS is theirs. */
  gesture(anchor: unknown, at: number): Gesture;
  /** The element of a gesture, if the store still has it. */
  anchorOf(gesture: number | null): unknown;
  /** A feed read: the entries new since the last read of the same sandbox arrive as evidence. */
  feed(sandboxId: string, entries: readonly { type: string; at: string; summary: string }[]): void;
  clear(): void;
}

let made = 0;
const madeId = () => `call-${++made}`;

/**
 * A store. Correlation: an event belongs to a trace when its `cause` is that trace's key (or the
 * command's id), or the id of an event that already belongs to it; an event whose cause is not
 * known yet waits, and joins when its cause does. A simulated event (`sim:` cause) never joins.
 */
export function createTraceStore(
  options: { sources?: readonly TraceSource[]; now?: () => number } = {},
): TraceStore {
  const now = options.now ?? (() => Date.now());
  let traces: Trace[] = [];
  let feed: FeedArrival[] = [];
  let heard: HeardEvent[] = [];
  let listening: Listening | null = null;
  let hops: RecorderHop[] = [];
  let version = 0;
  let snapshot: TraceSnapshot = { traces, feed, heard, listening, hops, version };
  const owner = new Map<string, string>();
  let orphans: Extract<Evidence, { kind: 'event' }>[] = [];
  let last: Gesture | null = null;
  /** The last number given to a click or to a story read the page made by itself. */
  let counter = 0;
  const anchors = new Map<number, unknown>();
  const listeners = new Set<() => void>();
  const seenFeed = new Map<string, Set<string>>();

  const changed = () => {
    version++;
    // The one rule, read once: a hop is a trace's when that trace holds its event.
    const holder = new Map<string, string>();
    for (const trace of traces) {
      for (const e of trace.events) if (e.id !== null) holder.set(e.id, trace.id);
    }
    hops = hops.map((h) => {
      const trace = holder.get(h.id) ?? null;
      return trace === h.trace ? h : { ...h, trace };
    });
    snapshot = { traces, feed, heard, listening, hops, version };
    for (const listener of listeners) listener();
  };

  /** A recorder hop for the panel: one line an event, kept at its furthest hop. */
  const listHop = (event: Extract<Evidence, { kind: 'event' }>) => {
    if (event.source !== 'recorder' || event.id === null) return;
    const line: RecorderHop = {
      id: event.id,
      type: event.type,
      stream: event.stream,
      cause: event.cause,
      attempt: event.attempt ?? Math.max(1, ...(event.deliveries ?? []).map((d) => d.attempt)),
      lagMs: event.lagMs ?? 0,
      deliveries: event.deliveries ?? [],
      at: event.at,
      trace: null,
    };
    const before = hops.find((h) => h.id === line.id);
    if (before !== undefined && deliveryRank(before.deliveries) > deliveryRank(line.deliveries)) {
      return;
    }
    hops = [line, ...hops.filter((h) => h.id !== line.id)].slice(0, KEEP_HOPS);
  };

  const update = (id: string, change: (trace: Trace) => Trace) => {
    traces = traces.map((trace) => (trace.id === id ? change(trace) : trace));
  };

  const start = (trace: Trace) => {
    traces = [trace, ...traces.filter((t) => t.id !== trace.id)].slice(0, KEEP_TRACES);
    const kept = new Set(traces.map((t) => t.id));
    for (const [key, id] of owner) if (!kept.has(id)) owner.delete(key);
    owner.set(trace.id, trace.id);
  };

  const gestureFor = (at: number) =>
    last !== null && at - last.at >= -SKEW_MS && at - last.at <= GESTURE_MS ? last.seq : null;

  /** Ties an event to its trace, and then any waiting event it caused; true when it joined. */
  const attach = (event: Extract<Evidence, { kind: 'event' }>): boolean => {
    const traceId = event.cause === null ? undefined : owner.get(event.cause);
    if (traceId === undefined) return false;
    const traced: TracedEvent = {
      id: event.id,
      type: event.type,
      stream: event.stream,
      seq: event.seq,
      source: event.source,
      at: event.at,
      cause: event.cause,
      ...(event.lagMs === undefined ? {} : { lagMs: event.lagMs }),
      ...(event.deliveries === undefined ? {} : { deliveries: event.deliveries }),
    };
    update(traceId, (trace) => {
      // The same event from a second source (the socket, then the recorder) is one event,
      // with what each source knew.
      const same = trace.events.findIndex((e) => e.id !== null && e.id === event.id);
      if (same < 0) {
        // A chain is kept short: the action's events and their reactions, up to a fixed number.
        if (trace.events.length >= KEEP_EVENTS) return trace;
        return { ...trace, events: [...trace.events, traced] };
      }
      return {
        ...trace,
        events: trace.events.map((e, i) => {
          if (i !== same) return e;
          // Two hops of one event can arrive out of order: keep the further one's deliveries.
          const keep = deliveryRank(e.deliveries) > deliveryRank(traced.deliveries);
          if (!keep) return { ...e, ...traced };
          const merged: TracedEvent = { ...e, ...traced };
          if (e.deliveries !== undefined) merged.deliveries = e.deliveries;
          if (e.lagMs !== undefined) merged.lagMs = e.lagMs;
          return merged;
        }),
      };
    });
    if (event.id !== null) {
      owner.set(event.id, traceId);
      const waiting = orphans.filter((o) => o.cause === event.id);
      orphans = orphans.filter((o) => o.cause !== event.id);
      for (const child of waiting) attach(child);
    }
    return true;
  };

  const store: TraceStore = {
    record(evidence) {
      switch (evidence.kind) {
        case 'heard': {
          if (heard.some((h) => h.id === evidence.id)) return;
          const { id, type, stream, seq, cause, at } = evidence;
          heard = [{ id, type, stream, seq, cause, at }, ...heard].slice(0, KEEP_TRACES);
          break;
        }
        case 'listening':
          if (listening?.how === evidence.how && listening.why === evidence.why) return;
          listening = { how: evidence.how, why: evidence.why, at: evidence.at };
          break;
        case 'call': {
          const id = evidence.key ?? madeId();
          const ok = evidence.status !== null && evidence.status < 400;
          start({
            id,
            key: evidence.key,
            // A story read is a note of its own, click or no click: one it follows keeps that
            // click's number, and one the page made itself (the menu's first load) gets a new one.
            gesture:
              gestureFor(evidence.at - evidence.ms) ??
              (evidence.read === undefined ? null : ++counter),
            transport: 'http',
            method: evidence.method.toUpperCase(),
            path: evidence.path,
            action: null,
            order: null,
            status: evidence.status,
            ms: Math.round(evidence.ms),
            outcome: evidence.status === null ? 'failed' : ok ? 'ok' : 'refused',
            rule: null,
            startedAt: evidence.at - evidence.ms,
            events: traces.find((t) => t.id === id)?.events ?? [],
            reading: traces.find((t) => t.id === id)?.reading ?? 'idle',
            ...(evidence.read === undefined ? {} : { read: evidence.read }),
          });
          // Events that arrived before the answer did (the socket is quick) join now.
          const waiting = orphans.filter((o) => o.cause === id);
          orphans = orphans.filter((o) => o.cause !== id);
          for (const event of waiting) attach(event);
          break;
        }
        case 'command':
          start({
            id: evidence.key,
            key: evidence.key,
            gesture: gestureFor(evidence.at),
            transport: 'socket',
            method: 'WS',
            path: 'cmd',
            action: evidence.action,
            order: evidence.order,
            status: null,
            ms: null,
            outcome: 'pending',
            rule: null,
            startedAt: evidence.at,
            events: [],
            reading: 'idle',
          });
          break;
        case 'answer':
          if (!owner.has(evidence.key)) return;
          update(evidence.key, (trace) => ({
            ...trace,
            outcome:
              evidence.outcome === 'ack'
                ? 'ok'
                : evidence.outcome === 'nack'
                  ? 'refused'
                  : 'failed',
            rule: evidence.rule,
            ms: trace.ms ?? Math.max(0, Math.round(evidence.at - trace.startedAt)),
          }));
          break;
        case 'reads':
          if (!traces.some((t) => t.id === evidence.key)) return;
          update(evidence.key, (trace) => ({ ...trace, reading: evidence.state }));
          break;
        case 'event': {
          // Every recorder hop is listed for the panel, whoever caused it; it is a trace's only
          // when the trace holds it (`changed`).
          listHop(evidence);
          if (attach(evidence)) break;
          const tieable = evidence.cause !== null && !evidence.cause.startsWith('sim:');
          if (tieable) orphans = [...orphans, evidence].slice(-KEEP_ORPHANS);
          if (evidence.source !== 'recorder') return;
          break;
        }
      }
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    gesture(anchor, at) {
      const seq = ++counter;
      last = { seq, at, anchor };
      anchors.set(seq, anchor);
      // Only the recent gestures' elements are kept, so a removed element can be collected.
      for (const key of anchors.keys()) if (key < seq - KEEP_TRACES) anchors.delete(key);
      return last;
    },
    anchorOf: (gesture) => (gesture === null ? null : (anchors.get(gesture) ?? null)),
    feed(sandboxId, entries) {
      const keys = entries.map((e) => `${e.at}|${e.type}|${e.summary}`);
      const before = seenFeed.get(sandboxId);
      seenFeed.set(sandboxId, new Set([...(before ?? []), ...keys]));
      // The first read of a sandbox's feed is the baseline: nothing in it is news.
      if (before === undefined) return;
      const fresh = entries.filter((_, i) => !before.has(keys[i] as string));
      if (fresh.length === 0) return;
      const at = now();
      feed = [...fresh.map((e) => ({ type: e.type, arrivedAt: at })), ...feed].slice(0, KEEP_FEED);
      changed();
    },
    clear() {
      traces = [];
      feed = [];
      heard = [];
      listening = null;
      hops = [];
      orphans = [];
      owner.clear();
      changed();
    },
  };
  for (const source of options.sources ?? []) source.connect(store);
  return store;
}

// ---- What a note shows: each expected event, observed or still expected ----

export interface ExpectedHop {
  type: string;
  /** Observed: the event itself, from the socket or the recorder, or only seen in the feed. */
  state: 'observed' | 'seen-in-feed' | 'expected';
  event: TracedEvent | null;
}

/**
 * The entry's event types against what the trace observed. An event the page saw with a cause that
 * ties it to the trace is observed; one the activity feed listed after the trace began is seen in
 * the feed (the feed has no cause, so this is weaker and says so); the rest are expected. Observed
 * events the entry did not name follow, so nothing the page saw is hidden.
 */
export function expectedHops(
  types: readonly string[],
  trace: Pick<Trace, 'events' | 'startedAt'>,
  feed: readonly FeedArrival[] = [],
): ExpectedHop[] {
  const hops: ExpectedHop[] = types.map((type) => {
    const event = trace.events.find((e) => e.type === type) ?? null;
    if (event !== null) return { type, state: 'observed', event };
    const listed = feed.some((f) => f.type === type && f.arrivedAt >= trace.startedAt);
    return { type, state: listed ? 'seen-in-feed' : 'expected', event: null };
  });
  for (const event of trace.events) {
    if (!types.includes(event.type)) hops.push({ type: event.type, state: 'observed', event });
  }
  return hops;
}

// ---- The page's store and its sources ----

/** The page's calls (lib/api.ts emits here). */
export const pageSource = pushSource('page');
/** The kitchen socket's commands, answers and envelopes (lib/use-kitchen.ts emits here). */
export const socketSource = pushSource('socket');
/** A page watching one order (lib/use-order-watch.ts emits here). */
export const watchSource = pushSource('socket');
/** The activity feed the console reads (lib/activity-feed.ts emits here). */
export const feedSource = pushSource('feed');

/**
 * How a story read is asked again from a note: the island that owns the read registers its own
 * repeat here (the menu's sends its ETag back as If-None-Match), and the note's button calls it.
 */
const repeats = new Map<ReadName, () => void>();
export const storyReads = {
  register(name: ReadName, repeat: () => void): () => void {
    repeats.set(name, repeat);
    return () => {
      if (repeats.get(name) === repeat) repeats.delete(name);
    };
  },
  repeat(name: ReadName): boolean {
    const repeat = repeats.get(name);
    repeat?.();
    return repeat !== undefined;
  },
  has: (name: ReadName) => repeats.has(name),
};

/**
 * What a page last read that an entry's note shows as observed, by name: the status page's flag
 * (`flag`). A page sets it when its read answers; a note reads it, never a promise in its place.
 */
export interface Observation {
  value: string;
  /** The request it came from, as a note shows it. */
  from: string;
  at: number;
}
const observed = new Map<string, Observation>();
const watchers = new Set<() => void>();
export const observations = {
  set(name: string, value: Observation) {
    observed.set(name, value);
    for (const w of watchers) w();
  },
  get: (name: string): Observation | null => observed.get(name) ?? null,
  subscribe(watcher: () => void) {
    watchers.add(watcher);
    return () => watchers.delete(watcher);
  },
};

/** The one store of the page, shared by every island because they share this module. */
export const traces = createTraceStore({
  sources: [pageSource, socketSource, watchSource, feedSource, recorderSource],
});

// The visitor's clicks, so a request that follows one is known as theirs. A click on a button (or a
// form's submit, which a press of Enter in a field makes) is a gesture; the element is the anchor a
// live note opens beside. Installed once, in the browser only.
if (typeof document !== 'undefined') {
  const pressed = (target: EventTarget | null) =>
    target instanceof Element
      ? target.closest('button, [role="button"], input[type="submit"], a[href]')
      : null;
  document.addEventListener(
    'click',
    (event) => {
      const element = pressed(event.target);
      if (element !== null && !element.closest('[data-guide-root]')) {
        traces.gesture(element, Date.now());
      }
    },
    { capture: true },
  );
  document.addEventListener(
    'submit',
    (event) => {
      const element = (event as SubmitEvent).submitter ?? event.target;
      if (element instanceof Element) traces.gesture(element, Date.now());
    },
    { capture: true },
  );
}
