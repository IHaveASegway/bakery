import { useCallback, useEffect, useRef, useState } from 'react';
import type { CateringCancelReason, CateringResponse, DeclineReason } from '../contracts';
import {
  declineInquiry,
  getCatering,
  listCatering,
  markCateringDelivered,
  sendQuote,
  staffCancelCatering,
  startCateringProduction,
} from '../lib/api';
import {
  CANCEL_REASONS,
  DECLINE_REASONS,
  STAFF_ACTION_LABELS,
  estimate,
  groupByState,
  packageLabel,
  parseQuoteTotal,
  splitTotal,
  stateLabel,
  staffActions,
  timeoutText,
  upcomingReminders,
  waitForInvoice,
} from '../lib/catering';
import { describeStaffError } from '../lib/catering-errors';
import { describeError, type Message as Text } from '../lib/messages';
import { usePoll } from '../lib/use-poll';
import { dollars } from '../lib/money';
import { dateLabel, startText } from '../lib/schedule';
import CateringFigures from './CateringFigures';
import GuestNote from './GuestNote';
import Message from './Message';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The catering queue: every event by state with the staff actions its state allows, and the
 * reminders due next across all of them. Signed-in sessions act; a guest reads. The queue looks
 * again every ten seconds, since a payment arrives by webhook and a reminder by alarm, and not by
 * anything this page did. The API refuses what is out of order, and its answer is shown as it came.
 */
export default function CateringQueue({
  sandboxId,
  isGuest,
}: {
  sandboxId: string;
  isGuest: boolean;
}) {
  const [events, setEvents] = useState<CateringResponse[] | null>(null);
  const [error, setError] = useState<Text | null>(null);
  const [busy, setBusy] = useState(false);

  // One look at the list. `quiet` is the timer's: it leaves the Refresh button as it is, so a
  // focused button is not disabled under the keyboard every ten seconds.
  const load = useCallback(
    async (quiet = false): Promise<boolean> => {
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

  usePoll(() => load(true));

  // The card an action changed, once its button may be gone: a card in a new state moves to its
  // new group and is drawn again, and the button that had the focus goes with the old one.
  const refocus = useRef<string | null>(null);
  const take = useCallback((event: CateringResponse) => {
    setEvents((list) => {
      const before = (list ?? []).find((e) => e.catering === event.catering);
      if (before?.state !== event.state) refocus.current = event.catering;
      return (list ?? []).map((e) => (e.catering === event.catering ? event : e));
    });
  }, []);

  // Focus goes to the changed card, but only when it has been dropped to the page: a visitor who
  // has moved on is left where they are.
  useEffect(() => {
    const id = refocus.current;
    if (id === null) return;
    refocus.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    (
      document.getElementById(`catering-card-${id}`) ??
      document.getElementById('catering-queue-heading')
    )?.focus();
  }, [events]);

  const groups = groupByState(events ?? []);
  const reminders = upcomingReminders(events ?? []);

  return (
    <section aria-labelledby="catering-queue-heading">
      <h3 id="catering-queue-heading" tabIndex={-1} data-tour="crm-catering-queue">
        Catering queue
      </h3>
      <p>
        Inquiries move through quote, deposit, production, delivery and the balance invoice. Each
        step is one object’s transaction; the deposit and the balance are confirmed only by Stripe’s
        webhooks.
      </p>
      {isGuest && <GuestNote />}
      <Message error={error} />
      {events === null ? (
        error === null && <p aria-live="polite">Loading the catering queue…</p>
      ) : events.length === 0 ? (
        <p className="hint">No catering events.</p>
      ) : (
        <>
          <p className="hint">
            {events.length} events:{' '}
            {groups
              .map((g) => `${g.events.length} ${stateLabel(g.state).toLowerCase()}`)
              .join(', ')}
            .
          </p>
          {groups.map((g) => (
            <div key={g.state}>
              <h4>
                {stateLabel(g.state)} ({g.events.length})
              </h4>
              <ul className="queue">
                {g.events.map((e) => (
                  <QueueCard
                    key={e.catering}
                    sandboxId={sandboxId}
                    event={e}
                    isGuest={isGuest}
                    onChange={take}
                    onSettled={() => void load()}
                  />
                ))}
              </ul>
            </div>
          ))}
        </>
      )}

      <h4>Reminders by alarm</h4>
      <p className="hint">
        Each is a timer on its event, due at the business time shown. It fires when the sandbox’s
        clock passes it, and cancelling or finishing the event removes it.
      </p>
      {reminders.length === 0 ? (
        <p className="hint">No reminders are due.</p>
      ) : (
        <ol className="feed" aria-label="Reminders, soonest first">
          {reminders.map((r) => (
            <li key={`${r.catering}-${r.kind}`}>
              <strong>{r.label}</strong>: <time dateTime={r.at}>{startText(r.at)}</time>,{' '}
              {dateLabel(r.event.date)}, {packageLabel(r.event.package)} for {r.event.headcount}
            </li>
          ))}
        </ol>
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
  );
}

/** One event in the queue: its facts and figures, the brief as text, and its staff actions. */
export function QueueCard({
  sandboxId,
  event,
  isGuest,
  onChange,
  onSettled,
}: {
  sandboxId: string;
  event: CateringResponse;
  isGuest: boolean;
  onChange: (event: CateringResponse) => void;
  onSettled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [total, setTotal] = useState('');
  const [decline, setDecline] = useState<DeclineReason>('too_soon');
  const [cancel, setCancel] = useState<CateringCancelReason>('customer_change');
  const stopped = useRef(false);
  const id = event.catering;
  const actions = isGuest ? [] : staffActions(event.state);

  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
    };
  }, []);

  const typed = parseQuoteTotal(total);
  const guess = estimate(event);
  // What the quote would come to: the staff's total when one is typed, else the package's price.
  const shown =
    typed.ok && typed.total_cents !== null
      ? { total_cents: typed.total_cents, ...splitTotal(typed.total_cents) }
      : guess;

  // Busy is aria-disabled, not disabled, on every button below: a disabled button drops the
  // keyboard's focus to the top of the page, and a refused action should leave it where it was.
  async function act(run: () => Promise<CateringResponse>, afterwards?: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      onChange(await run());
      await afterwards?.();
    } catch (e) {
      setError(describeStaffError(e));
    } finally {
      setBusy(false);
    }
  }

  // The invoice is raised from the Queue after delivery: ask until it shows.
  async function untilInvoiced() {
    const result = await waitForInvoice(() => getCatering(sandboxId, id), {
      sleep,
      stopped: () => stopped.current,
    });
    if (result.kind === 'paid' || result.kind === 'closed') onChange(result.value);
    else if (result.kind === 'timeout') setSaid(timeoutText('invoice'));
    if (result.kind !== 'stopped') onSettled();
  }

  return (
    <li id={`catering-card-${id}`} tabIndex={-1}>
      <CateringFigures event={event} />
      {event.brief && <p className="brief">Brief: {event.brief}</p>}
      {event.state === 'delivered' && (
        <p className="hint">The Queue raises the balance invoice; it shows here when it arrives.</p>
      )}

      {actions.includes('quote') && (
        <div>
          <p>
            <label htmlFor={`quote-${id}`}>Total in dollars (optional)</label>
            <input
              id={`quote-${id}`}
              type="text"
              inputMode="decimal"
              value={total}
              aria-describedby={`quote-${id}-says`}
              onChange={(e) => setTotal(e.target.value)}
            />
            <span id={`quote-${id}-says`} className="hint">
              {!typed.ok
                ? typed.message
                : shown === null
                  ? 'Blank: the API prices it at the package’s price per head.'
                  : `${typed.total_cents === null ? 'At the package price' : 'With your total'}: ${dollars(shown.total_cents)}, a deposit of ${dollars(shown.deposit_cents)} and a balance of ${dollars(shown.balance_cents)}. The API computes the real figures.`}
            </span>
          </p>
          <p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!typed.ok}
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy)
                  void act(() =>
                    sendQuote(
                      sandboxId,
                      id,
                      typed.ok && typed.total_cents !== null
                        ? { total_cents: typed.total_cents }
                        : {},
                    ),
                  );
              }}
            >
              {STAFF_ACTION_LABELS.quote}
            </button>
          </p>
        </div>
      )}

      {actions.includes('decline') && (
        <p className="inline-action">
          <label htmlFor={`decline-${id}`}>Reason</label>
          <select
            id={`decline-${id}`}
            value={decline}
            onChange={(e) => setDecline(e.target.value as DeclineReason)}
          >
            {DECLINE_REASONS.map((r) => (
              <option key={r.reason} value={r.reason}>
                {r.label}
              </option>
            ))}
          </select>{' '}
          <button
            type="button"
            className="btn btn-danger btn-sm"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) void act(() => declineInquiry(sandboxId, id, { reason: decline }));
            }}
          >
            {STAFF_ACTION_LABELS.decline}
          </button>
        </p>
      )}

      {(actions.includes('start-production') || actions.includes('delivered')) && (
        <p className="actions">
          {actions.includes('start-production') && (
            <button
              type="button"
              className="btn btn-primary"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) void act(() => startCateringProduction(sandboxId, id));
              }}
            >
              {STAFF_ACTION_LABELS['start-production']}
            </button>
          )}
          {actions.includes('delivered') && (
            <button
              type="button"
              className={
                actions.includes('start-production') ? 'btn btn-secondary' : 'btn btn-primary'
              }
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) void act(() => markCateringDelivered(sandboxId, id), untilInvoiced);
              }}
            >
              {STAFF_ACTION_LABELS.delivered}
            </button>
          )}
        </p>
      )}

      {actions.includes('staff-cancel') && (
        <p className="inline-action">
          <label htmlFor={`cancel-${id}`}>Reason</label>
          <select
            id={`cancel-${id}`}
            value={cancel}
            onChange={(e) => setCancel(e.target.value as CateringCancelReason)}
          >
            {CANCEL_REASONS.map((r) => (
              <option key={r.reason} value={r.reason}>
                {r.label}
              </option>
            ))}
          </select>{' '}
          <button
            type="button"
            className="btn btn-danger btn-sm"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) void act(() => staffCancelCatering(sandboxId, id, { reason: cancel }));
            }}
          >
            {STAFF_ACTION_LABELS['staff-cancel']}
          </button>
        </p>
      )}

      <Message error={error}>{said !== null && <p>{said}</p>}</Message>
      <p className="hint">
        Updated <time dateTime={event.updated_at}>{startText(event.updated_at)}</time>.
      </p>
    </li>
  );
}
