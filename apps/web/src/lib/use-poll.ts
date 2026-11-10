// Looking again on a timer, for the screens that hold no socket: the catering staff queue, the
// visitor's own /catering/ page and Dispatch. A payment arrives by Stripe's webhook, a reminder or
// a lapse by an alarm, a quote, production or delivery from the other side of the counter, and a
// stop goes out when its order is made ready on the board, none of it by anything this page did,
// so these pages look every ten seconds. A look that fails waits twice as long before the next, up
// to a minute, and the first look that works goes back to ten seconds. The Kitchen board and the
// order's own page listen on the Kitchen's socket instead: there a change must show at once, and
// on every screen that watches.
import { useEffect, useRef } from 'react';

/** The wait between looks while they work. */
export const POLL_MS = 10_000;
/** The longest wait after looks that fail. */
export const POLL_MAX_MS = 60_000;

/** The wait before the next look: `POLL_MS` after one that worked, doubling after each failure. */
export function nextPollMs(failures: number, base = POLL_MS, max = POLL_MAX_MS): number {
  return Math.min(max, base * 2 ** Math.max(0, failures));
}

/**
 * Runs `look` every `POLL_MS` while the component is mounted, backing off while it fails. `look`
 * resolves true when it worked. The first look is the caller's own (on mount), so this one starts
 * a wait later. A tab in the background is not looked from: the next look runs when it is shown.
 */
export function usePoll(look: () => Promise<boolean>, enabled = true): void {
  const latest = useRef(look);
  latest.current = look;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!stopped) timer = setTimeout(() => void run(), nextPollMs(failures));
    };
    const run = async () => {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.hidden) return schedule();
      const ok = await latest.current().catch(() => false);
      failures = ok ? 0 : failures + 1;
      schedule();
    };
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled]);
}
