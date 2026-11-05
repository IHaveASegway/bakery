// Words for what the catering routes refuse with. A refused inquiry is a 422 problem `catering`
// whose `detail` names the rule (`CateringError::rule()`): `headcount`, `unknown-package`,
// `unknown-venue`, `closed-day`, `catering-lead` (naming the earliest date), `brief-too-long`,
// `brief-email`, `brief-phone`, `brief-card-number`, `brief-url`. A refused step is a 409
// `catering` naming `quote-expired` or `out-of-order`, or a 409 `slot-full` when the day's two
// catering places are taken; staff get a 403 `guest-scope` as a guest. These sentences name the
// rule and nothing the visitor typed, so the brief is never echoed (docs/domain.md, "Free text and
// personal data").
import { ApiError } from './api';
import { describeError, type Message } from './messages';

const SENTENCES: Record<string, string> = {
  headcount: 'A catering event feeds 10 to 200 people. Enter a headcount in that range.',
  'unknown-package': 'That is not one of the four packages. Choose one from the list.',
  'unknown-venue': 'That is not one of the six venues. Choose one from the list.',
  'closed-day': 'The bakery is closed that day: it opens Tuesday to Sunday. Choose another date.',
  'catering-lead':
    'Catering needs 7 business days’ notice (the bakery opens Tuesday to Sunday). Choose a later date.',
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
  'amount-mismatch': 'The amount did not match what the quote says is due.',
  overflow: 'That total is too large for the bakery to work with.',
  'slot-full': 'The day’s two catering places are taken. Choose another date.',
  'guest-scope': 'Guests can look at the catering queue. Sign in to change it.',
};

// Longest first, so `brief-email` wins over `brief`.
const RULES = Object.keys(SENTENCES).sort((a, b) => b.length - a.length);

/**
 * The rule a problem's detail names, if it names one these pages know. The lead rule is also
 * known by its words, since the domain's message for it (which the detail may carry whole) names
 * "7 business days" and the earliest date rather than the slug.
 */
export function ruleOf(detail: string | null): string | null {
  if (detail === null) return null;
  const lower = detail.toLowerCase();
  return (
    RULES.find((rule) => new RegExp(`(^|[^a-z-])${rule}($|[^a-z-])`).test(lower)) ??
    (/7 business days/.test(lower) ? 'catering-lead' : null)
  );
}

/** The first `YYYY-MM-DD` in a detail: for `catering-lead` this is the earliest date allowed. */
export function dateIn(detail: string | null): string | null {
  const found = /\d{4}-\d{2}-\d{2}/.exec(detail ?? '');
  return found === null ? null : found[0];
}

/** The rule of an ApiError: the detail's, else its problem slug (`slot-full`, `guest-scope`). */
function ruleOfError(error: ApiError): string | null {
  return ruleOf(error.detail) ?? (error.slug in SENTENCES ? error.slug : null);
}

/** The sentence for a rule, with the earliest date added for the lead rule when the API gave it. */
export function sentenceFor(rule: string, detail: string | null = null): string | null {
  const sentence = SENTENCES[rule] ?? null;
  const date = rule === 'catering-lead' ? dateIn(detail) : null;
  return sentence !== null && date !== null
    ? `${sentence} The earliest date is ${date}.`
    : sentence;
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
