import { describe, expect, test } from 'vitest';
import { formatCountdown, utcClock } from '../src/lib/countdown';
import { parseProblem, problemSlug } from '../src/lib/problem';

describe('parseProblem', () => {
  test('reads a problem+json body', () => {
    const body = JSON.stringify({
      type: 'https://bakery.ihaveasegway.com/problems/sandbox-cap',
      title: 'No more sandboxes today',
      status: 503,
      detail: 'The daily cap is reached.',
      instance: '/v1/sandboxes',
    });
    expect(parseProblem(503, body)).toEqual({
      status: 503,
      type: 'https://bakery.ihaveasegway.com/problems/sandbox-cap',
      title: 'No more sandboxes today',
      detail: 'The daily cap is reached.',
    });
  });

  test('a null or missing detail is null', () => {
    const body = JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 });
    expect(parseProblem(404, body).detail).toBeNull();
  });

  test('a body that is not a problem still gives one, from the status', () => {
    for (const body of ['', '<html>Bad gateway</html>', '{"ok":false}', '42', 'null']) {
      const p = parseProblem(502, body);
      expect(p.status).toBe(502);
      expect(p.type).toBe('about:blank');
      expect(p.title).toContain('502');
    }
  });

  test('the slug is the last path segment', () => {
    expect(problemSlug('https://bakery.ihaveasegway.com/problems/guest-cap')).toBe('guest-cap');
    expect(problemSlug('about:blank')).toBe('about:blank');
  });
});

describe('countdown', () => {
  test('says hours and minutes, then minutes, then under a minute, then now', () => {
    expect(formatCountdown((6 * 60 + 12) * 60_000)).toBe('6 h 12 min');
    expect(formatCountdown(12 * 60_000)).toBe('12 min');
    expect(formatCountdown(30_000)).toBe('under a minute');
    expect(formatCountdown(0)).toBe('now');
  });

  test('reads the clock time in UTC', () => {
    expect(utcClock('2026-11-06T10:00:00.000Z')).toBe('10:00 UTC');
  });
});
