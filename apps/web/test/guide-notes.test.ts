// The guide's live notes: which route a request was, which entry explains it, where the note sits,
// what its chain says (observed against expected), the one sentence a screen reader hears, and
// the short path's steps. The trace store's correlation is trace.test.ts's.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Note, resolveAnchor } from '../src/components/guide/Note';
import { byGesture } from '../src/components/guide/Panel';
import {
  expectedFor,
  gesturesIn,
  newestWatchNews,
  noteToOpen,
  routeIdOf,
  watchKeysBefore,
  watchToOpen,
} from '../src/components/guide/match';
import {
  TraceChain,
  WatchChain,
  WhyLines,
  listeningText,
  objectOf,
  readSentence,
  requestText,
  shortPath,
  traceSentence,
  watchSentence,
} from '../src/components/guide/Views';
import { ALL_ENTRIES, PATHS, ROUTE_SHAPES } from '../src/guide';
import {
  PATH_CLOSED,
  pathReduce,
  pickEntry,
  placeNote,
  placeSpot,
  routeMatcher,
  switchOn,
  type GuideEntry,
} from '../src/lib/guide';
import type { Trace } from '../src/lib/trace';

const entry = (id: string): GuideEntry => ALL_ENTRIES.find((e) => e.id === id)!;
const T0 = Date.parse('2026-11-09T15:00:00Z');
// The visitor's request id (its Idempotency-Key), a made-up ULID.
const SENT = '01JC9A0K3W9QF2N4T7XRB5M0HZ';
const trace = (over: Partial<Trace> = {}): Trace => ({
  id: 'req-one',
  key: SENT,
  gesture: 1,
  transport: 'http',
  method: 'POST',
  path: '/v1/sandboxes/sbx-one/orders',
  action: null,
  order: null,
  status: 201,
  ms: 84,
  outcome: 'ok',
  rule: null,
  startedAt: T0,
  events: [],
  ...over,
});
const command = (over: Partial<Trace> = {}) =>
  trace({
    transport: 'socket',
    method: 'WS',
    path: 'cmd',
    action: 'start_production',
    order: 'ord-one',
    status: null,
    ms: 30,
    ...over,
  });

describe('which route a request was', () => {
  const routeOf = routeMatcher(ROUTE_SHAPES);

  test('a concrete path matches its template, and a literal segment beats a parameter', () => {
    expect(routeOf('POST', '/v1/sandboxes/sbx-one/orders')).toBe('place-order');
    expect(routeOf('POST', '/v1/sandboxes/sbx-one/orders/ord-one/payment')).toBe('pay');
    expect(routeOf('POST', '/v1/sandboxes/sbx-one/menu/publish')).toBe('publish-menu');
    expect(routeOf('PATCH', '/v1/sandboxes/sbx-one/menu/items/country-loaf')).toBe(
      'patch-menu-item',
    );
    expect(routeOf('PATCH', '/v1/sandboxes/sbx-one/menu/tax-rate')).toBe('set-tax-rate');
    expect(routeOf('DELETE', '/v1/sandboxes/sbx-one')).toBe('wipe-sandbox');
    expect(routeOf('POST', '/v1/sandboxes')).toBe('create-sandbox');
    expect(routeOf('POST', '/v1/sandboxes/sbx-one/token/rotate')).toBe('rotate-token');
  });

  test('the method counts, a query string does not, and an unknown path is null', () => {
    expect(routeOf('DELETE', '/v1/sandboxes/sbx-one/traffic')).toBe('stop-traffic');
    expect(routeOf('POST', '/v1/sandboxes/sbx-one/traffic?rate=3')).toBe('start-traffic');
    expect(routeOf('POST', '/v1/nowhere')).toBeNull();
  });

  test('a socket command is the kitchen socket', () => {
    expect(routeIdOf(command())).toBe('kitchen-socket');
    expect(routeIdOf(trace())).toBe('place-order');
  });
});

describe('which entry explains it', () => {
  test('a route’s entry on this screen first: placing an order at checkout is the order form', () => {
    expect(pickEntry(ALL_ENTRIES, 'checkout', 'place-order', [])?.id).toBe('checkout-form');
  });

  test('the same route on another screen picks that screen’s entry', () => {
    expect(pickEntry(ALL_ENTRIES, 'privacy', 'wipe-sandbox', [])?.id).toBe('privacy-wipe');
    expect(pickEntry(ALL_ENTRIES, 'console', 'wipe-sandbox', [])?.id).toBe('controls-wipe');
  });

  test('a board command is the kitchen board, and an event type finds an entry with no route', () => {
    expect(pickEntry(ALL_ENTRIES, 'console', 'kitchen-socket', [])?.id).toBe('kitchen-board');
    expect(pickEntry(ALL_ENTRIES, 'console', null, ['CampaignSent'])?.id).toBe(
      'crm-campaign-schedule',
    );
    expect(pickEntry(ALL_ENTRIES, 'console', 'heartbeat', [])).toBeNull();
  });

  test('among entries on one screen, the one whose element holds the press wins', () => {
    const inMenu = (target: string) => target === 'controls-menu';
    expect(pickEntry(ALL_ENTRIES, 'console', 'publish-menu', [], inMenu)?.id).toBe(
      'controls-menu-publish',
    );
  });

  test('a board command expects its one event; any other action its entry’s events', () => {
    const board = entry('kitchen-board');
    expect(expectedFor(board, [command()])).toEqual(['OrderProductionStarted']);
    expect(expectedFor(board, [command({ action: 'mark_ready' })])).toEqual(['OrderReady']);
    expect(expectedFor(entry('checkout-form'), [trace()])).toEqual(['OrderPlaced', 'SlotHeld']);
    expect(expectedFor(null, [trace()])).toEqual([]);
  });
});

describe('where a note sits', () => {
  const view = { width: 1440, height: 836 };
  const note = { width: 344, height: 300 };

  test('never over the masthead or the top bar: beside, above or docked, its top is under the bar', () => {
    const masthead = { ...view, top: 64 };
    // Beside an anchor near the top: clamped under the bar, not to the window's edge.
    const beside = placeNote({ top: 70, left: 430, width: 160, height: 44 }, note, masthead);
    expect(beside.side).toBe('left');
    expect(beside.top).toBe(64 + 8);
    // Docked (an anchor as wide and tall as the window): the top corners are under the bar too.
    const big = placeNote({ top: 60, left: 0, width: 1440, height: 776 }, note, masthead);
    expect(big.side).toBe('none');
    expect(big.top).toBeGreaterThanOrEqual(64 + 8);
    // With no room above under the bar, the note goes below its anchor instead of above.
    const narrow = { width: 500, height: 836, top: 64 };
    const low = placeNote({ top: 380, left: 20, width: 460, height: 40 }, note, narrow);
    expect(low.side).toBe('top');
  });

  test('to the right of its anchor when it fits, the caret at the anchor’s middle', () => {
    const at = placeNote({ top: 400, left: 430, width: 160, height: 44 }, note, view);
    expect(at.side).toBe('left');
    expect(at.left).toBe(430 + 160 + 12);
    expect(at.top + at.caret).toBe(422);
  });

  test('to the left when the right has no room', () => {
    const at = placeNote({ top: 400, left: 1200, width: 200, height: 44 }, note, view);
    expect(at.side).toBe('right');
    expect(at.left + note.width).toBe(1200 - 12);
  });

  test('below, then above, when neither side fits, kept inside the window', () => {
    const narrow = { width: 500, height: 836 };
    const wide = { top: 100, left: 20, width: 460, height: 40 };
    const below = placeNote(wide, note, narrow);
    expect(below.side).toBe('top');
    expect(below.top).toBe(152);
    const above = placeNote({ ...wide, top: 700 }, note, narrow);
    expect(above.side).toBe('bottom');
    expect(above.top + note.height).toBe(688);
    for (const at of [below, above]) {
      expect(at.left).toBeGreaterThanOrEqual(8);
      expect(at.left + note.width).toBeLessThanOrEqual(492);
    }
  });

  test('an anchor near the window’s edge keeps the note inside and the caret on the note', () => {
    const at = placeNote({ top: 820, left: 300, width: 100, height: 30 }, note, view);
    expect(at.top + note.height).toBeLessThanOrEqual(view.height - 8);
    expect(at.caret).toBeGreaterThanOrEqual(16);
    expect(at.caret).toBeLessThanOrEqual(note.height - 16);
  });

  test('never over its anchor: with no room on any side it docks in a corner clear of it', () => {
    // A full-width shell with little margin: no side, nor above or below, has room for the note.
    const card = { top: 120, left: 60, width: 1020, height: 640 };
    const docked = placeNote(card, note, view);
    expect(docked.side).toBe('none');
    expect(docked.left).toBeGreaterThanOrEqual(card.left + card.width);
    // A card reaching the right edge: the dock goes to the left corner instead.
    const edge = { top: 120, left: 355, width: 1085, height: 640 };
    const left = placeNote(edge, note, view);
    expect(left.side).toBe('none');
    expect(left.left + note.width).toBeLessThanOrEqual(edge.left);
    // A narrow window where every corner meets the card: the corner that covers least of it, and
    // the page is never scrolled for the note.
    const small = { width: 900, height: 736 };
    const tall = { top: 224, left: 145, width: 613, height: 266 };
    const docked2 = placeNote(tall, note, small);
    expect(docked2.side).toBe('none');
    expect(docked2).not.toHaveProperty('scroll');
    expect(docked2.top).toBe(small.height - note.height - 8);
    // A wide card with room below it: below, not over.
    const wideCard = { top: 100, left: 40, width: 1360, height: 200 };
    const at = placeNote(wideCard, note, view);
    expect(at.side).toBe('top');
    expect(at.top).toBeGreaterThanOrEqual(wideCard.top + wideCard.height);
  });

  test('wherever it sits, the note’s box and its anchor’s never overlap', () => {
    const boxes = [
      { top: 10, left: 10, width: 200, height: 40 },
      { top: 400, left: 700, width: 300, height: 300 },
      { top: 780, left: 1300, width: 120, height: 40 },
      { top: 300, left: 100, width: 1240, height: 100 },
      { top: 0, left: 0, width: 1440, height: 836 },
    ];
    for (const a of boxes) {
      const at = placeNote(a, note, view);
      // A box that fills the window leaves nowhere clear; every other one is never covered.
      if (a.width === view.width && a.height === view.height) continue;
      const apart =
        at.left >= a.left + a.width ||
        at.left + note.width <= a.left ||
        at.top >= a.top + a.height ||
        at.top + note.height <= a.top;
      expect(apart, JSON.stringify(a)).toBe(true);
    }
  });

  test('with no page to look at, there is no anchor: the note goes to its corner', () => {
    expect(resolveAnchor(null, [() => null])).toBeNull();
  });
});

describe('what a note says', () => {
  test('a path reads with the sandbox folded and a template’s parameters named', () => {
    expect(shortPath('/v1/sandboxes/sbx-one/orders')).toBe('…/orders');
    expect(shortPath('/v1/sandboxes/{id}/orders/{oid}/payment')).toBe('…/orders/{oid}/payment');
    expect(shortPath('/v1/sandboxes/sbx-one')).toBe('…/{sandbox}');
    expect(shortPath('/v1/auth/demo/signin?x=1')).toBe('/v1/auth/demo/signin');
    // A long id is cut to its last six characters, as the board shows an order.
    expect(shortPath('/v1/sandboxes/sbx-one/orders/01M7147F8NS3XVXVF39FM6TZ92/payment')).toBe(
      '…/orders/…FM6TZ92/payment'.replace('…FM6TZ92', '…M6TZ92'),
    );
  });

  test('a stream names the object that decided it', () => {
    expect(objectOf('order:sbx-one:ord-one')).toBe('Order');
    expect(objectOf('catering-event:sbx:c1')).toBe('CateringEvent');
    expect(objectOf(null)).toBeNull();
  });

  test('a request is its method, path and status; a frame its action and answer', () => {
    expect(requestText(trace())).toEqual({
      sent: 'POST …/orders',
      answer: '201',
    });
    expect(requestText(trace({ status: null, outcome: 'failed' })).answer).toBe('no answer');
    expect(requestText(command())).toEqual({ sent: 'cmd start_production', answer: 'ack' });
    expect(requestText(command({ outcome: 'refused', rule: 'out-of-order' })).answer).toBe(
      'nack out-of-order',
    );
    expect(requestText(command({ outcome: 'pending' })).answer).toBe('waiting');
  });

  test('a screen reader hears one sentence: what was sent, what came back, how long', () => {
    const http = traceSentence(trace(), entry('checkout-form'));
    expect(http).toBe('Under the hood. Placing the order: POST …/orders answered 201 in 84 ms.');
    const socket = traceSentence(command(), entry('kitchen-board'));
    expect(socket).toContain('the start production command went over the kitchen socket');
    expect(socket).toContain('the Kitchen accepted it');
    for (const said of [http, socket]) expect(said.split('. ').length).toBeLessThanOrEqual(2);
  });

  test('the chain names the frame, the event that came back with its sequence, and what is still expected', () => {
    const sent = command({
      events: [
        {
          id: 'evt-one',
          type: 'OrderProductionStarted',
          stream: 'order:sbx-one:ord-one',
          seq: 3,
          source: 'socket',
          at: T0 + 40,
          cause: 'req-one',
        },
      ],
    });
    const html = renderToStaticMarkup(
      createElement(TraceChain, {
        traces: [sent],
        expected: ['OrderProductionStarted', 'BakeListChanged'],
        feed: [],
      }),
    );
    expect(html).toContain('cmd start_production');
    expect(html).toContain('>ack<');
    expect(html).toContain('by the Order object');
    expect(html).toMatch(/data-state="observed".*OrderProductionStarted.*seq 3/s);
    expect(html).toMatch(/data-state="expected".*BakeListChanged.*expected/s);
    expect(html).not.toContain('style=');
  });

  test('an event the activity feed listed after the action is shown as seen in the feed', () => {
    const html = renderToStaticMarkup(
      createElement(TraceChain, {
        traces: [trace({ path: '/v1/sandboxes/sbx-one/clock' })],
        expected: ['ClockAdvanced'],
        feed: [{ type: 'ClockAdvanced', arrivedAt: T0 + 9_000 }],
      }),
    );
    expect(html).toContain('data-state="seen-in-feed"');
    expect(html).toContain('in the activity feed');
  });

  test('why and when not are both said, with the essay to read', () => {
    const html = renderToStaticMarkup(createElement(WhyLines, { entry: entry('kitchen-board') }));
    expect(html).toContain('Why this tool');
    expect(html).toContain('two tabs cannot disagree and nothing needs a lock');
    expect(html).toContain('When not');
    expect(html).toContain('that needs a projection');
    expect(html).toContain('href="/how-its-built/single-writer/"');
  });
});

describe('where a hotspot sits', () => {
  const view = { width: 1440, height: 900 };
  const topBar = { top: 0, left: 0, width: 1440, height: 56 };

  test('outside its target’s top-right corner, or above its right end on a narrow window', () => {
    expect(placeSpot({ top: 200, left: 300, width: 400, height: 80 }, view, [topBar])).toEqual({
      top: 200,
      left: 708,
    });
    const phone = { width: 390, height: 844 };
    expect(placeSpot({ top: 200, left: 16, width: 358, height: 80 }, phone, [])).toEqual({
      top: 172,
      left: 350,
    });
  });

  test('not drawn under the top bar, the masthead or past the window, never pushed onto a bar', () => {
    // A target scrolled up under the console's sticky top bar.
    expect(placeSpot({ top: 20, left: 300, width: 400, height: 300 }, view, [topBar])).toBeNull();
    // A target above the window, or below it.
    expect(placeSpot({ top: -400, left: 300, width: 400, height: 80 }, view, [])).toBeNull();
    expect(placeSpot({ top: 890, left: 300, width: 400, height: 80 }, view, [])).toBeNull();
  });

  test('not drawn on a phone’s tab bar, its cart bar or the guide’s dock', () => {
    const phone = { width: 390, height: 844 };
    const tabBar = { top: 784, left: 0, width: 390, height: 60 };
    const cartBar = { top: 700, left: 16, width: 358, height: 48 };
    // The bake list's card starts just under the fold's tab bar: its mark would sit on "More".
    expect(placeSpot({ top: 806, left: 16, width: 358, height: 200 }, phone, [tabBar])).toBeNull();
    expect(placeSpot({ top: 720, left: 16, width: 358, height: 200 }, phone, [cartBar])).toBeNull();
    // Scrolled into the open part of the window, it is drawn.
    expect(
      placeSpot({ top: 400, left: 16, width: 358, height: 200 }, phone, [tabBar, cartBar]),
    ).toEqual({
      top: 372,
      left: 350,
    });
  });
});

describe('what a story read’s note says', () => {
  const read = (status: number, cache: string | null, asked: string | null = null) =>
    trace({
      key: null,
      method: 'GET',
      path: '/v1/sandboxes/sbx-one/menu',
      status,
      read: { name: 'menu', cache, etag: '"v3"', asked },
    });

  test('served from the cache, or the object answered and filled it, with the ETag it saw', () => {
    expect(readSentence(read(200, 'hit'))).toMatch(/^Served from the cache.*"v3"/);
    expect(readSentence(read(200, 'miss'))).toMatch(
      /^The Catalog object answered and the cache was filled.*"v3"/,
    );
    expect(readSentence(read(200, null))).toContain('no Bakery-Cache header');
  });

  test('asked again with the ETag: current, 304, no body', () => {
    expect(readSentence(read(304, 'hit', '"v3"'))).toBe(
      'This page’s copy was current: it sent If-None-Match "v3", and the API answered 304 with no body.',
    );
  });

  test('the chain shows the headers it carried', () => {
    const html = renderToStaticMarkup(
      createElement(TraceChain, { traces: [read(304, 'hit', '"v3"')], expected: [], feed: [] }),
    );
    expect(html).toContain('Bakery-Cache: hit');
    expect(html).toContain('ETag: &quot;v3&quot;');
    expect(html).toContain('If-None-Match: &quot;v3&quot;');
  });
});

describe('a note is not a dialog', () => {
  test('it is a named region that takes no focus and carries no style in its markup', () => {
    const html = renderToStaticMarkup(
      createElement(Note, {
        id: 'guide-live',
        anchor: () => null,
        label: 'Under the hood: The kitchen board',
        pinned: false,
        changed: 1,
        onClose: () => undefined,
        children: 'body',
      }),
    );
    expect(html).toMatch(/^<section id="guide-live" class="guide-note"/);
    expect(html).toContain('aria-label="Under the hood: The kitchen board"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('style=');
  });
});

describe('the recorder’s rows', () => {
  test('group the visitor’s requests by the click that made them, newest click first', () => {
    const groups = byGesture([
      trace({ id: 'c', gesture: 2 }),
      trace({ id: 'b', gesture: 1 }),
      trace({ id: 'a', gesture: 1 }),
      trace({ id: 'heartbeat', gesture: null }),
    ]);
    expect(groups.map((g) => g.map((t) => t.id))).toEqual([['c'], ['a', 'b']]);
  });
});

describe('the short path', () => {
  const steps = PATHS.console ?? [];

  test('waits at each step for its own thing, and moves on when it is done', () => {
    let state = pathReduce(PATH_CLOSED, { type: 'start' }, steps);
    expect(state).toEqual({ open: true, index: 0 });
    state = pathReduce(state, { type: 'done', entry: 'controls-clock' }, steps);
    expect(state.index).toBe(0);
    state = pathReduce(state, { type: 'done', entry: 'kitchen-board' }, steps);
    expect(state.index).toBe(1);
  });

  test('can be skipped, ends after its last step, and ends at once on Escape', () => {
    let state = pathReduce(PATH_CLOSED, { type: 'start' }, steps);
    for (let i = 0; i < steps.length; i++) state = pathReduce(state, { type: 'skip' }, steps);
    expect(state.open).toBe(false);
    state = pathReduce(pathReduce(PATH_CLOSED, { type: 'start' }, steps), { type: 'end' }, steps);
    expect(state.open).toBe(false);
    expect(pathReduce(PATH_CLOSED, { type: 'start' }, []).open).toBe(false);
  });
});

describe('the switch', () => {
  test('is on unless the tab stored off', () => {
    expect(switchOn(null)).toBe(true);
    expect(switchOn('on')).toBe(true);
    expect(switchOn('garbage')).toBe(true);
    expect(switchOn('off')).toBe(false);
  });
});

describe('when a live note opens', () => {
  const action = (gesture: number | null, id = `t-${gesture}`) => trace({ id, gesture });

  test('the newest action made by a click opens one, once', () => {
    const seen = new Set<number>();
    expect(noteToOpen([action(2), action(1)], seen, { on: true, panel: false })).toBe(2);
    expect(noteToOpen([action(2), action(1)], seen, { on: true, panel: false })).toBeNull();
  });

  test('with the recorder open, the action is the panel’s row and no note opens, even after it closes', () => {
    const seen = new Set<number>();
    expect(noteToOpen([action(3)], seen, { on: true, panel: true })).toBeNull();
    expect(noteToOpen([action(3)], seen, { on: true, panel: false })).toBeNull();
    // A new action once the panel is closed opens a note again.
    expect(noteToOpen([action(4), action(3)], seen, { on: true, panel: false })).toBe(4);
  });

  test('with the guide off nothing opens, and turning it on does not open the old action', () => {
    const seen = new Set<number>();
    expect(noteToOpen([action(5)], seen, { on: false, panel: false })).toBeNull();
    expect(noteToOpen([action(5)], seen, { on: true, panel: false })).toBeNull();
  });

  test('a layer that mounts late treats old actions as seen, and a press just before it as new', () => {
    const later = T0 + 60_000;
    const seen = gesturesIn([action(7), action(null, 'heartbeat'), action(6)], later);
    expect([...seen].sort()).toEqual([6, 7]);
    expect(noteToOpen([action(7)], seen, { on: true, panel: false })).toBeNull();
    // The layer loaded a second after the visitor pressed Place order: that press opens its note.
    const quick = gesturesIn([action(8)], T0 + 1_000);
    expect(quick.size).toBe(0);
    expect(noteToOpen([action(8)], quick, { on: true, panel: false })).toBe(8);
  });

  test('the page’s own calls (no click) never open one', () => {
    expect(noteToOpen([action(null, 'beat')], new Set(), { on: true, panel: false })).toBeNull();
  });

  test('a story read is never old news: the menu’s first load opens its note however late the layer comes', () => {
    const menu = trace({
      id: 'menu-read',
      key: null,
      gesture: 9,
      method: 'GET',
      path: '/v1/sandboxes/sbx-one/menu',
      status: 200,
      read: { name: 'menu', cache: 'miss', etag: '"v1"', asked: null },
    });
    const seen = gesturesIn([menu], T0 + 60_000);
    expect(seen.size).toBe(0);
    expect(noteToOpen([menu], seen, { on: true, panel: false })).toBe(9);
  });
});

describe('the order page’s note: what it heard and how it listens', () => {
  const heard = (id: string, at: number, seq = 3) => ({
    id,
    type: 'OrderProductionStarted',
    stream: 'order:sbx-one:ord-one',
    seq,
    cause: 'staff-cmd',
    at,
  });

  test('an event heard about the order opens a note, once', () => {
    const seen = new Set<string>();
    const news = watchToOpen([heard('evt-a', T0)], null, seen, { on: true, panel: false });
    expect(news).toMatchObject({ kind: 'heard', event: { seq: 3 } });
    expect(watchToOpen([heard('evt-a', T0)], null, seen, { on: true, panel: false })).toBeNull();
  });

  test('giving the socket up for a read every 10 seconds is news of its own, newer than the last event', () => {
    const reading = { how: 'reading' as const, why: 'yielded' as const, at: T0 + 50 };
    const news = newestWatchNews([heard('evt-a', T0)], reading);
    expect(news?.kind).toBe('reading');
    expect(newestWatchNews([heard('evt-b', T0 + 99)], reading)?.kind).toBe('heard');
    expect(
      newestWatchNews([], { how: 'socket', why: null, at: T0 }),
      'listening on the socket is not news',
    ).toBeNull();
  });

  test('nothing opens with the recorder open or the guide off, nor late after', () => {
    const seen = new Set<string>();
    expect(watchToOpen([heard('evt-a', T0)], null, seen, { on: true, panel: true })).toBeNull();
    expect(watchToOpen([heard('evt-a', T0)], null, seen, { on: true, panel: false })).toBeNull();
  });

  test('what was heard well before the layer mounted is old news', () => {
    const seen = watchKeysBefore(
      [heard('evt-old', T0), heard('evt-new', T0 + 59_000)],
      null,
      T0 + 60_000,
    );
    expect([...seen]).toEqual(['heard:evt-old']);
  });

  test('the listening line says why the page reads instead, and the sentence names the event and its sequence', () => {
    expect(listeningText({ how: 'socket', why: null, at: T0 })).toContain('sends nothing');
    expect(listeningText({ how: 'reading', why: 'yielded', at: T0 })).toContain(
      'the board reported four sockets open, so this page gave its own up',
    );
    expect(listeningText({ how: 'reading', why: 'limit', at: T0 })).toContain('refused a fifth');
    expect(listeningText({ how: 'reading', why: 'unavailable', at: T0 })).toContain(
      'Reading every 10 seconds',
    );
    expect(watchSentence(heard('evt-a', T0), null)).toBe(
      'Under the hood. Heard OrderProductionStarted, event 3 of the Order object, over the kitchen’s socket.',
    );
  });

  test('the chain shows the event heard with its sequence, and how the page listens', () => {
    const html = renderToStaticMarkup(
      createElement(WatchChain, {
        heard: heard('evt-a', T0, 4),
        listening: { how: 'socket', why: null, at: T0 },
      }),
    );
    expect(html).toContain('evt OrderProductionStarted');
    expect(html).toContain('seq 4 on Order');
    expect(html).toContain('listening only');
    expect(html).not.toContain('style=');
  });
});
