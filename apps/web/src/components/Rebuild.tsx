import { useCallback, useEffect, useRef, useState } from 'react';
import type { RebuildResponse } from '../contracts';
import { ApiError, getRebuild, startRebuild } from '../lib/api';
import { KeyedAction, rebuildPercent, rebuildSays, watchRebuild } from '../lib/crm';
import { describeCrmError } from '../lib/crm-errors';
import { type Message as Text } from '../lib/messages';
import GuestNote from './GuestNote';
import Message from './Message';
import { HOW } from '../tour/how';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * "Rebuild projections": the CRM drops what it derived from its log and replays the log, 200
 * events at a time, with a cursor. The button starts it (staff only); the bar then reads the
 * cursor every second until it stops. Reads show the rebuilding state until the cursor reaches
 * the end. A page opened in the middle of a rebuild picks it up.
 */
export default function Rebuild({
  sandboxId,
  isGuest,
  onFinished,
}: {
  sandboxId: string;
  isGuest: boolean;
  onFinished: () => void;
}) {
  const [state, setState] = useState<RebuildResponse | null>(null);
  const [error, setError] = useState<Text | null>(null);
  const [starting, setStarting] = useState(false);
  const stopped = useRef(false);
  const watching = useRef(false);
  const clicks = useRef(new KeyedAction());
  const finished = useRef(onFinished);
  finished.current = onFinished;

  /**
   * Follows the cursor from here until the rebuild is no longer running, then tells the screens
   * to look again, when a rebuild was running or `started` says this page started one.
   */
  const follow = useCallback(
    async (started = false) => {
      if (watching.current) return;
      watching.current = true;
      let sawRunning = started;
      try {
        const result = await watchRebuild(
          () => getRebuild(sandboxId),
          (r) => {
            if (r.state === 'rebuilding') sawRunning = true;
            setState(r);
          },
          { sleep, stopped: () => stopped.current },
        );
        if (result.kind === 'paid' && sawRunning) finished.current();
      } finally {
        watching.current = false;
      }
    },
    [sandboxId],
  );

  useEffect(() => {
    stopped.current = false;
    // Look once on arrival: a rebuild may already be running.
    void follow();
    return () => {
      stopped.current = true;
    };
  }, [follow]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      setState(await clicks.current.run('rebuild', (key) => startRebuild(sandboxId, key)));
      void follow(true);
    } catch (e) {
      setError(describeCrmError(e));
      // A 409 means one is already running: show it.
      if (e instanceof ApiError && e.status === 409) void follow(true);
    } finally {
      setStarting(false);
    }
  }

  const running = state?.state === 'rebuilding';
  const percent = state === null ? 0 : rebuildPercent(state);

  return (
    <section aria-labelledby="rebuild-heading" data-tour="crm-rebuild">
      <h3 id="rebuild-heading">Rebuild projections</h3>
      <p>
        <button
          type="button"
          disabled={isGuest || starting || running}
          onClick={() => void start()}
        >
          {running ? 'Rebuilding…' : 'Rebuild projections'}
        </button>
      </p>
      {isGuest && <GuestNote />}
      <Message error={error} />
      {state !== null && state.state !== 'idle' && (
        <p aria-live="polite">
          <progress max={100} value={percent} aria-label="Rebuild progress">
            {percent}%
          </progress>{' '}
          {percent}%. {rebuildSays(state)}
        </p>
      )}
      <p className="hint">How this works: {HOW.rebuild}</p>
    </section>
  );
}
