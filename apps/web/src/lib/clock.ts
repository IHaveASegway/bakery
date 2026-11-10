// The console's clock control, as pure functions and one small class. Business time is wall time
// plus the sandbox's offset (docs/architecture.md, "Time travel"); the page shows it ticking
// between answers and takes the offset from the API each time it answers. The API owns the rules:
// the 14-day cap and "not positive" are its 422s, shown in its words.
import type { ClockRequest, ClockResponse, ClockStep } from '../contracts';
import { ApiError, advanceClock } from './api';
import { attemptFor, keepKeyAfter, type Attempt } from './attempt';
import { momentText } from './when';
import { businessTime } from './slots';

/** The most business time may run ahead of the wall clock: 14 days. */
export const MAX_OFFSET_S = 14 * 86_400;

/** The four steps, in the order the buttons show them. */
export const STEPS: { step: ClockStep; label: string; says: string }[] = [
  { step: '15m', label: '15 minutes', says: 'Advance 15 minutes' },
  { step: '1h', label: '1 hour', says: 'Advance 1 hour' },
  { step: '1d', label: '1 day', says: 'Advance 1 day' },
  { step: 'next-opening', label: 'Next opening', says: 'Advance to the next opening, 7:00 am' },
];

/** Business time now, in Unix milliseconds. */
export const businessNowMs = (wallMs: number, offsetS: number): number => wallMs + offsetS * 1000;

/** Business now as the wire writes it, `2026-11-07T09:42:10-07:00`. */
export const businessNowText = (wallMs: number, offsetS: number): string =>
  businessTime(businessNowMs(wallMs, offsetS));

/** "1 d 2 h 15 min", "45 min", or "0 min" for an offset in seconds. */
export function formatOffset(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const parts = [
    d > 0 ? `${d} d` : '',
    h > 0 ? `${h} h` : '',
    m > 0 || minutes === 0 ? `${m} min` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

/** What is left of the 14 days, for the line under the buttons; negative input counts as none. */
export const remainingS = (offsetS: number): number => Math.max(0, MAX_OFFSET_S - offsetS);

const RULES: Record<string, string> = {
  'offset-cap':
    'The clock is at its limit: business time may run at most 14 days ahead of the wall clock, and this step would pass it.',
  'not-positive':
    'That advance would not move the clock forward. Business time only moves forward.',
};

/** The rule a clock 422 names: from the detail, else from the problem type's last segment. */
export function clockRule(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const text = `${error.detail ?? ''} ${error.slug}`.toLowerCase();
  return Object.keys(RULES).find((rule) => text.includes(rule)) ?? null;
}

/** The plain sentence for a clock refusal, or null for any other error. */
export function clockRefusal(error: unknown): string | null {
  const rule = clockRule(error);
  return rule === null ? null : (RULES[rule] ?? null);
}

/**
 * Sends the clock buttons' clicks. Every click is an intent with its own Idempotency-Key. If the
 * answer never came (offline, a 5xx) the next click on the same step sends the same key, so the
 * API replays the first answer instead of moving the clock twice; after an answer or a refusal
 * the next click is a new intent with a new key (lib/attempt.ts).
 */
export class ClockClicks {
  private previous: Attempt | null = null;
  private readonly mint: (() => string) | undefined;
  private readonly send: (id: string, req: ClockRequest, key: string) => Promise<ClockResponse>;

  constructor(
    send: (id: string, req: ClockRequest, key: string) => Promise<ClockResponse> = advanceClock,
    mint?: () => string,
  ) {
    this.send = send;
    this.mint = mint;
  }

  async click(sandboxId: string, step: ClockStep): Promise<ClockResponse> {
    const current = attemptFor(this.previous, step, this.mint);
    this.previous = current;
    try {
      const answer = await this.send(sandboxId, { step }, current.key);
      this.previous = null;
      return answer;
    } catch (e) {
      if (!keepKeyAfter(e)) this.previous = null;
      throw e;
    }
  }
}

/** Business now for the display: the wire form for `<time>`, and words for a person. */
export function businessNowView(wallMs: number, offsetS: number): { iso: string; text: string } {
  const iso = businessNowText(wallMs, offsetS);
  return { iso, text: momentText(iso, { seconds: true }) };
}
