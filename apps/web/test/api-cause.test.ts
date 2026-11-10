import { afterEach, describe, expect, test } from 'vitest';
import { patchMenuItem, proposeDispatch, setCapacity } from '../src/lib/api';
import { causeOf } from '../src/lib/cause';
import { pageSource, type Evidence, type WatchEvidence } from '../src/lib/trace';
import { fakeFetch, json, problem, scheduleFor } from './support';

// Every write can be followed (ADR 0013's postscript of 2026-11-10): the API names the cause a
// command's events carry in `Bakery-Cause`, and the page's trace records that as the call's key,
// which is what the guide's store ties events to (lib/trace.ts, `createTraceStore`).

const SANDBOX = '01JC8YV2D4QK7S1M9E3PZ6W8AN';
const SENT = '01JC8Z6K3W9QF2N4T7XRB5M0HD';
let fake: ReturnType<typeof fakeFetch> | null = null;
let stop: (() => void) | null = null;
afterEach(() => {
  fake?.restore();
  stop?.();
});

function recorded(): Extract<Evidence, { kind: 'call' }>[] {
  const seen: Extract<Evidence, { kind: 'call' }>[] = [];
  stop = pageSource.connect({
    record(evidence: Evidence | WatchEvidence) {
      if (evidence.kind === 'call') seen.push(evidence);
    },
  });
  return seen;
}

describe('causeOf', () => {
  test('reads Bakery-Cause, and nothing from an answer without it', () => {
    expect(causeOf(new Response(null, { headers: { 'Bakery-Cause': `capacity:${SENT}` } }))).toBe(
      `capacity:${SENT}`,
    );
    expect(causeOf(new Response(null))).toBeNull();
    expect(causeOf(new Response(null, { headers: { 'Bakery-Cause': ' ' } }))).toBeNull();
    expect(causeOf(null)).toBeNull();
  });
});

describe('a write the page makes is traced under its cause', () => {
  test('a PATCH sent without a key is traced under the cause the API named', async () => {
    const seen = recorded();
    fake = fakeFetch([
      json(scheduleFor('2026-11-07'), 200, { 'Bakery-Cause': `capacity:${SENT}` }),
    ]);
    await setCapacity(SANDBOX, '2026-11-07', { target: 'slot:07:45', capacity: 3 });
    expect(fake.calls[0]?.headers['Idempotency-Key']).toBeUndefined();
    expect(seen.map((c) => [c.method, c.key])).toEqual([['PATCH', `capacity:${SENT}`]]);
  });

  test('a price edit is traced under the key the API made for it', async () => {
    const seen = recorded();
    fake = fakeFetch([
      json({ version: 2, pending: ['country-loaf'] }, 200, { 'Bakery-Cause': SENT }),
    ]);
    await patchMenuItem(SANDBOX, 'country-loaf', { price_cents: 900 });
    expect(seen[0]?.key).toBe(SENT);
  });

  test('a POST whose events carry a prefixed cause is traced under that, not the bare key', async () => {
    const seen = recorded();
    fake = fakeFetch([json({}, 200, { 'Bakery-Cause': `propose:${SENT}` })]);
    await proposeDispatch(SANDBOX, '2026-11-07', { vans: 2, capacity: 40 }, SENT);
    expect(fake.calls[0]?.headers['Idempotency-Key']).toBe(SENT);
    expect(seen[0]?.key).toBe(`propose:${SENT}`);
  });

  test('a refusal names no cause, so the call keeps the key it sent', async () => {
    const seen = recorded();
    fake = fakeFetch([problem(422, 'dispatch', 'Refused', { detail: 'The rule is no-stops.' })]);
    await proposeDispatch(SANDBOX, '2026-11-07', { vans: 2, capacity: 40 }, SENT).catch(
      () => undefined,
    );
    expect(seen[0]?.key).toBe(SENT);
    expect(seen[0]?.status).toBe(422);
  });
});
