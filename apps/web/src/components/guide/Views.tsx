import { useMemo, useState, useSyncExternalStore } from 'react';
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
  storyReads,
  type Delivery,
  type FeedArrival,
  type ReadFacts,
  type HeardEvent,
  type Listening,
  type Trace,
} from '../../lib/trace';
import type { RecorderState } from '../../lib/recorder';
import { useSandboxPhase } from '../../lib/use-session';
import { ROUTE_SHAPES } from '../../guide';
import { routeIdOf } from './match';
import { ulid } from '../../lib/ulid';

// ---- Words, pure, so the tests can read them ----

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
 * The chain of hops for the visitor's action: each request (or socket command) with its answer,
 * time and key; the object that decided it, once an event names it; then each event the entry
 * expects, observed with its sequence number, seen in the activity feed, or still expected; and
 * the subscribers the server's recorder saw take it, when it reports them.
 */
export function TraceChain({
  traces,
  expected,
  feed,
  reading = 'idle',
}: {
  traces: readonly Trace[];
  /** The event types the action should make (match.ts, expectedFor). */
  expected: readonly string[];
  feed: readonly FeedArrival[];
  /** The recorder's reads for this note: once done, an event no hop showed is "not seen yet". */
  reading?: 'idle' | 'reading' | 'done';
}) {
  const first = traces[0];
  if (first === undefined) return null;
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
              <code className="guide-chip">{sent}</code>
              <code className={bad ? 'guide-chip guide-chip-bad' : 'guide-chip'}>{answer}</code>
              {trace.ms !== null && <span className="guide-meta">{trace.ms} ms</span>}
              {trace.key !== null && (
                <span className="guide-meta" title={trace.key}>
                  {trace.transport === 'socket' ? 'id' : 'key'} <code>{shortId(trace.key)}</code>
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
      {hops.map((hop) => {
        const event = hop.event;
        const delivered = event?.deliveries ?? [];
        return (
          <li key={`${hop.type}-${event?.id ?? ''}`} className="guide-hop" data-state={hop.state}>
            <span className="guide-hop-kind">
              {hop.state === 'observed' && event?.source === 'socket' ? 'Came back' : 'Event'}
            </span>
            <span className="guide-hop-body">
              <code className="guide-chip">{hop.type}</code>
              {hop.state === 'observed' && event !== null ? (
                <span className="guide-meta">
                  {event.seq !== null && <>seq {event.seq}</>}
                  {event.stream !== null && <> on {objectOf(event.stream)}</>}
                  {event.lagMs !== undefined && (
                    <>, taken by the Queue’s consumer {event.lagMs} ms after it was written</>
                  )}
                </span>
              ) : (
                <span className="guide-meta">
                  {hop.state === 'seen-in-feed'
                    ? 'in the activity feed'
                    : reading === 'done'
                      ? 'not seen yet: the recorder may have missed it'
                      : 'expected'}
                </span>
              )}
              {delivered.length > 0 && (
                <span className="guide-meta guide-deliveries">{deliveryWords(delivered)}</span>
              )}
            </span>
          </li>
        );
      })}
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
