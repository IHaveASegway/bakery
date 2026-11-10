import { useEffect, useRef, useState } from 'react';
import type { GuideEntry, ScreenId } from '../../lib/guide';
import type { FeedArrival, HeardEvent, Listening, Trace } from '../../lib/trace';
import { entryForTraces, expectedFor, routeIdOf, targetOf } from './match';
import { EntryBody, TraceChain, WhyLines, listeningText, objectOf, requestText } from './Views';

/** The visitor's traces grouped by the click that made them, newest click first. */
export function byGesture(traces: readonly Trace[]): Trace[][] {
  const groups = new Map<number, Trace[]>();
  for (const trace of traces) {
    if (trace.gesture === null) continue;
    groups.set(trace.gesture, [trace, ...(groups.get(trace.gesture) ?? [])]);
  }
  return [...groups.entries()].sort(([a], [b]) => b - a).map(([, group]) => group);
}

/**
 * The recorder: the keyboard's and the screen reader's way to everything a note shows. It lists
 * the visitor's last actions, newest first, each a row that opens into its hops; and every entry
 * of this screen, each opening into its standing explanation. It is a panel the visitor opens from
 * the guide's bar, not a dialog: the page stays usable beside it, and Escape or Close shuts it and
 * puts the focus back on the bar's button.
 */
export default function Panel({
  screen,
  entries,
  traces,
  feed,
  heard = [],
  listening = null,
  onClose,
}: {
  screen: ScreenId;
  entries: readonly GuideEntry[];
  traces: readonly Trace[];
  feed: readonly FeedArrival[];
  /** On a page that watches an order: what it heard, and how it listens. */
  heard?: readonly HeardEvent[];
  listening?: Listening | null;
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const groups = byGesture(traces);
  // The console's pages share one set of entries: list those whose element this page shows, or all
  // of them while none is drawn yet.
  const here = entries.filter((entry) => targetOf(entry.target) !== null);
  const listed = here.length > 0 ? here : entries;

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  const toggle = (id: string) => setOpenRow((now) => (now === id ? null : id));

  return (
    <section id="guide-panel" className="guide-panel" aria-labelledby="guide-panel-title">
      <header className="guide-head">
        <div>
          <p className="guide-eyebrow">Under the hood</p>
          <h2 id="guide-panel-title" className="guide-title" tabIndex={-1} ref={heading}>
            Recorder
          </h2>
        </div>
        <div className="guide-head-actions">
          <button type="button" className="guide-quiet" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      <h3 className="guide-section">Your actions</h3>
      {groups.length === 0 ? (
        <p className="guide-meta">
          Nothing yet. Press a button that changes something, and what happened shows here.
        </p>
      ) : (
        <ul className="guide-rows">
          {groups.map((group) => {
            const first = group[0] as Trace;
            const entry = entryForTraces(group, screen, null);
            const id = `trace-${first.id}`;
            const { sent, answer } = requestText(first);
            return (
              <li key={id}>
                <button
                  type="button"
                  className="guide-row"
                  aria-expanded={openRow === id}
                  aria-controls={openRow === id ? id : undefined}
                  onClick={() => toggle(id)}
                >
                  <span>{entry?.title ?? routeIdOf(first) ?? 'A request'}</span>
                  <code>
                    {sent} · {answer}
                    {first.ms === null ? '' : ` · ${first.ms} ms`}
                  </code>
                </button>
                {openRow === id && (
                  <div id={id} className="guide-row-body">
                    <TraceChain traces={group} expected={expectedFor(entry, group)} feed={feed} />
                    {entry !== null && <WhyLines entry={entry} />}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(heard.length > 0 || listening !== null) && (
        <>
          <h3 className="guide-section">Heard on this page</h3>
          <p className="guide-meta">{listeningText(listening)}</p>
          {heard.length > 0 && (
            <ul className="guide-rows guide-heard">
              {heard.map((event) => (
                <li key={event.id}>
                  <code className="guide-chip">evt {event.type}</code>{' '}
                  <span className="guide-meta">
                    seq {event.seq} on {objectOf(event.stream) ?? 'its stream'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <h3 className="guide-section">On this screen</h3>
      <ul className="guide-rows">
        {listed.map((entry) => {
          const id = `entry-${entry.id}`;
          return (
            <li key={id}>
              <button
                type="button"
                className="guide-row"
                aria-expanded={openRow === id}
                aria-controls={openRow === id ? id : undefined}
                onClick={() => toggle(id)}
              >
                <span>{entry.title}</span>
              </button>
              {openRow === id && (
                <div id={id} className="guide-row-body">
                  <EntryBody entry={entry} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
