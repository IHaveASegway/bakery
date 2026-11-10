import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { CardView, commandText } from '../src/components/KitchenBoard';
import GuestNote from '../src/components/GuestNote';
import {
  EMPTY_BOARD,
  FEED_MAX,
  actionFor,
  applyEvent,
  backoffMs,
  boardFromSnapshot,
  commandFrame,
  groupByState,
  isSimulated,
  parseFrame,
  pushFeed,
  routeWords,
  type BoardState,
  type Card,
  type Envelope,
} from '../src/lib/kitchen';
import { kitchenSocketUrl } from '../src/lib/api';

const ORDER = '01JC8Z5R0T2B6Y8C4V1N3K7QXE';

const envelope = (seq: number, type: string, data = {}, cause: string | null = null): Envelope => ({
  id: `01JC8Z6K3W9QF2N4T7XRB5M${String(seq).padStart(3, '0')}`,
  stream: `order:01JC8YV2D4QK7S1M9E3PZ6W8AN:${ORDER}`,
  seq,
  type,
  at: '2026-11-07T12:12:10-07:00',
  recorded_at: '2026-11-04T19:12:10.318Z',
  cause,
  data,
});

const placed = (cause: string | null = null) =>
  envelope(
    1,
    'OrderPlaced',
    {
      kind: 'pickup',
      slot: '2026-11-07T09:45:00-07:00',
      lines: [{ item: 'country-loaf', variant: 'country-loaf/whole', qty: 2, unit_cents: 950 }],
      note: '<b>crusty</b>',
    },
    cause,
  );

describe('frames', () => {
  test('a cmd frame carries the ULID id, the order and the action', () => {
    expect(JSON.parse(commandFrame('01JC8Z6K3W9QF2N4T7XRB5M0HD', ORDER, 'mark_ready'))).toEqual({
      t: 'cmd',
      v: 1,
      id: '01JC8Z6K3W9QF2N4T7XRB5M0HD',
      order: ORDER,
      action: 'mark_ready',
    });
  });

  test('reads presence, bye, ack and nack', () => {
    expect(parseFrame('{"t":"presence","v":1,"sockets":2}')).toEqual({ t: 'presence', sockets: 2 });
    expect(parseFrame('{"t":"bye","v":1,"reason":"wiped"}')).toEqual({ t: 'bye', reason: 'wiped' });
    expect(parseFrame('{"t":"ack","v":1,"id":"X"}')).toEqual({ t: 'ack', id: 'X' });
    expect(parseFrame('{"t":"nack","v":1,"id":"X","rule":"out-of-order"}')).toEqual({
      t: 'nack',
      id: 'X',
      rule: 'out-of-order',
    });
  });

  test('ignores what is not a v1 frame', () => {
    expect(parseFrame('nope')).toBeNull();
    expect(parseFrame('{"t":"presence","v":2,"sockets":1}')).toBeNull();
    expect(parseFrame('{"t":"mystery","v":1}')).toBeNull();
    expect(parseFrame('{"t":"evt","v":1,"env":{}}')).toBeNull();
    expect(parseFrame('[]')).toBeNull();
  });

  test('the socket is on the API origin with ws: or wss:', () => {
    expect(kitchenSocketUrl('01JC8YV2D4QK7S1M9E3PZ6W8AN')).toMatch(
      /^wss?:\/\/[^/]+\/v1\/sandboxes\/01JC8YV2D4QK7S1M9E3PZ6W8AN\/kitchen\/ws$/,
    );
  });
});

describe('the snapshot', () => {
  const card = {
    order: ORDER,
    state: 'confirmed',
    lines: [{ variant: 'country-loaf/whole', qty: 2 }],
    note: null,
    slot: '2026-11-07T09:45:00-07:00',
    kind: 'pickup',
    updated_seq: 2,
  };

  test.each([
    ['a list', [card]],
    ['{cards: list}', { cards: [card] }],
    ['{cards: map}', { cards: { [ORDER]: { ...card, order: undefined } } }],
  ])('takes %s of cards', (_name, raw) => {
    const frame = parseFrame(JSON.stringify({ t: 'snapshot', v: 1, board: raw, seq: 9 }));
    expect(frame?.t).toBe('snapshot');
    if (frame?.t !== 'snapshot') return;
    expect(Object.keys(frame.board.cards)).toEqual([ORDER]);
    expect(frame.board.cards[ORDER]?.state).toBe('confirmed');
    expect(frame.board.heads[ORDER]).toBe(2);
    expect(frame.seq).toBe(9);
  });

  test('drops a card in a state the board does not draw', () => {
    expect(boardFromSnapshot([{ ...card, state: 'picked_up' }]).cards).toEqual({});
  });
});

describe('events folded into the board', () => {
  test('a placed order is a pending card with its lines and note, and the event cause', () => {
    const board = applyEvent(EMPTY_BOARD, placed('sim:01JC8Z7AAAAAAAAAAAAAAAAAAA'));
    const card = board.cards[ORDER] as Card;
    expect(card.state).toBe('pending');
    expect(card.lines).toEqual([{ variant: 'country-loaf/whole', qty: 2 }]);
    expect(card.note).toBe('<b>crusty</b>'); // kept as text; rendering never makes markup of it
    expect(card.cause).toBe('sim:01JC8Z7AAAAAAAAAAAAAAAAAAA');
    expect(isSimulated(card.cause)).toBe(true);
  });

  test('an order moves through the board and leaves when picked up', () => {
    let board = applyEvent(EMPTY_BOARD, placed());
    board = applyEvent(board, envelope(2, 'OrderPaid'));
    expect(board.cards[ORDER]?.state).toBe('confirmed');
    board = applyEvent(board, envelope(3, 'OrderProductionStarted', {}, 'cmd-1'));
    expect(board.cards[ORDER]?.state).toBe('in_production');
    expect(board.cards[ORDER]?.cause).toBe('cmd-1');
    board = applyEvent(board, envelope(4, 'OrderReady'));
    expect(board.cards[ORDER]?.state).toBe('ready');
    board = applyEvent(board, envelope(5, 'OrderPickedUp'));
    expect(board.cards[ORDER]).toBeUndefined();
    expect(board.heads[ORDER]).toBe(5);
  });

  test('a stale or repeated event changes nothing', () => {
    let board = applyEvent(EMPTY_BOARD, placed());
    board = applyEvent(board, envelope(2, 'OrderPaid'));
    const same = applyEvent(board, envelope(2, 'OrderPaid'));
    expect(same).toBe(board);
    expect(applyEvent(board, envelope(1, 'OrderPlaced'))).toBe(board);
  });

  test('an event for an order with no card is ignored, and so is an unrelated stream', () => {
    expect(applyEvent(EMPTY_BOARD, envelope(2, 'OrderPaid'))).toBe(EMPTY_BOARD);
    expect(applyEvent(EMPTY_BOARD, { ...placed(), stream: 'catalog:x' })).toBe(EMPTY_BOARD);
  });

  test('cards are grouped by state in the board order, empty columns kept', () => {
    const board = applyEvent(applyEvent(EMPTY_BOARD, placed()), envelope(2, 'OrderPaid'));
    const groups = groupByState(board);
    expect(groups.map((g) => g.state)).toEqual([
      'pending',
      'confirmed',
      'in_production',
      'ready',
      'out_for_delivery',
    ]);
    expect(groups.map((g) => g.cards.length)).toEqual([0, 1, 0, 0, 0]);
  });
});

describe('staff actions', () => {
  const base: Card = {
    order: ORDER,
    state: 'confirmed',
    lines: [],
    note: null,
    slot: '',
    kind: 'pickup',
    updated_seq: 1,
    cause: null,
    last: null,
    van: null,
    stop: null,
  };

  test('each state offers the next step', () => {
    expect(actionFor(base)?.action).toBe('start_production');
    expect(actionFor({ ...base, state: 'in_production' })?.action).toBe('mark_ready');
    expect(actionFor({ ...base, state: 'ready' })?.action).toBe('mark_picked_up');
    expect(actionFor({ ...base, state: 'pending' })).toBeNull();
  });

  test('a delivery that is ready waits for its route, not a button', () => {
    expect(actionFor({ ...base, state: 'ready', kind: 'delivery' })).toBeNull();
  });
});

describe('the activity feed and the reconnect delay', () => {
  test('keeps the last 50 events, newest first, with type, stream, seq, cause and time', () => {
    let feed = pushFeed([], placed('sim:X'));
    expect(feed[0]).toMatchObject({
      type: 'OrderPlaced',
      seq: 1,
      cause: 'sim:X',
      time: '2026-11-04T19:12:10.318Z',
    });
    for (let seq = 2; seq < 80; seq++) feed = pushFeed(feed, envelope(seq, 'OrderPaid'));
    expect(feed).toHaveLength(FEED_MAX);
    expect(feed[0]?.seq).toBe(79);
  });

  test('a redelivered event is not listed twice', () => {
    const e = envelope(2, 'OrderPaid');
    expect(pushFeed(pushFeed([], e), e)).toHaveLength(1);
  });

  test('backoff doubles from one second and stops at thirty', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10, 100].map(backoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000,
    ]);
  });
});

describe('a delivery’s van and stop', () => {
  const delivery = () =>
    envelope(1, 'OrderPlaced', {
      kind: 'delivery',
      slot: '2026-11-07T09:45:00-07:00',
      lines: [{ item: 'country-loaf', variant: 'country-loaf/whole', qty: 2, unit_cents: 950 }],
    });
  const outForDelivery = (seq: number, route = 'van-2', stop = 3) =>
    envelope(seq, 'OrderOutForDelivery', { route, stop });
  const snapshotCard = {
    order: ORDER,
    state: 'out_for_delivery',
    lines: [{ variant: 'country-loaf/whole', qty: 2 }],
    note: null,
    slot: '2026-11-07T09:45:00-07:00',
    kind: 'delivery',
    updated_seq: 5,
  };

  test('a new card has none; a snapshot carries them when set and reads null otherwise', () => {
    expect(applyEvent(EMPTY_BOARD, delivery()).cards[ORDER]).toMatchObject({
      van: null,
      stop: null,
    });
    const withPair = boardFromSnapshot([{ ...snapshotCard, van: 'van-1', stop: 2 }]);
    expect(withPair.cards[ORDER]).toMatchObject({ van: 'van-1', stop: 2 });
    for (const odd of [
      {},
      { van: null, stop: null },
      { van: '', stop: 0 },
      { van: 1, stop: 'x' },
    ]) {
      expect(boardFromSnapshot([{ ...snapshotCard, ...odd }]).cards[ORDER]).toMatchObject({
        van: null,
        stop: null,
      });
    }
  });

  test('OrderOutForDelivery sets the pair, so the fold agrees with a snapshot', () => {
    let board = applyEvent(EMPTY_BOARD, delivery());
    board = applyEvent(board, envelope(2, 'OrderPaid'));
    board = applyEvent(board, envelope(3, 'OrderProductionStarted'));
    board = applyEvent(board, envelope(4, 'OrderReady'));
    expect(board.cards[ORDER]).toMatchObject({ van: null, stop: null });
    board = applyEvent(board, outForDelivery(5));
    const folded = board.cards[ORDER] as Card;
    expect(folded).toMatchObject({ state: 'out_for_delivery', van: 'van-2', stop: 3 });
    const snapshot = boardFromSnapshot([{ ...snapshotCard, van: 'van-2', stop: 3 }]);
    expect({ ...folded, cause: null, last: null }).toEqual(snapshot.cards[ORDER]);
  });

  test('an event without a usable pair keeps what the card has', () => {
    let board = applyEvent(EMPTY_BOARD, delivery());
    board = applyEvent(board, envelope(2, 'OrderPaid'));
    board = applyEvent(board, { ...outForDelivery(3), data: {} });
    expect(board.cards[ORDER]).toMatchObject({ state: 'out_for_delivery', van: null, stop: null });
  });

  test('the label: van and stop, either alone, and nothing when neither is set', () => {
    expect(routeWords({ van: 'van-1', stop: 3 })).toBe('Van 1, stop 3');
    expect(routeWords({ van: 'van-4', stop: null })).toBe('Van 4');
    expect(routeWords({ van: null, stop: 7 })).toBe('Stop 7');
    expect(routeWords({ van: 'van-a', stop: 2 })).toBe('Van a, stop 2');
    expect(routeWords({ van: null, stop: null })).toBeNull();
  });

  test('the card shows the label when set and no label when not', () => {
    const base = applyEvent(EMPTY_BOARD, delivery()).cards[ORDER] as Card;
    const draw = (card: Card) =>
      renderToStaticMarkup(
        createElement(CardView, {
          card,
          sandboxId: '01JC8YV2D4QK7S1M9E3PZ6W8AN',
          canRefund: false,
          open: true,
          onAct: () => undefined,
          onRefunded: () => undefined,
        }),
      );
    expect(draw({ ...base, state: 'out_for_delivery', van: 'van-1', stop: 3 })).toContain(
      '<p>Van 1, stop 3</p>',
    );
    const plain = draw(base);
    expect(plain).not.toMatch(/Van \d|[Ss]top \d/);
  });

  // A guest moves the orders on their own board since 2026-11-10 (roadmap R72); a refund still
  // needs a sign-in, so its menu is a signed-in session's only.
  test('every session gets the move button; only a signed-in one gets the refund menu', () => {
    const paid = applyEvent(applyEvent(EMPTY_BOARD, delivery()), envelope(2, 'OrderPaid'));
    const card = paid.cards[ORDER] as Card;
    const draw = (canRefund: boolean) =>
      renderToStaticMarkup(
        createElement(CardView, {
          card,
          sandboxId: '01JC8YV2D4QK7S1M9E3PZ6W8AN',
          canRefund,
          open: true,
          onAct: () => undefined,
          onRefunded: () => undefined,
        }),
      );
    const guest = draw(false);
    expect(guest).toContain(`aria-label="Start production for order ${ORDER.slice(-6)}"`);
    expect(guest).not.toContain('More for order');
    const signedIn = draw(true);
    expect(signedIn).toContain(`Start production for order ${ORDER.slice(-6)}`);
    expect(signedIn).toContain(`More for order ${ORDER.slice(-6)}`);
  });

  test('a refused move says its rule in plain words, the budget’s included', () => {
    const base = { id: 'C1', order: ORDER, action: 'mark_ready' as const, status: 'nack' as const };
    expect(commandText({ ...base, rule: 'rate-limit' })).toBe(
      `Mark ready for ${ORDER.slice(-6)}: refused, too many moves at once; wait a moment and press it again.`,
    );
    expect(commandText({ ...base, rule: 'out-of-order' })).toContain(
      'the order is not in the right state for that',
    );
    expect(commandText({ ...base, rule: 'read-only' })).toBe(
      `Mark ready for ${ORDER.slice(-6)}: refused, the demo is read-only for now, so the board can be watched but not moved.`,
    );
    expect(commandText({ ...base, rule: 'something-new' })).toContain('refused, something-new.');
  });

  test('the guest note says what a sign-in adds, the board’s own sentence when it has one', () => {
    const plain = renderToStaticMarkup(createElement(GuestNote));
    expect(plain).toContain('Sign in to use the console’s writes.');
    const board = renderToStaticMarkup(
      createElement(
        GuestNote,
        null,
        'Guests move their own orders here; a refund needs a sign-in.',
      ),
    );
    expect(board).toContain('Guests move their own orders here; a refund needs a sign-in.');
    expect(board).not.toContain('console’s writes');
    expect(board).toContain('href="/signin/"');
  });

  describe('RoutePublished, as crates/domain/src/kitchen.rs applies it', () => {
    const O = (k: number) => `01JC8Z5R0T2B6Y8C4V1N3K7Q${String(k).padStart(2, '0')}`;
    const stream = 'dispatch:01JC8YV2D4QK7S1M9E3PZ6W8AN:2026-11-07';
    const published = (planV: number, vans: { van: number; stops: string[] }[], seq = planV) => ({
      id: `01JC8Z6K3W9QF2N4T7XRB5N${String(seq).padStart(3, '0')}`,
      stream,
      seq,
      type: 'RoutePublished',
      at: '2026-11-07T07:00:00-07:00',
      recorded_at: '2026-11-07T14:00:00.000Z',
      cause: null,
      data: { date: '2026-11-07', plan_v: planV, source: 'server', vans, minutes: 40 },
    });
    const placedOrder = (k: number, seq = 1): Envelope => ({
      ...delivery(),
      stream: `order:01JC8YV2D4QK7S1M9E3PZ6W8AN:${O(k)}`,
      id: `01JC8Z6K3W9QF2N4T7XRB5M${String(k).padStart(3, '0')}`,
      seq,
    });
    // Orders 1, 2 and 3 have cards; 9 has none. Order 3 is in no plan.
    const start = () => [1, 2, 3].reduce((b, k) => applyEvent(b, placedOrder(k)), EMPTY_BOARD);
    const labels = (board: BoardState) =>
      [1, 2, 3].map((k) => [board.cards[O(k)]?.van, board.cards[O(k)]?.stop]);

    test('labels the cards in stop order across the vans, skips an order with no card', () => {
      const plan = published(1, [
        { van: 1, stops: [O(2)] },
        { van: 2, stops: [O(1), O(9)] },
      ]);
      const board = applyEvent(start(), plan);
      expect(labels(board)).toEqual([
        ['van-2', 2],
        ['van-1', 1],
        [null, null],
      ]);
      expect(board.cards[O(9)]).toBeUndefined();
      // Nothing of the order's own moved.
      expect(board.cards[O(1)]).toMatchObject({ updated_seq: 1, last: 'OrderPlaced' });
      expect(board.heads).toEqual(start().heads);
    });

    test('the folded board equals the snapshot the Kitchen would send', () => {
      const folded = applyEvent(
        start(),
        published(1, [
          { van: 1, stops: [O(2)] },
          { van: 2, stops: [O(1), O(9)] },
        ]),
      );
      // kitchen.rs `snapshot()`: the cards by slot then order, `van` and `stop` only when set.
      const wire = [
        { ...snapshotCard, order: O(1), state: 'pending', updated_seq: 1, van: 'van-2', stop: 2 },
        { ...snapshotCard, order: O(2), state: 'pending', updated_seq: 1, van: 'van-1', stop: 1 },
        { ...snapshotCard, order: O(3), state: 'pending', updated_seq: 1 },
      ];
      const snapshot = boardFromSnapshot(wire);
      const bare = (b: BoardState) =>
        Object.values(b.cards).map((c) => ({ ...c, cause: null, last: null }));
      expect(bare(folded)).toEqual(bare(snapshot));
      expect(folded.heads).toEqual(snapshot.heads);
    });

    test('a lower or equal plan_v after a higher one changes nothing', () => {
      const first = applyEvent(start(), published(2, [{ van: 1, stops: [O(1), O(2)] }]));
      const older = applyEvent(first, published(1, [{ van: 3, stops: [O(2), O(1)] }]));
      expect(older).toBe(first);
      const same = applyEvent(first, published(2, [{ van: 3, stops: [O(2), O(1)] }], 7));
      expect(same).toBe(first);
      expect(labels(first)).toEqual([
        ['van-1', 1],
        ['van-1', 2],
        [null, null],
      ]);
    });

    test('a newer plan relabels its cards and leaves a card it does not name as it was', () => {
      let board = applyEvent(start(), published(1, [{ van: 1, stops: [O(1), O(2)] }]));
      board = applyEvent(board, published(2, [{ van: 2, stops: [O(2)] }]));
      expect(labels(board)).toEqual([
        ['van-1', 1],
        ['van-2', 1],
        [null, null],
      ]);
    });

    test('the days are separate, and a plan’s label survives OrderOutForDelivery with the same pair', () => {
      let board = applyEvent(start(), published(1, [{ van: 1, stops: [O(1)] }]));
      const otherDay = published(1, [{ van: 4, stops: [O(3)] }], 5);
      otherDay.data.date = '2026-11-08';
      board = applyEvent(board, otherDay);
      expect(labels(board)).toEqual([
        ['van-1', 1],
        [null, null],
        ['van-4', 1],
      ]);
      const before = board.cards[O(1)] as Card;
      board = applyEvent(board, {
        ...placedOrder(1, 2),
        type: 'OrderOutForDelivery',
        data: { route: 'van-1', stop: 1 },
      });
      expect(board.cards[O(1)]).toMatchObject({ state: 'out_for_delivery', van: 'van-1', stop: 1 });
      expect(board.cards[O(1)]?.lines).toEqual(before.lines);
    });

    test('malformed data changes nothing, logs no error, and the feed still lists the frame', () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const board = start();
        for (const data of [{}, { date: 'x', plan_v: 1, vans: [] }, { date: '2026-11-07' }]) {
          expect(applyEvent(board, { ...published(1, []), data })).toBe(board);
        }
        const frame = parseFrame(JSON.stringify({ t: 'evt', v: 1, env: published(1, []) }));
        expect(frame?.t).toBe('evt');
        if (frame?.t !== 'evt') return;
        const feed = pushFeed([], frame.env);
        expect(feed).toHaveLength(1);
        expect(feed[0]).toMatchObject({ type: 'RoutePublished', stream, seq: 1, cause: null });
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });
  });
});
