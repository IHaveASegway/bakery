import { describe, expect, test } from 'vitest';
import {
  EMPTY_BOARD,
  applyEvent,
  bakeListsByDate,
  groupBakeLines,
  parseFrame,
  type BoardState,
  type Envelope,
} from '../src/lib/kitchen';

const SANDBOX = '01JC8YV2D4QK7S1M9E3PZ6W8AN';
const DAY = '2026-11-07';
const REF = (n: number) => `01JC8Z5R0T2B6Y8C4V1N3K7Q${String(n).padStart(2, '0')}`;

const schedule = (
  date: string,
  seq: number,
  type: string,
  data: Record<string, unknown>,
): Envelope => ({
  id: `01JC8Z6K3W9QF2N4T7XRB5M${String(seq).padStart(3, '0')}${type.length}`,
  stream: `schedule:${SANDBOX}:${date}`,
  seq,
  type,
  at: '2026-11-07T08:00:00-07:00',
  recorded_at: '2026-11-07T15:00:00.000Z',
  cause: null,
  data: { date, ...data },
});

const planned = (date: string, seq: number, version: number, lines: object[] = []) =>
  schedule(date, seq, 'BakeListChanged', { version, lines });
const reserved = (date: string, seq: number, n: number) =>
  schedule(date, seq, 'SlotReserved', {
    kind: 'slot',
    start: `${date}T09:00:00-07:00`,
    ref: REF(n),
  });
const released = (date: string, seq: number, n: number) =>
  schedule(date, seq, 'SlotReleased', {
    kind: 'slot',
    start: `${date}T09:00:00-07:00`,
    ref: REF(n),
    reason: 'cancelled',
  });

const fold = (events: Envelope[], from: BoardState = EMPTY_BOARD) =>
  events.reduce((board, env) => applyEvent(board, env), from);

describe('the snapshot’s bake lists', () => {
  test('are read from board.bake_lists with the cards beside them', () => {
    const frame = parseFrame(
      JSON.stringify({
        t: 'snapshot',
        v: 1,
        seq: 4,
        board: {
          cards: [],
          bake_lists: [
            {
              date: '2026-11-08',
              version: 3,
              lines: [{ item: 'croissant', qty: 24, start: '2026-11-08T08:00:00-07:00' }],
              reserved: 2,
            },
            { date: DAY, version: 1, lines: [], reserved: 0 },
            { date: 'soon', version: 1, lines: [], reserved: 1 },
          ],
        },
      }),
    );
    if (frame?.t !== 'snapshot') throw new Error('not a snapshot');
    expect(Object.keys(frame.board.bakeLists).sort()).toEqual([DAY, '2026-11-08']);
    expect(frame.board.bakeLists['2026-11-08']).toEqual({
      date: '2026-11-08',
      version: 3,
      lines: [{ item: 'croissant', qty: 24, start: '2026-11-08T08:00:00-07:00' }],
      reserved: 2,
    });
    expect(bakeListsByDate(frame.board).map((b) => b.date)).toEqual([DAY, '2026-11-08']);
  });

  test('a snapshot with no bake_lists, as a list of cards or older, has none', () => {
    for (const board of [[], { cards: [] }, { cards: {} }]) {
      const frame = parseFrame(JSON.stringify({ t: 'snapshot', v: 1, board, seq: 1 }));
      if (frame?.t !== 'snapshot') throw new Error('not a snapshot');
      expect(frame.board.bakeLists).toEqual({});
    }
  });
});

describe('BakeListChanged', () => {
  const croissants = [{ item: 'croissant', qty: 12, start: `${DAY}T08:00:00-07:00` }];

  test('arrives as an evt frame and lands in the board by date', () => {
    const text = JSON.stringify({ t: 'evt', v: 1, env: planned(DAY, 2, 1, croissants) });
    const frame = parseFrame(text);
    if (frame?.t !== 'evt') throw new Error('not an evt');
    const board = applyEvent(EMPTY_BOARD, frame.env);
    expect(board.bakeLists[DAY]).toEqual({ date: DAY, version: 1, lines: croissants, reserved: 0 });
  });

  test('a higher version replaces the plan; an equal or lower one is ignored', () => {
    let board = fold([planned(DAY, 2, 2, croissants)]);
    const newer = [{ item: 'croissant', qty: 30, start: `${DAY}T08:00:00-07:00` }];
    board = applyEvent(board, planned(DAY, 3, 3, newer));
    expect(board.bakeLists[DAY]?.version).toBe(3);
    expect(board.bakeLists[DAY]?.lines).toEqual(newer);
    // Version 2 arrives late, and version 3 again: neither changes the board.
    expect(applyEvent(board, planned(DAY, 4, 2, croissants))).toBe(board);
    expect(applyEvent(board, planned(DAY, 5, 3, []))).toBe(board);
  });

  test('is judged by version, not by seq, and per day', () => {
    const board = fold([
      planned(DAY, 9, 4, croissants),
      planned('2026-11-08', 1, 1, croissants),
      planned(DAY, 2, 5, []),
    ]);
    expect(board.bakeLists[DAY]?.version).toBe(5);
    expect(board.bakeLists[DAY]?.lines).toEqual([]);
    expect(board.bakeLists['2026-11-08']?.version).toBe(1);
  });

  test('takes the day from the stream when the data has none, and ignores a stream with no day', () => {
    const noDate = { ...planned(DAY, 1, 1), data: { version: 1, lines: [] } };
    expect(applyEvent(EMPTY_BOARD, noDate).bakeLists[DAY]?.version).toBe(1);
    expect(applyEvent(EMPTY_BOARD, { ...noDate, stream: 'schedule:x' })).toBe(EMPTY_BOARD);
  });

  test('a snapshot then newer events: the fold continues from the snapshot’s version', () => {
    const snapshot: BoardState = {
      ...EMPTY_BOARD,
      bakeLists: { [DAY]: { date: DAY, version: 7, lines: croissants, reserved: 3 } },
    };
    expect(applyEvent(snapshot, planned(DAY, 1, 7))).toBe(snapshot);
    expect(applyEvent(snapshot, planned(DAY, 2, 8)).bakeLists[DAY]?.version).toBe(8);
  });
});

describe('reserved counts', () => {
  test('SlotReserved and SlotReleased adjust the day’s count, a ref counting once', () => {
    let board = fold([reserved(DAY, 1, 1), reserved(DAY, 2, 2), reserved('2026-11-08', 1, 3)]);
    expect(board.bakeLists[DAY]?.reserved).toBe(2);
    expect(board.bakeLists['2026-11-08']?.reserved).toBe(1);
    board = applyEvent(board, released(DAY, 3, 2));
    expect(board.bakeLists[DAY]?.reserved).toBe(1);
  });

  test('a repeated or older event for a ref changes nothing', () => {
    const board = fold([reserved(DAY, 1, 1), reserved(DAY, 2, 2)]);
    expect(applyEvent(board, reserved(DAY, 2, 2))).toBe(board);
    expect(applyEvent(board, reserved(DAY, 1, 1))).toBe(board);
    // The same ref reserved again at a higher seq is still one place.
    expect(applyEvent(board, reserved(DAY, 5, 2)).bakeLists[DAY]?.reserved).toBe(2);
  });

  test('a late reservation after its release does not count (the latest seq wins)', () => {
    const board = fold([reserved(DAY, 1, 1), released(DAY, 5, 1)]);
    expect(board.bakeLists[DAY]?.reserved).toBe(0);
    expect(applyEvent(board, reserved(DAY, 4, 1))).toBe(board);
    // A later reservation of the same ref (a revived hold) counts again.
    expect(applyEvent(board, reserved(DAY, 6, 1)).bakeLists[DAY]?.reserved).toBe(1);
  });

  test('a release of a ref never seen reserved changes no count', () => {
    const base: BoardState = {
      ...EMPTY_BOARD,
      bakeLists: { [DAY]: { date: DAY, version: 1, lines: [], reserved: 4 } },
    };
    expect(applyEvent(base, released(DAY, 1, 9)).bakeLists[DAY]?.reserved).toBe(4);
  });

  test('a count never goes below zero, and the plan is kept when the count moves', () => {
    const lines = [{ item: 'croissant', qty: 6, start: `${DAY}T09:00:00-07:00` }];
    const board = fold([planned(DAY, 1, 1, lines), reserved(DAY, 2, 1)]);
    expect(board.bakeLists[DAY]).toEqual({ date: DAY, version: 1, lines, reserved: 1 });
    expect(applyEvent(board, released(DAY, 3, 1)).bakeLists[DAY]?.reserved).toBe(0);
  });

  test('events for the cards still fold as before, and keep the bake lists', () => {
    const withLists = fold([planned(DAY, 1, 1)]);
    const placed: Envelope = {
      ...schedule(DAY, 1, 'OrderPlaced', {
        kind: 'pickup',
        slot: `${DAY}T09:00:00-07:00`,
        lines: [],
      }),
      stream: `order:${SANDBOX}:01JC8Z5R0T2B6Y8C4V1N3K7QXE`,
    };
    const board = applyEvent(withLists, placed);
    expect(Object.keys(board.cards)).toEqual(['01JC8Z5R0T2B6Y8C4V1N3K7QXE']);
    expect(board.bakeLists[DAY]?.version).toBe(1);
  });
});

describe('the day a frame carries (bake_list, since 2026-11-06)', () => {
  const lines = [{ item: 'croissant', qty: 6, start: `${DAY}T09:00:00-07:00` }];
  const frameOf = (env: Envelope, day: object | undefined) => {
    const frame = parseFrame(JSON.stringify({ t: 'evt', v: 1, env, bake_list: day }));
    if (frame?.t !== 'evt') throw new Error('not an evt');
    return frame;
  };
  const apply = (board: BoardState, env: Envelope, day?: object) => {
    const frame = frameOf(env, day);
    return applyEvent(board, frame.env, frame.bakeList);
  };

  test('is read from the evt frame, and is null when the frame has none', () => {
    const day = { date: DAY, version: 2, lines, reserved: 3 };
    expect(frameOf(released(DAY, 4, 1), day).bakeList).toEqual(day);
    expect(frameOf(released(DAY, 4, 1), undefined).bakeList).toBeNull();
    expect(frameOf(released(DAY, 4, 1), { date: 'soon', reserved: 1 }).bakeList).toBeNull();
  });

  test('a place reserved before the snapshot and released while watching lowers the count', () => {
    // The snapshot: one place reserved, by a ref this page has seen no event for.
    const snapshot: BoardState = {
      ...EMPTY_BOARD,
      bakeLists: { [DAY]: { date: DAY, version: 1, lines, reserved: 1 } },
    };
    // The old rule, an adjusted count, leaves it one too high.
    expect(applyEvent(snapshot, released(DAY, 2, 1)).bakeLists[DAY]?.reserved).toBe(1);
    // The frame's day sets it, plan included.
    const after = apply(snapshot, released(DAY, 2, 1), {
      date: DAY,
      version: 1,
      lines,
      reserved: 0,
    });
    expect(after.bakeLists[DAY]).toEqual({ date: DAY, version: 1, lines, reserved: 0 });
    // The replan that follows carries the day too.
    const replanned = apply(after, planned(DAY, 3, 2, []), {
      date: DAY,
      version: 2,
      lines: [],
      reserved: 0,
    });
    expect(replanned.bakeLists[DAY]).toEqual({ date: DAY, version: 2, lines: [], reserved: 0 });
  });

  test('a set is idempotent and survives a missed frame', () => {
    const day = (reserved: number) => ({ date: DAY, version: 1, lines, reserved });
    let board = apply(EMPTY_BOARD, reserved(DAY, 1, 1), day(1));
    const again = apply(board, reserved(DAY, 1, 1), day(1));
    expect(again.bakeLists[DAY]).toEqual(board.bakeLists[DAY]);
    // The frame for ref 2's reservation is missed; ref 3's frame says 3, and 3 it is.
    board = apply(board, reserved(DAY, 3, 3), day(3));
    expect(board.bakeLists[DAY]?.reserved).toBe(3);
  });

  test('a day that is not the event’s is ignored, and the event folds as before', () => {
    const board = fold([reserved(DAY, 1, 1)]);
    const other = apply(board, reserved(DAY, 2, 2), { date: '2026-11-08', reserved: 9 });
    expect(other.bakeLists[DAY]?.reserved).toBe(2);
    expect(other.bakeLists['2026-11-08']).toBeUndefined();
  });
});

describe('what the panels show', () => {
  test('days run earliest first, from today on', () => {
    const board = fold([
      planned('2026-11-09', 1, 1),
      planned(DAY, 1, 1),
      planned('2026-11-06', 1, 1),
    ]);
    expect(bakeListsByDate(board).map((b) => b.date)).toEqual(['2026-11-06', DAY, '2026-11-09']);
    expect(bakeListsByDate(board, DAY).map((b) => b.date)).toEqual([DAY, '2026-11-09']);
  });

  test('lines group by start in time order, then item by name, summing repeats', () => {
    const groups = groupBakeLines([
      { item: 'country-loaf', qty: 2, start: `${DAY}T11:00:00-07:00` },
      { item: 'sourdough', qty: 1, start: `${DAY}T09:00:00-07:00` },
      { item: 'croissant', qty: 6, start: `${DAY}T09:00:00-07:00` },
      { item: 'croissant', qty: 6, start: `${DAY}T09:00:00-07:00` },
      { item: 'croissant', qty: 3, start: `${DAY}T11:00:00-07:00` },
    ]);
    expect(groups).toEqual([
      {
        start: `${DAY}T09:00:00-07:00`,
        items: [
          { item: 'croissant', qty: 12 },
          { item: 'sourdough', qty: 1 },
        ],
      },
      {
        start: `${DAY}T11:00:00-07:00`,
        items: [
          { item: 'country-loaf', qty: 2 },
          { item: 'croissant', qty: 3 },
        ],
      },
    ]);
  });

  test('starts compare as instants, so the offset change day keeps its order', () => {
    // 2026-11-01 falls back: 01:30 -06:00 comes before 01:30 -07:00.
    const groups = groupBakeLines([
      { item: 'a', qty: 1, start: '2026-11-01T01:30:00-07:00' },
      { item: 'a', qty: 1, start: '2026-11-01T01:30:00-06:00' },
    ]);
    expect(groups.map((g) => g.start)).toEqual([
      '2026-11-01T01:30:00-06:00',
      '2026-11-01T01:30:00-07:00',
    ]);
  });
});
