import { afterEach, describe, expect, test } from 'vitest';
import {
  ApiError,
  NetworkError,
  advanceClock,
  apiOrigin,
  getSchedule,
  setCapacity,
} from '../src/lib/api';
import { fakeFetch, json, problem, scheduleFor } from './support';

const SANDBOX = '01JC8YV2D4QK7S1M9E3PZ6W8AN';
let fake: ReturnType<typeof fakeFetch> | null = null;
const failure = (call: Promise<unknown>) =>
  call.then(
    () => {
      throw new Error('the call was expected to fail');
    },
    (e: unknown) => e as ApiError,
  );
afterEach(() => fake?.restore());

describe('getSchedule', () => {
  test('reads the day from /schedule/{date} with the session cookie and no key', async () => {
    const day = scheduleFor('2026-11-07');
    fake = fakeFetch([json(day)]);
    expect(await getSchedule(SANDBOX, '2026-11-07')).toEqual(day);
    const [call] = fake.calls;
    expect(call?.url).toBe(`${apiOrigin}/v1/sandboxes/${SANDBOX}/schedule/2026-11-07`);
    expect(call?.method).toBe('GET');
    expect(call?.headers['Idempotency-Key']).toBeUndefined();
  });

  test('a 422 closed-day is an ApiError with its slug and detail', async () => {
    fake = fakeFetch([problem(422, 'schedule', 'Not a bakery day', { detail: 'closed-day' })]);
    const error = await getSchedule(SANDBOX, '2026-11-09').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).detail).toBe('closed-day');
  });
});

describe('setCapacity', () => {
  test('PATCHes the capacity route with the request and returns the day', async () => {
    const day = scheduleFor('2026-11-07', { capacity: 3 });
    fake = fakeFetch([json(day)]);
    const answer = await setCapacity(SANDBOX, '2026-11-07', { target: 'slot:14:45', capacity: 3 });
    expect(answer.slots[0]?.capacity).toBe(3);
    const [call] = fake.calls;
    expect(call?.url).toBe(`${apiOrigin}/v1/sandboxes/${SANDBOX}/schedule/2026-11-07/capacity`);
    expect(call?.method).toBe('PATCH');
    expect(call?.body).toEqual({ target: 'slot:14:45', capacity: 3 });
    expect(call?.headers['Content-Type']).toBe('application/json');
  });
});

describe('advanceClock', () => {
  const answer = {
    business_now: '2026-11-08T07:00:00-07:00',
    clock_offset_s: 86_400,
    clock_v: 2,
  };

  test('a named step goes as {step} with the key the caller gave', async () => {
    fake = fakeFetch([json(answer)]);
    expect(await advanceClock(SANDBOX, { step: '1d' }, '01JC8Z6K3W9QF2N4T7XRB5M0HD')).toEqual(
      answer,
    );
    const [call] = fake.calls;
    expect(call?.url).toBe(`${apiOrigin}/v1/sandboxes/${SANDBOX}/clock`);
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ step: '1d' });
    expect(call?.headers['Idempotency-Key']).toBe('01JC8Z6K3W9QF2N4T7XRB5M0HD');
  });

  test('a plain number of minutes still works and mints its own key', async () => {
    fake = fakeFetch([json(answer)]);
    await advanceClock(SANDBOX, 15);
    const [call] = fake.calls;
    expect(call?.body).toEqual({ minutes: 15 });
    expect(call?.headers['Idempotency-Key']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('errors', () => {
  test('a slot-full problem exposes next_free; other problems have none', async () => {
    fake = fakeFetch([
      problem(409, 'slot-full', 'That slot is full', {
        detail: 'slot-full: next free 10:15',
        next_free: '2026-11-07T10:15:00-07:00',
      }),
      problem(409, 'item-cap', 'Sold out'),
    ]);
    const full = await failure(getSchedule(SANDBOX, '2026-11-07'));
    expect(full.next_free).toBe('2026-11-07T10:15:00-07:00');
    expect(full.slug).toBe('slot-full');
    const cap = await failure(getSchedule(SANDBOX, '2026-11-07'));
    expect(cap.next_free).toBeNull();
  });

  test('an unanswered request is a NetworkError', async () => {
    fake = fakeFetch([new Error('offline')]);
    await expect(getSchedule(SANDBOX, '2026-11-07')).rejects.toBeInstanceOf(NetworkError);
  });
});
