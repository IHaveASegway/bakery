// The old tour's own parts (lib/tour.ts): moving through a tour, its keys, what it remembered and
// the events of the last action. They go with the tour; the guide's are in guide.test.ts.
import { describe, expect, test } from 'vitest';
import {
  CLOSED,
  SCREENS,
  keyAction,
  parseSeen,
  progressText,
  recentEvents,
  tourReduce,
  withSeen,
  type TourState,
} from '../src/lib/tour';
import { ENTRIES as TOURS } from '../src/guide';

describe('moving through a tour', () => {
  const open = (index = 0): TourState => ({ open: true, index });

  test('open starts at the first step, or a named one kept inside the tour', () => {
    expect(tourReduce(CLOSED, { type: 'open' }, 9)).toEqual({ open: true, index: 0 });
    expect(tourReduce(CLOSED, { type: 'open', index: 4 }, 9)).toEqual({ open: true, index: 4 });
    expect(tourReduce(CLOSED, { type: 'open', index: 99 }, 9).index).toBe(8);
    expect(tourReduce(CLOSED, { type: 'open' }, 0).open).toBe(false);
  });

  test('next and back move one step, back stops at the first, and next on the last ends the tour', () => {
    expect(tourReduce(open(2), { type: 'next' }, 9).index).toBe(3);
    expect(tourReduce(open(2), { type: 'back' }, 9).index).toBe(1);
    expect(tourReduce(open(0), { type: 'back' }, 9).index).toBe(0);
    expect(tourReduce(open(8), { type: 'next' }, 9).open).toBe(false);
  });

  test('first and last jump; close keeps the place; nothing moves while closed', () => {
    expect(tourReduce(open(4), { type: 'first' }, 9).index).toBe(0);
    expect(tourReduce(open(4), { type: 'last' }, 9).index).toBe(8);
    expect(tourReduce(open(4), { type: 'close' }, 9)).toEqual({ open: false, index: 4 });
    expect(tourReduce(CLOSED, { type: 'next' }, 9)).toEqual(CLOSED);
    expect(tourReduce(CLOSED, { type: 'last' }, 9)).toEqual(CLOSED);
  });

  test('the progress reads “3 of 9”, counting from one', () => {
    expect(progressText(2, 9)).toBe('3 of 9');
    expect(progressText(0, 1)).toBe('1 of 1');
  });

  test('a tour can be walked end to end with next and ends, never past the last step', () => {
    for (const screen of SCREENS) {
      const total = TOURS[screen].length;
      let state = tourReduce(CLOSED, { type: 'open' }, total);
      let seen = 1;
      while (state.open) {
        state = tourReduce(state, { type: 'next' }, total);
        if (state.open) seen++;
      }
      expect(seen, screen).toBe(total);
    }
  });
});

describe('the keyboard', () => {
  test('arrows move, home and end jump, escape closes', () => {
    expect(keyAction('ArrowRight', false)).toEqual({ type: 'next' });
    expect(keyAction('ArrowDown', true)).toEqual({ type: 'next' });
    expect(keyAction('ArrowLeft', false)).toEqual({ type: 'back' });
    expect(keyAction('ArrowUp', true)).toEqual({ type: 'back' });
    expect(keyAction('Home', false)).toEqual({ type: 'first' });
    expect(keyAction('End', false)).toEqual({ type: 'last' });
    expect(keyAction('Escape', true)).toEqual({ type: 'close' });
  });

  test('enter goes forward on the card but belongs to a button or a link when the focus is on one', () => {
    expect(keyAction('Enter', false)).toEqual({ type: 'next' });
    expect(keyAction('Enter', true)).toBeNull();
  });

  test('Tab and every other key are left alone, so the focus is never trapped', () => {
    for (const key of ['Tab', 'Shift', 'a', ' ', 'PageDown'])
      expect(keyAction(key, false)).toBeNull();
  });
});

describe('seen, the one thing remembered', () => {
  test('reads only known screens set to true, and survives garbage', () => {
    expect(parseSeen(null)).toEqual({});
    expect(parseSeen('not json')).toEqual({});
    expect(parseSeen('[1,2]')).toEqual({});
    expect(parseSeen('{"menu":true,"nowhere":true,"home":"yes"}')).toEqual({ menu: true });
  });

  test('marking a screen seen keeps the others', () => {
    expect(withSeen({ menu: true }, 'home')).toEqual({ menu: true, home: true });
  });
});

describe('the events of the last action', () => {
  const now = Date.parse('2026-11-05T12:00:00.000Z');
  const entry = (type: string, secondsAgo: number) => ({
    type,
    at: new Date(now - secondsAgo * 1000).toISOString(),
    summary: `${type} happened`,
  });
  const feed = [
    entry('FaultSet', 5),
    entry('ClockAdvanced', 20),
    entry('FaultSet', 300),
    entry('MenuPublished', -2),
  ];

  test('keeps the step’s event types from the last minute, in the feed’s order', () => {
    expect(recentEvents(feed, ['FaultSet'], now).map((e) => e.type)).toEqual(['FaultSet']);
    expect(recentEvents(feed, ['FaultSet', 'ClockAdvanced'], now)).toHaveLength(2);
    expect(recentEvents(feed, ['OrderPlaced'], now)).toEqual([]);
  });

  test('leaves out an entry older than a minute and allows a few seconds of clock skew ahead', () => {
    expect(recentEvents([entry('FaultSet', 61)], ['FaultSet'], now)).toEqual([]);
    expect(recentEvents([entry('FaultSet', 60)], ['FaultSet'], now)).toHaveLength(1);
    expect(recentEvents(feed, ['MenuPublished'], now)).toHaveLength(1);
    expect(recentEvents([entry('FaultSet', -30)], ['FaultSet'], now)).toEqual([]);
  });

  test('an entry with an unreadable time is left out', () => {
    expect(
      recentEvents([{ type: 'FaultSet', at: 'soon', summary: 's' }], ['FaultSet'], now),
    ).toEqual([]);
  });
});
