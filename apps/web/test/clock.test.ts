import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, NetworkError, advanceClock, apiOrigin } from '../src/lib/api';
import {
  ClockClicks,
  MAX_OFFSET_S,
  STEPS,
  businessNowText,
  businessNowView,
  clockRefusal,
  clockRule,
  formatOffset,
  remainingS,
} from '../src/lib/clock';
import { fakeFetch, json, problem } from './support';

const SANDBOX = '01JC8YV2D4QK7S1M9E3PZ6W8AN';
const answer = (offset: number) => ({
  business_now: '2026-11-07T09:42:10-07:00',
  clock_offset_s: offset,
  clock_v: 1,
});
let fake: ReturnType<typeof fakeFetch> | null = null;
afterEach(() => fake?.restore());

const keys = (calls: { headers: Record<string, string> }[]) =>
  calls.map((c) => c.headers['Idempotency-Key']);

describe('the clock display', () => {
  // 2026-11-05 17:07:30 UTC is 10:07:30 in Salt Lake City.
  const wall = Date.UTC(2026, 10, 5, 17, 7, 30);

  test('business now is wall time plus the offset, written in Mountain time', () => {
    expect(businessNowText(wall, 0)).toBe('2026-11-05T10:07:30-07:00');
    expect(businessNowText(wall, 86_400)).toBe('2026-11-06T10:07:30-07:00');
    // Across the fall-back day the offset written changes with the instant.
    expect(businessNowText(Date.UTC(2026, 9, 31, 17, 0, 0), 86_400)).toBe(
      '2026-11-01T10:00:00-07:00',
    );
  });

  test('ticks: a second of wall time is a second of business time', () => {
    expect(businessNowView(wall + 1000, 3600).iso).toBe('2026-11-05T11:07:31-07:00');
    expect(businessNowView(wall, 0).text).toBe('Thu 5 Nov, 10:07:30 am');
  });

  test('the offset reads in days, hours and minutes, and the cap is 14 days', () => {
    expect(formatOffset(0)).toBe('0 min');
    expect(formatOffset(45 * 60)).toBe('45 min');
    expect(formatOffset(26 * 3600 + 15 * 60)).toBe('1 d 2 h 15 min');
    expect(formatOffset(MAX_OFFSET_S)).toBe('14 d');
    expect(remainingS(5 * 86_400)).toBe(9 * 86_400);
    expect(remainingS(MAX_OFFSET_S + 5)).toBe(0);
  });

  test('has the four steps the API names', () => {
    expect(STEPS.map((s) => s.step)).toEqual(['15m', '1h', '1d', 'next-opening']);
  });
});

describe('one key per click', () => {
  test('each click sends its step with a key of its own', async () => {
    fake = fakeFetch([json(answer(900)), json(answer(4500)), json(answer(90_900))]);
    const clicks = new ClockClicks();
    await clicks.click(SANDBOX, '15m');
    await clicks.click(SANDBOX, '1h');
    await clicks.click(SANDBOX, '1d');
    expect(fake.calls.map((c) => c.body)).toEqual([
      { step: '15m' },
      { step: '1h' },
      { step: '1d' },
    ]);
    expect(fake.calls.every((c) => c.url === `${apiOrigin}/v1/sandboxes/${SANDBOX}/clock`)).toBe(
      true,
    );
    const sent = keys(fake.calls);
    expect(new Set(sent).size).toBe(3);
    for (const key of sent) expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test('two clicks on the same step are still two intents', async () => {
    fake = fakeFetch([json(answer(900)), json(answer(1800))]);
    const clicks = new ClockClicks();
    await clicks.click(SANDBOX, '15m');
    await clicks.click(SANDBOX, '15m');
    expect(new Set(keys(fake.calls)).size).toBe(2);
  });

  test('after an unanswered request the next click on that step repeats the key', async () => {
    fake = fakeFetch([
      new Error('offline'),
      problem(503, 'unavailable', 'Try later'),
      json(answer(900)),
    ]);
    const clicks = new ClockClicks();
    await expect(clicks.click(SANDBOX, '15m')).rejects.toBeInstanceOf(NetworkError);
    await expect(clicks.click(SANDBOX, '15m')).rejects.toBeInstanceOf(ApiError);
    await clicks.click(SANDBOX, '15m');
    expect(new Set(keys(fake.calls)).size).toBe(1);
  });

  test('a different step after a failure is a new intent, and so is a click after a refusal', async () => {
    fake = fakeFetch([
      new Error('offline'),
      json(answer(3600)),
      problem(422, 'clock', 'The clock did not move', { detail: 'offset-cap' }),
      json(answer(900)),
    ]);
    const clicks = new ClockClicks();
    await expect(clicks.click(SANDBOX, '15m')).rejects.toBeInstanceOf(NetworkError);
    await clicks.click(SANDBOX, '1h');
    await expect(clicks.click(SANDBOX, '1d')).rejects.toBeInstanceOf(ApiError);
    await clicks.click(SANDBOX, '1d');
    expect(new Set(keys(fake.calls)).size).toBe(4);
  });

  test('works with a faked sender and a faked key mint', async () => {
    const sent: { req: unknown; key: string }[] = [];
    let n = 0;
    const clicks = new ClockClicks(
      async (_id, req, key) => {
        sent.push({ req, key });
        return answer(0);
      },
      () => `KEY${++n}`,
    );
    await clicks.click(SANDBOX, 'next-opening');
    await clicks.click(SANDBOX, 'next-opening');
    expect(sent).toEqual([
      { req: { step: 'next-opening' }, key: 'KEY1' },
      { req: { step: 'next-opening' }, key: 'KEY2' },
    ]);
  });
});

describe('the clock’s refusals', () => {
  test('offset-cap and not-positive are shown plainly', async () => {
    fake = fakeFetch([
      problem(422, 'clock', 'Clock refused', { detail: 'offset-cap' }),
      problem(422, 'clock', 'Clock refused', { detail: 'not-positive' }),
    ]);
    const cap = await advanceClock(SANDBOX, { step: '1d' }).catch((e: unknown) => e);
    const flat = await advanceClock(SANDBOX, 0).catch((e: unknown) => e);
    expect(clockRule(cap)).toBe('offset-cap');
    expect(clockRefusal(cap)).toMatch(/14 days/);
    expect(clockRule(flat)).toBe('not-positive');
    expect(clockRefusal(flat)).toMatch(/only moves forward/);
  });

  test('the rule can come from the problem type instead of the detail', async () => {
    fake = fakeFetch([problem(422, 'offset-cap', 'Too far')]);
    const e = await advanceClock(SANDBOX, { step: '1d' }).catch((x: unknown) => x);
    expect(clockRule(e)).toBe('offset-cap');
  });

  test('anything else is not a clock refusal', async () => {
    fake = fakeFetch([problem(403, 'guest-scope', 'Guests cannot do that')]);
    const e = await advanceClock(SANDBOX, { step: '1d' }).catch((x: unknown) => x);
    expect(clockRule(e)).toBeNull();
    expect(clockRefusal(e)).toBeNull();
    expect(clockRefusal(new Error('x'))).toBeNull();
  });
});
