// What the catering pages know without asking: the dates the lead time allows, the figures a
// total splits into, the states and the actions each offers, the reminders, the brief's hints and
// the waits after a payment. Every rule here is a hint or a label. The API is the check: it
// refuses a bad inquiry with the rule named, an out-of-order step with `out-of-order`, and it
// decides every figure it sends (docs/domain.md, "CateringEvent"; "Free text and personal data").
// Pure functions only, so vitest covers them; the components in Catering.tsx and
// CateringQueue.tsx only draw the answers.
import type {
  CateringCancelReason,
  CateringInquiryRequest,
  CateringReminder,
  CateringResponse,
  CateringState,
  DeclineReason,
  ReminderKind,
} from '../contracts';
import { noteLength } from './cart';
import { parseDollars } from './money';
import { pollUntil, type PollOptions, type Polled } from './payment';
import { dateOf, mountainLocal } from './slots';
import { dayText } from './when';

// ---- The rules the domain publishes, as numbers a page can show ----

/** A catering event feeds 10 to 200 people. */
export const MIN_HEADCOUNT = 10;
export const MAX_HEADCOUNT = 200;
/** The date is at least 7 business days (open days, Tuesday to Sunday) after the inquiry. */
export const LEAD_BUSINESS_DAYS = 7;
/** The brief's cap in characters, counted the way the API counts (Unicode scalar values). */
export const BRIEF_MAX = 500;
/** The deposit is 2,500 basis points of the quote's total, rounded half-up. */
export const DEPOSIT_BP = 2_500;
/** How many open days after the earliest the date list offers. */
export const DATE_CHOICES = 60;

/**
 * The four packages and their price per head, in cents: the domain's `PACKAGES`
 * (crates/domain/src/catering.rs), which no route returns. test/catering.test.ts reads that file
 * and fails when this list drifts from it.
 */
export const PACKAGES: { slug: string; label: string; per_head_cents: number }[] = [
  { slug: 'pastry-platter', label: 'Pastry platter', per_head_cents: 950 },
  { slug: 'breakfast-spread', label: 'Breakfast spread', per_head_cents: 1_450 },
  { slug: 'lunch-boxes', label: 'Lunch boxes', per_head_cents: 1_850 },
  {
    slug: 'celebration-cake-and-coffee',
    label: 'Celebration cake and coffee',
    per_head_cents: 1_250,
  },
];

/** The six made-up venues, `v1` to `v6`. Their names live in the seed; no route returns them. */
export const VENUES: { id: string; label: string }[] = [
  { id: 'v1', label: 'Venue 1' },
  { id: 'v2', label: 'Venue 2' },
  { id: 'v3', label: 'Venue 3' },
  { id: 'v4', label: 'Venue 4' },
  { id: 'v5', label: 'Venue 5' },
  { id: 'v6', label: 'Venue 6' },
];

export const packageLabel = (slug: string): string =>
  PACKAGES.find((p) => p.slug === slug)?.label ?? slug.replaceAll('-', ' ');

export const venueLabel = (id: string): string => VENUES.find((v) => v.id === id)?.label ?? id;

/** A package's price per head times the headcount, or null for an unknown package or headcount. */
export function packageTotal(slug: string, headcount: number): number | null {
  const found = PACKAGES.find((p) => p.slug === slug);
  if (found === undefined || !Number.isInteger(headcount) || headcount < 1) return null;
  return found.per_head_cents * headcount;
}

// ---- Money: the split, for display only ----

/** The deposit of a total: 25%, rounded half-up. */
export const depositCents = (totalCents: number): number =>
  Math.floor((totalCents * DEPOSIT_BP + 5_000) / 10_000);

/** Deposit and balance from a total; they always add up to it. The API computes the real ones. */
export function splitTotal(totalCents: number): { deposit_cents: number; balance_cents: number } {
  const deposit = depositCents(totalCents);
  return { deposit_cents: deposit, balance_cents: totalCents - deposit };
}

// ---- Dates: bakery dates are `YYYY-MM-DD`, counted in whole days ----

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysOf(date: string): number {
  const m = DATE.exec(date);
  if (m === null) return NaN;
  const days = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
  // 2026-11-31 rolls over to December: only a date that survives the round trip is a date.
  return dateOfDays(days) === date ? days : NaN;
}

function dateOfDays(days: number): string {
  const d = new Date(days * DAY_MS);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

/** The date `n` days later (earlier when negative). */
export const addDays = (date: string, n: number): string => dateOfDays(daysOf(date) + n);

/** Whether the bakery opens that day: Tuesday to Sunday. */
export function isOpenDay(date: string): boolean {
  const days = daysOf(date);
  if (Number.isNaN(days)) return false;
  // 1970-01-01 was a Thursday (4); Monday is 1.
  return ((days % 7) + 7 + 4) % 7 !== 1;
}

/** The `n`th open day strictly after `date`, so 1 is the next open day. */
export function nthOpenDayAfter(date: string, n: number): string {
  let day = daysOf(date);
  let left = n;
  while (left > 0) {
    day += 1;
    if (isOpenDay(dateOfDays(day))) left -= 1;
  }
  return dateOfDays(day);
}

/** The bakery's date at a business instant (wall time plus the sandbox's clock offset). */
export const bakeryDate = (businessNowMs: number): string => dateOf(mountainLocal(businessNowMs));

/** The first date the 7-business-day lead allows for an inquiry made today. */
export const earliestDate = (today: string): string => nthOpenDayAfter(today, LEAD_BUSINESS_DAYS);

/** The open days a visitor may pick from: the earliest and the open days after it. */
export function openDates(earliest: string, count: number = DATE_CHOICES): string[] {
  const out: string[] = [];
  let day = earliest;
  while (out.length < count) {
    if (isOpenDay(day)) out.push(day);
    day = addDays(day, 1);
  }
  return out;
}

/** The hint under the date list. */
export function leadHint(earliest: string, now?: number): string {
  return `The bakery needs ${LEAD_BUSINESS_DAYS} business days’ notice (it opens Tuesday to Sunday), so the earliest day is ${dayText(earliest, { now })}.`;
}

// ---- The brief: hints only ----

export type BriefClass = 'email' | 'phone' | 'card-number' | 'url';

// Full-width digits count as digits, as in the API's checker.
const isDigit = (c: string) => /[0-9０-９]/.test(c);
const isSeparator = (c: string) => ' .-()+'.includes(c);

/** Removes control characters other than a newline, the way the API normalizes before checking. */
function stripControls(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}

/** A run of digits and separators of 13 to 19 digits is a card number, of 7 or more a phone. */
function digitClass(text: string): 'card-number' | 'phone' | null {
  let worst: 'card-number' | 'phone' | null = null;
  let digits = 0;
  for (const c of [...text, '\n']) {
    if (isDigit(c)) {
      digits += 1;
    } else if (!isSeparator(c)) {
      const found = digits >= 13 && digits <= 19 ? 'card-number' : digits >= 7 ? 'phone' : null;
      if (found === 'card-number' || worst === null) worst = found ?? worst;
      digits = 0;
    }
  }
  return worst;
}

function hasEmail(text: string): boolean {
  return text.split(/\s+/).some((token) => {
    for (let at = token.indexOf('@'); at >= 0; at = token.indexOf('@', at + 1)) {
      const domain = token.slice(at + 1);
      const dot = domain.indexOf('.');
      for (let d = dot; d >= 0; d = domain.indexOf('.', d + 1)) {
        if (at > 0 && d > 0 && d + 1 < domain.length) return true;
      }
    }
    return false;
  });
}

const TLDS = [
  'com',
  'org',
  'net',
  'io',
  'co',
  'us',
  'uk',
  'de',
  'fr',
  'app',
  'dev',
  'info',
  'biz',
  'edu',
  'gov',
];

function hasUrl(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes('http://') || lower.includes('https://') || lower.includes('www.')) {
    return true;
  }
  const chars = [...lower];
  return chars.some((c, i) => {
    if (c !== '.' || i === 0 || !/[\p{L}\p{N}-]/u.test(chars[i - 1] ?? '')) return false;
    let tail = '';
    for (const t of chars.slice(i + 1)) {
      if (!/[\p{L}\p{N}]/u.test(t)) break;
      tail += t;
    }
    return TLDS.includes(tail);
  });
}

/**
 * The first of the four classes the text looks like (card number, phone number, email address,
 * web address), or null. A hint that follows the API's checker closely, not the check: the API
 * refuses a brief with `brief-email`, `brief-phone`, `brief-card-number` or `brief-url`.
 */
export function briefClass(text: string): BriefClass | null {
  const clean = stripControls(text);
  const digits = digitClass(clean);
  if (digits !== null) return digits;
  if (hasEmail(clean)) return 'email';
  if (hasUrl(clean)) return 'url';
  return null;
}

/** The brief's length the way the API counts it. */
export const briefLength = (text: string): number => noteLength(text);

/** The sentence under the brief for a class the text looks like. Never quotes the text. */
export const BRIEF_CLASS_HINTS: Record<BriefClass, string> = {
  email: 'This looks like an email address. The bakery keeps none: leave it out.',
  phone: 'This looks like a phone number. The bakery keeps none: leave it out.',
  'card-number': 'This looks like a card number. Leave it out.',
  url: 'This looks like a web address. The bakery keeps none: leave it out.',
};

/** The line shown with the brief before anything is typed. */
export const BRIEF_HINT = 'No email, phone, card number or web address: the bakery keeps none.';

/** The warning to show for this brief, or null. It does not stop the submit: the API decides. */
export function briefWarning(text: string): string | null {
  const found = briefClass(text);
  return found === null ? null : BRIEF_CLASS_HINTS[found];
}

// ---- The inquiry form ----

export interface InquiryForm {
  date: string;
  headcount: string;
  package: string;
  venue: string;
  brief: string;
}

export const EMPTY_INQUIRY: InquiryForm = {
  date: '',
  headcount: '',
  package: '',
  venue: '',
  brief: '',
};

/** The headcount typed, when it is a whole number from 10 to 200. */
export function parseHeadcount(text: string): number | null {
  if (!/^\s*\d{1,4}\s*$/.test(text)) return null;
  const n = Number(text);
  return n >= MIN_HEADCOUNT && n <= MAX_HEADCOUNT ? n : null;
}

/** What keeps the button off, in words; empty when the form could be sent. The API checks again. */
export function inquiryReasons(form: InquiryForm, earliest: string): string[] {
  const reasons: string[] = [];
  if (form.date === '') reasons.push('Choose a date.');
  else if (!isOpenDay(form.date))
    reasons.push('The bakery is closed on Mondays. Choose another date.');
  else if (form.date < earliest) reasons.push(`The earliest date is ${earliest}.`);
  if (parseHeadcount(form.headcount) === null) {
    reasons.push(`Enter a headcount from ${MIN_HEADCOUNT} to ${MAX_HEADCOUNT}.`);
  }
  if (form.package === '') reasons.push('Choose a package.');
  if (form.venue === '') reasons.push('Choose a venue.');
  const over = briefLength(form.brief) - BRIEF_MAX;
  if (over > 0) reasons.push(`Shorten the brief by ${over}.`);
  return reasons;
}

/**
 * What is wrong with a value the visitor has entered, said at its field in the field's own words
 * (F11, 2026-11-10). A field left empty is not wrong yet: what is still to choose is said beside
 * the button (`inquiryMissing`).
 */
export interface InquiryFieldErrors {
  date?: string;
  headcount?: string;
  brief?: string;
}

export function inquiryFieldErrors(form: InquiryForm, earliest: string): InquiryFieldErrors {
  const errors: InquiryFieldErrors = {};
  if (form.date !== '') {
    if (!isOpenDay(form.date)) errors.date = 'The bakery is closed on Mondays.';
    else if (form.date < earliest) errors.date = `The earliest day is ${dayText(earliest)}.`;
  }
  if (form.headcount.trim() !== '' && parseHeadcount(form.headcount) === null) {
    const n = /^\s*\d{1,6}\s*$/.test(form.headcount) ? Number(form.headcount) : null;
    errors.headcount =
      n !== null && n > MAX_HEADCOUNT
        ? `${n} is more than ${MAX_HEADCOUNT} people.`
        : n !== null && n < MIN_HEADCOUNT
          ? `${n} is fewer than ${MIN_HEADCOUNT} people.`
          : `A whole number of people, ${MIN_HEADCOUNT} to ${MAX_HEADCOUNT}.`;
  }
  const over = briefLength(form.brief) - BRIEF_MAX;
  if (over > 0) errors.brief = `${over} characters over the limit.`;
  return errors;
}

/** The fields still to fill, as one sentence beside the button; null when none is. */
export function inquiryMissing(form: InquiryForm): string | null {
  const missing = [
    form.date === '' && 'a day',
    form.headcount.trim() === '' && 'a headcount',
    form.package === '' && 'a package',
    form.venue === '' && 'a venue',
  ].filter((m): m is string => m !== false);
  if (missing.length === 0) return null;
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  return `Still to fill: ${list}.`;
}

/** The request body for a form with no reason against it, else null. A blank brief is left out. */
export function inquiryRequest(form: InquiryForm, earliest: string): CateringInquiryRequest | null {
  if (inquiryReasons(form, earliest).length > 0) return null;
  const headcount = parseHeadcount(form.headcount);
  if (headcount === null) return null;
  return {
    date: form.date,
    headcount,
    package: form.package,
    venue: form.venue,
    ...(form.brief.trim() === '' ? {} : { brief: form.brief }),
  };
}

// ---- States, the actions each offers, and what comes next ----

/** The states in the order an event moves through them; the queue groups by these. */
export const STATE_ORDER: CateringState[] = [
  'inquiry',
  'quoted',
  'accepted',
  'confirmed',
  'in_production',
  'delivered',
  'invoiced',
  'paid',
  'closed',
  'declined',
  'expired',
  'cancelled',
];

export const STATE_LABELS: Record<CateringState, string> = {
  inquiry: 'Inquiry',
  quoted: 'Quoted',
  accepted: 'Accepted, deposit due',
  confirmed: 'Confirmed',
  in_production: 'In production',
  delivered: 'Delivered',
  invoiced: 'Invoiced, balance due',
  paid: 'Paid',
  closed: 'Closed',
  declined: 'Declined',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export const stateLabel = (state: CateringState): string => STATE_LABELS[state];

/** States an event never leaves. */
export const ENDED: ReadonlySet<CateringState> = new Set([
  'closed',
  'declined',
  'expired',
  'cancelled',
]);

/** What the customer can do in each state (docs/domain.md, the diagram). The API refuses the rest. */
export type CustomerAction = 'accept' | 'pay-deposit' | 'pay-balance' | 'cancel';

export const CUSTOMER_ACTIONS: Record<CateringState, CustomerAction[]> = {
  inquiry: [],
  quoted: ['accept'],
  accepted: ['pay-deposit'],
  confirmed: ['cancel'],
  in_production: [],
  delivered: [],
  invoiced: ['pay-balance'],
  paid: [],
  closed: [],
  declined: [],
  expired: [],
  cancelled: [],
};

/** What staff can do in each state. Only a confirmed event is cancelled (the diagram). */
export type StaffAction = 'quote' | 'decline' | 'start-production' | 'delivered' | 'staff-cancel';

export const STAFF_ACTIONS: Record<CateringState, StaffAction[]> = {
  inquiry: ['quote', 'decline'],
  quoted: [],
  accepted: [],
  confirmed: ['start-production', 'staff-cancel'],
  in_production: ['delivered'],
  delivered: [],
  invoiced: [],
  paid: [],
  closed: [],
  declined: [],
  expired: [],
  cancelled: [],
};

export const customerActions = (state: CateringState): CustomerAction[] => CUSTOMER_ACTIONS[state];
export const staffActions = (state: CateringState): StaffAction[] => STAFF_ACTIONS[state];

export const STAFF_ACTION_LABELS: Record<StaffAction, string> = {
  quote: 'Send quote',
  decline: 'Decline',
  'start-production': 'Start production',
  delivered: 'Mark delivered',
  'staff-cancel': 'Cancel event',
};

export const CANCEL_REASONS: { reason: CateringCancelReason; label: string }[] = [
  { reason: 'customer_change', label: 'The customer changed plans' },
  { reason: 'venue_lost', label: 'The venue fell through' },
  { reason: 'other', label: 'Another reason' },
];

export const DECLINE_REASONS: { reason: DeclineReason; label: string }[] = [
  { reason: 'too_soon', label: 'Too soon' },
  { reason: 'over_capacity', label: 'Over capacity' },
  { reason: 'other', label: 'Another reason' },
];

/** One sentence per state for the customer: where the event stands and what happens next. */
export const NEXT_STEP: Record<CateringState, string> = {
  inquiry:
    'The bakery has your inquiry. Staff send a quote, and there is nothing to do until then.',
  quoted: 'Accept the quote to hold the day’s place. The deposit then confirms it.',
  accepted:
    'A place on the day is held for you for 15 minutes of bakery time. Pay the deposit to confirm it; if the hold lapses the quote goes back to Quoted and you can accept again.',
  confirmed:
    'The deposit is paid and the day is yours. The kitchen starts production, and until then you can cancel.',
  in_production: 'The kitchen is making your order.',
  delivered:
    'Delivered. The bakery raises the balance invoice from its queue, and it shows here once it arrives.',
  invoiced: 'The balance invoice is open. Pay it with Stripe’s test card.',
  paid: 'The balance is paid. The event closes in the same step.',
  closed: 'Paid in full and closed. Nothing more to do.',
  declined: 'The bakery declined this inquiry.',
  expired: 'The quote was not accepted in time and has expired.',
  cancelled: 'This event was cancelled.',
};

// ---- The figures ----

export interface Figures {
  total_cents: number;
  deposit_cents: number;
  balance_cents: number;
}

/** The figures a response carries, when it has a quote; the API computed them. */
export function figuresOf(event: CateringResponse): Figures | null {
  const { total_cents, deposit_cents, balance_cents } = event;
  if (
    total_cents === null ||
    total_cents === undefined ||
    deposit_cents === null ||
    deposit_cents === undefined ||
    balance_cents === null ||
    balance_cents === undefined
  ) {
    return null;
  }
  return { total_cents, deposit_cents, balance_cents };
}

/** The line shown for an unquoted event: what the package would come to at its price per head. */
export function estimate(event: Pick<CateringResponse, 'package' | 'headcount'>): Figures | null {
  const total = packageTotal(event.package, event.headcount);
  return total === null ? null : { total_cents: total, ...splitTotal(total) };
}

// ---- Reminders ----

export const REMINDER_LABELS: Record<ReminderKind, string> = {
  follow_up: 'Follow up on the quote',
  event_soon: 'The event is two days away',
  invoice_due: 'The balance invoice is due',
};

export interface DueReminder {
  catering: string;
  kind: ReminderKind;
  at: string;
  label: string;
  event: CateringResponse;
}

/** Every reminder still to come across the events, soonest first (ties by event id). */
export function upcomingReminders(events: CateringResponse[]): DueReminder[] {
  const out: DueReminder[] = [];
  for (const event of events) {
    if (ENDED.has(event.state)) continue;
    for (const r of event.reminders as CateringReminder[]) {
      out.push({
        catering: event.catering,
        kind: r.kind,
        at: r.at,
        label: REMINDER_LABELS[r.kind],
        event,
      });
    }
  }
  const ms = (at: string) => {
    const t = Date.parse(at);
    return Number.isNaN(t) ? Infinity : t;
  };
  return out.sort(
    (a, b) =>
      ms(a.at) - ms(b.at) || a.catering.localeCompare(b.catering) || a.kind.localeCompare(b.kind),
  );
}

// ---- The queue ----

/** The events grouped by state in the diagram's order; a state with none is left out. */
export function groupByState(
  events: CateringResponse[],
): { state: CateringState; events: CateringResponse[] }[] {
  return STATE_ORDER.map((state) => ({
    state,
    events: events.filter((e) => e.state === state),
  })).filter((g) => g.events.length > 0);
}

export type QuoteTotal = { ok: true; total_cents: number | null } | { ok: false; message: string };

/**
 * The staff's optional total override, typed in dollars. Blank means "let the API price it". Zero
 * and anything that is not dollars is refused here with a sentence; the API still checks.
 */
export function parseQuoteTotal(text: string): QuoteTotal {
  if (text.trim() === '') return { ok: true, total_cents: null };
  const cents = parseDollars(text);
  return cents === null
    ? {
        ok: false,
        message: 'Enter the total in dollars, such as 2400 or 2400.50, or leave it blank.',
      }
    : { ok: true, total_cents: cents };
}

// ---- The waits ----

const DEPOSIT_PAID: ReadonlySet<CateringState> = new Set([
  'confirmed',
  'in_production',
  'delivered',
  'invoiced',
  'paid',
  'closed',
]);
const DEAD: ReadonlySet<CateringState> = new Set(['declined', 'expired', 'cancelled']);

/** After the deposit: `paid` once the webhook confirmed the event (or it is further on). */
export function depositOutcome(event: CateringResponse): 'paid' | 'closed' | null {
  if (DEPOSIT_PAID.has(event.state)) return 'paid';
  return DEAD.has(event.state) ? 'closed' : null;
}

/** After the balance: `paid` when the event is `paid` or `closed`, `closed` when it ended unpaid. */
export function balanceOutcome(event: CateringResponse): 'paid' | 'closed' | null {
  if (event.state === 'paid' || event.state === 'closed') return 'paid';
  return DEAD.has(event.state) ? 'closed' : null;
}

/** After staff mark it delivered: `paid` once the invoice shows, which the Queue raises. */
export function invoiceOutcome(event: CateringResponse): 'paid' | 'closed' | null {
  const raised = event.invoice !== null && event.invoice !== undefined && event.invoice !== '';
  if (raised || ['invoiced', 'paid', 'closed'].includes(event.state)) return 'paid';
  return DEAD.has(event.state) ? 'closed' : null;
}

type Read = () => Promise<CateringResponse>;

/** Asks for the event every second, for up to 30 seconds, until the deposit has confirmed it. */
export const waitForDeposit = (
  read: Read,
  options: PollOptions,
): Promise<Polled<CateringResponse>> => pollUntil(read, depositOutcome, options);

/** Until the balance is paid (`paid`/`closed`), or the event ended some other way. */
export const waitForBalance = (
  read: Read,
  options: PollOptions,
): Promise<Polled<CateringResponse>> => pollUntil(read, balanceOutcome, options);

/** Until the balance invoice shows on an event that was just marked delivered. */
export const waitForInvoice = (
  read: Read,
  options: PollOptions,
): Promise<Polled<CateringResponse>> => pollUntil(read, invoiceOutcome, options);

/** The line under /catering/ for a visitor with no sandbox: the page shows no menu, so it says nothing of one. */
export const CATERING_SIGNED_OUT =
  'You have no sandbox yet, so there are no catering events to show.';

/** The words for the end of a wait that did not find what it waited for. */
export function timeoutText(waiting: 'deposit' | 'balance' | 'invoice'): string {
  switch (waiting) {
    case 'deposit':
      return 'Your payment is being confirmed. It has not shown up here yet: the event moves to Confirmed when the webhook arrives. Refresh in a minute.';
    case 'balance':
      return 'The balance payment is being confirmed. The event moves to Paid when the invoice’s webhook arrives. Refresh in a minute.';
    case 'invoice':
      return 'The balance invoice has not been raised yet. The Queue raises it a moment after delivery; refresh in a minute.';
  }
}
