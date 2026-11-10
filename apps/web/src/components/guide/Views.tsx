import { Fragment, useMemo, useState, useSyncExternalStore } from 'react';
import { apiOrigin } from '../../lib/api';
import {
  curlText,
  maskToken,
  shortId,
  type GuideEntry,
  type Principle as PrincipleData,
} from '../../lib/guide';
import { liveToken, tokenStore } from '../../lib/token-store';
import {
  expectedHops,
  observations,
  storyReads,
  type Delivery,
  type FeedArrival,
  type ReadFacts,
  type HeardEvent,
  type Listening,
  type ExpectedHop,
  type Reading,
  type SeenEvent,
  type Trace,
  type TracedEvent,
} from '../../lib/trace';
import type { RecorderState } from '../../lib/recorder';
import { useSandboxPhase } from '../../lib/use-session';
import { ROUTE_SHAPES } from '../../guide';
import { LATER, routeIdOf } from './match';
import { ulid } from '../../lib/ulid';

// ---- Words, pure, so the tests can read them ----

/**
 * A name with a break opportunity between its words and nowhere inside one: after an underscore,
 * a slash, a hyphen, a dot or a colon (`start_ production`, `…/ orders/`), and between the
 * capitalised words of an event type (`Order Production Started`), so a narrow note (a board
 * column's) wraps a name between its words instead of cutting one in two.
 */
export function nameParts(name: string): string[] {
  return name.split(/(?<=[_/\-.:])|(?<=[a-z])(?=[A-Z])/).filter((p) => p !== '');
}

export function Breakable({ text }: { text: string }) {
  return (
    <>
      {nameParts(text).map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/** Running text whose event names may wrap between their words (Breakable on each name). */
export function BreakableText({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b)/)
        .map((piece, i) => (i % 2 === 1 ? <Breakable key={i} text={piece} /> : piece))}
    </>
  );
}

/**
 * A path as a note shows it: the sandbox's part folded to `…`, every long id cut to its last six
 * characters as the board shows an order (`…/orders/…M6TY92/payment`), a query string dropped.
 */
export function shortPath(path: string): string {
  const bare = path.split('?')[0] ?? path;
  const rest = bare.replace(/^\/v1\/sandboxes\/[^/]+/, '');
  const short = (rest === bare ? bare : rest === '' ? '…/{sandbox}' : `…${rest}`)
    .split('/')
    .map((part) => (part.length > 12 && !part.startsWith('{') ? shortId(part) : part))
    .join('/');
  return short;
}

/** The object a stream belongs to, as the domain names it: `order:…` is the Order object. */
export function objectOf(stream: string | null): string | null {
  const kind = stream?.split(':')[0];
  if (kind === undefined || kind === '') return null;
  return kind
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** A socket command's action in words: `start_production` is "start production". */
export const actionWords = (action: string | null) => (action ?? 'command').replaceAll('_', ' ');

/**
 * What a request row is, in a word or two: the last fixed part of its route's path, such as
 * "Orders", "Payment" or "Publish", so two requests from one click read apart.
 */
export function requestLabel(trace: Trace): string {
  const shape = ROUTE_SHAPES.find((r) => r.routeId === routeIdOf(trace));
  const word = shape?.path
    .split('/')
    .filter((part) => part !== '' && !part.startsWith('{'))
    .at(-1);
  if (word === undefined || word === 'v1') return 'Request';
  return (word.charAt(0).toUpperCase() + word.slice(1)).replaceAll('-', ' ');
}

/** The first hop of a trace: what was sent and what came back. */
export function requestText(trace: Trace): { sent: string; answer: string } {
  if (trace.transport === 'socket') {
    const answer =
      trace.outcome === 'pending'
        ? 'waiting'
        : trace.outcome === 'ok'
          ? 'ack'
          : trace.outcome === 'refused'
            ? `nack ${trace.rule ?? ''}`.trim()
            : 'lost';
    return { sent: `cmd ${trace.action ?? ''}`.trim(), answer };
  }
  return {
    sent: `${trace.method} ${shortPath(trace.path)}`,
    answer: trace.status === null ? 'no answer' : String(trace.status),
  };
}

/**
 * The one sentence a screen reader hears when a live note opens, about the visitor's first request:
 * what was sent, what came back, how long it took. The note itself has the rest.
 */
export function traceSentence(trace: Trace, entry: GuideEntry | null): string {
  const what = entry === null ? '' : `${entry.title}: `;
  if (trace.transport === 'socket') {
    const told =
      trace.outcome === 'ok'
        ? 'the Kitchen accepted it'
        : trace.outcome === 'refused'
          ? `the Kitchen refused it${trace.rule === null ? '' : ` (${trace.rule})`}`
          : 'waiting for the Kitchen';
    return `Under the hood. ${what}the ${actionWords(trace.action)} command went over the kitchen socket, and ${told}.`;
  }
  const { sent, answer } = requestText(trace);
  const time = trace.ms === null ? '' : ` in ${trace.ms} ms`;
  const read = trace.read === undefined ? '' : ` ${readSentence(trace)}`;
  return `Under the hood. ${what}${sent} answered ${answer}${time}.${read}`;
}

/**
 * What a story read's answer means, in one or two sentences with its real values: served from the
 * cache, or the object answered and the cache was filled, or the copy in hand was current (304).
 */
export function readSentence(trace: Trace): string {
  const read = trace.read;
  if (read === undefined) return '';
  const etag = read.etag === null ? 'no ETag' : `the ETag ${read.etag}`;
  if (trace.status === 304) {
    return `This page’s copy was current: it sent If-None-Match ${read.asked ?? '(none)'}, and the API answered 304 with no body.`;
  }
  if (trace.status === null || trace.status >= 400) {
    return 'The read got no menu back, so the page shows the copy it had.';
  }
  if (read.cache === 'hit') {
    return `Served from the cache: the API’s cache held this version, so the Catalog object was not asked. It came with ${etag}.`;
  }
  if (read.cache === 'miss') {
    return `The Catalog object answered and the cache was filled, so the next read of this version is served from it. It came with ${etag}.`;
  }
  return `The API answered with ${etag} and no Bakery-Cache header.`;
}

/**
 * Where an event's deliveries stand, in plain words: each subscriber class it reached, with the
 * attempt when it took more than one, and a retry or a dead letter said as what it is. The
 * attempt is the recorder's own count, a lower bound on the Queue's (ADR 0015).
 */
export function deliveryWords(deliveries: readonly Delivery[]): string {
  const ok = deliveries.filter((d) => d.outcome === 'ok').map((d) => d.to);
  const retry = deliveries.filter((d) => d.outcome === 'retry').map((d) => d.to);
  const dead = deliveries.filter((d) => d.outcome === 'dead').map((d) => d.to);
  const attempt = Math.max(...deliveries.map((d) => d.attempt));
  const parts: string[] = [];
  if (ok.length > 0) {
    parts.push(`delivered to ${ok.join(', ')}${attempt > 1 ? ` on attempt ${attempt}` : ''}`);
  }
  if (retry.length > 0) parts.push(`${retry.join(', ')} retried after attempt ${attempt}`);
  if (dead.length > 0) parts.push(`dead-lettered for ${dead.join(', ')} after attempt ${attempt}`);
  return parts.join('; ');
}

// ---- Views ----

/** What the recorder could not promise for this note, when it matters: a ring that moved on, a wipe. */
export function RecorderSays({ state }: { state: Pick<RecorderState, 'missed' | 'wiped'> }) {
  if (state.wiped) {
    return <p className="guide-meta">The sandbox was wiped: there is nothing more to read.</p>;
  }
  if (state.missed) {
    return (
      <p className="guide-meta">
        Older hops left the recorder’s ring of 200 batches before this read: what they held is not
        known.
      </p>
    );
  }
  return null;
}

/** The note's head: an eyebrow, the title, and the pin and close buttons. */
export function NoteHead({
  eyebrow,
  title,
  pinned,
  onPin,
  onClose,
}: {
  eyebrow: string;
  title: string;
  pinned?: boolean;
  onPin?: () => void;
  onClose: () => void;
}) {
  return (
    <header className="guide-head">
      <div>
        <p className="guide-eyebrow">{eyebrow}</p>
        <h2 className="guide-title">{title}</h2>
      </div>
      <div className="guide-head-actions">
        {onPin !== undefined && (
          <button
            type="button"
            className="guide-icon"
            aria-pressed={pinned === true}
            aria-label="Keep this note open"
            title="Keep open"
            onClick={onPin}
          >
            <PinGlyph />
          </button>
        )}
        <button
          type="button"
          className="guide-icon"
          aria-label="Close this note"
          title="Close"
          onClick={onClose}
        >
          <CloseGlyph />
        </button>
      </div>
    </header>
  );
}

const PinGlyph = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M6 2h4l-1 4 3 3H4l3-3zM8 9v5" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
const CloseGlyph = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

/** A story read's headers, as the answer carried them. */
function ReadHeaders({ read }: { read: ReadFacts }) {
  return (
    <>
      {read.asked !== null && (
        <span className="guide-meta">
          sent <code>If-None-Match: {read.asked}</code>
        </span>
      )}
      <code className="guide-chip">Bakery-Cache: {read.cache ?? 'not sent'}</code>
      <code className="guide-chip">ETag: {read.etag ?? 'not sent'}</code>
    </>
  );
}

/**
 * A story read's note body above its why and when not: what the answer means, and a button that
 * asks again with the ETag in hand, while the island that owns the read is on the page.
 */
export function ReadStory({ trace }: { trace: Trace }) {
  const read = trace.read;
  if (read === undefined) return null;
  return (
    <div className="guide-read-story">
      <p>{readSentence(trace)}</p>
      {storyReads.has(read.name) && (
        <p className="guide-actions">
          <button
            type="button"
            className="guide-secondary"
            onClick={() => storyReads.repeat(read.name)}
          >
            Ask again
          </button>
          <span className="guide-meta"> sends the ETag back; an unchanged menu answers 304.</span>
        </p>
      )}
    </div>
  );
}

/**
 * What an event the note waits for says before it is seen (audit G4): waiting for the recorder at
 * first; after about 3 s, late and still listened for; after about 30 s, not seen, in words.
 */
export function hopWait(reading: Reading): string {
  if (reading === 'late') return 'not seen on the recorder yet; still listening';
  if (reading === 'done') return 'not seen on the recorder in 30 s; it may have missed it';
  return reading === 'reading' ? 'waiting for the recorder' : 'on its way';
}

/** The day a stream is for, when its last part is one (`schedule:…:2026-11-10`), as "10 Nov". */
export function dayOf(stream: string | null): string | null {
  const last = stream?.split(':').at(-1) ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last)) return null;
  return new Date(`${last}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** A chain's row: an event the action made, or several of one type it did not name, folded. */
type ChainRow = ExpectedHop & { also: TracedEvent[] };

/**
 * The rows of a chain: each event the action makes, then the others the trace observed, with
 * several of one type folded into one row (on 2026-11-10 Publish menu listed nine bare "CapsRefreshed
 * seq 2 on Schedule" rows, one a day, without the day).
 */
export function chainRows(hops: readonly ExpectedHop[], expected: readonly string[]): ChainRow[] {
  const rows: ChainRow[] = [];
  for (const hop of hops) {
    const fold =
      !expected.includes(hop.type) &&
      hop.event !== null &&
      rows.find((r) => r.type === hop.type && !expected.includes(r.type));
    if (fold && hop.event !== null) fold.also.push(hop.event);
    else rows.push({ ...hop, also: [] });
  }
  return rows;
}

/** A folded row's words: how many, on which object, for which days when a stream names one. */
export function foldedWords(events: readonly TracedEvent[]): string {
  const object = objectOf(events[0]?.stream ?? null);
  const days = [...new Set(events.map((e) => dayOf(e.stream)).filter((d) => d !== null))];
  const span =
    days.length === 0
      ? ''
      : days.length === 1
        ? `, for ${days[0]}`
        : `, for ${days.length} days between ${days[0]} and ${days.at(-1)}`;
  return `${events.length} times${object === null ? '' : ` on ${object}`}${span}`;
}

/**
 * What the chain says of an observed event's subscribers: the classes the recorder saw take it, or,
 * when its hop named none, that nothing subscribes to it; nothing while only the socket has it.
 */
export function takenWords(deliveries: readonly Delivery[] | undefined): string | null {
  if (deliveries === undefined) return null;
  return deliveries.length === 0 ? 'written; nothing subscribes to it' : deliveryWords(deliveries);
}

/**
 * The chain of hops for the visitor's action: each request (or socket command) with its answer,
 * time and cause; the object that decided it, once an event names it; then each event the action
 * makes, observed with its sequence number, seen in the activity feed, or not yet seen; and the
 * subscribers the server's recorder saw take it. The live note and the recorder panel both draw
 * it from the same traces, whose reading state is the store's (lib/trace.ts), so they say the
 * same of every event.
 */
/**
 * A board move answered ack whose event this page already saw for the same order under another
 * command (another tab, or an earlier press): the Order took the repeat as a no-op and wrote
 * nothing, so there is nothing to wait for. The other command's event, or null.
 */
export function madeBefore(
  trace: Trace,
  type: string,
  seen: readonly SeenEvent[],
): SeenEvent | null {
  if (trace.transport !== 'socket' || trace.outcome !== 'ok' || trace.order === null) return null;
  return (
    seen.find(
      (e) =>
        e.type === type &&
        e.cause !== trace.key &&
        e.stream !== null &&
        e.stream.endsWith(`:${trace.order}`),
    ) ?? null
  );
}

export function TraceChain({
  traces,
  expected,
  feed,
  seen = [],
}: {
  traces: readonly Trace[];
  /** The event types the action should make (match.ts, expectedFor). */
  expected: readonly string[];
  feed: readonly FeedArrival[];
  /** The last events the page saw, whoever caused them (lib/trace.ts, `seen`). */
  seen?: readonly SeenEvent[];
}) {
  const first = traces[0];
  if (first === undefined) return null;
  const reading = first.reading;
  const route = routeIdOf(first);
  const later = route === null ? undefined : LATER[route];
  const hops = expectedHops(
    expected,
    { startedAt: first.startedAt, events: traces.flatMap((t) => t.events) },
    feed,
  );
  const decider = objectOf(hops.find((h) => h.event !== null)?.event?.stream ?? null);
  return (
    <ol className="guide-chain">
      {traces.map((trace) => {
        const { sent, answer } = requestText(trace);
        const bad = trace.outcome === 'refused' || trace.outcome === 'failed';
        return (
          <li
            key={trace.id}
            className="guide-hop"
            data-state={trace.outcome === 'pending' ? 'expected' : 'observed'}
          >
            <span className="guide-hop-kind">
              {trace.transport === 'socket' ? 'Sent' : requestLabel(trace)}
            </span>
            <span className="guide-hop-body">
              <code className="guide-chip">
                <Breakable text={sent} />
              </code>
              <code className={bad ? 'guide-chip guide-chip-bad' : 'guide-chip'}>{answer}</code>
              {trace.ms !== null && <span className="guide-meta">{trace.ms} ms</span>}
              {trace.key !== null && (
                <span className="guide-meta" title={trace.key}>
                  {trace.transport === 'socket' ? 'id' : 'cause'} <code>{shortId(trace.key)}</code>
                </span>
              )}
              {trace.read !== undefined && <ReadHeaders read={trace.read} />}
            </span>
          </li>
        );
      })}
      {decider !== null && (
        <li className="guide-hop" data-state="observed">
          <span className="guide-hop-kind">Decided</span>
          <span className="guide-hop-body">
            <span>by the {decider} object</span>
          </span>
        </li>
      )}
      {chainRows(hops, expected).map((hop) => {
        const event = hop.event;
        const all = event === null ? [] : [event, ...hop.also];
        if (all.length > 1) {
          // Several of one type the action did not name: one row, with the days they are for.
          const ways = new Set(all.map((e) => takenWords(e.deliveries)));
          const taken = ways.size === 1 ? [...ways][0] : null;
          return (
            <li key={`${hop.type}-folded`} className="guide-hop" data-state="observed">
              <span className="guide-hop-kind">Event</span>
              <span className="guide-hop-body">
                <code className="guide-chip">
                  <Breakable text={hop.type} />
                </code>
                <span className="guide-meta">{foldedWords(all)}</span>
                {taken !== null && taken !== undefined && (
                  <span className="guide-meta guide-deliveries">{taken}, each</span>
                )}
              </span>
            </li>
          );
        }
        const taken = hop.state === 'observed' ? takenWords(event?.deliveries) : null;
        const before = hop.state === 'observed' ? null : madeBefore(first, hop.type, seen);
        if (before !== null) {
          return (
            <li key={`${hop.type}-before`} className="guide-hop" data-state="noop">
              <span className="guide-hop-kind">Event</span>
              <span className="guide-hop-body">
                <code className="guide-chip">
                  <Breakable text={hop.type} />
                </code>
                <span className="guide-meta">
                  already made for this order under another command (another screen, or an earlier
                  press): the Order took this one as a repeat and wrote nothing new
                </span>
              </span>
            </li>
          );
        }
        return (
          <li key={`${hop.type}-${event?.id ?? ''}`} className="guide-hop" data-state={hop.state}>
            <span className="guide-hop-kind">
              {hop.state === 'observed' && event?.source === 'socket' ? 'Came back' : 'Event'}
            </span>
            <span className="guide-hop-body">
              <code className="guide-chip">
                <Breakable text={hop.type} />
              </code>
              {hop.state === 'observed' && event !== null ? (
                <span className="guide-meta">
                  {event.seq !== null && <>seq {event.seq}</>}
                  {event.stream !== null && <> on {objectOf(event.stream)}</>}
                  {dayOf(event.stream) !== null && <> for {dayOf(event.stream)}</>}
                  {event.lagMs !== undefined && (
                    <>, taken by the Queue’s consumer {event.lagMs} ms after it was written</>
                  )}
                </span>
              ) : (
                <span className="guide-meta">
                  {hop.state === 'seen-in-feed' ? 'in the activity feed' : hopWait(reading)}
                </span>
              )}
              {taken !== null && <span className="guide-meta guide-deliveries">{taken}</span>}
            </span>
          </li>
        );
      })}
      {later !== undefined && !hops.some((h) => h.type === later.type) && (
        <li className="guide-hop" data-state="later">
          <span className="guide-hop-kind">Later</span>
          <span className="guide-hop-body">
            <code className="guide-chip">
              <Breakable text={later.type} />
            </code>
            <span className="guide-meta">{later.when}</span>
          </span>
        </li>
      )}
    </ol>
  );
}

/** Why this tool, and when it would be the wrong one, with the essay that argues it. */
export function WhyLines({
  entry,
  read = true,
}: {
  entry: Pick<GuideEntry, 'why' | 'whenNot' | 'principle'>;
  read?: boolean;
}) {
  const essay = read ? entry.principle.essay : undefined;
  return (
    <div className="guide-why">
      <p>
        <span className="guide-label">Why this tool</span> {entry.why}
      </p>
      <p>
        <span className="guide-label">When not</span> {entry.whenNot}
      </p>
      {essay !== undefined && (
        <p className="guide-read">
          Read: <a href={essay.url}>{essay.title}</a>
        </p>
      )}
    </div>
  );
}

/**
 * The reasons once per entry in a visit (audit G12, 2026-11-10): the first note of an entry shows
 * why this tool and when not; a later one of the same entry shows its trace and one line that
 * opens them, since the second move teaches nothing new. Kept in this page's memory only.
 */
const reasonsShown = new Map<string, number>();
export function ReasonsOnce({
  entry,
  note,
}: {
  entry: Pick<GuideEntry, 'id' | 'why' | 'whenNot' | 'principle'>;
  /** The note's own key (its gesture): the note that first showed an entry keeps showing it. */
  note: number;
}) {
  const first = reasonsShown.get(entry.id) ?? note;
  if (!reasonsShown.has(entry.id)) reasonsShown.set(entry.id, note);
  // In a narrow note (a board column's) the reasons stay behind their line even the first time;
  // CSS shows one of the two by the note's width (guide.css, the in-flow note).
  if (first === note) {
    return (
      <>
        <div className="guide-wide-only">
          <WhyLines entry={entry} />
        </div>
        <details className="guide-reasons guide-narrow-only">
          <summary>Why this tool, and when not</summary>
          <WhyLines entry={entry} />
        </details>
      </>
    );
  }
  return (
    <details className="guide-reasons">
      <summary>Why this tool, and when not</summary>
      <WhyLines entry={entry} />
    </details>
  );
}

/**
 * A value this page itself read, shown as observed with where it came from and when: the note
 * says what the page saw, not what the system promises. Nothing yet, and it says so.
 */
export function Observed({ name }: { name: string }) {
  // The note is drawn in the browser only, so the server's snapshot is the same read.
  const read = () => observations.get(name);
  const seen = useSyncExternalStore(observations.subscribe, read, read);
  if (seen === null) {
    return <p className="guide-meta">Observed: nothing yet; this page has not read it.</p>;
  }
  return (
    <p className="guide-observed">
      <span className="guide-label">Observed</span> <code className="guide-chip">{seen.from}</code>{' '}
      answered <code className="guide-chip">{`${name}: ${seen.value}`}</code>{' '}
      <span className="guide-meta">at {new Date(seen.at).toISOString().slice(11, 19)} UTC</span>
    </p>
  );
}

/** Why the command says <your token>, and what the visitor can do about it, by who is looking. */
export function tokenHint(phase: ReturnType<typeof useSandboxPhase>): string {
  const lead = 'No token is held by this page, so the command says <your token>.';
  if (phase.name === 'live' || phase.name === 'seeding') {
    return phase.kind === 'guest'
      ? `${lead} A guest cannot issue one: sign in with an account, then issue one in the console.`
      : `${lead} Issue one in the console’s API token panel to have it filled in here.`;
  }
  return `${lead} Sign in and issue one in the console to have it filled in here.`;
}

/**
 * The principle and where it is explained (Q32 · Q-links): its lab page on the site and its ADR on
 * GitHub, or, for a principle with no lab page, its section of the How it's built page and the
 * ADR; and its essay, by title.
 */
export function Principle({ principle }: { principle: PrincipleData }) {
  return (
    <p className="guide-principle">
      <span className="guide-label">Principle</span> {principle.name}.{' '}
      {principle.labUrl === undefined ? (
        <a href={principle.howUrl}>How it’s built</a>
      ) : (
        <a href={principle.labUrl} rel="noopener">
          {principle.lab}
        </a>
      )}
      {' · '}
      <a href={principle.adrUrl} rel="noopener">
        ADR {principle.adr}
      </a>
      {principle.essay !== undefined && (
        <>
          {' · '}
          <a href={principle.essay.url}>{principle.essay.title}</a>
        </>
      )}
    </p>
  );
}

/**
 * An entry's standing explanation, as a hotspot's note and the recorder panel show it: what this
 * is, the events it produces, why this tool and when not, the principle with its links, and the
 * same call as `curl` (masked on screen, whole in the copy).
 */
export function EntryBody({ entry }: { entry: GuideEntry }) {
  const phase = useSandboxPhase();
  const held = useSyncExternalStore(tokenStore.subscribe, tokenStore.get, () => null);
  const token = held === null ? null : liveToken(Date.now());
  const sandboxId = phase.name === 'live' || phase.name === 'seeding' ? phase.id : null;
  // One Idempotency-Key per entry shown, so the copied command is valid and steady as it redraws.
  const key = useMemo(() => ulid(), [entry.id]);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const context = { origin: apiOrigin, sandboxId, token, key };

  async function copy() {
    try {
      await navigator.clipboard.writeText(curlText(entry.api, context, 'copy'));
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <div className="guide-body">
      <p>{entry.what}</p>
      {entry.facts !== undefined && entry.facts.length > 0 && (
        <ul className="guide-facts">
          {entry.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      )}
      {entry.observe !== undefined && <Observed name={entry.observe} />}
      {entry.events.length === 0 ? (
        <p className="guide-meta">This makes no event of its own.</p>
      ) : (
        <p className="guide-events">
          <span className="guide-label">Events</span>{' '}
          {entry.events.map((name) => (
            <code key={name} className="guide-chip">
              {name}
            </code>
          ))}
        </p>
      )}
      <WhyLines entry={entry} read={false} />
      <Principle principle={entry.principle} />
      {entry.records !== undefined && entry.records.length > 0 && (
        <p className="guide-meta guide-records">
          Records:{' '}
          {entry.records.map((r, n) => (
            <span key={r.href}>
              {n > 0 && ' · '}
              <a href={r.href}>{r.title}</a>
            </span>
          ))}
        </p>
      )}
      <details className="guide-curl">
        <summary>The same call with curl</summary>
        <p className="guide-meta">{entry.api.note}</p>
        <pre tabIndex={0} aria-label={`curl for ${entry.api.routeId}`}>
          <code>{curlText(entry.api, context, 'screen')}</code>
        </pre>
        <p className="guide-meta">
          {token === null
            ? tokenHint(phase)
            : `Your token is held in this page’s memory (${maskToken(token)}); the copy has it whole.`}{' '}
          Route <code>{entry.api.routeId}</code>.
        </p>
        <p className="guide-actions">
          <button type="button" className="guide-secondary" onClick={() => void copy()}>
            Copy the curl
          </button>
          <span aria-live="polite">
            {copied === 'copied' && 'Copied.'}
            {copied === 'failed' && 'Copy failed: select the command and copy it by hand.'}
          </span>
        </p>
      </details>
    </div>
  );
}

// ---- A page watching an order: what it heard, and how it listens ----

/** How the page listens, in words, with the reason when it reads instead. */
export function listeningText(listening: Listening | null): string {
  if (listening === null) return 'Connecting to the kitchen’s socket.';
  switch (listening.how) {
    case 'socket':
      return 'On the kitchen’s socket, listening only: this page sends nothing on it.';
    case 'paused':
      return 'Paused: the tab is hidden, and the page reads the order again when it shows.';
    case 'done':
      return 'Finished: the order is done, so the page no longer listens to the kitchen.';
    case 'reading':
      switch (listening.why) {
        case 'yielded':
          return 'Reading every 10 seconds: the board reported four sockets open, so this page gave its own up.';
        case 'limit':
          return 'Reading every 10 seconds: the kitchen already had four sockets and refused a fifth.';
        default:
          return 'Reading every 10 seconds: the socket closed, and the page tries it again a few times.';
      }
  }
}

/** The one sentence a screen reader hears when a watch note opens. */
export function watchSentence(heard: HeardEvent | null, listening: Listening | null): string {
  if (heard === null) return `Under the hood. ${listeningText(listening)}`;
  const object = objectOf(heard.stream);
  return `Under the hood. Heard ${heard.type}, event ${heard.seq}${object === null ? '' : ` of the ${object} object`}, over the kitchen’s socket.`;
}

/** The chain for a watching page: the event heard, with its sequence, and how the page listens. */
export function WatchChain({
  heard,
  listening,
}: {
  heard: HeardEvent | null;
  listening: Listening | null;
}) {
  return (
    <ol className="guide-chain">
      {heard !== null && (
        <li className="guide-hop" data-state="observed">
          <span className="guide-hop-kind">Heard</span>
          <span className="guide-hop-body">
            <code className="guide-chip">evt {heard.type}</code>
            <span className="guide-meta">
              seq {heard.seq} on {objectOf(heard.stream) ?? 'its stream'}
            </span>
          </span>
        </li>
      )}
      {heard !== null && objectOf(heard.stream) !== null && (
        <li className="guide-hop" data-state="observed">
          <span className="guide-hop-kind">Decided</span>
          <span className="guide-hop-body">
            <span>by the {objectOf(heard.stream)} object, moved by the kitchen</span>
          </span>
        </li>
      )}
      <li className="guide-hop" data-state={listening?.how === 'socket' ? 'observed' : 'expected'}>
        <span className="guide-hop-kind">Listening</span>
        <span className="guide-hop-body">
          <span>{listeningText(listening)}</span>
        </span>
      </li>
    </ol>
  );
}
