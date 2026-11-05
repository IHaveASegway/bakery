import { useState } from 'react';
import { getOrder, refundOrder } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import { dollars } from '../lib/money';
import { parseRefundAmount } from '../lib/payment';
import Message from './Message';

/**
 * "Refund" (all that is left) and "Refund part" (an amount in dollars) on an order card, for
 * signed-in staff. The API checks the amount against what was paid less what was refunded; the
 * page checks it against the order’s total first, so a typo costs no request.
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
  onRefunded: () => void;
}) {
  const [part, setPart] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const field = `refund-amount-${order}`;

  async function run(body: () => Promise<number | null>) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const cents = await body();
      if (cents === null) return;
      setDone(`Refunded ${dollars(cents)} on order ${label}.`);
      setPart(false);
      setAmount('');
      onRefunded();
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
      return refund.amount_cents;
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
      return refund.amount_cents;
    });

  return (
    <div className="refunds">
      <p className="actions">
        <button
          type="button"
          disabled={busy}
          aria-label={`Refund order ${label}`}
          onClick={() => void full()}
        >
          Refund
        </button>
        <button
          type="button"
          disabled={busy}
          aria-expanded={part}
          aria-controls={field + '-form'}
          aria-label={`Refund part of order ${label}`}
          onClick={() => setPart((p) => !p)}
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
            void partial();
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
            <button type="submit" disabled={busy || amount.trim() === ''}>
              Send refund
            </button>
          </p>
        </form>
      )}
      <Message error={error}>{done !== null && <p className="hint">{done}</p>}</Message>
    </div>
  );
}
