import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { CateringResponse, CateringState } from '../src/contracts';
import {
  BRIEF_MAX,
  CUSTOMER_ACTIONS,
  DATE_CHOICES,
  EMPTY_INQUIRY,
  ENDED,
  MAX_HEADCOUNT,
  MIN_HEADCOUNT,
  NEXT_STEP,
  PACKAGES,
  STAFF_ACTIONS,
  STATE_LABELS,
  STATE_ORDER,
  VENUES,
  addDays,
  balanceOutcome,
  bakeryDate,
  briefClass,
  briefLength,
  briefWarning,
  customerActions,
  depositCents,
  depositOutcome,
  earliestDate,
  estimate,
  figuresOf,
  groupByState,
  inquiryFieldErrors,
  inquiryMissing,
  inquiryReasons,
  inquiryRequest,
  invoiceOutcome,
  isOpenDay,
  leadHint,
  nthOpenDayAfter,
  openDates,
  packageTotal,
  parseHeadcount,
  parseQuoteTotal,
  splitTotal,
  staffActions,
  stateLabel,
  timeoutText,
  upcomingReminders,
  waitForBalance,
  waitForDeposit,
  waitForInvoice,
  type InquiryForm,
} from '../src/lib/catering';

/** A synthetic event in a state; the figures follow the 25% rule when it has a quote. */
function event(state: CateringState, extra: Partial<CateringResponse> = {}): CateringResponse {
  const quoted = !['inquiry', 'declined'].includes(state);
  return {
    catering: '01JTESTCATERING00000000AA',
    state,
    date: '2026-11-20',
    headcount: 40,
    package: 'breakfast-spread',
    venue: 'v3',
    created_at: '2026-11-03T10:00:00-07:00',
    updated_at: '2026-11-03T10:00:00-07:00',
    reminders: [],
    ...(quoted ? { total_cents: 58_000, deposit_cents: 14_500, balance_cents: 43_500 } : {}),
    ...extra,
  };
}

describe('business days', () => {
  test('the bakery is closed on Mondays only', () => {
    expect(isOpenDay('2026-11-09')).toBe(false); // Monday
    for (const d of ['2026-11-03', '2026-11-07', '2026-11-08', '2026-11-10']) {
      expect(isOpenDay(d), d).toBe(true);
    }
    expect(isOpenDay('2026-11-31')).toBe(false); // not a date
    expect(isOpenDay('')).toBe(false);
  });

  test('the nth open day after counts Tuesday to Sunday (the domain’s own vectors)', () => {
    expect(nthOpenDayAfter('2026-11-07', 1)).toBe('2026-11-08');
    expect(nthOpenDayAfter('2026-11-07', 2)).toBe('2026-11-10');
    expect(nthOpenDayAfter('2026-11-07', 7)).toBe('2026-11-15');
    expect(nthOpenDayAfter('2026-11-09', 1)).toBe('2026-11-10');
    expect(nthOpenDayAfter('2026-11-09', 7)).toBe('2026-11-17');
    expect(nthOpenDayAfter('2026-11-07', 0)).toBe('2026-11-07');
  });

  test('the earliest date is the 7th open day after today', () => {
    expect(earliestDate('2026-11-03')).toBe('2026-11-11'); // Tuesday: Monday falls inside the count
    expect(earliestDate('2026-11-07')).toBe('2026-11-15');
    expect(earliestDate('2026-11-09')).toBe('2026-11-17'); // from the closed Monday itself
    expect(earliestDate('2027-03-12')).toBe('2027-03-20');
  });

  test('a business instant is read as the bakery’s date, not the UTC one', () => {
    // 23:30 on Friday 2026-10-30 in Denver is already Saturday in UTC.
    expect(bakeryDate(Date.parse('2026-10-31T05:30:00Z'))).toBe('2026-10-30');
    expect(earliestDate(bakeryDate(Date.parse('2026-10-31T05:30:00Z')))).toBe('2026-11-07');
  });

  test('the date list ends inside the API’s 365-day bound (catering-too-far)', () => {
    // The API refuses a date more than 365 days after business today (since 2026-11-10); the
    // list's 60 open days after the earliest end about ten weeks out, so it never offers one.
    for (const today of ['2026-11-03', '2027-03-04', '2028-02-29']) {
      const last = openDates(earliestDate(today)).at(-1)!;
      expect(last <= addDays(today, 365), today).toBe(true);
      expect(last <= addDays(today, 90), today).toBe(true);
    }
  });

  test('addDays crosses month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  test('the date list is open days from the earliest, 60 of them, none a Monday', () => {
    const dates = openDates('2026-11-11');
    expect(dates).toHaveLength(DATE_CHOICES);
    expect(dates[0]).toBe('2026-11-11');
    expect(dates.slice(0, 6)).toEqual([
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
      '2026-11-17',
    ]);
    expect(dates.every(isOpenDay)).toBe(true);
    expect(dates).toEqual([...dates].sort());
    // An earliest date that is itself closed starts at the next open day.
    expect(openDates('2026-11-09', 2)).toEqual(['2026-11-10', '2026-11-11']);
  });

  test('the hint names the 7-business-day rule and the earliest date', () => {
    const hint = leadHint('2026-11-11', Date.parse('2026-11-10T16:00:00Z'));
    expect(hint).toContain('7 business days');
    expect(hint).toContain('Tuesday to Sunday');
    expect(hint).toContain('the earliest day is Wed 11 Nov.');
  });
});

describe('the inquiry’s hints', () => {
  const earliest = '2026-11-11';
  const good: InquiryForm = {
    date: '2026-11-14',
    headcount: '40',
    package: 'breakfast-spread',
    venue: 'v2',
    brief: 'Setup at 8, no nuts',
  };

  test('a complete form has no reason against it and builds the API’s body', () => {
    expect(inquiryReasons(good, earliest)).toEqual([]);
    expect(inquiryRequest(good, earliest)).toEqual({
      date: '2026-11-14',
      headcount: 40,
      package: 'breakfast-spread',
      venue: 'v2',
      brief: 'Setup at 8, no nuts',
    });
  });

  test('a blank brief is left out of the body, and nothing personal is ever a field', () => {
    const body = inquiryRequest({ ...good, brief: '  \n ' }, earliest);
    expect(body).toEqual({
      date: '2026-11-14',
      headcount: 40,
      package: 'breakfast-spread',
      venue: 'v2',
    });
    expect(Object.keys(inquiryRequest(good, earliest) ?? {}).sort()).toEqual([
      'brief',
      'date',
      'headcount',
      'package',
      'venue',
    ]);
  });

  test('each missing choice is named, and no body is built', () => {
    expect(inquiryReasons(EMPTY_INQUIRY, earliest)).toEqual([
      'Choose a date.',
      'Enter a headcount from 10 to 200.',
      'Choose a package.',
      'Choose a venue.',
    ]);
    expect(inquiryRequest(EMPTY_INQUIRY, earliest)).toBeNull();
  });

  test('a date before the earliest, or on a Monday, is a reason', () => {
    expect(inquiryReasons({ ...good, date: '2026-11-10' }, earliest)).toEqual([
      'The earliest date is 2026-11-11.',
    ]);
    expect(inquiryReasons({ ...good, date: '2026-11-16' }, earliest)).toEqual([
      'The bakery is closed on Mondays. Choose another date.',
    ]);
  });

  test('the headcount is a whole number from 10 to 200', () => {
    expect([MIN_HEADCOUNT, MAX_HEADCOUNT]).toEqual([10, 200]);
    expect(parseHeadcount('10')).toBe(10);
    expect(parseHeadcount(' 200 ')).toBe(200);
    for (const bad of ['9', '201', '', '12.5', '-20', 'forty', '1e2', '0040x']) {
      expect(parseHeadcount(bad), bad).toBeNull();
    }
    expect(inquiryReasons({ ...good, headcount: '9' }, earliest)).toEqual([
      'Enter a headcount from 10 to 200.',
    ]);
  });

  test('the brief counts characters the way the API does and stops at 500', () => {
    expect(BRIEF_MAX).toBe(500);
    expect(briefLength('a'.repeat(500))).toBe(500);
    // Scalar values, not UTF-16 units; controls other than a newline do not count.
    expect(briefLength('\u{1F950}'.repeat(3))).toBe(3);
    expect(briefLength('a\tb\u0007c\nd')).toBe(5);
    expect(inquiryReasons({ ...good, brief: 'b'.repeat(500) }, earliest)).toEqual([]);
    expect(inquiryReasons({ ...good, brief: 'b'.repeat(503) }, earliest)).toEqual([
      'Shorten the brief by 3.',
    ]);
  });

  test('a class hint warns but does not stop the send: the API is the check', () => {
    const risky = { ...good, brief: 'write to fern@example.com' };
    expect(briefWarning(risky.brief)).toContain('email address');
    expect(inquiryReasons(risky, earliest)).toEqual([]);
    expect(inquiryRequest(risky, earliest)).not.toBeNull();
  });
});

describe('the brief’s four classes, hinted as the API’s checker finds them', () => {
  // The vectors are crates/domain/src/free_text.rs's own tests.
  const none = [
    'Please slice the loaf',
    'Leave at the side door',
    'Two candles, no message',
    '12 scones',
    'Two candles, 24 forks, 3 napkins',
    'Ring the bell twice (the left one)',
    'Half-and-half, no sugar. Thanks!',
    'Pick up at 3.30 please',
    'Table for 12 at 5, back door',
    'e.g. the big one, i.e. the round loaf',
    'Line one\nLine two',
    '',
    'meet @ 5pm',
    'cake@ home',
    '@home',
    'see you @noon',
    'fern@localhost',
    'fern@.com',
    'fern@example.',
    '555-01',
    '123456',
    '12 34 56',
    '6 loaves, 12 rolls, 7 tarts',
    'bread.community',
    'end.Done',
    'U.S. only',
    'the.dog',
    'Thanks.Comfy seat',
    'wait... what',
    '.com',
    'Cost: $4.50',
    '555\n0100',
  ];
  test.each(none)('%j looks like none of them', (text) => {
    expect(briefClass(text)).toBeNull();
    expect(briefWarning(text)).toBeNull();
  });

  const found: [string, string][] = [
    ['mail me at fern@example.com', 'email'],
    ['fern.sorrel+cakes@example.org', 'email'],
    ['x@a.b', 'email'],
    ['(fern@example.net)', 'email'],
    ['me@example.com.', 'email'],
    ['call 555-0100', 'phone'],
    ['call 555 0100', 'phone'],
    ['(801) 555-0100', 'phone'],
    ['+1 801 555 0100', 'phone'],
    ['801.555.0100', 'phone'],
    ['8015550100', 'phone'],
    ['call me on 555 0100 after 5', 'phone'],
    ['５５５０１００', 'phone'],
    ['12345678901234567890', 'phone'],
    ['4242 4242 4242 4242', 'card-number'],
    ['4242-4242-4242-4242', 'card-number'],
    ['pay with 4242 4242 4242 4242 please', 'card-number'],
    ['1234567890123', 'card-number'],
    ['1234567890123456789', 'card-number'],
    ['see http://example.com', 'url'],
    ['see HTTPS://EXAMPLE.ORG/x', 'url'],
    ['www.example', 'url'],
    ['bakery.com', 'url'],
    ['go to cake-shop.org now', 'url'],
    ['a.co', 'url'],
    ['note.dev,', 'url'],
    ['x.edu/path', 'url'],
    // A control character cannot split a number or a word.
    ['555\u00000100', 'phone'],
    ['4242\t4242\t4242\t4242', 'card-number'],
    ['ex\u0007ample.com', 'url'],
  ];
  test.each(found)('%j looks like a %s', (text, expected) => {
    expect(briefClass(text)).toBe(expected);
    expect(briefWarning(text)).not.toBeNull();
  });

  test('a warning names the class and never quotes the text', () => {
    for (const [text] of found) {
      const warning = briefWarning(text) ?? '';
      expect(warning.includes(text.trim()) && text.trim().length > 3, text).toBe(false);
    }
  });
});

describe('the figures', () => {
  test('the deposit is 25% rounded half-up and the balance is the rest', () => {
    expect(depositCents(58_000)).toBe(14_500);
    expect(splitTotal(58_000)).toEqual({ deposit_cents: 14_500, balance_cents: 43_500 });
    // Half-up: 25% of 2 cents is 0.5, which rounds to 1; of 6 it is 1.5, which rounds to 2.
    expect(splitTotal(2)).toEqual({ deposit_cents: 1, balance_cents: 1 });
    expect(splitTotal(6)).toEqual({ deposit_cents: 2, balance_cents: 4 });
    expect(splitTotal(1)).toEqual({ deposit_cents: 0, balance_cents: 1 });
    expect(splitTotal(101)).toEqual({ deposit_cents: 25, balance_cents: 76 });
  });

  test('deposit plus balance is the total, for a spread of totals', () => {
    for (const total of [1, 2, 3, 99, 100, 101, 949, 9_500, 58_000, 370_000, 999_999_999]) {
      const { deposit_cents, balance_cents } = splitTotal(total);
      expect(deposit_cents + balance_cents, String(total)).toBe(total);
      expect(Math.abs(deposit_cents * 4 - total)).toBeLessThanOrEqual(2);
    }
  });

  test('a package’s total is its price per head times the headcount', () => {
    expect(packageTotal('pastry-platter', 10)).toBe(9_500);
    expect(packageTotal('breakfast-spread', 40)).toBe(58_000);
    expect(packageTotal('lunch-boxes', 200)).toBe(370_000);
    expect(packageTotal('nope', 40)).toBeNull();
    expect(packageTotal('lunch-boxes', 0)).toBeNull();
    expect(estimate(event('inquiry'))).toEqual({
      total_cents: 58_000,
      deposit_cents: 14_500,
      balance_cents: 43_500,
    });
  });

  test('a response’s figures are the API’s own, and an unquoted event has none', () => {
    expect(figuresOf(event('quoted'))).toEqual({
      total_cents: 58_000,
      deposit_cents: 14_500,
      balance_cents: 43_500,
    });
    expect(figuresOf(event('inquiry'))).toBeNull();
    expect(figuresOf(event('quoted', { balance_cents: null }))).toBeNull();
  });

  test('a staff total is dollars, blank means let the API price it', () => {
    expect(parseQuoteTotal('')).toEqual({ ok: true, total_cents: null });
    expect(parseQuoteTotal('   ')).toEqual({ ok: true, total_cents: null });
    expect(parseQuoteTotal('2400')).toEqual({ ok: true, total_cents: 240_000 });
    expect(parseQuoteTotal('2400.5')).toEqual({ ok: true, total_cents: 240_050 });
    for (const bad of ['0', 'lots', '-5', '12.345', '$20']) {
      expect(parseQuoteTotal(bad).ok, bad).toBe(false);
    }
  });
});

describe('the packages, venues and rules against the domain', () => {
  const file = fileURLToPath(new URL('../../../crates/domain/src/catering.rs', import.meta.url));
  const rust = existsSync(file) ? readFileSync(file, 'utf8') : null;

  test('the four packages and their prices', () => {
    expect(PACKAGES.map((p) => p.slug)).toEqual([
      'pastry-platter',
      'breakfast-spread',
      'lunch-boxes',
      'celebration-cake-and-coffee',
    ]);
    expect(VENUES.map((v) => v.id)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
  });

  test.skipIf(rust === null)('match crates/domain/src/catering.rs, which owns them', () => {
    const text = rust ?? '';
    const packages = [
      ...text.matchAll(/slug:\s*"([^"]+)",\s*per_head_cents:\s*Cents\(([\d_]+)\)/g),
    ].map((m) => ({ slug: m[1], per_head_cents: Number((m[2] ?? '').replaceAll('_', '')) }));
    expect(PACKAGES.map(({ slug, per_head_cents }) => ({ slug, per_head_cents }))).toEqual(
      packages,
    );
    const venues = /VENUES:\s*\[&str;\s*6\]\s*=\s*\[([^\]]*)\]/.exec(text)?.[1] ?? '';
    expect(VENUES.map((v) => `"${v.id}"`).join(', ')).toBe(venues.replace(/\s+/g, ' ').trim());
    const number = (name: string) =>
      Number(
        new RegExp(`pub const ${name}: \\w+ = ([\\d_]+);`).exec(text)?.[1]?.replaceAll('_', ''),
      );
    expect(number('MIN_HEADCOUNT')).toBe(MIN_HEADCOUNT);
    expect(number('MAX_HEADCOUNT')).toBe(MAX_HEADCOUNT);
    expect(number('LEAD_BUSINESS_DAYS')).toBe(7);
    expect(number('DEPOSIT_BP')).toBe(2_500);
  });
});

describe('the states and what each offers', () => {
  const states = [...STATE_ORDER];

  test('the twelve states of the diagram, each with a label and a next step', () => {
    expect(states).toHaveLength(12);
    expect(new Set(states).size).toBe(12);
    for (const s of states) {
      expect(stateLabel(s), s).toBe(STATE_LABELS[s]);
      expect(NEXT_STEP[s].length, s).toBeGreaterThan(10);
    }
    expect(Object.keys(STATE_LABELS).sort()).toEqual([...states].sort());
    expect(Object.keys(NEXT_STEP).sort()).toEqual([...states].sort());
  });

  test('the customer’s actions by state', () => {
    expect(
      Object.fromEntries(
        states.map((s) => [s, customerActions(s)] as const).filter(([, a]) => a.length > 0),
      ),
    ).toEqual({
      quoted: ['accept'],
      accepted: ['pay-deposit'],
      confirmed: ['cancel'],
      invoiced: ['pay-balance'],
    });
  });

  test('staff’s actions by state', () => {
    expect(
      Object.fromEntries(
        states.map((s) => [s, staffActions(s)] as const).filter(([, a]) => a.length > 0),
      ),
    ).toEqual({
      inquiry: ['quote', 'decline'],
      confirmed: ['start-production', 'staff-cancel'],
      in_production: ['delivered'],
    });
  });

  test('an ended event offers nothing to anyone', () => {
    expect([...ENDED].sort()).toEqual(['cancelled', 'closed', 'declined', 'expired']);
    for (const s of ENDED) {
      expect(CUSTOMER_ACTIONS[s], s).toEqual([]);
      expect(STAFF_ACTIONS[s], s).toEqual([]);
    }
  });

  test('every transition of the diagram is offered to the one who makes it', () => {
    // The diagram's commands: inquiry -> quoted/declined by staff; quoted -> accepted by the
    // customer; confirmed -> in_production, cancelled by staff or customer; in_production ->
    // delivered by staff; invoiced -> paid by the customer.
    expect(staffActions('inquiry')).toEqual(expect.arrayContaining(['quote', 'decline']));
    expect(customerActions('quoted')).toContain('accept');
    expect(staffActions('confirmed')).toEqual(
      expect.arrayContaining(['start-production', 'staff-cancel']),
    );
    expect(customerActions('confirmed')).toContain('cancel');
    expect(staffActions('in_production')).toContain('delivered');
    expect(customerActions('invoiced')).toContain('pay-balance');
    // The webhook alone moves an event to confirmed and to paid: no page action does.
    const offered = new Set<string>(
      states.flatMap((s) => [...customerActions(s), ...staffActions(s)]),
    );
    expect([...offered].sort()).toEqual(
      [
        'accept',
        'cancel',
        'decline',
        'delivered',
        'pay-balance',
        'pay-deposit',
        'quote',
        'staff-cancel',
        'start-production',
      ].sort(),
    );
  });

  test('the queue groups by state in the diagram’s order and leaves empty states out', () => {
    const events = [
      event('confirmed', { catering: 'C' }),
      event('inquiry', { catering: 'A' }),
      event('confirmed', { catering: 'D' }),
      event('cancelled', { catering: 'E' }),
      event('quoted', { catering: 'B' }),
    ];
    const groups = groupByState(events);
    expect(groups.map((g) => g.state)).toEqual(['inquiry', 'quoted', 'confirmed', 'cancelled']);
    expect(groups[2]?.events.map((e) => e.catering)).toEqual(['C', 'D']);
    expect(groupByState([])).toEqual([]);
  });
});

describe('reminders by alarm', () => {
  const at = (day: string) => `${day}T07:00:00-07:00`;

  test('soonest first across every event, ties by event', () => {
    const list = upcomingReminders([
      event('quoted', {
        catering: 'B',
        reminders: [{ kind: 'follow_up', at: at('2026-11-06') }],
      }),
      event('confirmed', {
        catering: 'A',
        reminders: [
          { kind: 'event_soon', at: at('2026-11-18') },
          { kind: 'invoice_due', at: at('2026-11-30') },
        ],
      }),
      event('invoiced', {
        catering: 'C',
        reminders: [{ kind: 'follow_up', at: at('2026-11-06') }],
      }),
    ]);
    expect(list.map((r) => `${r.catering}:${r.kind}`)).toEqual([
      'B:follow_up',
      'C:follow_up',
      'A:event_soon',
      'A:invoice_due',
    ]);
    expect(list.map((r) => r.label)).toEqual([
      'Follow up on the quote',
      'Follow up on the quote',
      'The event is two days away',
      'The balance invoice is due',
    ]);
  });

  test('compares instants, not text, across the offset change', () => {
    const list = upcomingReminders([
      event('quoted', {
        catering: 'A',
        reminders: [{ kind: 'follow_up', at: '2026-11-01T07:00:00-07:00' }],
      }),
      event('quoted', {
        catering: 'B',
        reminders: [{ kind: 'follow_up', at: '2026-11-01T06:30:00-06:00' }],
      }),
    ]);
    expect(list.map((r) => r.catering)).toEqual(['B', 'A']);
  });

  test('an ended event shows none, and no events show none', () => {
    expect(
      upcomingReminders([
        event('cancelled', { reminders: [{ kind: 'event_soon', at: at('2026-11-18') }] }),
      ]),
    ).toEqual([]);
    expect(upcomingReminders([])).toEqual([]);
  });
});

describe('the waits after a payment', () => {
  const instant = async () => {};

  test('the deposit is paid once the event is confirmed or further on', () => {
    for (const s of [
      'confirmed',
      'in_production',
      'delivered',
      'invoiced',
      'paid',
      'closed',
    ] as const) {
      expect(depositOutcome(event(s)), s).toBe('paid');
    }
    // Accepted, and quoted again after a lapsed hold, keep waiting: the webhook may still come.
    expect(depositOutcome(event('accepted'))).toBeNull();
    expect(depositOutcome(event('quoted'))).toBeNull();
    for (const s of ['declined', 'expired', 'cancelled'] as const) {
      expect(depositOutcome(event(s)), s).toBe('closed');
    }
  });

  test('the balance is paid at paid or closed, and ended unpaid otherwise', () => {
    expect(balanceOutcome(event('invoiced'))).toBeNull();
    expect(balanceOutcome(event('paid'))).toBe('paid');
    expect(balanceOutcome(event('closed'))).toBe('paid');
    expect(balanceOutcome(event('cancelled'))).toBe('closed');
  });

  test('the invoice shows when the event carries one', () => {
    expect(invoiceOutcome(event('delivered'))).toBeNull();
    expect(invoiceOutcome(event('delivered', { invoice: '01JTESTINVOICE0000000000AA' }))).toBe(
      'paid',
    );
    expect(invoiceOutcome(event('invoiced'))).toBe('paid');
  });

  test('the deposit wait looks every second and stops when the webhook has moved the event', async () => {
    const seen: CateringState[] = ['accepted', 'accepted', 'confirmed'];
    const slept: number[] = [];
    let n = 0;
    const result = await waitForDeposit(async () => event(seen[n++]!), {
      sleep: async (ms) => void slept.push(ms),
    });
    expect(result).toEqual({ kind: 'paid', value: event('confirmed') });
    expect(slept).toEqual([1000, 1000]);
  });

  test('the balance wait gives up after 30 seconds, having looked 31 times', async () => {
    let looks = 0;
    const result = await waitForBalance(
      async () => {
        looks += 1;
        return event('invoiced');
      },
      { sleep: instant },
    );
    expect(result).toEqual({ kind: 'timeout' });
    expect(looks).toBe(31);
  });

  test('the balance wait ends at closed, and a failed look is a missed look', async () => {
    let looks = 0;
    const result = await waitForBalance(
      async () => {
        looks += 1;
        if (looks < 3) throw new Error('offline');
        return event('closed');
      },
      { sleep: instant },
    );
    expect(result.kind).toBe('paid');
    expect(looks).toBe(3);
  });

  test('the invoice wait stops when asked to', async () => {
    let stop = false;
    const result = await waitForInvoice(async () => event('delivered'), {
      sleep: async () => void (stop = true),
      stopped: () => stop,
    });
    expect(result).toEqual({ kind: 'stopped' });
  });

  test('a wait that times out has words, and they promise nothing', () => {
    for (const what of ['deposit', 'balance', 'invoice'] as const) {
      expect(timeoutText(what)).toMatch(/refresh/i);
    }
  });
});

describe('the inquiry form says what is wrong at its field (F11, 2026-11-10)', () => {
  const earliest = '2026-11-17';

  test('a headcount out of range is said at the headcount, in its own words', () => {
    expect(inquiryFieldErrors({ ...EMPTY_INQUIRY, headcount: '500' }, earliest)).toEqual({
      headcount: '500 is more than 200 people.',
    });
    expect(inquiryFieldErrors({ ...EMPTY_INQUIRY, headcount: '4' }, earliest)).toEqual({
      headcount: '4 is fewer than 10 people.',
    });
    expect(inquiryFieldErrors({ ...EMPTY_INQUIRY, headcount: 'ten' }, earliest).headcount).toBe(
      'A whole number of people, 10 to 200.',
    );
  });

  test('an empty field is not wrong yet: it is said beside the button as still to fill', () => {
    expect(inquiryFieldErrors(EMPTY_INQUIRY, earliest)).toEqual({});
    expect(inquiryMissing(EMPTY_INQUIRY)).toBe(
      'Still to fill: a day, a headcount, a package and a venue.',
    );
    expect(inquiryMissing({ ...EMPTY_INQUIRY, date: earliest, headcount: '40' })).toBe(
      'Still to fill: a package and a venue.',
    );
    expect(
      inquiryMissing({ date: earliest, headcount: '40', package: 'p', venue: 'v', brief: '' }),
    ).toBeNull();
  });

  test('a brief over the limit is said at the brief', () => {
    expect(inquiryFieldErrors({ ...EMPTY_INQUIRY, brief: 'b'.repeat(503) }, earliest)).toEqual({
      brief: '3 characters over the limit.',
    });
  });
});
