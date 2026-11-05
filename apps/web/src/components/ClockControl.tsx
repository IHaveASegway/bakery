import { useEffect, useRef, useState } from 'react';
import type { ClockStep } from '../contracts';
import {
  ClockClicks,
  MAX_OFFSET_S,
  STEPS,
  businessNowView,
  clockRefusal,
  formatOffset,
  remainingS,
} from '../lib/clock';
import { describeError, type Message as Text } from '../lib/messages';
import GuestNote from './GuestNote';
import Message from './Message';

/**
 * Time travel: the business clock shown live, and four steps that move it forward. Business time
 * is the wall clock plus an offset; between answers the page ticks it locally from the last
 * offset the API gave. Whether a step is allowed (the 14-day cap, a step that moves nothing) is
 * the API's decision, shown in its words.
 */
export default function ClockControl({
  sandboxId,
  offsetSeconds,
  isGuest,
  onAdvanced,
}: {
  sandboxId: string;
  offsetSeconds: number;
  isGuest: boolean;
  onAdvanced: () => void;
}) {
  // The latest offset: from the sandbox, then from each advance's own answer.
  const [offset, setOffset] = useState(offsetSeconds);
  useEffect(() => setOffset(offsetSeconds), [offsetSeconds]);
  const [wall, setWall] = useState(() => Date.now());
  const [busy, setBusy] = useState<ClockStep | null>(null);
  const [error, setError] = useState<Text | null>(null);
  const [said, setSaid] = useState('');
  // One key per click, kept only for a retry of the same step after an unanswered request.
  const clicks = useRef(new ClockClicks());

  useEffect(() => {
    const timer = setInterval(() => setWall(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  async function advance(step: ClockStep) {
    setBusy(step);
    setError(null);
    setSaid('');
    try {
      const clock = await clicks.current.click(sandboxId, step);
      setOffset(clock.clock_offset_s);
      setWall(Date.now());
      setSaid(`Business time moved forward. It is now ${clock.business_now}.`);
      onAdvanced();
    } catch (e) {
      const refusal = clockRefusal(e);
      setError(
        refusal === null ? describeError(e) : { title: 'The clock did not move', detail: refusal },
      );
    } finally {
      setBusy(null);
    }
  }

  const now = businessNowView(wall, offset);
  const left = remainingS(offset);

  return (
    <>
      <h3>Clock</h3>
      <p>
        Business time is{' '}
        <strong>
          <time dateTime={now.iso}>{now.text}</time>
        </strong>{' '}
        (Mountain). It runs {formatOffset(offset)} ahead of the wall clock; the most it may run
        ahead is {formatOffset(MAX_OFFSET_S)}, so {formatOffset(left)} is left. Business time only
        moves forward.
      </p>
      <p className="actions">
        {STEPS.map(({ step, label, says }) => (
          <button
            key={step}
            type="button"
            disabled={busy !== null || isGuest}
            aria-label={says}
            onClick={() => void advance(step)}
          >
            {busy === step ? 'Moving…' : label}
          </button>
        ))}
      </p>
      {isGuest && <GuestNote />}
      <Message error={error}>{said && <p className="hint">{said}</p>}</Message>
      <p className="hint">
        How this works: business time is the wall clock plus an offset that the Sandbox keeps and
        hands to every object, and each object re-works its timers from it. A step grows the offset;
        each click carries its own Idempotency-Key, so a repeated request moves the clock once. It
        moves: order expiries (an unpaid order lasts 15 minutes of business time), slot dates, the
        bake list’s day, and as they arrive catering lead times and reminders, invoice due dates,
        campaign schedules and simulated opens, and the time written on new events. It does not
        move: the platform’s alarms (they run on the wall clock and are set again when the clock
        moves), the nightly wipe and its 36-hour backstop, cookies, Turnstile tokens, Stripe’s
        timestamps and webhook tolerance, the daily traffic ledger, the recording time on events,
        and logs.
      </p>
    </>
  );
}
