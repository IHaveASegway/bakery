import { useEffect, useRef, useState } from 'react';
import { RECORDER } from '../../guide/recorder';
import { tailForPanel, useRecorderState } from '../../lib/recorder';
import { useSandboxPhase } from '../../lib/use-session';
import type { GuideEntry, ScreenId } from '../../lib/guide';
import type {
  Delivery,
  FeedArrival,
  HeardEvent,
  Listening,
  RecorderHop,
  Trace,
} from '../../lib/trace';
import { byGesture, entryForGroup, expectedFor, routeIdOf, targetOf } from './match';
import {
  EntryBody,
  ReadStory,
  TraceChain,
  WhyLines,
  deliveryWords,
  listeningText,
  objectOf,
  requestText,
} from './Views';

/** How many lines the panel's hop list shows; repeats of one kind fold into one line. */
export const HOP_LINES = 8;

/** A line of the panel's hop list: one hop, or a run of hops of one type that read the same. */
export interface HopLine {
  hops: readonly RecorderHop[];
  type: string;
  /** The visitor's action whose trace holds these hops, or null. */
  trace: string | null;
}

/**
 * The recorder's hops as the panel lists them, newest first: a run of the same type with the same
 * deliveries and the same owner is one line with a count ("MessageDelivered, 8 times"), so a burst
 * of replies never pushes the visitor's own hop out; at most HOP_LINES lines, and a line holding a
 * hop of the visitor's newest action (`keep`) is never cut (audit, Step 4: the hop a note cited at
 * 220 ms had left the list).
 */
export function hopLines(hops: readonly RecorderHop[], keep: string | null): HopLine[] {
  const lines: HopLine[] = [];
  for (const hop of hops) {
    const last = lines.at(-1);
    if (
      last !== undefined &&
      last.type === hop.type &&
      last.trace === hop.trace &&
      hopWords(last.hops[0] as RecorderHop) === hopWords(hop)
    ) {
      lines[lines.length - 1] = { ...last, hops: [...last.hops, hop] };
    } else {
      lines.push({ hops: [hop], type: hop.type, trace: hop.trace });
    }
  }
  const shown = lines.slice(0, HOP_LINES);
  const kept = lines.slice(HOP_LINES).filter((l) => keep !== null && l.trace === keep);
  return [...shown, ...kept];
}

export { byGesture };

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
  hops,
  heard = [],
  listening = null,
  onClose,
}: {
  screen: ScreenId;
  entries: readonly GuideEntry[];
  traces: readonly Trace[];
  feed: readonly FeedArrival[];
  /** The recorder's hops, from the same store as the traces (lib/trace.ts). */
  hops: readonly RecorderHop[];
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
            const entry = entryForGroup(group, screen);
            const id = `trace-${first.id}`;
            const { sent, answer } = requestText(first);
            return (
              <li key={id} data-guide-trace={first.id}>
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
          {hops.length > 0 && (
            <ul
              className="guide-rows guide-heard"
              aria-label="Hops from the recorder, newest first"
            >
              {hopLines(hops, groups[0]?.[0]?.id ?? null).map((line) => {
                const hop = line.hops[0] as RecorderHop;
                const yours =
                  line.trace === null
                    ? null
                    : groups.find((g) => g.some((t) => t.id === line.trace));
                return (
                  <li key={`${hop.id}-${hop.attempt}`} data-guide-hop-of={line.trace ?? undefined}>
                    <code className="guide-chip">{line.type}</code>{' '}
                    {line.hops.length > 1 && (
                      <span className="guide-meta">{line.hops.length} times, </span>
                    )}
                    <span className="guide-meta">
                      {hopWords(hop)} {hop.lagMs} ms after it was written
                      {line.hops.length > 1 ? ' (the newest)' : ''}.
                    </span>
                    {yours !== undefined && yours !== null && (
                      <span className="guide-meta guide-yours">
                        {' '}
                        From your action:{' '}
                        {entryForGroup(yours, screen)?.title ?? routeIdOf(yours[0] as Trace)}.
                      </span>
                    )}
                  </li>
                );
              })}
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

/**
 * A recorder hop in plain words, the note's own words for it (Views.tsx, deliveryWords): whom it
 * reached, on which attempt, a retry or a dead letter; or that nothing subscribes to it.
 */
export function hopWords(hop: { deliveries: readonly Delivery[] }): string {
  if (hop.deliveries.length === 0) return 'Written; nothing subscribes to it;';
  const said = deliveryWords(hop.deliveries);
  return `${said.charAt(0).toUpperCase()}${said.slice(1)},`;
}
