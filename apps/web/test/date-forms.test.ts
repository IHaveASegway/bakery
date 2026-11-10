// The forms the console and the inbox print a date in (F18, 2026-11-10), one test a form. Every
// screen takes its words from src/lib/when.ts, so these are the only shapes a reader meets: a short
// day, a day in another year, a time with its day, and the clock alone in a list that names the
// day. The long form, whenText, is for a title or a <time>'s machine form, not for the text.
import { describe, expect, test } from 'vitest';
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
    expect(timesIn('Moved to 2026-11-10T08:15:00-07:00.')).toMatch(/^Moved to \w{3} 10 Nov/);
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
