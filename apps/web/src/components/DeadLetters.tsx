import { useCallback, useEffect, useState } from 'react';
import type { DeadLetter } from '../contracts';
import { getDeadLetters, redrive } from '../lib/api';
import { redriveSaid, whileOffNote } from '../lib/dead-letters';
import { describeError, type Message as Text } from '../lib/messages';
import { whenText } from '../lib/when';
import GuestNote from './GuestNote';
import Message from './Message';

/**
 * Messages the consumer gave up on after three tries (ADR 0004). "Redrive" sends the stored event
 * to the Queue again with the same id, so a subscriber that already applied it does nothing.
 */
export default function DeadLetters({
  sandboxId,
  isGuest,
}: {
  sandboxId: string;
  isGuest: boolean;
}) {
  const [letters, setLetters] = useState<DeadLetter[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Text | null>(null);
  const [said, setSaid] = useState('');

  const refresh = useCallback(async () => {
    try {
      setLetters(await getDeadLetters(sandboxId));
    } catch (e) {
      setError(describeError(e));
    }
  }, [sandboxId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function send(letter: DeadLetter) {
    setBusy(letter.id);
    setError(null);
    try {
      await redrive(sandboxId, letter.id);
      setSaid(redriveSaid(letter));
      await refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h3 id="dead-letters-heading" tabIndex={-1} data-tour="kitchen-dead-letters">
        Dead letters
      </h3>
      <p className="hint">
        A delivery that fails three times lands here; switch the fault off, then redrive it.
      </p>
      <p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>
          Refresh
        </button>
      </p>
      {letters !== null && letters.length === 0 && <p className="hint">No dead letters.</p>}
      {letters !== null && letters.length > 0 && (
        <ul className="letters">
          {letters.map((letter) => (
            <li key={letter.id}>
              <p>
                <strong>{letter.type}</strong> <code>{letter.stream}</code> seq {letter.seq}
              </p>
              <p>
                Error: <code>{letter.error}</code>
              </p>
              {whileOffNote(letter) !== null && <p className="hint">{whileOffNote(letter)}</p>}
              <p className="hint">
                <time dateTime={letter.at}>{whenText(letter.at, { seconds: true })}</time>
              </p>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={isGuest || busy !== null}
                aria-label={`Redrive ${letter.type} for ${letter.stream}`}
                onClick={() => void send(letter)}
              >
                Redrive
              </button>
            </li>
          ))}
        </ul>
      )}
      {isGuest && <GuestNote />}
      <Message error={error}>{said && <p className="hint">{said}</p>}</Message>
    </>
  );
}
