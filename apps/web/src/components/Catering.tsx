import { useCallback, useEffect, useRef, useState } from 'react';
import type { CateringResponse } from '../contracts';
import { listCatering } from '../lib/api';
import {
  CATERING_START,
  bakeryDate,
  earliestDate,
  packageLabel,
  stateLabel,
} from '../lib/catering';
import { describeError, type Message as Text } from '../lib/messages';
import { dollars } from '../lib/money';
import { businessNowMs, dayText } from '../lib/when';
import { usePoll } from '../lib/use-poll';
import { useSandboxPhase } from '../lib/use-session';
import CateringDetail from './CateringDetail';
import CateringInquiryForm from './CateringInquiryForm';
import { StartHere } from './Guest';
import Message from './Message';
import StatusLine from './StatusLine';

/**
 * The /catering/ island: the inquiry, the visitor's events, and the one open for reading. The list
 * looks again every ten seconds, so a quote or a delivery the staff make shows without Refresh.
 * With no sandbox yet, the gate the menu and the checkout show stands where the inquiry goes, and
 * starts a guest sandbox on this page (R87's follow-up, 2026-11-10).
 */
export default function Catering() {
  const phase = useSandboxPhase();
  const sandboxId = phase.name === 'live' ? phase.id : null;
  const offsetS = phase.name === 'live' ? phase.clockOffsetS : 0;
  // Business now, so a date this year prints without its year on the bakery's calendar.
  const bakeryNow = businessNowMs(offsetS);
  const [now, setNow] = useState<number | null>(null);
  const [apiEarliest, setApiEarliest] = useState<string | null>(null);
  const [events, setEvents] = useState<CateringResponse[] | null>(null);
  const [error, setError] = useState<Text | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The date list is computed from business time (wall time plus the sandbox's clock offset).
  useEffect(() => {
    setNow(Date.now() + offsetS * 1000);
    const timer = setInterval(() => setNow(Date.now() + offsetS * 1000), 30_000);
    return () => clearInterval(timer);
  }, [offsetS]);

  const computed = now === null ? null : earliestDate(bakeryDate(now));
  // The API's own earliest date wins when it names a later one than the page worked out.
  const earliest =
    computed === null
      ? null
      : apiEarliest !== null && apiEarliest > computed
        ? apiEarliest
        : computed;

  // One look at the visitor's events. `quiet` is the timer's: it leaves the Refresh button as it
  // is, so a focused button is not disabled under the keyboard.
  const load = useCallback(
    async (quiet = false): Promise<boolean> => {
      if (sandboxId === null) return true;
      if (!quiet) setBusy(true);
      try {
        setEvents((await listCatering(sandboxId)).events);
        setError(null);
        return true;
      } catch (e) {
        setError(describeError(e));
        return false;
      } finally {
        if (!quiet) setBusy(false);
      }
    },
    [sandboxId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // A quote, production and delivery are the staff's doing, and a payment arrives by webhook, so
  // the page looks again on its own, as the staff queue does (lib/use-poll.ts).
  usePoll(() => load(true), sandboxId !== null);

  /** Puts an answer into the list, whether the event is new or changed. */
  const take = useCallback((event: CateringResponse) => {
    setEvents((list) => {
      const all = list ?? [];
      return all.some((e) => e.catering === event.catering)
        ? all.map((e) => (e.catering === event.catering ? event : e))
        : [event, ...all];
    });
  }, []);

  const open = events?.find((e) => e.catering === selected) ?? null;
  // Once the gate's sandbox is live, the focus, left on a button that is gone, goes to the form.
  const wasGated = useRef(false);
  const formShown = sandboxId !== null && earliest !== null;
  useEffect(() => {
    if (phase.name === 'nosession' || phase.name === 'nosandbox' || phase.name === 'seeding') {
      wasGated.current = true;
    } else if (formShown && wasGated.current) {
      wasGated.current = false;
      document.getElementById('inquiry-heading')?.focus();
    }
  }, [phase.name, formShown]);
  // No sandbox, or one seeding: the gate, which says so itself, so the status line stays out.
  const gated =
    phase.name === 'nosession' || phase.name === 'nosandbox' || phase.name === 'seeding';

  return (
    <>
      {!gated && <StatusLine phase={phase} />}

      {sandboxId !== null && earliest !== null ? (
        <CateringInquiryForm
          sandboxId={sandboxId}
          earliest={earliest}
          now={bakeryNow}
          onLead={setApiEarliest}
          onCreated={(event) => {
            take(event);
            setSelected(event.catering);
          }}
        />
      ) : gated ? (
        <StartHere
          here="/catering/"
          seeding={phase.name === 'seeding'}
          title={CATERING_START.title}
          action={CATERING_START.action}
          className="catering-gate"
        />
      ) : null}

      {sandboxId !== null && (
        <section aria-labelledby="events-heading" data-tour="catering-events">
          <h2 id="events-heading">Your events</h2>
          <Message error={error} />
          {events === null ? (
            error === null && <p aria-live="polite">Loading your events…</p>
          ) : events.length === 0 ? (
            <p className="hint">No events yet.</p>
          ) : (
            <ul className="events" aria-label="Catering events, newest first">
              {events.map((e) => (
                <li key={e.catering}>
                  <p>
                    <strong>{stateLabel(e.state)}</strong>: {dayText(e.date, { now: bakeryNow })}
                  </p>
                  <p>
                    {packageLabel(e.package)} for {e.headcount}
                    {e.total_cents !== null && e.total_cents !== undefined && (
                      <>
                        , {dollars(e.total_cents)} (deposit {dollars(e.deposit_cents ?? 0)}, balance{' '}
                        {dollars(e.balance_cents ?? 0)})
                      </>
                    )}
                  </p>
                  <p>
                    <button
                      type="button"
                      className="link"
                      aria-pressed={e.catering === selected}
                      onClick={() => setSelected(e.catering)}
                    >
                      Open this event
                    </button>
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => void load()}
            >
              Refresh
            </button>
          </p>
        </section>
      )}

      {sandboxId !== null && open !== null && (
        <CateringDetail sandboxId={sandboxId} event={open} onChange={take} now={bakeryNow} />
      )}
    </>
  );
}
