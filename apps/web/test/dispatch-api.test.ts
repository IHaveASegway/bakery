import { afterEach, describe, expect, test } from 'vitest';
import {
  ApiError,
  apiOrigin,
  completeStop,
  getDispatch,
  proposeDispatch,
  publishDispatch,
  submitPlan,
} from '../src/lib/api';
import { KeyedAction } from '../src/lib/crm';
import { fakeFetch, json, problem } from './support';
import { describeDispatchError, sentenceFor } from '../src/lib/dispatch-errors';
import { day, orderId, plan, stop } from './dispatch-support';

const SANDBOX = '01JC8YV2D4QK7S1M9E3PZ6W8AN';
const DATE = '2026-11-07';
const BASE = `${apiOrigin}/v1/sandboxes/${SANDBOX}/dispatch/${DATE}`;
const KEY = '01JKEY00000000000000000001';
const MINTED = /^[0-9A-HJKMNP-TV-Z]{26}$/;
let fake: ReturnType<typeof fakeFetch> | null = null;
afterEach(() => fake?.restore());

const answer = day([stop(1, 1, 10)], { proposed: plan('server', [{ van: 1, stops: [1] }]) });

describe('getDispatch', () => {
  test('reads the day with the session cookie, no key and no body', async () => {
    fake = fakeFetch([json(answer)]);
    expect(await getDispatch(SANDBOX, DATE)).toEqual(answer);
    expect(fake.calls[0]).toMatchObject({ url: BASE, method: 'GET', body: undefined });
    expect(fake.calls[0]?.headers['Idempotency-Key']).toBeUndefined();
  });

  test('a day outside the sandbox’s days is a 404 with its slug', async () => {
    fake = fakeFetch([problem(404, 'no-such-day', 'No such day')]);
    const error = await getDispatch(SANDBOX, '2027-01-01').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).slug).toBe('no-such-day');
  });
});

describe.each([
  ['proposeDispatch', 'propose', { vans: 3, capacity: 250 }, proposeDispatch],
  ['submitPlan', 'plan', { vans: [{ van: 1, stops: [orderId(1)], start: 0, end: 0 }] }, submitPlan],
  ['publishDispatch', 'publish', { plan: 'proposed' }, publishDispatch],
  ['completeStop', 'complete', { stop: 3 }, completeStop],
] as const)('%s', (_name, suffix, body, call) => {
  // The four writes share one shape: POST, the request as JSON, an Idempotency-Key.
  const send = call as (
    id: string,
    date: string,
    req: typeof body,
    key?: string,
  ) => Promise<unknown>;

  test(`POSTs ${suffix} with the request body and the caller’s key`, async () => {
    fake = fakeFetch([json(answer)]);
    expect(await send(SANDBOX, DATE, body, KEY)).toEqual(answer);
    expect(fake.calls[0]).toMatchObject({ url: `${BASE}/${suffix}`, method: 'POST', body });
    expect(fake.calls[0]?.headers['Idempotency-Key']).toBe(KEY);
    expect(fake.calls[0]?.headers['Content-Type']).toBe('application/json');
  });

  test('mints a key when the caller names none, and a new one each call', async () => {
    fake = fakeFetch([json(answer), json(answer)]);
    await send(SANDBOX, DATE, body);
    await send(SANDBOX, DATE, body);
    const [first, second] = fake.calls.map((c) => c.headers['Idempotency-Key']);
    expect(first).toMatch(MINTED);
    expect(second).toMatch(MINTED);
    expect(first).not.toBe(second);
  });

  test('a guest’s refusal is a 403 guest-scope', async () => {
    fake = fakeFetch([problem(403, 'guest-scope', 'Guests cannot do that')]);
    const error = (await send(SANDBOX, DATE, body).catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(403);
    expect(error.slug).toBe('guest-scope');
  });
});

describe('what the API refuses with', () => {
  test('a propose, a plan, a publish and a completion carry their rule in the detail', async () => {
    fake = fakeFetch([
      problem(422, 'dispatch', 'Dispatch refused', { detail: 'vans' }),
      problem(422, 'dispatch', 'Dispatch refused', { detail: 'over-capacity' }),
      problem(409, 'dispatch', 'Dispatch refused', { detail: 'no-plan' }),
      problem(422, 'dispatch', 'Dispatch refused', { detail: 'stop-unknown' }),
    ]);
    const errors = (await Promise.all([
      proposeDispatch(SANDBOX, DATE, { vans: 9, capacity: 1 }).catch((e: unknown) => e),
      submitPlan(SANDBOX, DATE, { vans: [] }).catch((e: unknown) => e),
      publishDispatch(SANDBOX, DATE, { plan: 'submitted' }).catch((e: unknown) => e),
      completeStop(SANDBOX, DATE, { stop: 99 }).catch((e: unknown) => e),
    ])) as ApiError[];
    expect(errors.map((e) => [e.status, e.slug, e.detail])).toEqual([
      [422, 'dispatch', 'vans'],
      [422, 'dispatch', 'over-capacity'],
      [409, 'dispatch', 'no-plan'],
      [422, 'dispatch', 'stop-unknown'],
    ]);
  });
});

describe('what the page shows for a publish or a completion the Worker refuses', () => {
  // The page's `act` leaves the day it holds as it was when a call throws, and shows the message
  // below; these are the throws the Worker sends (workers/api/src/http/dispatch.rs).
  test('a 409 published on publish is the sentence about the van that has left', async () => {
    fake = fakeFetch([
      problem(409, 'dispatch', 'Dispatch refused', { detail: 'The rule is published.' }),
    ]);
    const error = await publishDispatch(SANDBOX, DATE, { plan: 'submitted' }, KEY).catch(
      (e: unknown) => e,
    );
    expect((error as ApiError).status).toBe(409);
    expect(describeDispatchError(error)).toEqual({
      title: 'Dispatch refused',
      detail: 'A van has already left with this plan, so today’s plan cannot be replaced.',
    });
  });

  test('a 409 no-plan on complete says to publish first', async () => {
    fake = fakeFetch([
      problem(409, 'dispatch', 'Dispatch refused', { detail: 'The rule is no-plan.' }),
    ]);
    const error = await completeStop(SANDBOX, DATE, { stop: 1 }, KEY).catch((e: unknown) => e);
    expect(describeDispatchError(error).detail).toBe(sentenceFor('no-plan'));
    expect(describeDispatchError(error).detail).toContain('publish a plan');
  });

  test('a key reused with another body is a 422 idempotency-key with its sentence', async () => {
    fake = fakeFetch([
      problem(422, 'idempotency-key', 'This Idempotency-Key was already used', {
        detail:
          'This Idempotency-Key was used for a different request. Send a new key with each new request.',
      }),
    ]);
    const error = await submitPlan(SANDBOX, DATE, { vans: [] }, KEY).catch((e: unknown) => e);
    expect(describeDispatchError(error).detail).toBe(sentenceFor('idempotency-key'));
  });
});

describe('publishing twice with one key', () => {
  // The object stores one plan for one key (Idempotent-Replayed); the screen's part is to send the
  // same key for a retry of the same publish, and a new one for a new decision.
  test('a retry after a dropped connection sends the same key; a fresh publish a new one', async () => {
    fake = fakeFetch([
      new Error('offline'),
      json(answer, 200, { 'Idempotent-Replayed': 'true' }),
      json(answer),
    ]);
    const clicks = new KeyedAction();
    const publish = () =>
      clicks.run('2026-11-07:proposed:1', (key) =>
        publishDispatch(SANDBOX, DATE, { plan: 'proposed' }, key),
      );
    await expect(publish()).rejects.toThrow('unreachable');
    await publish();
    await publish();
    const keys = fake.calls.map((c) => c.headers['Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  test('a refusal means the next click is a new attempt', async () => {
    fake = fakeFetch([
      problem(409, 'dispatch', 'Dispatch refused', { detail: 'stop-missing' }),
      json(answer),
    ]);
    const clicks = new KeyedAction();
    const publish = () =>
      clicks.run('same', (key) => publishDispatch(SANDBOX, DATE, { plan: 'proposed' }, key));
    await expect(publish()).rejects.toBeInstanceOf(ApiError);
    await publish();
    const [a, b] = fake.calls.map((c) => c.headers['Idempotency-Key']);
    expect(a).not.toBe(b);
  });
});
