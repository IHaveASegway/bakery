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
import { whenText } from '../lib/when';
import GuestNote from './GuestNote';
import Message from './Message';
import { HOW } from '../tour/how';
import HowItWorks from './HowItWorks';

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
  variant = 'panel',
}: {
  /** "popover": the top bar's, with no heading of its own (the System page's panel has it). */
  variant?: 'panel' | 'popover';
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
      setSaid(`Business time moved forward. It is now ${whenText(clock.business_now)}.`);
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
      {variant === 'panel' && (
        <h3 id="clock-heading" tabIndex={-1} data-tour="controls-clock">
          Clock
        </h3>
      )}
      <p>
        Business time is{' '}
        <strong>
          <time dateTime={now.iso}>{now.text}</time>
        </strong>{' '}
        (Mountain), {formatOffset(offset)} ahead of the wall clock, with {formatOffset(left)} of{' '}
        {formatOffset(MAX_OFFSET_S)} left.
      </p>
      <p className="actions">
        {STEPS.map(({ step, label, says }) => (
          // Busy is aria-disabled, not disabled: a disabled button drops the keyboard's focus to
          // the top of the page, and the step a visitor pressed is the place to stay.
          <button
            key={step}
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={isGuest}
            aria-disabled={busy !== null || undefined}
            aria-label={says}
            onClick={() => {
              if (busy === null) void advance(step);
            }}
          >
            {busy === step ? 'Moving…' : label}
          </button>
        ))}
      </p>
      {isGuest && <GuestNote />}
      <Message error={error}>{said && <p className="hint">{said}</p>}</Message>
      {variant === 'panel' && (
        <HowItWorks>
          <p>{HOW.clock}</p>
        </HowItWorks>
      )}
    </>
  );
}
