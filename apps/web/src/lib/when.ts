// Times as the bakery says them. Every screen that shows a moment shows it here: the bakery's own
// wall clock (America/Denver, as the board and the slot picker read it), in the friendly form
// "8:15 am on Sunday 2026-11-08". The wire form stays in `<time dateTime>` for machines. A UTC
// stamp such as the feed's `2026-11-08T16:22:07.235Z` reads as the same bakery time, so two screens
// never disagree about the hour.
import { dateLabel } from './schedule';
import { clockLabel, dateOf, mountainLocal } from './slots';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** An RFC 3339 time inside a sentence: date, time, optional fraction, then Z or an offset. */
const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g;

const two = (n: number) => String(n).padStart(2, '0');

/** "9:22:07 am", the clock with its seconds, for events that come seconds apart. */
function clockWithSeconds(hour: number, minute: number, second: number): string {
  const short = clockLabel(hour * 60 + minute);
  return short.replace(/ (am|pm)$/, `:${two(second)} $1`);
}

/**
 * A bakery date or a moment, in words: "Sunday 2026-11-08", or "8:15 am on Sunday 2026-11-08" on
 * the bakery's clock whatever offset the wire used. `seconds` adds them ("9:22:07 am on …") where
 * events come seconds apart. "never" for nothing; the text itself when it is not a time.
 */
export function whenText(
  value: string | null | undefined,
  options: { seconds?: boolean } = {},
): string {
  if (value == null || value === '') return 'never';
  if (DATE_ONLY.test(value)) return dateLabel(value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || !/T\d{2}:\d{2}/.test(value)) return value;
  const l = mountainLocal(ms);
  const clock = options.seconds
    ? clockWithSeconds(l.hour, l.minute, l.second)
    : clockLabel(l.hour * 60 + l.minute);
  return `${clock} on ${dateLabel(dateOf(l))}`;
}

/** "8:15 am", the bakery's clock alone, for a list that already names the day. */
export function clockOfText(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const l = mountainLocal(ms);
  return clockLabel(l.hour * 60 + l.minute);
}

/**
 * A sentence the API wrote with wire times in it ("Clock moved from 2026-11-11T07:01:40-07:00 to
 * …"), with each time in words. Nothing else in the sentence changes.
 */
export function timesIn(text: string, options: { seconds?: boolean } = {}): string {
  return text.replace(STAMP, (stamp) => whenText(stamp, options));
}
