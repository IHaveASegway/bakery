import { useCallback, useEffect, useState } from 'react';
import type { CateringResponse } from '../contracts';
import { listCatering } from '../lib/api';
import { bakeryDate, earliestDate, packageLabel, stateLabel } from '../lib/catering';
import { describeError, type Message as Text } from '../lib/messages';
import { dollars } from '../lib/money';
import { dateLabel } from '../lib/schedule';
import { useSandboxPhase } from '../lib/use-session';
import CateringDetail from './CateringDetail';
import CateringInquiryForm from './CateringInquiryForm';
import Message from './Message';
import StatusLine from './StatusLine';
import { HOW } from '../tour/how';

/** The /catering/ island: the inquiry, the visitor's events, and the one open for reading. */
export default function Catering() {
  const phase = useSandboxPhase();
  const sandboxId = phase.name === 'live' ? phase.id : null;
  const offsetS = phase.name === 'live' ? phase.clockOffsetS : 0;
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

  const load = useCallback(async () => {
    if (sandboxId === null) return;
    setBusy(true);
    try {
      setEvents((await listCatering(sandboxId)).events);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, [sandboxId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <>
      <StatusLine phase={phase} />

      {sandboxId !== null && earliest !== null ? (
        <CateringInquiryForm
          sandboxId={sandboxId}
          earliest={earliest}
          onLead={setApiEarliest}
          onCreated={(event) => {
            take(event);
            setSelected(event.catering);
          }}
        />
      ) : phase.name === 'seeding' || phase.name === 'loading' ? (
        <p>Seeding your bakery… You can ask about an event as soon as it is ready.</p>
      ) : (
        <p>
          Catering needs a sandbox. <a href="/signin/">Sign in or try it as a guest</a>.
        </p>
      )}

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
                    <strong>{stateLabel(e.state)}</strong>: {dateLabel(e.date)}
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
            <button type="button" disabled={busy} onClick={() => void load()}>
              Refresh
            </button>
          </p>
        </section>
      )}

      {sandboxId !== null && open !== null && (
        <CateringDetail sandboxId={sandboxId} event={open} onChange={take} />
      )}

      <p className="hint">How this works: {HOW.catering}</p>
    </>
  );
}
