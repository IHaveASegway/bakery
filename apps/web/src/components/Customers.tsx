import { useState } from 'react';
import { shortWhen } from '../lib/when';
import { whenText, zoneLabel } from '../lib/crm';
import { useCustomers } from '../lib/use-customers';
import CustomerTimeline from './CustomerTimeline';
import Message from './Message';

/**
 * The customer list: name, zone, consent, loyalty points, orders and the last order, with one
 * customer’s timeline open under it. The customers are synthetic personas from the seed; the
 * system holds no email, phone or address for any of them. The list looks again every ten
 * seconds and when `refresh` changes, since orders arrive by webhook and not by this page.
 */
export default function Customers({
  sandboxId,
  isGuest,
  personaId,
  refresh,
  onConsent,
}: {
  sandboxId: string;
  isGuest: boolean;
  personaId: string;
  refresh: number;
  onConsent: () => void;
}) {
  const { customers, error, replace } = useCustomers(sandboxId, refresh, 10_000);
  const [selected, setSelected] = useState<string | null>(null);
  const open = customers?.find((c) => c.customer === selected) ?? null;

  return (
    <section aria-labelledby="customers-heading">
      <h3 id="customers-heading" tabIndex={-1} data-tour="crm-customers">
        Customers
      </h3>
      <p className="hint">
        {customers === null ? 'The' : `The ${customers.length}`} synthetic customers: pick one for
        their timeline and consent.
      </p>
      <Message error={error} />
      {customers === null ? (
        error === null && <p aria-live="polite">Loading the customers…</p>
      ) : customers.length === 0 ? (
        <p className="hint">No customers yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <caption className="sr-only">Customers</caption>
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Zone</th>
                <th scope="col">Consent</th>
                <th scope="col" className="num">
                  Points
                </th>
                <th scope="col" className="num">
                  Orders
                </th>
                <th scope="col">Last order</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.customer}>
                  <th scope="row" data-label="Customer">
                    <button
                      type="button"
                      className="link"
                      aria-pressed={c.customer === selected}
                      onClick={() => setSelected(c.customer === selected ? null : c.customer)}
                    >
                      {c.display_name}
                    </button>
                    {c.customer === personaId && <span className="hint"> (you)</span>}
                  </th>
                  <td data-label="Zone">{zoneLabel(c.home_zone)}</td>
                  <td data-label="Consent">{c.marketing ? 'Yes' : 'No'}</td>
                  <td className="num" data-label="Points">
                    {c.loyalty_points}
                  </td>
                  <td className="num" data-label="Orders">
                    {c.orders}
                  </td>
                  <td data-label="Last order">
                    {c.last_order_at ? (
                      <time dateTime={c.last_order_at} title={whenText(c.last_order_at)}>
                        {shortWhen(c.last_order_at)}
                      </time>
                    ) : (
                      whenText(c.last_order_at)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <CustomerTimeline
          sandboxId={sandboxId}
          customer={open}
          isGuest={isGuest}
          personaId={personaId}
          refresh={refresh}
          onChanged={(c) => {
            replace(c);
            onConsent();
          }}
        />
      )}
    </section>
  );
}
