import { useCallback, useEffect, useState } from 'react';
import type { SegmentResponse } from '../contracts';
import { listSegments } from '../lib/api';
import { SEGMENTS, segmentLabel, segmentSays } from '../lib/crm';
import { namesOf, recipientName } from '../lib/inbox';
import { describeError, type Message as Text } from '../lib/messages';
import { useCustomers } from '../lib/use-customers';
import Message from './Message';

/**
 * The five segments with their member counts and a sample of who is in. A segment is a rule over
 * the CRM projection and the API evaluates it; membership changes when an event arrives (an
 * order, a consent change, a catering inquiry), which is why the page looks again every ten
 * seconds and when `refresh` changes. Members are counted before consent: a send leaves out
 * the customers who have said no.
 */
export default function Segments({ sandboxId, refresh }: { sandboxId: string; refresh: number }) {
  const [segments, setSegments] = useState<SegmentResponse[] | null>(null);
  const [error, setError] = useState<Text | null>(null);
  const { customers } = useCustomers(sandboxId, refresh);
  const names = namesOf(customers ?? []);

  const load = useCallback(() => {
    listSegments(sandboxId).then(
      (answer) => {
        setSegments(answer.segments);
        setError(null);
      },
      (e: unknown) => setError(describeError(e)),
    );
  }, [sandboxId]);

  useEffect(load, [load, refresh]);
  useEffect(() => {
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  // The API's order is not assumed: the page lists them in its own.
  const ordered = [...(segments ?? [])].sort(
    (a, b) =>
      SEGMENTS.findIndex((s) => s.segment === a.segment) -
      SEGMENTS.findIndex((s) => s.segment === b.segment),
  );

  return (
    <section aria-labelledby="segments-heading">
      <h3 id="segments-heading">Segments</h3>
      <p>
        A segment is a rule over what the CRM knows. Who is in changes when an event arrives: place
        an order, change a consent flag, or advance the clock, then look again.
      </p>
      <Message error={error} />
      {segments === null ? (
        error === null && <p aria-live="polite">Loading the segments…</p>
      ) : (
        <ul className="cards">
          {ordered.map((s) => (
            <li key={s.segment} className="card">
              <h4>{segmentLabel(s.segment)}</h4>
              <p>
                <strong>{s.members}</strong> {s.members === 1 ? 'member' : 'members'}
              </p>
              <p className="hint">{segmentSays(s.segment)}</p>
              {s.sample.length > 0 && (
                <p className="hint">
                  For example: {s.sample.map((id) => recipientName(names, id)).join(', ')}.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
