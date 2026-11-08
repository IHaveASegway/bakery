import { useCallback, useEffect, useState } from 'react';
import type { TrafficResponse } from '../contracts';
import { getTraffic, startTraffic, stopTraffic } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import GuestNote from './GuestNote';
import Message from './Message';

/** The Simulator's rate presets, in orders a minute (docs/domain.md, "Simulator": at most 6). */
const PRESETS = [1, 3, 6];

/** "Start traffic" and "Stop traffic", with the minutes used and left today. Signed-in only. */
export default function Traffic({ sandboxId, isGuest }: { sandboxId: string; isGuest: boolean }) {
  const [info, setInfo] = useState<TrafficResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInfo(await getTraffic(sandboxId));
    } catch {
      // A guest or a hiccup: the buttons and their errors say what matters.
    }
  }, [sandboxId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While it runs, the minutes used and the orders placed change; look every ten seconds.
  const running = info?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [running, refresh]);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      await refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3 data-tour="controls-traffic">Simulated traffic</h3>
      <p>
        Synthetic customers place orders so the board moves while you watch. It runs only while this
        page is open, at most 6 orders a minute and 30 minutes a day.
      </p>
      <p aria-live="polite">
        {info === null
          ? 'Traffic: not known yet.'
          : info.running
            ? `Running at ${info.rate} ${info.rate === 1 ? 'order' : 'orders'} a minute, ${info.orders} placed so far. `
            : 'Stopped. '}
        {info !== null &&
          `${info.minutes_used} ${info.minutes_used === 1 ? 'minute' : 'minutes'} used today, ${info.minutes_left} left.`}
      </p>
      <p className="actions">
        {PRESETS.map((rate) => (
          <button
            key={rate}
            type="button"
            disabled={busy || isGuest || running}
            onClick={() => void act(() => startTraffic(sandboxId, rate))}
          >
            Start traffic: {rate} {rate === 1 ? 'order' : 'orders'} a minute
          </button>
        ))}
        <button
          type="button"
          disabled={busy || isGuest || !running}
          onClick={() => void act(() => stopTraffic(sandboxId))}
        >
          Stop traffic
        </button>
      </p>
      {isGuest && <GuestNote />}
      <Message error={error} />
    </>
  );
}
