import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ApiError, NetworkError } from '../src/lib/api';
import { attemptFor, keepKeyAfter } from '../src/lib/attempt';
import { describeOrderError, ruleOf } from '../src/lib/order-errors';
import { parseProblem } from '../src/lib/problem';

const problem = (status: number, detail: string | null = null) =>
  new ApiError(
    {
      status,
      type: 'https://example.test/problems/order',
      title: 'Order',
      detail,
      next_free: null,
    },
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

  test('a command the demo’s flag refused shows the API’s sentence (roadmap R85)', () => {
    // The 503s the router answers at read-only and off, as parsed from the wire.
    for (const [slug, title, detail] of [
      [
        'read-only',
        'The demo is read-only',
        'The demo is read-only for now: sandboxes can be looked at, not changed.',
      ],
      [
        'off',
        'The demo is switched off',
        "The demo is off for now. The storefront's pages and the status page still work.",
      ],
    ] as const) {
      const refused = new ApiError(
        parseProblem(
          503,
          JSON.stringify({
            type: `https://bakery.ihaveasegway.com/problems/${slug}`,
            title,
            status: 503,
            detail,
          }),
        ),
        null,
      );
      const message = describeOrderError(refused);
      expect(message.title).toBe(title);
      expect(message.detail).toBe(detail);
    }
  });

  // Every rule placing an order can answer has words of its own, read from the domain that owns
  // the rules: the Order's (`place_order`, `delivery_zone` and a second placement) and the four
  // the day's hold answers 422 with (crates/domain/src/schedule.rs, `ScheduleError::rule`).
  const rust = (path: string) => {
    const file = fileURLToPath(new URL(`../../../${path}`, import.meta.url));
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };
  const order = rust('crates/domain/src/order.rs');
  const schedule = rust('crates/domain/src/schedule.rs');

  test.skipIf(order === null || schedule === null)(
    'every rule an order can be refused by has its own sentence',
    () => {
      const text = order ?? '';
      const body = (start: string) => {
        const from = text.indexOf(start);
        expect(from, start).toBeGreaterThan(-1);
        const end = text.indexOf('\n}\n', from);
        return text.slice(from, end);
      };
      const variants = new Set(
        [
          body('fn place_order('),
          body('pub fn delivery_zone('),
          /OrderCommand::PlaceOrder\(_\) => Err\(OrderError::\w+\)/.exec(text)?.[0] ?? '',
        ].flatMap((part) => [...part.matchAll(/OrderError::(\w+)/g)].map((m) => m[1] ?? '')),
      );
      // The slug each variant's arm of `rule()` names.
      const ruleFn = (source: string) => {
        const from = source.indexOf('pub fn rule(&self)');
        return source.slice(from, source.indexOf('\n    }\n', from));
      };
      const slugOf = (enumName: string, source: string, variant: string) =>
        new RegExp(`${enumName}::${variant}\\b[^=]*=> "([a-z-]+)"`).exec(ruleFn(source))?.[1];
      const rules = [...variants].map((v) => slugOf('OrderError', text, v));
      for (const v of ['ClosedDay', 'NoSuchSlot', 'UnknownZone', 'ZoneRequired']) {
        rules.push(slugOf('ScheduleError', schedule ?? '', v));
      }
      expect(rules).toContain('wrong-zone');
      expect(rules).toContain('zone-required');
      for (const rule of rules) {
        expect(rule).toBeDefined();
        const message = describeOrderError(problem(422, `The rule is ${rule ?? ''}.`));
        expect(message.title, rule).toBe('The bakery could not take this order');
        expect(message.detail, rule).toBeTruthy();
      }
    },
  );

  test('a delivery the bakery cannot place says so without asking for a zone', () => {
    for (const rule of ['zone-required', 'unknown-zone', 'wrong-zone']) {
      const detail = describeOrderError(problem(422, rule)).detail ?? '';
      expect(detail, rule).not.toMatch(/choose (one|zone)/i);
    }
  });

  test('another status gets the general words', () => {
    expect(describeOrderError(problem(503)).title).toBe('Order');
    expect(describeOrderError(new NetworkError()).title).toBe('The API is unreachable');
  });
});
