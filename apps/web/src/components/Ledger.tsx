import { useCallback, useEffect, useState } from 'react';
import type { LedgerResponse } from '../contracts';
import { getLedger } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import { dollars } from '../lib/money';
import { whenText } from '../lib/when';
import Message from './Message';

/**
 * The Billing ledger: what Stripe's webhooks made the sandbox record, newest first, with the net.
 * `refresh` changes when something the ledger depends on did (a refund), and it also looks every
 * ten seconds, since a payment arrives by webhook and not by anything this page did.
 */
export default function Ledger({ sandboxId, refresh }: { sandboxId: string; refresh: number }) {
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [error, setError] = useState<Text | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setLedger(await getLedger(sandboxId));
      setError(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, [sandboxId]);

  useEffect(() => {
    void load();
  }, [load, refresh]);

  useEffect(() => {
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const entries = ledger === null ? [] : [...ledger.entries].reverse();

  return (
    <section aria-labelledby="ledger-heading" data-tour="kitchen-ledger">
      <h3 id="ledger-heading" tabIndex={-1}>
        Ledger
      </h3>
      <p className="hint">
        Payments and refunds as Stripe’s sandbox reported them. No money moved.
      </p>
      <Message error={error} />
      {ledger === null ? (
        error === null && <p aria-live="polite">Loading the ledger…</p>
      ) : (
        <>
          <dl className="totals">
            <dt>Paid</dt>
            <dd>{dollars(ledger.paid_cents)}</dd>
            <dt>Refunded</dt>
            <dd>{dollars(ledger.refunded_cents)}</dd>
            <dt>Net</dt>
            <dd>
              <strong>{dollars(ledger.net_cents)}</strong>
            </dd>
          </dl>
          {entries.length === 0 ? (
            <p className="hint">No payments yet.</p>
          ) : (
            <ol className="feed" aria-label="Ledger entries, newest first">
              {entries.map((e, i) => (
                <li key={`${e.stripe_id ?? e.at}-${i}`}>
                  <strong>{e.kind === 'payment' ? 'Payment' : 'Refund'}</strong>{' '}
                  <span className="price">
                    {e.kind === 'payment' ? '+' : '-'}
                    {dollars(Math.abs(e.amount_cents))}
                  </span>
                  , <time dateTime={e.at}>{whenText(e.at)}</time>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      <p>
        <button type="button" disabled={busy} onClick={() => void load()}>
          Refresh the ledger
        </button>
      </p>
    </section>
  );
}
