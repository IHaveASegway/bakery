import { afterEach, describe, expect, test } from 'vitest';
import { setCapacity } from '../src/lib/api';
import {
  buildTarget,
  capacityRequest,
  changedText,
  describeCapacityError,
  parseCapacity,
  slotTime,
  standing,
} from '../src/lib/capacity';
import { fakeFetch, json, problem, scheduleFor } from './support';

const SANDBOX = '01JC8YV2D4QK7S1M9E3PZ6W8AN';
let fake: ReturnType<typeof fakeFetch> | null = null;
afterEach(() => fake?.restore());

describe('the target grammar', () => {
  test('builds slot:HH:MM, zone:z1, item:<slug> and catering', () => {
    expect(buildTarget('slot', '14:45')).toEqual({ ok: true, target: 'slot:14:45' });
    expect(buildTarget('zone', 'z3')).toEqual({ ok: true, target: 'zone:z3' });
    expect(buildTarget('item', 'country-loaf')).toEqual({ ok: true, target: 'item:country-loaf' });
    expect(buildTarget('item', ' croissant ')).toEqual({ ok: true, target: 'item:croissant' });
    expect(buildTarget('catering', 'whatever')).toEqual({ ok: true, target: 'catering' });
  });

  test('says why it cannot build one', () => {
    for (const [kind, value] of [
      ['slot', '14:40'],
      ['slot', '7:00'],
      ['slot', '25:00'],
      ['slot', ''],
      ['zone', 'z4'],
      ['zone', 'Z1'],
      ['item', ''],
      ['item', 'Country Loaf'],
      ['item', 'a:b'],
    ] as const) {
      const built = buildTarget(kind, value);
      expect(built.ok, `${kind} ${value}`).toBe(false);
      if (!built.ok) expect(built.reason.length).toBeGreaterThan(10);
    }
  });

  test('a slot is named by its Mountain start', () => {
    expect(slotTime('2026-11-07T14:45:00-07:00')).toBe('14:45');
    expect(slotTime('2026-07-14T07:00:00-06:00')).toBe('07:00');
  });

  test('a capacity is a whole number that fits a u16', () => {
    expect(parseCapacity('0')).toBe(0);
    expect(parseCapacity(' 12 ')).toBe(12);
    expect(parseCapacity('65535')).toBe(65_535);
    for (const bad of ['', '-1', '1.5', '65536', 'six', '1e3', '123456']) {
      expect(parseCapacity(bad), bad).toBeNull();
    }
  });
});

describe('sending a capacity', () => {
  test('posts the request and returns the changed day', async () => {
    const day = scheduleFor('2026-11-07', { capacity: 2, taken: { '09:00': 5 } });
    fake = fakeFetch([json(day)]);
    const built = buildTarget('slot', '09:00');
    if (!built.ok) throw new Error('unreachable');
    const answer = await setCapacity(SANDBOX, '2026-11-07', capacityRequest(built.target, 2));
    expect(fake.calls[0]?.body).toEqual({ target: 'slot:09:00', capacity: 2 });
    expect(standing(answer, 'slot:09:00')).toEqual({ capacity: 2, taken: 5 });
  });

  test('a lowered capacity says it never drops a reservation', () => {
    const day = scheduleFor('2026-11-07', { capacity: 2, taken: { '09:00': 5 } });
    const text = changedText('slot:09:00', 2, day);
    expect(text).toMatch(/5 already taken stay/);
    expect(text).toMatch(/never drops a reservation/);
    expect(changedText('slot:10:00', 2, day)).toMatch(/0 taken, 2 free/);
  });

  test('reads the standing of every kind of target', () => {
    const day = scheduleFor('2026-11-07');
    expect(standing(day, 'zone:z2')).toEqual({ capacity: 20, taken: 0 });
    expect(standing(day, 'item:croissant')).toEqual({ capacity: 40, taken: 12 });
    expect(standing(day, 'item:rye')).toBeNull();
    expect(standing(day, 'catering')).toEqual({ capacity: 2, taken: 1 });
    expect(standing(day, 'nonsense')).toBeNull();
  });
});

describe('the refusals', () => {
  test('422 bad-target is shown with what the API said', async () => {
    fake = fakeFetch([
      problem(422, 'schedule', 'Bad request', { detail: 'bad-target: unknown target kind' }),
    ]);
    const e = await setCapacity(SANDBOX, '2026-11-07', { target: 'slot:14:40', capacity: 1 }).catch(
      (x: unknown) => x,
    );
    const message = describeCapacityError(e);
    expect(message.title).toBe('The API did not accept that target');
    expect(message.detail).toMatch(/slot:HH:MM/);
    expect(message.detail).toMatch(/unknown target kind/);
  });

  test('403 guest-scope says guests cannot change capacities', async () => {
    fake = fakeFetch([problem(403, 'guest-scope', 'Forbidden')]);
    const e = await setCapacity(SANDBOX, '2026-11-07', { target: 'catering', capacity: 1 }).catch(
      (x: unknown) => x,
    );
    expect(describeCapacityError(e).title).toBe('Guests cannot change capacities');
  });

  test('anything else gets the general words', () => {
    expect(describeCapacityError(new Error('x')).title).toBe('Something went wrong');
  });
});
