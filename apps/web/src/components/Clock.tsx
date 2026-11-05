import { useState } from 'react';
import { advanceClock } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import GuestNote from './GuestNote';
import Message from './Message';

/** "2 h 15 min" for a count of seconds. */
function ahead(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes === 0) return 'not at all';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** Time travel in its smallest form: business time moves forward, never back. */
export default function Clock({
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [said, setSaid] = useState('');

  async function advance() {
    setBusy(true);
    setError(null);
    try {
      const clock = await advanceClock(sandboxId, 15);
      setSaid(`Business time moved forward 15 minutes. It is now ${clock.business_now}.`);
      onAdvanced();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>Clock</h3>
      <p>
        Business time is {ahead(offsetSeconds)} ahead of the wall clock. An unpaid order expires 15
        minutes after it is placed, in business time, so one advance is enough to watch it happen.
        Business time only moves forward.
      </p>
      <p>
        <button type="button" disabled={busy || isGuest} onClick={() => void advance()}>
          Advance 15 minutes
        </button>
      </p>
      {isGuest && <GuestNote />}
      <Message error={error}>{said && <p className="hint">{said}</p>}</Message>
    </>
  );
}
