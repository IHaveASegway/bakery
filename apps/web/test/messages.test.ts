// The words for an API problem: the Retry-After sentence is added once, never a second time after a
// detail that already says it (2026-11-10).
import { describe, expect, test } from 'vitest';
import { ApiError } from '../src/lib/api';
import { describeError } from '../src/lib/messages';

const problem = (detail: string | null) => ({
  status: 429,
  type: 'https://bakery.ihaveasegway.com/problems/rate-limit',
  title: 'Slow down',
  detail,
  next_free: null,
});

describe('describeError and Retry-After', () => {
  test('adds when to try again to a detail that does not say it', () => {
    const said = describeError(new ApiError(problem('Too many requests from here.'), 60));
    expect(said.detail).toBe('Too many requests from here. Try again in a minute.');
  });

  test('says it once when the detail already does', () => {
    const detail = 'Too many requests from here in the last minute. Try again in a minute.';
    expect(describeError(new ApiError(problem(detail), 60)).detail).toBe(detail);
  });

  test('a detail-less problem gets the sentence alone, and no Retry-After adds nothing', () => {
    expect(describeError(new ApiError(problem(null), 600)).detail).toBe(
      'Try again in about 10 minutes.',
    );
    expect(describeError(new ApiError(problem('Gone.'), null)).detail).toBe('Gone.');
  });
});
