import { useCallback, useEffect, useRef, useState } from 'react';
import type { CustomerResponse, TimelineEntry } from '../contracts';
import { getTimeline, setConsent } from '../lib/api';
import {
  KeyedAction,
  canChangeConsent,
  consentLabel,
  newestFirst,
  whenText,
  zoneLabel,
} from '../lib/crm';
import { describeCrmError } from '../lib/crm-errors';
import { momentText, timesIn } from '../lib/when';
import { describeError, type Message as Text } from '../lib/messages';
import Message from './Message';

/**
 * One customer: the facts the list already holds, the marketing-consent toggle and the timeline,
 * newest first. The toggle is offered to staff and to the visitor for their own persona; the API
 * is the check, and its 403 is shown in its words. Consent is data the next send reads: a customer
 * who turns it off is left out of a campaign that sends after.
 */
export default function CustomerTimeline({
  sandboxId,
  customer,
  isGuest,
  personaId,
  refresh,
  onChanged,
}: {
  sandboxId: string;
  customer: CustomerResponse;
  isGuest: boolean;
  personaId: string;
  refresh: number;
  onChanged: (customer: CustomerResponse) => void;
}) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [error, setError] = useState<Text | null>(null);
  const [busy, setBusy] = useState(false);
  const clicks = useRef(new KeyedAction());
  const id = customer.customer;

  const load = useCallback(() => {
    getTimeline(sandboxId, id).then(
      (answer) => {
        setEntries(answer.entries);
        setError(null);
      },
      (e: unknown) => setError(describeError(e)),
    );
  }, [sandboxId, id]);

  useEffect(() => {
    setEntries(null);
    load();
  }, [load, refresh]);

  const allowed = canChangeConsent(isGuest, personaId, id);

  async function toggle(marketing: boolean) {
    setBusy(true);
    setError(null);
    try {
      const updated = await clicks.current.run(`${id}:${marketing}`, (key) =>
        setConsent(sandboxId, id, { marketing }, key),
      );
      onChanged(updated);
      load();
    } catch (e) {
      setError(describeCrmError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`timeline-${id}`}>
      <h4 id={`timeline-${id}`}>{customer.display_name}</h4>
      <p className="hint">
        {zoneLabel(customer.home_zone)}, {customer.loyalty_points} points, {customer.orders}{' '}
        {customer.orders === 1 ? 'order' : 'orders'}, {customer.catering} catering. Likes:{' '}
        {customer.preferences.join(', ')}.
      </p>
      <p>
        <label className="check">
          <input
            type="checkbox"
            checked={customer.marketing}
            // Busy is aria-disabled, not disabled, so the keyboard's focus stays on the toggle.
            disabled={!allowed}
            aria-disabled={busy || undefined}
            onChange={(e) => {
              if (!busy) void toggle(e.target.checked);
            }}
          />{' '}
          {consentLabel(customer.marketing)}
        </label>
        {!allowed && (
          <span className="hint">
            Guests can change their own persona’s consent only. Sign in to change anyone’s.
          </span>
        )}
      </p>
      <Message error={error} />
      {entries === null ? (
        error === null && <p aria-live="polite">Loading the timeline…</p>
      ) : entries.length === 0 ? (
        <p className="hint">Nothing has happened to this customer yet.</p>
      ) : (
        <ol className="feed" aria-label={`Timeline of ${customer.display_name}, newest first`}>
          {newestFirst(entries).map((e) => (
            <li key={`${e.at}-${e.type}-${e.ref}`}>
              <time dateTime={e.at} title={whenText(e.at)}>
                {momentText(e.at)}
              </time>
              : {timesIn(e.label)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
