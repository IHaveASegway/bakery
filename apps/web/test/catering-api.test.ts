import { afterEach, describe, expect, test } from 'vitest';
import {
  ApiError,
  acceptQuote,
  apiOrigin,
  cancelCatering,
  createDeposit,
  declineInquiry,
  getCatering,
  listCatering,
  markCateringDelivered,
  payBalance,
  sendQuote,
  staffCancelCatering,
  startCateringProduction,
  submitInquiry,
} from '../src/lib/api';
import type { CateringInquiryRequest, CateringResponse } from '../src/contracts';
import { fakeFetch, json, problem } from './support';

const SANDBOX = '01JC8YV2D4QK7S1M9E3PZ6W8AN';
const CID = '01JCATERING000000000000AB';
const BASE = `${apiOrigin}/v1/sandboxes/${SANDBOX}/catering`;
let fake: ReturnType<typeof fakeFetch> | null = null;
afterEach(() => fake?.restore());

const response = (state: CateringResponse['state']): CateringResponse => ({
  catering: CID,
  state,
  date: '2026-11-20',
  headcount: 40,
  package: 'breakfast-spread',
  venue: 'v3',
  created_at: '2026-11-03T10:00:00-07:00',
  updated_at: '2026-11-03T10:00:00-07:00',
  reminders: [],
});

const inquiry: CateringInquiryRequest = {
  date: '2026-11-20',
  headcount: 40,
  package: 'breakfast-spread',
  venue: 'v3',
  brief: 'Setup at 8',
};

describe('submitInquiry', () => {
  test('POSTs the inquiry to /catering with the caller’s key and returns the event', async () => {
    fake = fakeFetch([json(response('inquiry'), 201, { Location: `/v1/x/catering/${CID}` })]);
    const event = await submitInquiry(SANDBOX, inquiry, '01JKEY00000000000000000001');
    expect(event.state).toBe('inquiry');
    const [call] = fake.calls;
    expect(call?.url).toBe(BASE);
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual(inquiry);
    expect(call?.headers['Idempotency-Key']).toBe('01JKEY00000000000000000001');
    expect(call?.headers['Content-Type']).toBe('application/json');
  });

  test('a replayed key answers 200 with the same event', async () => {
    fake = fakeFetch([json(response('inquiry'), 200, { 'Idempotent-Replayed': 'true' })]);
    expect((await submitInquiry(SANDBOX, inquiry, 'k')).catering).toBe(CID);
  });

  test('a refused inquiry is an ApiError with the rule in its detail', async () => {
    fake = fakeFetch([problem(422, 'catering', 'Refused', { detail: 'brief-email' })]);
    const error = await submitInquiry(SANDBOX, inquiry, 'k').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).slug).toBe('catering');
    expect((error as ApiError).detail).toBe('brief-email');
  });
});

describe('the reads', () => {
  test('listCatering GETs /catering without a key', async () => {
    fake = fakeFetch([json({ events: [response('quoted')] })]);
    expect((await listCatering(SANDBOX)).events).toHaveLength(1);
    const [call] = fake.calls;
    expect(call?.url).toBe(BASE);
    expect(call?.method).toBe('GET');
    expect(call?.headers['Idempotency-Key']).toBeUndefined();
  });

  test('getCatering GETs /catering/{cid}, and another sandbox’s id is a 404', async () => {
    fake = fakeFetch([json(response('quoted')), problem(404, 'not-found', 'Not found')]);
    await getCatering(SANDBOX, CID);
    expect(fake.calls[0]?.url).toBe(`${BASE}/${CID}`);
    expect(fake.calls[0]?.method).toBe('GET');
    const error = await getCatering(SANDBOX, 'OTHER').catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(404);
  });

  test('ids are encoded into the path', async () => {
    fake = fakeFetch([json(response('quoted'))]);
    await getCatering('a/b', 'c d');
    expect(fake.calls[0]?.url).toBe(`${apiOrigin}/v1/sandboxes/a%2Fb/catering/c%20d`);
  });
});

describe('the customer’s actions', () => {
  test('acceptQuote POSTs /accept with no body and a fresh key each time', async () => {
    fake = fakeFetch([json(response('accepted')), json(response('accepted'))]);
    await acceptQuote(SANDBOX, CID);
    await acceptQuote(SANDBOX, CID);
    const [a, b] = fake.calls;
    expect(a?.url).toBe(`${BASE}/${CID}/accept`);
    expect(a?.method).toBe('POST');
    expect(a?.body).toBeUndefined();
    expect(a?.headers['Content-Type']).toBeUndefined();
    expect(a?.headers['Idempotency-Key']).toMatch(/^[0-9A-Z]{26}$/);
    expect(a?.headers['Idempotency-Key']).not.toBe(b?.headers['Idempotency-Key']);
  });

  test('createDeposit POSTs /deposit with the catering id as the key and returns the intent', async () => {
    const intent = {
      amount_cents: 14_500,
      client_secret: 'pi_test_secret_x',
      payment: '01JPAYMENT000000000000AA',
      status: 'created',
    };
    fake = fakeFetch([json(intent), json(intent)]);
    expect((await createDeposit(SANDBOX, CID)).amount_cents).toBe(14_500);
    await createDeposit(SANDBOX, CID);
    for (const call of fake.calls) {
      expect(call.url).toBe(`${BASE}/${CID}/deposit`);
      expect(call.method).toBe('POST');
      expect(call.body).toBeUndefined();
      expect(call.headers['Idempotency-Key']).toBe(CID);
    }
  });

  test('payBalance POSTs /pay-balance with the catering id as the key; 202 is a success', async () => {
    fake = fakeFetch([json(response('invoiced'), 202)]);
    expect((await payBalance(SANDBOX, CID)).state).toBe('invoiced');
    const [call] = fake.calls;
    expect(call?.url).toBe(`${BASE}/${CID}/pay-balance`);
    expect(call?.body).toBeUndefined();
    expect(call?.headers['Idempotency-Key']).toBe(CID);
  });

  test('cancelCatering POSTs /cancel with the reason and no actor: the Worker derives it', async () => {
    fake = fakeFetch([json({ ...response('cancelled'), refund_deposit: true })]);
    const event = await cancelCatering(SANDBOX, CID, { reason: 'venue_lost' });
    expect(event.refund_deposit).toBe(true);
    const [call] = fake.calls;
    expect(call?.url).toBe(`${BASE}/${CID}/cancel`);
    expect(call?.body).toEqual({ reason: 'venue_lost' });
    expect(call?.headers['Idempotency-Key']).toMatch(/^[0-9A-Z]{26}$/);
  });

  test('a step out of order is a 409 ApiError naming the rule', async () => {
    fake = fakeFetch([problem(409, 'catering', 'Out of order', { detail: 'out-of-order' })]);
    const error = await acceptQuote(SANDBOX, CID).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).detail).toBe('out-of-order');
  });
});

describe('staff’s actions', () => {
  test('sendQuote POSTs /quote with the optional total, and an empty object without one', async () => {
    fake = fakeFetch([json(response('quoted')), json(response('quoted'))]);
    await sendQuote(SANDBOX, CID, { total_cents: 240_000 });
    await sendQuote(SANDBOX, CID, {});
    expect(fake.calls[0]?.url).toBe(`${BASE}/${CID}/quote`);
    expect(fake.calls[0]?.method).toBe('POST');
    expect(fake.calls[0]?.body).toEqual({ total_cents: 240_000 });
    expect(fake.calls[1]?.body).toEqual({});
  });

  test('declineInquiry POSTs /decline with the reason', async () => {
    fake = fakeFetch([json(response('declined'))]);
    await declineInquiry(SANDBOX, CID, { reason: 'over_capacity' });
    expect(fake.calls[0]?.url).toBe(`${BASE}/${CID}/decline`);
    expect(fake.calls[0]?.body).toEqual({ reason: 'over_capacity' });
  });

  test('startCateringProduction and markCateringDelivered POST with no body', async () => {
    fake = fakeFetch([json(response('in_production')), json(response('delivered'))]);
    await startCateringProduction(SANDBOX, CID);
    await markCateringDelivered(SANDBOX, CID);
    expect(fake.calls.map((c) => c.url)).toEqual([
      `${BASE}/${CID}/start-production`,
      `${BASE}/${CID}/delivered`,
    ]);
    for (const call of fake.calls) {
      expect(call.method).toBe('POST');
      expect(call.body).toBeUndefined();
      expect(call.headers['Idempotency-Key']).toMatch(/^[0-9A-Z]{26}$/);
    }
  });

  test('staffCancelCatering POSTs /staff-cancel with the reason', async () => {
    fake = fakeFetch([json(response('cancelled'))]);
    await staffCancelCatering(SANDBOX, CID, { reason: 'other' });
    expect(fake.calls[0]?.url).toBe(`${BASE}/${CID}/staff-cancel`);
    expect(fake.calls[0]?.body).toEqual({ reason: 'other' });
  });

  test('a guest is refused with a 403 guest-scope', async () => {
    fake = fakeFetch([problem(403, 'guest-scope', 'Not for guests', { detail: 'sign in' })]);
    const error = await markCateringDelivered(SANDBOX, CID).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).slug).toBe('guest-scope');
  });
});
