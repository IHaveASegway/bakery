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
