import { useCallback, useEffect, useState } from 'react';
import type { ActivityEntry } from '../contracts';
import { activityFeed } from '../lib/activity-feed';
import { getActivity } from '../lib/api';
import { timesIn, whenText } from '../lib/when';
import { describeError, type Message as Text } from '../lib/messages';
import Message from './Message';

/** How many entries the feed asks for. */
const SHOWN = 30;

/**
 * The activity feed: what the CRM has logged, newest first. Each line is written by the API from
 * an event (an order paid, a campaign sent, a rebuild finished) and holds no free text a visitor
 * typed. The feed looks again every ten seconds and when `refresh` changes.
 */
export default function Activity({ sandboxId, refresh }: { sandboxId: string; refresh: number }) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<Text | null>(null);

  const load = useCallback(() => {
    getActivity(sandboxId, SHOWN).then(
      (answer) => {
        activityFeed.set(sandboxId, answer.entries);
        setEntries(answer.entries);
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

  return (
    <section aria-labelledby="activity-heading" data-tour="crm-activity">
      <h3 id="activity-heading" tabIndex={-1}>
        Activity
      </h3>
      <Message error={error} />
      {entries === null ? (
        error === null && <p aria-live="polite">Loading the activity…</p>
      ) : entries.length === 0 ? (
        <p className="hint">Nothing has happened yet.</p>
      ) : (
        <ol className="feed" aria-label="Activity, newest first">
          {entries.map((e) => (
            <li key={`${e.at}-${e.type}-${e.summary}`}>
              <time dateTime={e.at}>{whenText(e.at)}</time>: {timesIn(e.summary)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
