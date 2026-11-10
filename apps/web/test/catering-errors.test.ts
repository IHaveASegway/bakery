import { describe, expect, test } from 'vitest';
import { ApiError } from '../src/lib/api';
import {
  dateIn,
  describeCateringError,
  describeStaffError,
  ruleOf,
  sentenceFor,
} from '../src/lib/catering-errors';
import { NetworkError } from '../src/lib/api';
import { parseProblem } from '../src/lib/problem';

const error = (status: number, slug: string, detail: string | null, title = 'Refused') =>
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

const INQUIRY_RULES = [
  'headcount',
  'unknown-package',
  'unknown-venue',
  'closed-day',
  'catering-lead',
  'catering-too-far',
  'brief-too-long',
  'brief-email',
  'brief-phone',
  'brief-card-number',
  'brief-url',
];

// Business now for the days these sentences name: a day in 2026, so a 2026 day prints without its
// year and a 2027 one with it, whatever year the machine's clock says.
const NOW = Date.parse('2026-11-10T16:00:00Z');

describe('the rule an inquiry’s 422 names', () => {
  test.each(INQUIRY_RULES)('%s has its own sentence, titled for the inquiry', (rule) => {
    const message = describeCateringError(error(422, 'catering', rule));
    expect(message.title).toBe('The bakery could not take this inquiry');
    expect(message.detail).toBe(sentenceFor(rule));
    expect(message.detail?.length).toBeGreaterThan(20);
  });

  test('every rule finds its own sentence even inside a longer detail', () => {
    for (const rule of INQUIRY_RULES) {
      expect(ruleOf(`${rule}: the API’s longer words`), rule).toBe(rule);
    }
    // The longer slug wins over its prefix.
    expect(ruleOf('brief-email')).toBe('brief-email');
    expect(ruleOf('brief')).toBe('brief');
  });

  test('the lead rule adds the earliest date the API named', () => {
    const detail =
      "a catering event needs 7 business days' notice (Tuesday to Sunday); the earliest date is 2026-11-11";
    expect(dateIn(detail)).toBe('2026-11-11');
    const message = describeCateringError(error(422, 'catering', detail), NOW);
    expect(message.detail).toContain('7 business days');
    expect(message.detail).toContain('The earliest day is Wed 11 Nov.');
  });

  test('the lead rule is known by the slug or by the domain’s words', () => {
    expect(ruleOf('catering-lead: the earliest date is 2026-11-11')).toBe('catering-lead');
    expect(ruleOf("needs 7 business days' notice; the earliest date is 2026-11-11")).toBe(
      'catering-lead',
    );
    expect(ruleOf('closed-day')).toBe('closed-day');
  });

  test('the 365-day bound adds the latest date the API named, by slug or by words', () => {
    const detail =
      'A catering event is at most 365 days ahead; the latest date is 2027-11-03. The rule is catering-too-far.';
    expect(ruleOf(detail)).toBe('catering-too-far');
    expect(
      ruleOf('a catering event is at most 365 days ahead; the latest date is 2027-11-03'),
    ).toBe('catering-too-far');
    const message = describeCateringError(error(422, 'catering', detail), NOW);
    expect(message.title).toBe('The bakery could not take this inquiry');
    expect(message.detail).toContain('365 days ahead');
    expect(message.detail).toContain('The latest day is Wed 3 Nov 2027.');
    expect(message.detail).not.toContain('earliest');
    const staff = describeStaffError(
      error(422, 'catering', detail, 'The catering inquiry was refused'),
      NOW,
    );
    expect(staff.detail).toContain('The latest day is Wed 3 Nov 2027.');
  });

  test('a lead refusal with no date still reads', () => {
    const message = describeCateringError(error(422, 'catering', 'catering-lead'));
    expect(message.detail).toBe(sentenceFor('catering-lead'));
    expect(dateIn(null)).toBeNull();
  });

  test('a brief refusal never echoes the text, because it never has it', () => {
    for (const rule of ['brief-email', 'brief-phone', 'brief-card-number', 'brief-url']) {
      const message = describeCateringError(error(422, 'catering', rule));
      expect(`${message.title} ${message.detail}`).not.toMatch(/@|\d{4}/);
    }
  });

  test('a 422 that names nothing known falls back to the API’s own words', () => {
    const message = describeCateringError(error(422, 'catering', 'something new', 'Odd'));
    expect(message.title).toBe('Odd');
    expect(message.detail).toBe('something new');
  });
});

describe('the answers to a refused step', () => {
  test('quote-expired and out-of-order are sentences', () => {
    const expired = describeCateringError(error(409, 'catering', 'quote-expired'));
    expect(expired.title).toBe('That step is not open');
    expect(expired.detail).toBe(sentenceFor('quote-expired'));
    const order = describeCateringError(error(409, 'catering', 'out-of-order'));
    expect(order.detail).toBe(sentenceFor('out-of-order'));
  });

  test('slot-full keeps the API’s title and says the day’s places are taken', () => {
    const message = describeCateringError(
      error(409, 'slot-full', 'both catering places on 2026-11-20 are taken', 'That day is full'),
    );
    expect(message.title).toBe('That day is full');
    expect(message.detail).toContain('two catering places are taken');
  });

  test('a 409 naming nothing shows the API’s detail', () => {
    const message = describeCateringError(error(409, 'catering', 'the deposit is not due'));
    expect(message.detail).toBe('the deposit is not due');
  });

  test('the general cases keep their general words', () => {
    expect(describeCateringError(new NetworkError()).title).toBe('The API is unreachable');
    expect(describeCateringError(error(500, 'internal', null, 'Broke')).title).toBe('Broke');
    expect(describeCateringError(new Error('x')).title).toBe('Something went wrong');
  });
});

describe('the answers to a refused staff action', () => {
  test('a guest’s 403 is shown with the API’s detail', () => {
    const message = describeStaffError(
      error(
        403,
        'guest-scope',
        'guest sessions cannot change the catering queue',
        'Not for guests',
      ),
    );
    expect(message.title).toBe('Not for guests');
    expect(message.detail).toContain('Sign in to change it.');
    expect(message.detail).toContain(
      'The API said: guest sessions cannot change the catering queue',
    );
  });

  test('a 409 shows the rule and the API’s detail together', () => {
    const message = describeStaffError(
      error(409, 'catering', 'out-of-order: the event is already quoted', 'Out of order'),
    );
    expect(message.title).toBe('Out of order');
    expect(message.detail).toContain(sentenceFor('out-of-order'));
    expect(message.detail).toContain('The API said: out-of-order: the event is already quoted');
  });

  test('a 422 quote-total and an unknown 409 are shown plainly', () => {
    expect(describeStaffError(error(422, 'catering', 'quote-total')).detail).toContain(
      'at least one cent',
    );
    expect(describeStaffError(error(409, 'catering', 'something else', 'Nope')).detail).toBe(
      'The API said: something else',
    );
  });

  test('anything else is the general message', () => {
    expect(describeStaffError(new NetworkError()).title).toBe('The API is unreachable');
  });
});
