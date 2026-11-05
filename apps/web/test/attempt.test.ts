import { describe, expect, test } from 'vitest';
import { ApiError, NetworkError } from '../src/lib/api';
import { attemptFor, keepKeyAfter } from '../src/lib/attempt';
import { describeOrderError, ruleOf } from '../src/lib/order-errors';

const problem = (status: number, detail: string | null = null) =>
  new ApiError(
    { status, type: 'https://example.test/problems/order', title: 'Order', detail },
    null,
  );

describe('the idempotency key of a checkout attempt', () => {
  const counter = () => {
    let n = 0;
    return () => `key-${++n}`;
  };

  test('a retry of the same attempt sends the same key', () => {
    const mint = counter();
    const first = attemptFor(null, '{"a":1}', mint);
    expect(attemptFor(first, '{"a":1}', mint).key).toBe(first.key);
  });

  test('a changed order is a new attempt with a new key', () => {
    const mint = counter();
    const first = attemptFor(null, '{"a":1}', mint);
    const second = attemptFor(first, '{"a":2}', mint);
    expect(second.key).not.toBe(first.key);
  });

  test('an unanswered request and a server error keep the key; a refusal does not', () => {
    expect(keepKeyAfter(new NetworkError())).toBe(true);
    expect(keepKeyAfter(problem(503))).toBe(true);
    expect(keepKeyAfter(problem(500))).toBe(true);
    expect(keepKeyAfter(problem(422, 'lead-time'))).toBe(false);
    expect(keepKeyAfter(problem(429))).toBe(false);
    expect(keepKeyAfter(new Error('other'))).toBe(false);
  });
});

describe('the 422 shown as a sentence', () => {
  test('finds the rule the detail names, longest first', () => {
    expect(ruleOf('note-email')).toBe('note-email');
    expect(ruleOf('The order broke a rule: lead-time')).toBe('lead-time');
    expect(ruleOf('note-card-number')).toBe('note-card-number');
    expect(ruleOf('note')).toBe('note');
    expect(ruleOf('something else')).toBeNull();
    expect(ruleOf(null)).toBeNull();
  });

  test.each(['note-email', 'note-phone', 'note-card-number', 'note-url'])(
    'the class %s becomes a sentence that names the class and nothing typed',
    (rule) => {
      const message = describeOrderError(problem(422, rule));
      expect(message.title).toBe('The bakery could not take this order');
      expect(message.detail).toMatch(/note/i);
      expect(message.detail).not.toContain(rule);
    },
  );

  test('another status gets the general words', () => {
    expect(describeOrderError(problem(503)).title).toBe('Order');
    expect(describeOrderError(new NetworkError()).title).toBe('The API is unreachable');
  });
});
