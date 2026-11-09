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
import { expectedHops, type FeedArrival, type Trace } from '../../lib/trace';
import { useSandboxPhase } from '../../lib/use-session';
import { templateOf } from './match';
import { ulid } from '../../lib/ulid';

// ---- Words, pure, so the tests can read them ----

/** A path as a note shows it: the sandbox's part folded to `…`, a query string dropped. */
export function shortPath(path: string): string {
  const bare = path.split('?')[0] ?? path;
  const rest = bare.replace(/^\/v1\/sandboxes\/[^/]+/, '');
  return rest === bare ? bare : rest === '' ? '…/{sandbox}' : `…${rest}`;
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
 * The first hop of a trace: what was sent and what came back. With the route's template the path
 * reads `…/orders/{oid}/payment`, not the order's own id, which the page already shows.
 */
export function requestText(
  trace: Trace,
  template: string | null = null,
): { sent: string; answer: string } {
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
    sent: `${trace.method} ${shortPath(template ?? trace.path)}`,
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
  return `Under the hood. ${what}${sent} answered ${answer}${time}.`;
}

// ---- Views ----

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
}: {
  traces: readonly Trace[];
  /** The event types the action should make (match.ts, expectedFor). */
  expected: readonly string[];
  feed: readonly FeedArrival[];
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
        const { sent, answer } = requestText(trace, templateOf(trace));
        const bad = trace.outcome === 'refused' || trace.outcome === 'failed';
        return (
          <li
            key={trace.id}
            className="guide-hop"
            data-state={trace.outcome === 'pending' ? 'expected' : 'observed'}
          >
            <span className="guide-hop-kind">
              {trace.transport === 'socket' ? 'Sent' : 'Request'}
            </span>
            <code className="guide-chip">{sent}</code>
            <code className={bad ? 'guide-chip guide-chip-bad' : 'guide-chip'}>{answer}</code>
            {trace.ms !== null && <span className="guide-meta">{trace.ms} ms</span>}
            {trace.key !== null && (
              <span className="guide-meta" title={trace.key}>
                {trace.transport === 'socket' ? 'id' : 'key'} <code>{shortId(trace.key)}</code>
              </span>
            )}
          </li>
        );
      })}
      {decider !== null && (
        <li className="guide-hop" data-state="observed">
          <span className="guide-hop-kind">Decided</span>
          <span>by the {decider} object</span>
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
            <code className="guide-chip">{hop.type}</code>
            {hop.state === 'observed' && event !== null ? (
              <span className="guide-meta">
                {event.seq !== null && <>seq {event.seq}</>}
                {event.stream !== null && <> on {objectOf(event.stream)}</>}
                {event.lagMs !== undefined && <>, {event.lagMs} ms after it was written</>}
              </span>
            ) : (
              <span className="guide-meta">
                {hop.state === 'seen-in-feed' ? 'in the activity feed' : 'expected'}
              </span>
            )}
            {delivered.length > 0 && (
              <span className="guide-meta">
                to{' '}
                {delivered
                  .map((d) => `${d.to}${d.attempt > 1 ? ` (attempt ${d.attempt})` : ''}`)
                  .join(', ')}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Why this tool, and when it would be the wrong one, with the essay that argues it. */
export function WhyLines({ entry, read = true }: { entry: GuideEntry; read?: boolean }) {
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
