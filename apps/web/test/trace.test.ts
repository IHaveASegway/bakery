// The guide's trace store (src/lib/trace.ts): which evidence belongs to the visitor's action, and
// what a note may call observed. The page's sources push into it; these tests push by hand.
import type { TraceHop } from '../src/contracts';
import { describe, expect, test } from 'vitest';
import {
  GESTURE_MS,
  KEEP_TRACES,
  createTraceStore,
  expectedHops,
  fromHop,
  pushSource,
  type Evidence,
} from '../src/lib/trace';

// Synthetic ids: ULID-shaped, made up for these tests.
// The visitor's request id (its Idempotency-Key), an event it caused and one that event caused.
const SENT = '01JC9A0K3W9QF2N4T7XRB5M0HD';
const EVENT = '01JC9A0K4P2B6Y8C4V1N3K7QZA';
const CHILD = '01JC9A0K5Q2B6Y8C4V1N3K7QZB';
const T0 = Date.parse('2026-11-09T15:00:00Z');

const call = (over: Partial<Extract<Evidence, { kind: 'call' }>> = {}): Evidence => ({
  kind: 'call',
  key: SENT,
  method: 'POST',
  path: '/v1/sandboxes/sbx-one/orders',
  status: 201,
  ms: 84,
  at: T0 + 84,
  ...over,
});
const event = (
  id: string | null,
  type: string,
  cause: string | null,
  over: Partial<Extract<Evidence, { kind: 'event' }>> = {},
): Evidence => ({
  kind: 'event',
  source: 'socket',
  id,
  type,
  stream: 'order:sbx-one:ord-one',
  seq: 1,
  cause,
  at: T0 + 200,
  ...over,
});

/** A recorder hop, as `GET .../trace` gives it; only what a test names differs. */
const hop = (over: Partial<TraceHop> & { deliveries?: TraceHop['deliveries'] } = {}): TraceHop => ({
  id: EVENT,
  type: 'OrderPlaced',
  stream: 'order:sbx-one:ord-one',
  seq: 1,
  cause: SENT,
  at: '2026-11-09T08:00:00-07:00',
  recorded_at: '2026-11-09T15:00:01Z',
  delivered_at: '2026-11-09T15:00:02Z',
  lag_ms: 40,
  attempt: 1,
  deliveries: [{ to: 'Kitchen', outcome: 'delivered' }],
  ...over,
});

describe('correlation: what belongs to the visitor’s action', () => {
  test('a call is a trace keyed by its Idempotency-Key, with its status and time', () => {
    const store = createTraceStore();
    store.record(call());
    const [trace] = store.getSnapshot().traces;
    expect(trace).toMatchObject({
      id: SENT,
      key: SENT,
      method: 'POST',
      status: 201,
      ms: 84,
      outcome: 'ok',
      startedAt: T0,
    });
  });

  test('an event caused by the key joins the trace, and one caused by that event joins too', () => {
    const store = createTraceStore();
    store.record(call());
    store.record(event(EVENT, 'OrderPlaced', SENT, { seq: 1 }));
    store.record(event(CHILD, 'SlotHeld', EVENT, { seq: 4, stream: 'schedule:sbx-one:day' }));
    const [trace] = store.getSnapshot().traces;
    expect(trace?.events.map((e) => [e.type, e.seq])).toEqual([
      ['OrderPlaced', 1],
      ['SlotHeld', 4],
    ]);
  });

  test('a simulated event, or one with an unrelated cause, joins nothing', () => {
    const store = createTraceStore();
    store.record(call());
    store.record(event('sim-evt-one', 'OrderPlaced', 'sim:01JC9A0K6R2B6Y8C4V1N3K7QZC'));
    store.record(event('other-evt', 'OrderPlaced', 'someone-else'));
    store.record(event('no-cause', 'OrderPlaced', null));
    expect(store.getSnapshot().traces[0]?.events).toEqual([]);
  });

  test('an event that arrives before its cause waits, and joins when the cause does', () => {
    const store = createTraceStore();
    // The socket can beat the HTTP answer: the event, then its child, then the call.
    store.record(event(CHILD, 'SlotHeld', EVENT));
    store.record(event(EVENT, 'OrderPlaced', SENT));
    store.record(call());
    expect(store.getSnapshot().traces[0]?.events.map((e) => e.type)).toEqual([
      'OrderPlaced',
      'SlotHeld',
    ]);
  });

  test('a socket command is a trace too: its id is the key, the ack ends it, the event joins', () => {
    const store = createTraceStore();
    store.record({
      kind: 'command',
      key: SENT,
      action: 'start_production',
      order: 'ord-one',
      at: T0,
    });
    store.record({ kind: 'answer', key: SENT, outcome: 'ack', rule: null, at: T0 + 30 });
    store.record(event(EVENT, 'OrderProductionStarted', SENT, { seq: 3 }));
    const [trace] = store.getSnapshot().traces;
    expect(trace).toMatchObject({ transport: 'socket', action: 'start_production', outcome: 'ok' });
    expect(trace?.ms).toBe(30);
    expect(trace?.events[0]).toMatchObject({ type: 'OrderProductionStarted', seq: 3 });
  });

  test('a refused command keeps its rule; an answer to a command never sent changes nothing', () => {
    const store = createTraceStore();
    store.record({ kind: 'command', key: SENT, action: 'mark_ready', order: 'ord-one', at: T0 });
    store.record({ kind: 'answer', key: SENT, outcome: 'nack', rule: 'out-of-order', at: T0 + 9 });
    store.record({ kind: 'answer', key: 'never-sent', outcome: 'ack', rule: null, at: T0 });
    expect(store.getSnapshot().traces).toHaveLength(1);
    expect(store.getSnapshot().traces[0]).toMatchObject({
      outcome: 'refused',
      rule: 'out-of-order',
    });
  });

  test('a call with no answer failed, and a 4xx was refused', () => {
    const store = createTraceStore();
    store.record(call({ key: 'a-key', status: null }));
    store.record(call({ key: 'b-key', status: 409 }));
    expect(store.getSnapshot().traces.map((t) => t.outcome)).toEqual(['refused', 'failed']);
  });

  test('keeps the newest traces only, newest first', () => {
    const store = createTraceStore();
    for (let i = 0; i < KEEP_TRACES + 5; i++) store.record(call({ key: `key-${i}` }));
    const ids = store.getSnapshot().traces.map((t) => t.id);
    expect(ids).toHaveLength(KEEP_TRACES);
    expect(ids[0]).toBe(`key-${KEEP_TRACES + 4}`);
  });
});

describe('the visitor’s own action, and the page’s', () => {
  test('a request that starts within the window after a click is the visitor’s, with its anchor', () => {
    const store = createTraceStore();
    const button = { name: 'Place order' };
    const g = store.gesture(button, T0 - 300);
    store.record(call());
    const [trace] = store.getSnapshot().traces;
    expect(trace?.gesture).toBe(g.seq);
    expect(store.anchorOf(trace?.gesture ?? null)).toBe(button);
  });

  test('a request sent in the click’s own handler is the click’s, though the two clocks round apart', () => {
    const store = createTraceStore();
    // The click's whole-millisecond stamp can land just after the request's measured start.
    const g = store.gesture({}, T0 + 1);
    store.record(call({ key: 'same-ms' }));
    store.gesture({}, T0 + 2_000 + 50);
    store.record(call({ key: 'before-the-click', at: T0 + 2_000 + 84 }));
    expect(store.getSnapshot().traces.map((t) => t.gesture)).toEqual([null, g.seq]);
  });

  test('a request long after the click, or with none, is the page’s own: no gesture', () => {
    const store = createTraceStore();
    store.record(call({ key: 'heartbeat-key' }));
    store.gesture({}, T0 - GESTURE_MS - 1);
    store.record(call());
    expect(store.getSnapshot().traces.map((t) => t.gesture)).toEqual([null, null]);
  });
});

describe('a story read: the menu’s, traced with what its answer said', () => {
  const menuRead = (over: Partial<Extract<Evidence, { kind: 'call' }>> = {}): Evidence =>
    call({
      key: null,
      method: 'GET',
      path: '/v1/sandboxes/sbx-one/menu',
      status: 200,
      read: { name: 'menu', cache: 'miss', etag: '"v1"', asked: null },
      ...over,
    });

  test('one the page made by itself is a note of its own, with its headers', () => {
    const store = createTraceStore();
    store.record(menuRead());
    const [read] = store.getSnapshot().traces;
    expect(read?.gesture).not.toBeNull();
    expect(read?.read).toEqual({ name: 'menu', cache: 'miss', etag: '"v1"', asked: null });
  });

  test('two reads are two notes, and a later click is a new one again', () => {
    const store = createTraceStore();
    store.record(menuRead());
    store.record(
      menuRead({ status: 304, read: { name: 'menu', cache: 'hit', etag: '"v1"', asked: '"v1"' } }),
    );
    const g = store.gesture({}, T0 + 10_000);
    const numbers = store.getSnapshot().traces.map((t) => t.gesture);
    expect(new Set(numbers).size).toBe(2);
    expect(numbers).not.toContain(g.seq);
  });

  test('a page’s other reads are not story reads: no gesture of their own', () => {
    const store = createTraceStore();
    store.record(call({ key: null, method: 'GET', path: '/v1/sandboxes/sbx-one/traffic' }));
    expect(store.getSnapshot().traces[0]?.gesture).toBeNull();
  });
});

describe('the flight recorder’s hops, matched by cause', () => {
  const placed = () => {
    const store = createTraceStore();
    store.gesture({}, T0 - 300);
    store.record(call({ key: SENT }));
    return store;
  };
  const events = (store: ReturnType<typeof createTraceStore>) =>
    store.getSnapshot().traces[0]?.events ?? [];

  test('a key with one event: the hop the command wrote joins its trace', () => {
    const store = placed();
    store.record(fromHop(hop({ id: 'evt-placed', type: 'OrderPlaced', cause: SENT }), T0 + 400));
    expect(events(store).map((e) => e.type)).toEqual(['OrderPlaced']);
  });

  test('a chain of reactions: an event caused by the first joins too, whichever arrives first', () => {
    const store = placed();
    // The reaction's hop arrives before its cause's: it waits, then joins.
    store.record(
      fromHop(hop({ id: 'evt-held', type: 'SlotReserved', cause: 'evt-placed' }), T0 + 500),
    );
    expect(events(store)).toHaveLength(0);
    store.record(fromHop(hop({ id: 'evt-placed', type: 'OrderPlaced', cause: SENT }), T0 + 600));
    expect(events(store).map((e) => e.type)).toEqual(['OrderPlaced', 'SlotReserved']);
  });

  test('a hop that never arrives leaves the event expected, never denied', () => {
    const store = placed();
    const trace = store.getSnapshot().traces[0];
    if (trace === undefined) throw new Error('no trace');
    const hops = expectedHops(['OrderPlaced'], trace);
    expect(hops).toEqual([{ type: 'OrderPlaced', state: 'expected', event: null }]);
  });

  test('two attempts: the later hop’s deliveries stand, whichever order the hops arrive in', () => {
    const store = placed();
    const second = hop({
      id: 'evt-placed',
      type: 'OrderPlaced',
      cause: SENT,
      attempt: 2,
      deliveries: [{ to: 'Kitchen', outcome: 'delivered' }],
    });
    const first = hop({
      id: 'evt-placed',
      type: 'OrderPlaced',
      cause: SENT,
      attempt: 1,
      deliveries: [{ to: 'Kitchen', outcome: 'retried' }],
    });
    store.record(fromHop(second, T0 + 900));
    store.record(fromHop(first, T0 + 950));
    expect(events(store)[0]?.deliveries).toEqual([{ to: 'Kitchen', outcome: 'ok', attempt: 2 }]);
  });

  test('a dead hop is final: no later attempt’s hop takes its place', () => {
    const store = placed();
    store.record(
      fromHop(
        hop({
          id: 'evt-placed',
          type: 'OrderPlaced',
          cause: SENT,
          attempt: 4,
          deliveries: [{ to: 'Kitchen', outcome: 'dead_lettered' }],
        }),
        T0 + 900,
      ),
    );
    store.record(
      fromHop(
        hop({
          id: 'evt-placed',
          type: 'OrderPlaced',
          cause: SENT,
          attempt: 3,
          deliveries: [{ to: 'Kitchen', outcome: 'retried' }],
        }),
        T0 + 950,
      ),
    );
    expect(events(store)[0]?.deliveries).toEqual([{ to: 'Kitchen', outcome: 'dead', attempt: 4 }]);
  });

  test('a hop whose cause is no action of this page is kept aside, never shown', () => {
    const store = placed();
    store.record(fromHop(hop({ id: 'evt-other', type: 'OrderPlaced', cause: 'someone-else' }), T0));
    expect(events(store)).toHaveLength(0);
  });
});

describe('the activity feed: weaker evidence, said as such', () => {
  const entry = (type: string, at: string) => ({ type, at, summary: `${type} happened` });

  test('the first read is a baseline; a later read’s new entries arrive', () => {
    let now = T0;
    const store = createTraceStore({ now: () => now });
    store.feed('sbx-one', [entry('ClockAdvanced', '2026-11-09T14:00:00Z')]);
    expect(store.getSnapshot().feed).toEqual([]);
    now = T0 + 10_000;
    store.feed('sbx-one', [
      entry('FaultSet', '2026-11-09T15:00:05Z'),
      entry('ClockAdvanced', '2026-11-09T14:00:00Z'),
    ]);
    expect(store.getSnapshot().feed).toEqual([{ type: 'FaultSet', arrivedAt: T0 + 10_000 }]);
  });
});

describe('expected against observed', () => {
  test('observed with its sequence, seen in the feed, or still expected', () => {
    const trace = {
      startedAt: T0,
      events: [
        {
          id: EVENT,
          type: 'OrderPlaced',
          stream: 'order:x',
          seq: 1,
          source: 'socket' as const,
          at: T0 + 50,
          cause: SENT,
        },
      ],
    };
    const feed = [
      { type: 'SlotHeld', arrivedAt: T0 + 9_000 },
      { type: 'OrderPaid', arrivedAt: T0 - 60_000 },
    ];
    const hops = expectedHops(['OrderPlaced', 'SlotHeld', 'OrderPaid'], trace, feed);
    expect(hops.map((h) => [h.type, h.state])).toEqual([
      ['OrderPlaced', 'observed'],
      ['SlotHeld', 'seen-in-feed'],
      // Listed before the action began: not evidence of it.
      ['OrderPaid', 'expected'],
    ]);
    expect(hops[0]?.event?.seq).toBe(1);
  });

  test('an observed event the entry did not name is shown after the expected ones', () => {
    const trace = {
      startedAt: T0,
      events: [
        {
          id: CHILD,
          type: 'BakeListChanged',
          stream: 's',
          seq: 7,
          source: 'socket' as const,
          at: T0,
          cause: SENT,
        },
      ],
    };
    expect(expectedHops(['OrderReady'], trace).map((h) => [h.type, h.state])).toEqual([
      ['OrderReady', 'expected'],
      ['BakeListChanged', 'observed'],
    ]);
  });

  test('becomes observed when evidence arrives', () => {
    const store = createTraceStore();
    store.record(call());
    const before = expectedHops(['OrderPlaced'], store.getSnapshot().traces[0]!);
    expect(before[0]?.state).toBe('expected');
    store.record(event(EVENT, 'OrderPlaced', SENT));
    const after = expectedHops(['OrderPlaced'], store.getSnapshot().traces[0]!);
    expect(after[0]?.state).toBe('observed');
  });
});

describe('sources behind one interface', () => {
  test('a push source delivers to the store it is connected to, and stops when disconnected', () => {
    const source = pushSource('page');
    const store = createTraceStore({ sources: [source] });
    source.emit(call({ key: 'first' }));
    expect(store.getSnapshot().traces).toHaveLength(1);
    const other = createTraceStore();
    const stop = source.connect(other);
    stop();
    source.emit(call({ key: 'second' }));
    expect(other.getSnapshot().traces).toHaveLength(0);
    expect(store.getSnapshot().traces).toHaveLength(2);
  });

  test('a recorder hop becomes an event with its lag and deliveries, merged with the socket’s', () => {
    const store = createTraceStore();
    store.record({ kind: 'command', key: SENT, action: 'start_production', order: 'o', at: T0 });
    store.record(event(EVENT, 'OrderProductionStarted', SENT, { seq: 3 }));
    store.record(
      fromHop(
        hop({
          id: EVENT,
          type: 'OrderProductionStarted',
          cause: SENT,
          seq: 3,
          lag_ms: 212,
          deliveries: [
            { to: 'Kitchen', outcome: 'delivered' },
            { to: 'Crm', outcome: 'delivered' },
          ],
        }),
        T0 + 400,
      ),
    );
    const events = store.getSnapshot().traces[0]?.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 3, lagMs: 212, source: 'recorder' });
    expect(events[0]?.deliveries).toEqual([
      { to: 'Kitchen', outcome: 'ok', attempt: 1 },
      { to: 'Crm', outcome: 'ok', attempt: 1 },
    ]);
  });
  test('a listener hears each change, and the snapshot is stable between changes', () => {
    const store = createTraceStore();
    let heard = 0;
    const stop = store.subscribe(() => heard++);
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.record(call());
    expect(heard).toBe(1);
    expect(store.getSnapshot()).not.toBe(first);
    stop();
    store.clear();
    expect(heard).toBe(1);
  });
});

describe('a page watching an order: what it heard and how it listens', () => {
  test('a heard event is kept once, newest first, apart from the traces', () => {
    const store = createTraceStore();
    const heard = (id: string, seq: number) =>
      ({
        kind: 'heard',
        id,
        type: 'OrderProductionStarted',
        stream: 'order:sbx-one:ord-one',
        seq,
        cause: 'staff-cmd',
        at: T0 + seq,
      }) as const;
    store.record(heard('evt-a', 3));
    store.record(heard('evt-a', 3));
    store.record(heard('evt-b', 4));
    expect(store.getSnapshot().heard.map((h) => h.seq)).toEqual([4, 3]);
    expect(store.getSnapshot().traces).toEqual([]);
  });

  test('how it listens is kept as it changes, and a repeat is no news', () => {
    const store = createTraceStore();
    let heardChanges = 0;
    store.subscribe(() => heardChanges++);
    store.record({ kind: 'listening', how: 'socket', why: null, at: T0 });
    store.record({ kind: 'listening', how: 'socket', why: null, at: T0 + 5 });
    store.record({ kind: 'listening', how: 'reading', why: 'yielded', at: T0 + 9 });
    expect(heardChanges).toBe(2);
    expect(store.getSnapshot().listening).toEqual({ how: 'reading', why: 'yielded', at: T0 + 9 });
  });
});

describe('the cap on a trace’s events never breaks the one rule', () => {
  test('a thirteenth event of a type the action expects is observed by the note and tied in the panel', () => {
    const store = createTraceStore();
    store.gesture(null, T0);
    store.record(call());
    // Twelve reactions first (as a published menu's CapsRefreshed, one a day), then the event the
    // action itself is waited for on.
    for (let i = 0; i < 12; i++) {
      store.record(
        fromHop(
          hop({
            id: `01JC9A0K6R2B6Y8C4V1N3K7Q${String(i).padStart(2, 'A')}`,
            type: 'CapsRefreshed',
            cause: SENT,
          }),
          T0 + 300,
        ),
      );
    }
    const LATE = '01JC9A0K7S2B6Y8C4V1N3K7QZZ';
    store.record(fromHop(hop({ id: LATE, type: 'OrderPlaced', cause: SENT }), T0 + 400));
    const snap = store.getSnapshot();
    const [trace] = snap.traces;
    expect(expectedHops(['OrderPlaced'], trace!).find((h) => h.type === 'OrderPlaced')?.state).toBe(
      'observed',
    );
    expect(snap.hops.find((h) => h.id === LATE)?.trace).toBe(SENT);
    // No hop the trace owns is listed as nobody's.
    expect(snap.hops.filter((h) => h.cause === SENT && h.trace === null)).toEqual([]);
  });
});
