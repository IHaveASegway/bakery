import { afterEach, describe, expect, test } from 'vitest';
import { apiOrigin, getMessage, listInbox } from '../src/lib/api';
import {
  ALL_KINDS,
  MESSAGE_KINDS,
  countText,
  engagementText,
  filterOf,
  kindLabel,
  namesOf,
  recipientName,
} from '../src/lib/inbox';
import { fakeFetch, json } from './support';

const SANDBOX = '01JC8YV2D4QK7S1M9E3PZ6W8AN';
const BASE = `${apiOrigin}/v1/sandboxes/${SANDBOX}/inbox`;
let fake: ReturnType<typeof fakeFetch> | null = null;
afterEach(() => fake?.restore());

describe('the filter', () => {
  test('all kinds and no recipient is no filter', () => {
    expect(filterOf(ALL_KINDS, '')).toEqual({ kind: undefined, to: undefined, limit: undefined });
  });

  test('a known kind and a recipient go through; an unknown kind does not', () => {
    expect(filterOf('campaign', 'CUST', 50)).toEqual({ kind: 'campaign', to: 'CUST', limit: 50 });
    expect(filterOf('spam', '').kind).toBeUndefined();
  });

  test('the select offers every kind the contract names, once', () => {
    expect(MESSAGE_KINDS.map((k) => k.kind)).toEqual([
      'receipt',
      'ready',
      'on_its_way',
      'refund',
      'declined',
      'acknowledgement',
      'quote',
      'notice',
      'reminder',
      'invoice',
      'campaign',
    ]);
    expect(kindLabel('on_its_way')).toBe('On its way');
    expect(kindLabel('future_kind')).toBe('future kind');
  });

  test('the filter becomes the query the API takes', async () => {
    fake = fakeFetch([json({ messages: [], total: 0 }), json({ messages: [], total: 0 })]);
    await listInbox(SANDBOX);
    await listInbox(SANDBOX, filterOf('campaign', 'CUST ONE', 20));
    expect(fake.calls[0]?.url).toBe(BASE);
    expect(fake.calls[1]?.url).toBe(`${BASE}?kind=campaign&to=CUST+ONE&limit=20`);
    for (const call of fake.calls) {
      expect(call.method).toBe('GET');
      expect(call.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  test('one message is read by id', async () => {
    fake = fakeFetch([json({ message: 'M1' })]);
    await getMessage(SANDBOX, 'M/1');
    expect(fake.calls[0]?.url).toBe(`${BASE}/M%2F1`);
  });
});

// Business now for the dates printed here: a day in 2026, so none carries its year whatever year the
// machine's clock says.
const NOW = Date.parse('2026-11-10T16:00:00Z');

describe('names and words', () => {
  test('a recipient is shown by display name, and by a short id until the list arrives', () => {
    const names = namesOf([
      { customer: '01JAAAAAAAAAAAAAAAAAAAAAAB', display_name: 'Drizzle Trowel' },
    ]);
    expect(recipientName(names, '01JAAAAAAAAAAAAAAAAAAAAAAB')).toBe('Drizzle Trowel');
    expect(recipientName(names, '01JZZZZZZZZZZZZZZZZZZZ123456')).toBe('customer 123456');
  });

  test('opens and clicks as they appear', () => {
    expect(engagementText({})).toBe('Not opened');
    expect(engagementText({ opened_at: '2026-11-07T10:15:00-07:00', clicked_at: null }, NOW)).toBe(
      'Opened Sat 7 Nov, 10:15 am',
    );
    expect(
      engagementText(
        {
          opened_at: '2026-11-07T10:15:00-07:00',
          clicked_at: '2026-11-07T10:20:00-07:00',
        },
        NOW,
      ),
    ).toBe('Opened Sat 7 Nov, 10:15 am, clicked Sat 7 Nov, 10:20 am');
  });

  test('how many are shown of how many there are', () => {
    expect(countText(0, 0)).toBe('The inbox is empty.');
    expect(countText(1, 1)).toBe('1 message.');
    expect(countText(50, 50)).toBe('50 messages.');
    expect(countText(50, 240)).toBe('Showing the newest 50 of 240 messages.');
  });
});
