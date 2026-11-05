// Words for what the CRM routes refuse with. A refused campaign step is a 409 or 422 problem
// `campaign` whose `detail` names the rule as a whole word (`out-of-order`, `schedule-too-soon`
// with the earliest allowed time, `unknown-campaign`, `campaign-exists`, `not-due`, `audience`,
// `overflow`). A rebuild started while one runs is a 409 `rebuild`. A staff action as a guest is a
// 403 `guest-scope`; an unknown customer, campaign, message or segment is a 404. These sentences
// name the rule and nothing a visitor typed: there is nothing to type here, every value is chosen
// from a list (docs/domain.md, "Free text and personal data").
import { ApiError } from './api';
import { describeError, type Message } from './messages';
import { inputValueOf } from './crm';
import { businessTime } from './slots';

const SENTENCES: Record<string, string> = {
  'out-of-order':
    'That step is not open in the campaign’s current state. Only a draft can be edited or scheduled. Refresh to see where it is.',
  'schedule-too-soon':
    'A campaign must be scheduled at least 15 minutes ahead of business time. Choose a later time.',
  'unknown-campaign': 'That campaign no longer exists. Refresh the list.',
  'campaign-exists': 'A campaign with that id already exists with different content.',
  'not-due': 'The campaign is not due yet. It sends when business time passes its send time.',
  audience: 'The campaign’s audience did not match its segment, so nothing was sent.',
  overflow: 'That number is too large for the bakery to work with.',
  rebuild: 'A rebuild is already running. Wait for it to finish.',
  'guest-scope': 'Guests can look at the CRM. Sign in to change it.',
};

// Longest first, so `schedule-too-soon` wins over a shorter slug it might contain.
const RULES = Object.keys(SENTENCES).sort((a, b) => b.length - a.length);

/** The rule a problem's detail names as a whole word, if it names one these screens know. */
export function ruleOf(detail: string | null): string | null {
  if (detail === null) return null;
  const lower = detail.toLowerCase();
  return RULES.find((rule) => new RegExp(`(^|[^a-z-])${rule}($|[^a-z-])`).test(lower)) ?? null;
}

/** The rule of an ApiError: the detail's, else its problem slug (`rebuild`, `guest-scope`). */
export function ruleOfError(error: ApiError): string | null {
  return ruleOf(error.detail) ?? (error.slug in SENTENCES ? error.slug : null);
}

const WHEN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?/;

/**
 * The earliest send time a `schedule-too-soon` detail names, as a `datetime-local` value in
 * Mountain time, or null. A time with an offset or `Z` is converted to the bakery's wall clock;
 * one without is already the bakery's.
 */
export function earliestIn(detail: string | null): string | null {
  const found = WHEN.exec(detail ?? '');
  if (found === null) return null;
  const text = found[0];
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : inputValueOf(businessTime(ms));
  }
  return inputValueOf(text);
}

/** The earliest send time a refused schedule names, or null for any other error. */
export function earliestOf(error: unknown): string | null {
  return error instanceof ApiError && ruleOfError(error) === 'schedule-too-soon'
    ? earliestIn(error.detail)
    : null;
}

/** The rule's sentence, with the earliest allowed time added for `schedule-too-soon` when given. */
export function sentenceFor(rule: string, detail: string | null = null): string | null {
  const sentence = SENTENCES[rule] ?? null;
  const earliest = rule === 'schedule-too-soon' ? earliestIn(detail) : null;
  return sentence !== null && earliest !== null
    ? `${sentence} The earliest time is ${earliest.replace('T', ' ')}.`
    : sentence;
}

/**
 * A message for a refused CRM step: the title the API sent and the rule's sentence, with the API's
 * own words after it when they say more. A 404 says what is gone; anything else is the general
 * wording.
 */
export function describeCrmError(error: unknown): Message {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return {
        title: error.title,
        detail:
          'That is not in this sandbox any more. Refresh the page; the sandbox may have been wiped.',
      };
    }
    if (error.status === 403 || error.status === 409 || error.status === 422) {
      const rule = ruleOfError(error);
      const sentence = rule === null ? null : sentenceFor(rule, error.detail);
      if (sentence !== null) return { title: error.title, detail: sentence };
      if (error.detail !== null) return { title: error.title, detail: error.detail };
    }
  }
  return describeError(error);
}
