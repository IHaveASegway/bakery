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

  const full = () =>
    run(async () => {
      if (
        !window.confirm(`Refund everything that is left on order ${label}? This cannot be undone.`)
      ) {
        return null;
      }
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
          aria-disabled={busy || undefined}
          aria-label={`Refund order ${label}`}
          onClick={() => {
            if (!busy) void full();
          }}
        >
          Refund
        </button>
        <button
          ref={toggle}
          type="button"
          aria-disabled={busy || undefined}
          aria-expanded={part}
          aria-controls={field + '-form'}
          aria-label={`Refund part of order ${label}`}
          onClick={() => {
            if (!busy) setPart((p) => !p);
          }}
        >
          Refund part
        </button>
      </p>
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
            <button type="submit" disabled={amount.trim() === ''} aria-disabled={busy || undefined}>
              Send refund
            </button>
          </p>
        </form>
      )}
      <Message error={error} />
    </div>
  );
}
