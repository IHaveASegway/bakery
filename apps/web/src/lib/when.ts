// Times as the bakery says them. Every screen that shows a moment shows it here: the bakery's own
// wall clock (America/Denver, as the board and the slot picker read it), in the friendly form
// "8:15 am on Sunday 2026-11-08". The wire form stays in `<time dateTime>` for machines. A UTC
// stamp such as the feed's `2026-11-08T16:22:07Z` reads as the same bakery time, so two screens
// never disagree about the hour.
import { WINDOW_MINUTES } from './dispatch';
import { dateLabel } from './schedule';
import { clockLabel, dateOf, mountainLocal, mountainToMs } from './slots';

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

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/*
 * The forms the console and the inbox print a date in (F18, 2026-11-10; design brief: "dates read as
 * people say them"), and no others:
 *
 *   dayText     a short day                 "Tue 10 Nov"
 *               a day in another year       "Thu 24 Dec 2027"
 *   momentText  a time with its day         "Tue 10 Nov, 8:15 am" (with seconds: "8:15:07 am")
 *   clockOfText the clock alone, in a list that already names the day   "8:15 am"
 *
 * The long form, whenText ("8:15 am on Tuesday 2026-11-10"), goes in a `title` or a `<time>`'s
 * machine form, not in the text. "This year" is the bakery's year at `now`, the wall clock unless a
 * test passes its own.
 */

/** The bakery's calendar day of a moment, or of a bakery date (`YYYY-MM-DD`) at its noon. */
function dayOf(value: string): ReturnType<typeof mountainLocal> | null {
  if (DATE_ONLY.test(value)) return mountainLocal(mountainToMs(value, 12 * 60));
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || !/T\d{2}:\d{2}/.test(value)) return null;
  return mountainLocal(ms);
}

/** "Tue 10 Nov", or "Thu 24 Dec 2027" in another year than now's. The text itself when not a day. */
export function dayText(value: string, options: { now?: number } = {}): string {
  const l = dayOf(value);
  if (l === null) return value;
  const weekday = WEEKDAYS[new Date(Date.UTC(l.year, l.month - 1, l.day)).getUTCDay()];
  const thisYear = mountainLocal(options.now ?? Date.now()).year;
  const year = l.year === thisYear ? '' : ` ${l.year}`;
  return `${weekday} ${l.day} ${MONTHS[l.month - 1]}${year}`;
}

/** "Tue 10 Nov, 8:15 am": a moment as a time with its day. The text itself when not a time. */
export function momentText(
  value: string | null | undefined,
  options: { seconds?: boolean; now?: number } = {},
): string {
  if (value == null || value === '') return 'never';
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || !/T\d{2}:\d{2}/.test(value)) return value;
  const l = mountainLocal(ms);
  const clock = options.seconds
    ? clockWithSeconds(l.hour, l.minute, l.second)
    : clockLabel(l.hour * 60 + l.minute);
  return `${dayText(value, options)}, ${clock}`;
}

/** The short form of a moment for a card or a cell: `momentText` (kept for its callers). */
export const shortWhen = (value: string): string => momentText(value);

/** The short day of a moment: `dayText` (kept for its callers). */
export const shortDate = (value: string): string => dayText(value);

/** "8:15 am", the bakery's clock alone, for a list that already names the day. */
export function clockOfText(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const l = mountainLocal(ms);
  return clockLabel(l.hour * 60 + l.minute);
}

/**
 * "11:00 am to 1:00 pm", a delivery window from its start (`StopView.window`): it closes
 * WINDOW_MINUTES, 120, later. The text itself when it is not a time.
 */
export function windowText(start: string): string {
  const ms = Date.parse(start);
  if (Number.isNaN(ms) || !/T\d{2}:\d{2}/.test(start)) return start;
  const l = mountainLocal(ms);
  const from = l.hour * 60 + l.minute;
  return `${clockLabel(from)} to ${clockLabel(from + WINDOW_MINUTES)}`;
}

/**
 * A sentence the API wrote with wire times in it ("Clock moved from 2026-11-11T07:01:40-07:00 to
 * …"), with each time in words. Nothing else in the sentence changes.
 */
export function timesIn(text: string, options: { seconds?: boolean } = {}): string {
  return text.replace(STAMP, (stamp) => momentText(stamp, options));
}

/**
 * A bakery date (`YYYY-MM-DD`) as a day chip says it: weekday "Tue" and day "10 Nov". Noon on the
 * bakery's clock names the day, whatever the offset.
 */
export function dayParts(date: string): { weekday: string; day: string } {
  const [weekday = date, ...rest] = shortDate(
    new Date(mountainToMs(date, 12 * 60)).toISOString(),
  ).split(' ');
  return { weekday, day: rest.join(' ') };
}
