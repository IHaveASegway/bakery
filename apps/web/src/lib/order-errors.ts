// Words for the 422 an order can get. The API's `detail` names the rule the order broke
// (`OrderError::rule()`), and for the note the matched class (`note-email`, `note-phone`,
// `note-card-number`, `note-url`, `note-too-long`), never the text. These sentences name the rule
// and nothing the visitor typed, so the note is never echoed back (docs/domain.md, "Free text and
// personal data").
import { ApiError } from './api';
import { describeError, type Message } from './messages';

const SENTENCES: Record<string, string> = {
  'no-lines': 'The cart is empty. Add something first.',
  'too-many-lines': 'An order holds at most 20 lines.',
  'qty-out-of-range': 'Each line is a quantity of 1 to 24.',
  'not-on-menu': 'Something in the cart is not on the current menu. Take it out and try again.',
  'item-paused': 'Something in the cart is paused right now. Take it out and try again.',
  'not-baked-that-day':
    'Something in the cart is not baked on the day you chose. Choose another day.',
  'out-of-season':
    'Something in the cart is out of season on the day you chose. Choose another day.',
  'pickup-only': 'Something in the cart is pickup only. Choose pickup, or take it out.',
  'zone-required': 'A delivery needs a zone. Choose one.',
  'zone-on-pickup': 'A pickup has no delivery zone.',
  'lead-time': 'Something in the cart needs more notice than that. Choose a later time.',
  'note-email':
    'The note looks like an email address. The bakery keeps no personal details, so leave it out.',
  'note-phone':
    'The note looks like a phone number. The bakery keeps no personal details, so leave it out.',
  'note-card-number': 'The note looks like a card number. Leave it out.',
  'note-url': 'The note looks like a web address. Leave it out.',
  'note-too-long': 'The note is longer than 140 characters. Shorten it.',
  note: 'The note was refused. Shorten it or take it out.',
};

// Longest first, so `note-email` wins over `note`.
const RULES = Object.keys(SENTENCES).sort((a, b) => b.length - a.length);

/** The rule a 422's detail names, if it names one this page knows. */
export function ruleOf(detail: string | null): string | null {
  if (detail === null) return null;
  return (
    RULES.find((rule) => new RegExp(`(^|[^a-z-])${rule}($|[^a-z-])`).test(detail.toLowerCase())) ??
    null
  );
}

/** A message for a failed checkout: the rule's sentence for a 422, the general words otherwise. */
export function describeOrderError(error: unknown): Message {
  if (error instanceof ApiError && error.status === 422) {
    const rule = ruleOf(error.detail);
    if (rule !== null) {
      return { title: 'The bakery could not take this order', detail: SENTENCES[rule] ?? null };
    }
  }
  return describeError(error);
}
