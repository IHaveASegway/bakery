import { describe, expect, test } from 'vitest';
import { ApiError, NetworkError } from '../src/lib/api';
import {
  WITHOUT_SOLVER,
  describeDispatchError,
  ruleOf,
  ruleOfError,
  sentenceFor,
  solverSentence,
} from '../src/lib/dispatch-errors';
import { parseProblem } from '../src/lib/problem';

const error = (status: number, slug: string, detail: string | null = null, title = 'Refused') =>
  new ApiError(
    parseProblem(
      status,
      JSON.stringify({
        type: `https://bakery.example.test/problems/${slug}`,
        title,
        status,
        ...(detail === null ? {} : { detail }),
      }),
    ),
    null,
  );

// Every rule slug the API names (the domain stream's report, "Errors and their slugs", and the
// routes the Worker answers).
const RULES = [
  'vans',
  'capacity',
  'no-stops',
  'place-unknown',
  'route-ends',
  'stop-unknown',
  'stop-twice',
  'over-capacity',
  'stop-missing',
  'no-plan',
  'published',
  'window',
  'not-ready',
  'idempotency-key',
] as const;

describe('the rule in a dispatch problem', () => {
  test.each(RULES)('%s has a sentence, found as a whole word in the detail', (rule) => {
    expect(sentenceFor(rule)).toEqual(expect.any(String));
    expect(ruleOf(rule)).toBe(rule);
    expect(ruleOf(`Refused: ${rule}.`)).toBe(rule);
    expect(describeDispatchError(error(422, 'dispatch', rule))).toEqual({
      title: 'Refused',
      detail: sentenceFor(rule),
    });
  });

  test('the longest slug wins, so stop-missing is not read as another', () => {
    expect(ruleOf('stop-missing')).toBe('stop-missing');
    expect(ruleOf('over-capacity')).toBe('over-capacity');
    expect(ruleOf('the plan is over-capacity')).toBe('over-capacity');
  });

  test('a slug inside another word is not a rule', () => {
    expect(ruleOf('canvassing')).toBeNull();
    expect(ruleOf(null)).toBeNull();
  });
});

describe('the refusals a publish and a completion can meet', () => {
  test('published says a van has left, and a 409 shows that sentence', () => {
    const sentence = 'A van has already left with this plan, so today’s plan cannot be replaced.';
    expect(sentenceFor('published')).toBe(sentence);
    expect(describeDispatchError(error(409, 'dispatch', 'The rule is published.'))).toEqual({
      title: 'Refused',
      detail: sentence,
    });
  });

  test.each([
    ['no-plan', 'The rule is no-plan.'],
    ['stop-missing', 'The rule is stop-missing.'],
    ['place-unknown', 'The rule is place-unknown.'],
    ['stop-unknown', 'The rule is stop-unknown.'],
  ])('%s has its own sentence for a 409 or 422 with the Worker’s detail', (rule, detail) => {
    const sentence = sentenceFor(rule);
    expect(sentence).toEqual(expect.any(String));
    for (const status of [409, 422]) {
      expect(describeDispatchError(error(status, 'dispatch', detail)).detail).toBe(sentence);
    }
  });

  test('a plan that reaches a stop after its window is window, a 422 on plan and a 409 on publish', () => {
    const detail =
      'van 2 reaches stop 01JD0ORDER0000000000000003 after its delivery window closes. The rule is window.';
    const sentence = sentenceFor('window');
    expect(sentence).toContain('after its delivery window closes');
    expect(sentence).toContain('9:00 am');
    for (const status of [409, 422]) {
      expect(describeDispatchError(error(status, 'dispatch', detail))).toEqual({
        title: 'Refused',
        detail: sentence,
      });
    }
  });

  test('completing a stop whose order is not ready is a 409 not-ready that names the kitchen board', () => {
    const detail = 'stop 3’s order is not ready yet. The rule is not-ready.';
    expect(ruleOf(detail)).toBe('not-ready');
    expect(describeDispatchError(error(409, 'dispatch', detail)).detail).toContain(
      'Mark it ready on the kitchen board',
    );
  });

  test('the word window in another rule’s detail is not the window rule', () => {
    expect(ruleOf('the stop’s window is not on this day. The rule is stop-missing.')).toBe(
      'stop-missing',
    );
    expect(ruleOf('the stop’s window is not on this day. The rule is wrong-day.')).toBeNull();
  });

  test('a completion with no published plan is a 409 no-plan that says to publish first', () => {
    expect(describeDispatchError(error(409, 'dispatch', 'The rule is no-plan.')).detail).toContain(
      'publish a plan before completing a stop',
    );
  });

  test('a reused key is the router’s 422 idempotency-key, found by its slug or its detail', () => {
    const sentence = sentenceFor('idempotency-key');
    expect(sentence).toContain('different details');
    expect(
      describeDispatchError(
        error(
          422,
          'idempotency-key',
          'This Idempotency-Key was used for a different request. Send a new key with each new request.',
          'This Idempotency-Key was already used',
        ),
      ),
    ).toEqual({ title: 'This Idempotency-Key was already used', detail: sentence });
    expect(ruleOfError(error(422, 'idempotency-key'))).toBe('idempotency-key');
  });
});

describe('describeDispatchError', () => {
  test('a guest’s write is a 403 guest-scope', () => {
    expect(describeDispatchError(error(403, 'guest-scope')).detail).toContain('Sign in');
    expect(ruleOfError(error(403, 'guest-scope'))).toBe('guest-scope');
  });

  test('a day outside the sandbox’s days is a 404 no-such-day', () => {
    expect(describeDispatchError(error(404, 'no-such-day', null, 'No such day'))).toEqual({
      title: 'No such day',
      detail: sentenceFor('no-such-day'),
    });
  });

  test('a 404 for something else says the sandbox may be gone', () => {
    expect(describeDispatchError(error(404, 'not-found')).detail).toContain('wiped');
  });

  test('a rule the screen does not know shows the API’s own words', () => {
    expect(describeDispatchError(error(422, 'dispatch', 'something new')).detail).toBe(
      'something new',
    );
  });

  test('anything else is the general wording', () => {
    expect(describeDispatchError(new NetworkError()).title).toBe('The API is unreachable');
    expect(describeDispatchError(error(500, 'internal', 'boom')).detail).toBe('boom');
    expect(describeDispatchError(new Error('x')).title).toBe('Something went wrong');
  });
});

describe('the solver’s failures', () => {
  test('each has its own plain sentence, and the page says what still works', () => {
    const all = (['unsupported', 'load', 'timeout', 'vroom'] as const).map(solverSentence);
    expect(new Set(all).size).toBe(4);
    expect(WITHOUT_SOLVER).toContain('server’s plan');
    expect(WITHOUT_SOLVER).toContain('publish');
  });
});
