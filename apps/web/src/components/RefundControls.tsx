import { useRef, useState } from 'react';
import { getOrder, refundOrder } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import { dollars } from '../lib/money';
import { parseRefundAmount } from '../lib/payment';
import Message from './Message';

/**
 * "Refund" (all that is left) and "Refund part" (an amount in dollars) on an order card, for
 * signed-in staff. The API checks the amount against what was paid less what was refunded; the
 * page checks it against the order’s total first, so a typo costs no request.
 *
 * What a refund did is said by the board (`onRefunded`), not here: a refund of the whole order
 * cancels it, and its card, this component with it, leaves the board as soon as the Kitchen hears.
 */
export default function RefundControls({
  sandboxId,
  order,
  label,
  onRefunded,
}: {
  sandboxId: string;
  order: string;
  /** The short id the card shows, for the buttons’ accessible names. */
  label: string;
  /** Called with the sentence to announce; `whole` when the order is now refunding in full. */
  onRefunded: (said: string, whole: boolean) => void;
}) {
  const [part, setPart] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  // The first press of Refund reads the order and asks, in words, what a second press does; the
  // second refunds (F21, 2026-11-10). Null until asked.
  const [asking, setAsking] = useState<{ total_cents: number } | null>(null);
  const field = `refund-amount-${order}`;
  // The part form closes on success, taking its button with it; focus goes back to its toggle.
  const toggle = useRef<HTMLButtonElement>(null);

  async function run(body: () => Promise<{ cents: number; status: string } | null>) {
    setBusy(true);
    setError(null);
    try {
      const done = await body();
      if (done === null) return;
      const whole = done.status === 'refund_pending';
      onRefunded(
        whole
          ? `Refunded ${dollars(done.cents)} on order ${label}, all that was left. A full refund cancels the order, so its card leaves the board.`
          : `Refunded ${dollars(done.cents)} on order ${label}.`,
        whole,
      );
      setPart(false);
      setAmount('');
      toggle.current?.focus();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const { total_cents } = await getOrder(sandboxId, order);
      setAsking({ total_cents });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const full = () =>
    run(async () => {
      setAsking(null);
      const refund = await refundOrder(sandboxId, order, { reason: 'goodwill' });
      return { cents: refund.amount_cents, status: refund.status };
    });

  const partial = () =>
    run(async () => {
      const { total_cents } = await getOrder(sandboxId, order);
      const checked = parseRefundAmount(amount, total_cents);
      if (!checked.ok) {
        setError({ title: 'That amount will not do', detail: checked.message });
        return null;
      }
      const refund = await refundOrder(sandboxId, order, {
        amount_cents: checked.cents,
        reason: 'goodwill',
      });
      return { cents: refund.amount_cents, status: refund.status };
    });

  return (
    <div className="refunds" data-tour="kitchen-refund">
      {/* Busy is aria-disabled, not disabled, so the keyboard's focus stays where it was. */}
      <p className="actions">
        <button
          type="button"
          className="btn btn-danger btn-sm"
          aria-disabled={busy || undefined}
          aria-label={
            asking === null
              ? `Refund order ${label}`
              : `Refund all that is left of ${dollars(asking.total_cents)} on order ${label}`
          }
          aria-describedby={asking === null ? undefined : `${field}-asking`}
          onClick={() => {
            if (busy) return;
            if (asking === null) void ask();
            else void full();
          }}
        >
          {asking === null ? 'Refund' : 'Refund all'}
        </button>
        {asking !== null && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAsking(null)}>
            Keep the order
          </button>
        )}
        <button
          ref={toggle}
          type="button"
          className="btn btn-secondary btn-sm"
          aria-disabled={busy || undefined}
          aria-expanded={part}
          aria-controls={field + '-form'}
          aria-label={`Refund part of order ${label}`}
          onClick={() => {
            if (busy) return;
            setAsking(null);
            setPart((p) => !p);
          }}
        >
          Refund part
        </button>
      </p>
      {asking !== null && (
        <p id={`${field}-asking`} className="hint refund-asking" role="status">
          Press Refund all to refund everything left of order {label}’s{' '}
          {dollars(asking.total_cents)}. This cannot be undone, and the card leaves the board.
        </p>
      )}
      {part && (
        <form
          id={field + '-form'}
          aria-label={`Refund part of order ${label}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void partial();
          }}
        >
          <label htmlFor={field}>Amount in dollars</label>
          <input
            id={field}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            aria-describedby={field + '-hint'}
            onChange={(e) => setAmount(e.target.value)}
          />
          <span id={field + '-hint'} className="hint">
            Up to the order’s total, such as 4 or 4.50.
          </span>
          <p>
            <button
              type="submit"
              className="btn btn-danger btn-sm"
              disabled={amount.trim() === ''}
              aria-disabled={busy || undefined}
            >
              Send refund
            </button>
          </p>
        </form>
      )}
      <Message error={error} />
    </div>
  );
}
