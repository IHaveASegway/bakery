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

  // Bumped by every action's answer. A look at the list that started before an action answered
  // carries the state from before it, so its answer is dropped: it would move the card back to its
  // old group for ten seconds, and take the keyboard's focus with it.
  const taken = useRef(0);

  // One look at the list. `quiet` is the timer's: it leaves the Refresh button as it is, so a
  // focused button is not disabled under the keyboard every ten seconds.
  const load = useCallback(
    async (quiet = false): Promise<boolean> => {
      if (!quiet) setBusy(true);
      const asked = taken.current;
      try {
        const answer = (await listCatering(sandboxId)).events;
        if (taken.current !== asked) return true;
        setEvents(answer);
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
    taken.current += 1;
    setEvents((list) => {
      const before = (list ?? []).find((e) => e.catering === event.catering);
      if (before?.state !== event.state) refocus.current = event.catering;
      return (list ?? []).map((e) => (e.catering === event.catering ? event : e));
    });
  }, []);

  // What last held the keyboard's focus inside the queue, and the card it was in; null once the
  // visitor has put the focus somewhere else themselves.
  const lastFocus = useRef<{ element: HTMLElement; card: string | null } | null>(null);

  // A press outside what holds the focus is the visitor moving on: after it, a redraw leaves the
  // focus wherever the press put it, the page itself included.
  useEffect(() => {
    const press = (e: PointerEvent) => {
      const held = lastFocus.current?.element;
      if (held !== undefined && !held.contains(e.target as Node)) lastFocus.current = null;
    };
    document.addEventListener('pointerdown', press, true);
    return () => document.removeEventListener('pointerdown', press, true);
  }, []);

  // A redraw can drop the focus to the page with no one asking: a card that changed state is drawn
  // anew in its new group, and the element that had the focus goes with the old one; and a fresh
  // look that lists the cards in another order moves the focused card, which the browser blurs. In
  // either case the focus goes back where it was: to the same element when it is still in the
  // page, else to its card (the changed card, after an action), else to the queue's heading. A
  // visitor who has moved on is left where they are.
  useEffect(() => {
    const held = lastFocus.current;
    const id = refocus.current ?? held?.card ?? null;
    refocus.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    if (held !== null && held.element.isConnected) {
      held.element.focus();
      return;
    }
    if (id === null) return;
    (
      document.getElementById(`catering-card-${id}`) ??
      document.getElementById('catering-queue-heading')
    )?.focus();
  }, [events]);

  const groups = groupByState(events ?? []);
  const reminders = upcomingReminders(events ?? []);

  return (
    <section
      aria-labelledby="catering-queue-heading"
      onFocus={(e) => {
        const element = e.target as HTMLElement;
        const card = element.closest('[id^="catering-card-"]');
        lastFocus.current = {
          element,
          card: card === null ? null : card.id.slice('catering-card-'.length),
        };
      }}
      onBlur={(e) => {
        // The keyboard took the focus out of the queue: that is the visitor's move too.
        const next = e.relatedTarget as Node | null;
        if (next !== null && !e.currentTarget.contains(next)) lastFocus.current = null;
      }}
    >
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
