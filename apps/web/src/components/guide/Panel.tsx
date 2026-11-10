import { useEffect, useRef, useState } from 'react';
import { RECORDER } from '../../guide/recorder';
import { tailForPanel, useRecorderState, type RecentHop } from '../../lib/recorder';
import { useSandboxPhase } from '../../lib/use-session';
import type { GuideEntry, ScreenId } from '../../lib/guide';
import type { FeedArrival, HeardEvent, Listening, Trace } from '../../lib/trace';
import { entryForTraces, expectedFor, routeIdOf, targetOf } from './match';
import {
  EntryBody,
  ReadStory,
  TraceChain,
  WhyLines,
  listeningText,
  objectOf,
  requestText,
} from './Views';

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

  // While the panel is open, the recorder's hops arrive live (lib/recorder.ts: its socket, or a
  // read every few seconds where the socket is refused); closing the panel lets them go.
  const phase = useSandboxPhase();
  const sandboxId = phase.name === 'live' ? phase.id : null;
  const recorder = useRecorderState();
  useEffect(() => {
    if (sandboxId === null) return;
    return tailForPanel(sandboxId);
  }, [sandboxId]);

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
                    {first.read !== undefined && <ReadStory trace={first} />}
                    {entry?.happened !== undefined && (
                      <p className="guide-happened">{entry.happened}</p>
                    )}
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

      {sandboxId !== null && (
        <>
          <h3 className="guide-section">Hops, as they arrive</h3>
          <p className="guide-meta" role="status">
            {recorder.wiped
              ? 'The sandbox was wiped: there is nothing more to read.'
              : recorder.panel === 'socket'
                ? 'Live, on the recorder’s socket: each batch the Queue’s consumer delivers appears here.'
                : recorder.panel === 'polling'
                  ? 'The recorder’s socket was refused here (a preview’s address is not the API’s, or the session’s upgrades are spent), so this panel reads it every 5 seconds instead.'
                  : 'Connecting to the recorder…'}
          </p>
          {recorder.recent.length > 0 && (
            <ul
              className="guide-rows guide-heard"
              aria-label="Hops from the recorder, newest first"
            >
              {recorder.recent.map((hop) => (
                <li key={`${hop.id}-${hop.attempt}`}>
                  <code className="guide-chip">{hop.type}</code>{' '}
                  <span className="guide-meta">
                    {hopWords(hop)} {hop.lagMs} ms after it was written.
                  </span>
                </li>
              ))}
            </ul>
          )}
          <details className="guide-curl">
            <summary>{RECORDER.title}: why, and when not</summary>
            <p className="guide-meta">{RECORDER.what}</p>
            <p className="guide-meta">{RECORDER.reads}</p>
            <WhyLines entry={RECORDER} />
          </details>
          <p className="guide-meta">{RECORDER.carries}</p>
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

/** A recorder hop in plain words: whom it reached, on which attempt, a retry or a dead letter. */
export function hopWords(hop: Pick<RecentHop, 'deliveries' | 'attempt'>): string {
  const of = (outcome: string) =>
    hop.deliveries.filter((d) => d.outcome === outcome).map((d) => d.to);
  const delivered = of('delivered');
  const retried = of('retried');
  const dead = of('dead_lettered');
  if (hop.deliveries.length === 0) return 'No class consumes it;';
  const parts: string[] = [];
  if (delivered.length > 0) {
    parts.push(
      `delivered to ${delivered.join(', ')}${hop.attempt > 1 ? ` on attempt ${hop.attempt}` : ''}`,
    );
  }
  if (retried.length > 0) parts.push(`${retried.join(', ')} retried after attempt ${hop.attempt}`);
  if (dead.length > 0)
    parts.push(`dead-lettered for ${dead.join(', ')} after attempt ${hop.attempt}`);
  const said = parts.join('; ');
  return `${said.charAt(0).toUpperCase()}${said.slice(1)},`;
}
