import { useEffect, useRef, useState } from 'react';
import type { CateringCancelReason, CateringResponse } from '../contracts';
import { acceptQuote, cancelCatering, createDeposit, getCatering, payBalance } from '../lib/api';
import {
  CANCEL_REASONS,
  NEXT_STEP,
  customerActions,
  timeoutText,
  waitForBalance,
  waitForDeposit,
} from '../lib/catering';
import { describeCateringError } from '../lib/catering-errors';
import { type Message as Text } from '../lib/messages';
import { dollars } from '../lib/money';
import { startText } from '../lib/schedule';
import CateringFigures from './CateringFigures';
import Message from './Message';
import PaymentPanel from './PaymentPanel';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Waiting = { kind: 'deposit' | 'balance'; run: number } | null;

/**
 * One event: its facts and figures, what happens next, and the customer's actions for its state
 * (lib/catering.ts, `CUSTOMER_ACTIONS`): Accept, then the deposit through the Payment Element,
 * Pay balance once invoiced, Cancel once confirmed. A payment is never confirmed by this page: it
 * asks for the event every second until the webhook has moved it.
 */
export default function CateringDetail({
  sandboxId,
  event,
  onChange,
}: {
  sandboxId: string;
  event: CateringResponse;
  onChange: (event: CateringResponse) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [waiting, setWaiting] = useState<Waiting>(null);
  const [said, setSaid] = useState<string | null>(null);
  // Once Stripe has the deposit the form goes away, so it cannot be paid twice.
  const [submitted, setSubmitted] = useState(false);
  const [reason, setReason] = useState<CateringCancelReason>('customer_change');
  const changed = useRef(onChange);
  changed.current = onChange;
  const actions = customerActions(event.state);

  // A different event starts clean.
  useEffect(() => {
    setError(null);
    setWaiting(null);
    setSaid(null);
    setSubmitted(false);
  }, [event.catering]);

  // A lapsed hold sends the event back to Quoted: the next acceptance pays afresh.
  useEffect(() => {
    if (event.state !== 'accepted') setSubmitted(false);
  }, [event.state]);

  // After a payment: look every second for up to 30 seconds. The webhook moves the event, never
  // this page.
  useEffect(() => {
    if (waiting === null) return;
    let stopped = false;
    const wait = waiting.kind === 'deposit' ? waitForDeposit : waitForBalance;
    void wait(() => getCatering(sandboxId, event.catering), {
      sleep,
      stopped: () => stopped,
    }).then((result) => {
      if (stopped || result.kind === 'stopped') return;
      setWaiting(null);
      if (result.kind === 'timeout') setSaid(timeoutText(waiting.kind));
      else changed.current(result.value);
    });
    return () => {
      stopped = true;
    };
  }, [waiting, sandboxId, event.catering]);

  /** Runs one action: busy while it runs, any refusal shown in the live region. */
  async function act(run: () => Promise<CateringResponse>, then?: () => void) {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const answer = await run();
      onChange(answer);
      then?.();
    } catch (e) {
      setError(describeCateringError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="event-heading" data-tour="catering-detail">
      <h2 id="event-heading">Your event</h2>
      <p className="hint">
        Event <code>{event.catering}</code>, asked about at{' '}
        <time dateTime={event.created_at}>{startText(event.created_at)}</time>.
      </p>
      <CateringFigures event={event} />
      {event.brief && (
        <>
          <h3>Your brief</h3>
          <p className="brief">{event.brief}</p>
        </>
      )}
      <p>{NEXT_STEP[event.state]}</p>

      {actions.includes('accept') && (
        <p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void act(() => acceptQuote(sandboxId, event.catering))}
          >
            {busy ? 'Accepting…' : 'Accept the quote'}
          </button>
        </p>
      )}

      {actions.includes('pay-deposit') && !submitted && (
        <div>
          <h3 id="pay-heading">Pay the deposit</h3>
          <dl className="totals">
            <dt>Deposit (25%)</dt>
            <dd>
              <strong>{dollars(event.deposit_cents ?? 0)}</strong>
            </dd>
          </dl>
          <PaymentPanel
            sandboxId={sandboxId}
            intentKey={event.catering}
            createIntent={() => createDeposit(sandboxId, event.catering)}
            onSubmitted={() => {
              setSubmitted(true);
              setWaiting((w) => ({ kind: 'deposit', run: (w?.run ?? 0) + 1 }));
            }}
            unconfigured="The day stays held for its 15 minutes, and nothing here asks for a card."
          />
        </div>
      )}

      {actions.includes('pay-balance') && waiting?.kind !== 'balance' && (
        <>
          <p className="hint">
            This pays the balance of {dollars(event.balance_cents ?? 0)} with Stripe’s test card
            through the invoice. No money moves, and this page asks for no card.
          </p>
          <p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                void act(
                  () => payBalance(sandboxId, event.catering),
                  () => setWaiting((w) => ({ kind: 'balance', run: (w?.run ?? 0) + 1 })),
                )
              }
            >
              {busy ? 'Paying…' : 'Pay balance'}
            </button>
          </p>
        </>
      )}

      {actions.includes('cancel') && (
        <div>
          <h3>Cancel this event</h3>
          <p className="hint">
            The bakery decides whether the deposit goes back: a cancellation more than 7 days before
            the day refunds it.
          </p>
          <p>
            <label htmlFor="cat-cancel-reason">Why</label>
            <select
              id="cat-cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as CateringCancelReason)}
            >
              {CANCEL_REASONS.map((r) => (
                <option key={r.reason} value={r.reason}>
                  {r.label}
                </option>
              ))}
            </select>
          </p>
          <p>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void act(() => cancelCatering(sandboxId, event.catering, { reason }))}
            >
              {busy ? 'Cancelling…' : 'Cancel the event'}
            </button>
          </p>
        </div>
      )}

      <div aria-live="polite" className="messages">
        {waiting?.kind === 'deposit' && (
          <p>Payment received by Stripe. Waiting for the bakery to confirm it…</p>
        )}
        {waiting?.kind === 'balance' && (
          <p>
            The balance is being paid through the invoice. Waiting for the bakery to confirm it…
          </p>
        )}
        {said !== null && <p>{said}</p>}
      </div>
      <Message error={error} />
    </section>
  );
}
