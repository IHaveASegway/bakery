import { describe, expect, test } from 'vitest';
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
    expect(parseFrame('{"t":"nack","v":1,"id":"X","rule":"guest-scope"}')).toEqual({
      t: 'nack',
      id: 'X',
      rule: 'guest-scope',
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
