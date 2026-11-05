import { describe, expect, test } from 'vitest';
import { ApiError, NetworkError } from '../src/lib/api';
import {
  describeCrmError,
  earliestIn,
  earliestOf,
  ruleOf,
  sentenceFor,
} from '../src/lib/crm-errors';

const error = (status: number, slug: string, detail: string | null, title = 'Refused') =>
  new ApiError(
    {
      status,
      type: `https://bakery.example.test/problems/${slug}`,
      title,
      detail,
      next_free: null,
    },
    null,
  );

describe('the rule a detail names', () => {
  test('whole words only', () => {
    expect(ruleOf('out-of-order')).toBe('out-of-order');
    expect(ruleOf('campaign is out-of-order: sent')).toBe('out-of-order');
    expect(ruleOf('schedule-too-soon: earliest 2026-11-08T09:30:00-07:00')).toBe(
      'schedule-too-soon',
    );
    expect(ruleOf('notaudience')).toBeNull();
    expect(ruleOf('audience-mismatch-x')).toBeNull();
    expect(ruleOf(null)).toBeNull();
  });
});

describe('the earliest time a refusal names', () => {
  test('a time with the bakery’s offset is the input value as written', () => {
    expect(earliestIn('schedule-too-soon: earliest 2026-11-08T09:30:00-07:00')).toBe(
      '2026-11-08T09:30',
    );
  });

  test('a UTC time is converted to the bakery’s wall clock', () => {
    expect(earliestIn('earliest allowed 2026-11-08T16:30:00Z')).toBe('2026-11-08T09:30');
  });

  test('a time with no offset is already the bakery’s', () => {
    expect(earliestIn('earliest 2026-11-08T09:30')).toBe('2026-11-08T09:30');
  });

  test('no time, no answer', () => {
    expect(earliestIn('schedule-too-soon')).toBeNull();
    expect(earliestIn(null)).toBeNull();
  });

  test('earliestOf reads it from a schedule refusal and from nothing else', () => {
    const soon = error(422, 'campaign', 'schedule-too-soon 2026-11-08T09:30:00-07:00');
    expect(earliestOf(soon)).toBe('2026-11-08T09:30');
    expect(earliestOf(error(409, 'campaign', 'out-of-order 2026-11-08T09:30:00-07:00'))).toBeNull();
    expect(earliestOf(new NetworkError())).toBeNull();
  });
});

describe('describeCrmError', () => {
  test('422 schedule-too-soon: the sentence, with the earliest time', () => {
    const m = describeCrmError(
      error(422, 'campaign', 'schedule-too-soon: earliest 2026-11-08T09:30:00-07:00', 'Too soon'),
    );
    expect(m.title).toBe('Too soon');
    expect(m.detail).toContain('at least 15 minutes ahead');
    expect(m.detail).toContain('The earliest time is 2026-11-08 09:30.');
  });

  test('409 out-of-order', () => {
    const m = describeCrmError(error(409, 'campaign', 'out-of-order'));
    expect(m.detail).toContain('Only a draft can be edited or scheduled');
  });

  test('409 rebuild while one runs is named by the slug', () => {
    const m = describeCrmError(error(409, 'rebuild', null));
    expect(m.detail).toBe('A rebuild is already running. Wait for it to finish.');
  });

  test('403 guest-scope', () => {
    expect(describeCrmError(error(403, 'guest-scope', null)).detail).toContain('Sign in');
  });

  test('404 says it is gone', () => {
    expect(describeCrmError(error(404, 'not-found', null)).detail).toContain('not in this sandbox');
  });

  test('a 409 naming no rule shows the API’s own words', () => {
    expect(describeCrmError(error(409, 'other', 'try again')).detail).toBe('try again');
  });

  test('anything else is the general wording, and a network error says nothing changed', () => {
    expect(describeCrmError(new NetworkError()).detail).toContain('Nothing was changed');
    expect(describeCrmError(new Error('x')).title).toBe('Something went wrong');
    expect(sentenceFor('nope')).toBeNull();
  });
});
