import { useCallback, useEffect, useState } from 'react';
import type { LedgerResponse } from '../contracts';
import { getLedger } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import { dollars } from '../lib/money';
import { LEDGER_HINT, ledgerSource } from '../lib/payment';
import { shortWhen, whenText } from '../lib/when';
import Message from './Message';

/**
 * The Billing ledger: what Stripe's webhooks made the sandbox record, and the seed's payments and
 * their refunds, which Billing recorded alone, newest first, with the net.
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
      <div className="panel-head">
        <h3 id="ledger-heading" tabIndex={-1}>
          Ledger
        </h3>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={() => void load()}
        >
          Refresh the ledger
        </button>
      </div>
      <Message error={error} />
      {ledger === null ? (
        error === null && <p aria-live="polite">Loading the ledger…</p>
      ) : (
        <>
          <dl className="stats">
            <div>
              <dt>Paid</dt>
              <dd>{dollars(ledger.paid_cents)}</dd>
            </div>
            <div>
              <dt>Refunded</dt>
              <dd>{dollars(ledger.refunded_cents)}</dd>
            </div>
            <div>
              <dt>Net</dt>
              <dd>
                <strong>{dollars(ledger.net_cents)}</strong>
              </dd>
            </div>
          </dl>
          {entries.length === 0 ? (
            <p className="hint">No payments yet.</p>
          ) : (
            <div className="table-scroll" role="region" aria-label="Ledger entries" tabIndex={0}>
              <table className="table">
                <caption className="sr-only">Ledger entries, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Entry</th>
                    <th scope="col">For</th>
                    <th scope="col">Recorded by</th>
                    <th scope="col" className="num">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={`${e.stripe_id ?? e.at}-${i}`}>
                      <td>
                        <time dateTime={e.at} title={whenText(e.at)}>
                          {shortWhen(e.at)}
                        </time>
                      </td>
                      <td>
                        <span
                          className="badge"
                          data-tone={e.kind === 'payment' ? 'ready' : 'pending'}
                        >
                          {e.kind === 'payment' ? 'Payment' : 'Refund'}
                        </span>
                      </td>
                      <td>
                        {PURPOSES[e.purpose] ?? e.purpose} <code>{e.ref.slice(-6)}</code>
                      </td>
                      <td>{ledgerSource(e) === '' ? 'Stripe' : 'Billing (seeded)'}</td>
                      <td className="num">
                        {e.kind === 'payment' ? '+' : '−'}
                        {dollars(Math.abs(e.amount_cents))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint">{LEDGER_HINT}</p>
        </>
      )}
    </section>
  );
}

/** What a ledger line paid for, in a word. */
const PURPOSES: Record<string, string> = {
  order: 'Order',
  deposit: 'Catering deposit',
  balance: 'Catering balance',
};
