// The guide's evidence (docs/architecture.md, "The guide"; ADR 0014): a small store in the page that
// keeps what the visitor's own actions did, as traces. Evidence arrives from sources behind one
// interface: the page's own calls (lib/api.ts), the kitchen socket's frames where the page holds it
// (lib/use-kitchen.ts), the activity feed the console already reads (lib/activity-feed.ts), and,
// later, the server's flight recorder (typed below, not built yet). The store keeps no response
// body: a call is its method, path, status, time and key; an event is its envelope's id, type,
// stream, sequence and cause, which the board already shows. Nothing is stored outside memory.

/** Where a piece of evidence came from. */
export type SourceKind = 'page' | 'socket' | 'feed' | 'recorder';

/** One delivery of an event to a subscriber, as the server's recorder will report it. */
export interface Delivery {
  /** The subscriber, such as "kitchen" or "crm". */
  to: string;
  outcome: 'ok' | 'retry' | 'dead';
  attempt: number;
}

/**
 * What the server's flight recorder will send over its socket for each delivered event: lossy by
 * design, fed by the Queue's consumer after each delivery, never in a command's path. Typed here so
 * the guide's notes are written against it; the source that reads it plugs in when it is built.
 */
export interface RecorderRecord {
  id: string;
  type: string;
  stream: string;
  seq: number;
  cause: string | null;
  recorded_at: string;
  delivered_at: string;
  lag_ms: number;
  deliveries: Delivery[];
}

/** One piece of evidence, whichever source saw it. Times are wall-clock milliseconds. */
export type Evidence =
  | {
      kind: 'call';
      /** The request's Idempotency-Key, or null for a call that sent none. */
      key: string | null;
      method: string;
      /** The path as sent, query string included. */
      path: string;
      /** The answer's status, or null when no answer came (offline, blocked). */
      status: number | null;
      ms: number;
      at: number;
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
    };

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

/** The recorder's record as evidence: the event it delivered, with its lag and deliveries. */
export function fromRecorder(record: RecorderRecord, at: number): Evidence {
  return {
    kind: 'event',
    source: 'recorder',
    id: record.id,
    type: record.type,
    stream: record.stream,
    seq: record.seq,
    cause: record.cause,
    at,
    lagMs: record.lag_ms,
    deliveries: record.deliveries,
  };
}

/**
 * The server's flight recorder, read over a socket. Not built yet: another change adds the
 * per-sandbox recorder and its socket, and this source then parses each message with
 * `fromRecorder` and sends it to the sink. Until then it connects to nothing.
 */
export const recorderSource: TraceSource = {
  kind: 'recorder',
  connect: () => () => undefined,
};

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
/** How many traces and orphan events are kept. */
export const KEEP_TRACES = 20;
const KEEP_ORPHANS = 100;
const KEEP_FEED = 50;

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
  let version = 0;
  let snapshot: TraceSnapshot = { traces, feed, heard, listening, version };
  const owner = new Map<string, string>();
  let orphans: Extract<Evidence, { kind: 'event' }>[] = [];
  let last: Gesture | null = null;
  const anchors = new Map<number, unknown>();
  const listeners = new Set<() => void>();
  const seenFeed = new Map<string, Set<string>>();

  const changed = () => {
    version++;
    snapshot = { traces, feed, heard, listening, version };
    for (const listener of listeners) listener();
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
    last !== null && at - last.at >= 0 && at - last.at <= GESTURE_MS ? last.seq : null;

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
      if (same < 0) return { ...trace, events: [...trace.events, traced] };
      return {
        ...trace,
        events: trace.events.map((e, i) => (i === same ? { ...e, ...traced } : e)),
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
            gesture: gestureFor(evidence.at - evidence.ms),
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
        case 'event':
          if (!attach(evidence)) {
            if (evidence.cause === null || evidence.cause.startsWith('sim:')) return;
            orphans = [...orphans, evidence].slice(-KEEP_ORPHANS);
            return;
          }
          break;
      }
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    gesture(anchor, at) {
      const seq = (last?.seq ?? 0) + 1;
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
