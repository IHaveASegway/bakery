// Words for what the catering routes refuse with. A refused inquiry is a 422 problem `catering`
// whose `detail` names the rule (`CateringError::rule()`): `headcount`, `unknown-package`,
// `unknown-venue`, `closed-day`, `catering-lead` (naming the earliest date), `catering-too-far`
// (since 2026-11-10: more than 365 days ahead, naming the latest date), `brief-too-long`,
// `brief-email`, `brief-phone`, `brief-card-number`, `brief-url`. A refused step is a 409
// `catering` naming `quote-expired`, `out-of-order` or `too-early` (since 2026-11-08), or a 409
// `slot-full` when the day's two catering places are taken; staff get a 403 `guest-scope` as a
// guest. These sentences name the rule and nothing the visitor typed, so the brief is never echoed
// (docs/domain.md, "Free text and personal data").
import { ApiError } from './api';
import { describeError, type Message } from './messages';

const SENTENCES: Record<string, string> = {
  headcount: 'A catering event feeds 10 to 200 people. Enter a headcount in that range.',
  'unknown-package': 'That is not one of the four packages. Choose one from the list.',
  'unknown-venue': 'That is not one of the six venues. Choose one from the list.',
  'closed-day': 'The bakery is closed that day: it opens Tuesday to Sunday. Choose another date.',
  'catering-lead':
    'Catering needs 7 business days’ notice (the bakery opens Tuesday to Sunday). Choose a later date.',
  'catering-too-far':
    'The bakery takes catering up to 365 days ahead, not further. Choose an earlier date.',
  'brief-too-long': 'The brief is longer than 500 characters. Shorten it.',
  'brief-email':
    'The brief looks like an email address. The bakery keeps no personal details, so leave it out.',
  'brief-phone':
    'The brief looks like a phone number. The bakery keeps no personal details, so leave it out.',
  'brief-card-number': 'The brief looks like a card number. Leave it out.',
  'brief-url': 'The brief looks like a web address. Leave it out.',
  brief: 'The brief was refused. Shorten it or take it out.',
  'quote-total': 'A quote’s total must be at least one cent.',
  'quote-expired': 'This quote has expired, so it can no longer be accepted.',
  'out-of-order': 'That step is not open in the event’s current state. Refresh to see where it is.',
  'too-early':
    'That step comes too early. Production may start the day before the event and delivery on the event day; the API names the first day allowed.',
  'amount-mismatch': 'The amount did not match what the quote says is due.',
  overflow: 'That total is too large for the bakery to work with.',
  'slot-full': 'The day’s two catering places are taken. Choose another date.',
  'guest-scope': 'Guests can look at the catering queue. Sign in to change it.',
};

// Longest first, so `brief-email` wins over `brief`.
const RULES = Object.keys(SENTENCES).sort((a, b) => b.length - a.length);

/**
 * The rule a problem's detail names, if it names one these pages know. The lead rule and the
 * 365-day bound are also known by their words, since the domain's message for each (which the
 * detail may carry whole) names "7 business days" or "365 days ahead" and a date rather than the
 * slug.
 */
export function ruleOf(detail: string | null): string | null {
  if (detail === null) return null;
  const lower = detail.toLowerCase();
  return (
    RULES.find((rule) => new RegExp(`(^|[^a-z-])${rule}($|[^a-z-])`).test(lower)) ??
    (/7 business days/.test(lower)
      ? 'catering-lead'
      : /365 days ahead/.test(lower)
        ? 'catering-too-far'
        : null)
  );
}

/**
 * The first `YYYY-MM-DD` in a detail: for `catering-lead` the earliest date allowed, for
 * `catering-too-far` the latest.
 */
export function dateIn(detail: string | null): string | null {
  const found = /\d{4}-\d{2}-\d{2}/.exec(detail ?? '');
  return found === null ? null : found[0];
}

/** The rule of an ApiError: the detail's, else its problem slug (`slot-full`, `guest-scope`). */
function ruleOfError(error: ApiError): string | null {
  return ruleOf(error.detail) ?? (error.slug in SENTENCES ? error.slug : null);
}

/**
 * The sentence for a rule, with the date the API gave added: the earliest for the lead rule, the
 * latest for the 365-day bound.
 */
export function sentenceFor(rule: string, detail: string | null = null): string | null {
  const sentence = SENTENCES[rule] ?? null;
  const date = rule === 'catering-lead' || rule === 'catering-too-far' ? dateIn(detail) : null;
  if (sentence === null || date === null) return sentence;
  return rule === 'catering-lead'
    ? `${sentence} The earliest date is ${date}.`
    : `${sentence} The latest date is ${date}.`;
}

/**
 * A message for a refused inquiry or customer step: the rule's sentence for a 422 or 409 that
 * names one, the API's own words for a 409 that names none, the general words otherwise.
 */
export function describeCateringError(error: unknown): Message {
  if (error instanceof ApiError && (error.status === 422 || error.status === 409)) {
    const rule = ruleOfError(error);
    const sentence = rule === null ? null : sentenceFor(rule, error.detail);
    if (sentence !== null) {
      return {
        title:
          error.status === 422
            ? 'The bakery could not take this inquiry'
            : error.slug === 'slot-full'
              ? error.title
              : 'That step is not open',
        detail: sentence,
      };
    }
    if (error.status === 409) {
      return { title: error.title, detail: error.detail ?? 'That step is not open right now.' };
    }
  }
  return describeError(error);
}

/**
 * A message for a refused staff action: the API's title and detail as they came, with the rule's
 * sentence in front when the detail names one (a 403 `guest-scope`, a 409 `out-of-order`).
 */
export function describeStaffError(error: unknown): Message {
  if (
    error instanceof ApiError &&
    (error.status === 403 || error.status === 409 || error.status === 422)
  ) {
    const rule = ruleOfError(error);
    const sentence = rule === null ? null : sentenceFor(rule, error.detail);
    const said = error.detail === null ? '' : `The API said: ${error.detail}`;
    const detail = [sentence, said]
      .filter((part): part is string => !!part && part !== '')
      .join(' ');
    return { title: error.title, detail: detail === '' ? null : detail };
  }
  return describeError(error);
}
