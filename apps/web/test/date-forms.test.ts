// The forms the console and the inbox print a date in (F18, 2026-11-10), one test a form. Every
// screen takes its words from src/lib/when.ts, so these are the only shapes a reader meets: a short
// day, a day in another year, a time with its day, and the clock alone in a list that names the
// day. The long form, whenText, is for a title or a <time>'s machine form, not for the text.
import { describe, expect, test } from 'vitest';
import { leadHint } from '../src/lib/catering';
import { sentenceFor } from '../src/lib/catering-errors';
import { scheduledSaid } from '../src/lib/crm';
import { engagementText } from '../src/lib/inbox';
import { businessNowView } from '../src/lib/clock';
import { clockOfText, dayText, momentText, timesIn, whenText } from '../src/lib/when';

// Business now for these tests: Tuesday 10 November 2026, 9:00 am in the bakery's zone.
const NOW = Date.parse('2026-11-10T16:00:00Z');

describe('the date forms', () => {
  test('a short day: "Tue 10 Nov", from a bakery date or a moment', () => {
    expect(dayText('2026-11-10', { now: NOW })).toBe('Tue 10 Nov');
    expect(dayText('2026-12-24', { now: NOW })).toBe('Thu 24 Dec');
    // A moment late in the evening is still that day on the bakery's clock.
    expect(dayText('2026-11-11T05:30:00Z', { now: NOW })).toBe('Tue 10 Nov');
  });

  test('a 2026 date read in 2027 carries its year: "this year" is now’s, not the machine’s', () => {
    const in2027 = Date.parse('2027-02-01T16:00:00Z');
    expect(dayText('2026-11-10', { now: in2027 })).toBe('Tue 10 Nov 2026');
    expect(momentText('2026-11-10T08:15:00-07:00', { now: in2027 })).toBe(
      'Tue 10 Nov 2026, 8:15 am',
    );
  });

  test('a day in another year carries its year: "Fri 1 Jan 2027"', () => {
    expect(dayText('2027-01-01', { now: NOW })).toBe('Fri 1 Jan 2027');
    expect(dayText('2025-12-31', { now: NOW })).toBe('Wed 31 Dec 2025');
  });

  test('a time with its day: "Tue 10 Nov, 8:15 am", seconds where events come seconds apart', () => {
    expect(momentText('2026-11-10T08:15:00-07:00', { now: NOW })).toBe('Tue 10 Nov, 8:15 am');
    expect(momentText('2026-11-10T06:49:07Z', { now: NOW })).toBe('Mon 9 Nov, 11:49 pm');
    expect(momentText('2026-11-10T08:15:07-07:00', { seconds: true, now: NOW })).toBe(
      'Tue 10 Nov, 8:15:07 am',
    );
    expect(momentText('2027-01-02T08:15:00-07:00', { now: NOW })).toBe('Sat 2 Jan 2027, 8:15 am');
  });

  test('the clock alone, in a list that already names the day: "8:15 am"', () => {
    expect(clockOfText('2026-11-10T08:15:00-07:00')).toBe('8:15 am');
  });

  test('a sentence the API wrote has its times as times with their day', () => {
    expect(timesIn('Moved to 2026-11-10T08:15:00-07:00.', { now: NOW })).toBe(
      'Moved to Tue 10 Nov, 8:15 am.',
    );
  });

  test('nothing, or text that is not a time, is said as it is', () => {
    expect(momentText(null)).toBe('never');
    expect(momentText('soon')).toBe('soon');
    expect(dayText('soon')).toBe('soon');
  });

  test('the long form stays for titles and machine text, not for the screen', () => {
    expect(whenText('2026-11-10T08:15:00-07:00')).toBe('8:15 am on Tuesday 2026-11-10');
  });
});

// Every date the console, the inbox and the public pages print comes from one of the forms above.
// Where a screen knows the sandbox's business time it passes it as `now`; the year rule is the
// bakery's. Each line names a place a date is printed and the form it takes.
describe('the inventory: where each date is printed, in which form', () => {
  test('the inbox: a message’s delivery, opening and click, as a time with its day', () => {
    expect(
      engagementText(
        { opened_at: '2026-11-07T10:15:00-07:00', clicked_at: '2026-11-07T10:20:00-07:00' },
        NOW,
      ),
    ).toBe('Opened Sat 7 Nov, 10:15 am, clicked Sat 7 Nov, 10:20 am');
  });

  test('the catering page: the earliest day an inquiry may name, as a short day', () => {
    expect(leadHint('2026-11-18', NOW)).toBe(
      'The bakery needs 7 business days’ notice (it opens Tuesday to Sunday), so the earliest day is Wed 18 Nov.',
    );
    expect(sentenceFor('catering-lead', 'earliest 2026-11-18', NOW)).toMatch(
      /The earliest day is Wed 18 Nov\.$/,
    );
  });

  test('a campaign’s send time, as a time with its day', () => {
    expect(scheduledSaid('2026-11-08T14:30:00-07:00', NOW)).toBe(
      'Send time set: Sun 8 Nov, 2:30 pm.',
    );
  });

  test('the System clock: business time with its seconds, the year from business now', () => {
    const wall = Date.parse('2026-11-05T17:07:30Z');
    expect(businessNowView(wall, 0).text).toBe('Thu 5 Nov, 10:07:30 am');
  });
});
