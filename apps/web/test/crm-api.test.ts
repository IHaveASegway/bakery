import { afterEach, describe, expect, test } from 'vitest';
import {
  ApiError,
  apiOrigin,
  cancelCampaign,
  createCampaign,
  editCampaign,
  getActivity,
  getCampaign,
  getCustomer,
  getLeads,
  getRebuild,
  getSegment,
  getTimeline,
  listCampaigns,
  listCustomers,
  listSegments,
  scheduleCampaign,
  setConsent,
  startRebuild,
} from '../src/lib/api';
import { fakeFetch, json, problem } from './support';

const SANDBOX = '01JC8YV2D4QK7S1M9E3PZ6W8AN';
const CUST = '01JC8Z6F0WQ3E5R7T9Y1V3K5P7';
const CAMP = '01JC8ZCAMPAIGN0000000000AA';
const BASE = `${apiOrigin}/v1/sandboxes/${SANDBOX}`;
const KEY = '01JKEY00000000000000000001';
const MINTED = /^[0-9A-HJKMNP-TV-Z]{26}$/;
let fake: ReturnType<typeof fakeFetch> | null = null;
afterEach(() => fake?.restore());

const campaign = {
  campaign: CAMP,
  state: 'draft',
  subject: 'cake-week',
  body: 'cake-orders',
  segment: 'everyone',
  recipients: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
};
const request = { subject: 'cake-week', body: 'cake-orders', segment: 'everyone' } as const;

describe('the reads send no key and no body', () => {
  test.each([
    ['listCustomers', () => listCustomers(SANDBOX), `${BASE}/customers`],
    ['getCustomer', () => getCustomer(SANDBOX, CUST), `${BASE}/customers/${CUST}`],
    ['getTimeline', () => getTimeline(SANDBOX, CUST), `${BASE}/customers/${CUST}/timeline`],
    ['listSegments', () => listSegments(SANDBOX), `${BASE}/segments`],
    ['getSegment', () => getSegment(SANDBOX, 'lapsed-60-days'), `${BASE}/segments/lapsed-60-days`],
    ['listCampaigns', () => listCampaigns(SANDBOX), `${BASE}/campaigns`],
    ['getCampaign', () => getCampaign(SANDBOX, CAMP), `${BASE}/campaigns/${CAMP}`],
    ['getLeads', () => getLeads(SANDBOX), `${BASE}/leads`],
    ['getActivity', () => getActivity(SANDBOX), `${BASE}/activity`],
    ['getActivity with a limit', () => getActivity(SANDBOX, 30), `${BASE}/activity?limit=30`],
    ['getRebuild', () => getRebuild(SANDBOX), `${BASE}/rebuild`],
  ])('%s', async (_name, call, url) => {
    fake = fakeFetch([json({})]);
    await call();
    const [sent] = fake.calls;
    expect(sent?.url).toBe(url);
    expect(sent?.method).toBe('GET');
    expect(sent?.headers['Idempotency-Key']).toBeUndefined();
    expect(sent?.body).toBeUndefined();
  });

  test('an id is escaped into the path', async () => {
    fake = fakeFetch([json({})]);
    await getCustomer(SANDBOX, 'a/b');
    expect(fake.calls[0]?.url).toBe(`${BASE}/customers/a%2Fb`);
  });
});

describe('the writes', () => {
  test('setConsent POSTs {marketing} to /customers/{cid}/consent with the caller’s key', async () => {
    fake = fakeFetch([json({ customer: CUST, marketing: false })]);
    await setConsent(SANDBOX, CUST, { marketing: false }, KEY);
    const [sent] = fake.calls;
    expect(sent?.url).toBe(`${BASE}/customers/${CUST}/consent`);
    expect(sent?.method).toBe('POST');
    expect(sent?.body).toEqual({ marketing: false });
    expect(sent?.headers['Idempotency-Key']).toBe(KEY);
  });

  test('createCampaign POSTs the three template choices to /campaigns', async () => {
    fake = fakeFetch([
      json(campaign, 201, { Location: `/v1/sandboxes/${SANDBOX}/campaigns/${CAMP}` }),
    ]);
    expect((await createCampaign(SANDBOX, request, KEY)).campaign).toBe(CAMP);
    const [sent] = fake.calls;
    expect(sent?.url).toBe(`${BASE}/campaigns`);
    expect(sent?.method).toBe('POST');
    expect(sent?.body).toEqual(request);
    expect(sent?.headers['Idempotency-Key']).toBe(KEY);
  });

  test('editCampaign PATCHes /campaigns/{cid} and sends its key (a PATCH otherwise sends none)', async () => {
    fake = fakeFetch([json(campaign)]);
    await editCampaign(SANDBOX, CAMP, { ...request, segment: 'lapsed-60-days' }, KEY);
    const [sent] = fake.calls;
    expect(sent?.url).toBe(`${BASE}/campaigns/${CAMP}`);
    expect(sent?.method).toBe('PATCH');
    expect(sent?.body).toEqual({ ...request, segment: 'lapsed-60-days' });
    expect(sent?.headers['Idempotency-Key']).toBe(KEY);
  });

  test('scheduleCampaign POSTs {send_at} to /campaigns/{cid}/schedule', async () => {
    fake = fakeFetch([json({ ...campaign, state: 'scheduled' })]);
    await scheduleCampaign(SANDBOX, CAMP, { send_at: '2026-11-08T09:30:00-07:00' }, KEY);
    const [sent] = fake.calls;
    expect(sent?.url).toBe(`${BASE}/campaigns/${CAMP}/schedule`);
    expect(sent?.method).toBe('POST');
    expect(sent?.body).toEqual({ send_at: '2026-11-08T09:30:00-07:00' });
    expect(sent?.headers['Idempotency-Key']).toBe(KEY);
  });

  test('cancelCampaign POSTs no body to /campaigns/{cid}/cancel', async () => {
    fake = fakeFetch([json({ ...campaign, state: 'cancelled' })]);
    await cancelCampaign(SANDBOX, CAMP, KEY);
    const [sent] = fake.calls;
    expect(sent?.url).toBe(`${BASE}/campaigns/${CAMP}/cancel`);
    expect(sent?.method).toBe('POST');
    expect(sent?.body).toBeUndefined();
    expect(sent?.headers['Idempotency-Key']).toBe(KEY);
  });

  test('startRebuild POSTs no body to /rebuild and the 202 is the answer', async () => {
    fake = fakeFetch([json({ state: 'rebuilding', applied: 0, total: 722 }, 202)]);
    expect(await startRebuild(SANDBOX, KEY)).toEqual({
      state: 'rebuilding',
      applied: 0,
      total: 722,
    });
    const [sent] = fake.calls;
    expect(sent?.url).toBe(`${BASE}/rebuild`);
    expect(sent?.method).toBe('POST');
    expect(sent?.body).toBeUndefined();
    expect(sent?.headers['Idempotency-Key']).toBe(KEY);
  });

  test('a write without a key mints one, and each call mints its own', async () => {
    fake = fakeFetch([json({}), json({}), json({}), json({}), json({})]);
    await setConsent(SANDBOX, CUST, { marketing: true });
    await createCampaign(SANDBOX, request);
    await scheduleCampaign(SANDBOX, CAMP, { send_at: '2026-11-08T09:30:00-07:00' });
    await cancelCampaign(SANDBOX, CAMP);
    await startRebuild(SANDBOX);
    const keys = fake.calls.map((c) => c.headers['Idempotency-Key']);
    for (const key of keys) expect(key).toMatch(MINTED);
    expect(new Set(keys).size).toBe(5);
  });

  test('the cookie rides along: every call sends credentials', async () => {
    fake = fakeFetch([json({})]);
    await listCampaigns(SANDBOX);
    const mock = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock;
    expect(mock.calls[0]?.[1].credentials).toBe('include');
  });
});

describe('problems', () => {
  test('a too-soon schedule is an ApiError: slug campaign, rule in the detail', async () => {
    fake = fakeFetch([
      problem(422, 'campaign', 'Too soon', {
        detail: 'schedule-too-soon: earliest 2026-11-08T09:30:00-07:00',
      }),
    ]);
    const e = await scheduleCampaign(SANDBOX, CAMP, { send_at: 'x' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(422);
    expect((e as ApiError).slug).toBe('campaign');
    expect((e as ApiError).detail).toContain('schedule-too-soon');
  });

  test('a second rebuild is a 409 rebuild; a guest’s staff action is a 403 guest-scope', async () => {
    fake = fakeFetch([
      problem(409, 'rebuild', 'A rebuild is running'),
      problem(403, 'guest-scope', 'Sign in'),
    ]);
    const a = (await startRebuild(SANDBOX).catch((x: unknown) => x)) as ApiError;
    const b = (await cancelCampaign(SANDBOX, CAMP).catch((x: unknown) => x)) as ApiError;
    expect([a.status, a.slug]).toEqual([409, 'rebuild']);
    expect([b.status, b.slug]).toEqual([403, 'guest-scope']);
  });
});
