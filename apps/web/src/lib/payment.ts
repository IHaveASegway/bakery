// What the payment step decides, as pure functions: which key to use, the billing details, when an
// order counts as paid, how long to wait for the webhook, and what a partial refund may be. The
// components in PaymentStep.tsx and Ledger.tsx only draw the answers.
import type { OrderResponse, OrderStatus, PersonaAddress } from '../contracts';
import { TEST_KEY_PREFIX } from './publishable-key';
import { dollars, parseDollars } from './money';

/**
 * The publishable key the page uses: the build's `PUBLIC_STRIPE_PUBLISHABLE_KEY`, else the one the
 * payment response carries. Anything that is not a sandbox key is treated as no key at all, so a
 * page never loads Stripe with a live key even if one were handed to it.
 */
export function publishableKeyFor(
  build: string | undefined,
  response: string | null | undefined,
): string | null {
  for (const candidate of [build, response]) {
    const key = (candidate ?? '').trim();
    if (key.startsWith(TEST_KEY_PREFIX)) return key;
  }
  return null;
}

/** The billing details `confirmPayment` is given, from the sandbox's synthetic persona. */
export function billingDetails(persona: { name: string; address: PersonaAddress }) {
  const { line1, city, state, postal_code, country } = persona.address;
  return { name: persona.name, address: { line1, city, state, postal_code, country } };
}

/** The checkout page's own address, without query or fragment, for `return_url`. */
export function returnUrl(location: Pick<Location, 'origin' | 'pathname'>): string {
  return `${location.origin}${location.pathname}`;
}

/** Statuses after the webhook has marked the order paid (docs/domain.md, "Order"). */
const PAID: ReadonlySet<OrderStatus> = new Set([
  'confirmed',
  'in_production',
  'ready',
  'picked_up',
  'out_for_delivery',
  'delivered',
  'closed',
]);

/** Statuses an unpaid order can no longer leave by paying. */
const CLOSED: ReadonlySet<OrderStatus> = new Set(['expired', 'cancelled', 'refund_pending']);

export const isPaid = (status: OrderStatus) => PAID.has(status);
export const isClosed = (status: OrderStatus) => CLOSED.has(status);

export type Waited =
  | { kind: 'paid'; order: OrderResponse }
  | { kind: 'closed'; order: OrderResponse }
  | { kind: 'timeout' }
  | { kind: 'stopped' };

export const POLL_INTERVAL_MS = 1_000;
export const POLL_LIMIT_MS = 30_000;

export interface PollOptions {
  sleep: (ms: number) => Promise<void>;
  stopped?: () => boolean;
  intervalMs?: number;
  limitMs?: number;
}

export type Polled<T> =
  | { kind: 'paid'; value: T }
  | { kind: 'closed'; value: T }
  | { kind: 'timeout' }
  | { kind: 'stopped' };

/**
 * Reads every second, for up to 30 seconds, until `classify` calls the answer `paid` (what was
 * waited for happened) or `closed` (it can no longer happen). A failed read is just a missed
 * look. The sleep and the stop flag are parameters so a test runs it in no time. The order's
 * payment wait and the catering waits (docs/architecture.md, "The catering saga") are this loop.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  classify: (value: T) => 'paid' | 'closed' | null,
  options: PollOptions,
): Promise<Polled<T>> {
  const interval = options.intervalMs ?? POLL_INTERVAL_MS;
  const limit = options.limitMs ?? POLL_LIMIT_MS;
  for (let waited = 0; waited <= limit; waited += interval) {
    if (options.stopped?.()) return { kind: 'stopped' };
    try {
      const value = await read();
      const kind = classify(value);
      if (kind === 'paid') return { kind, value };
      if (kind === 'closed') return { kind, value };
    } catch {
      // The next look tries again.
    }
    await options.sleep(interval);
  }
  return { kind: 'timeout' };
}

/**
 * Asks for the order every second, for up to 30 seconds, until the webhook has marked it paid
 * (never the browser: a succeeded confirm alone proves nothing here).
 */
export async function waitForPaid(
  read: () => Promise<OrderResponse>,
  options: PollOptions,
): Promise<Waited> {
  const result = await pollUntil(
    read,
    (order) => (isPaid(order.status) ? 'paid' : isClosed(order.status) ? 'closed' : null),
    options,
  );
  if (result.kind === 'paid') return { kind: 'paid', order: result.value };
  if (result.kind === 'closed') return { kind: 'closed', order: result.value };
  return result;
}

export type RefundAmount = { ok: true; cents: number } | { ok: false; message: string };

/** Dollars typed into "Refund part", checked against the order's total. */
export function parseRefundAmount(text: string, totalCents: number): RefundAmount {
  const cents = parseDollars(text);
  if (cents === null) {
    return { ok: false, message: 'Enter an amount in dollars, such as 4 or 4.50.' };
  }
  if (cents > totalCents) {
    return { ok: false, message: `That is more than the order’s total of ${dollars(totalCents)}.` };
  }
  return { ok: true, cents };
}

/** The words under the Element after a failed confirm: Stripe's own message, else a plain one. */
export function declineMessage(error: { message?: string | undefined }): string {
  const own = (error.message ?? '').trim();
  return own === '' ? 'The payment did not go through. Try another test card.' : own;
}
