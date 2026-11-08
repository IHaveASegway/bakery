import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ActivityEntry } from '../contracts';
import { activityFeed } from '../lib/activity-feed';
import { apiOrigin, getActivity } from '../lib/api';
import { describeError } from '../lib/messages';
import {
  CLOSED,
  SEEN_KEY,
  curlText,
  keyAction,
  maskToken,
  parseSeen,
  progressText,
  recentEvents,
  tourReduce,
  withSeen,
  type Principle as PrincipleData,
  type ScreenId,
  type TourStep,
} from '../lib/tour';
import { liveToken, tokenStore } from '../lib/token-store';
import { useSandboxPhase } from '../lib/use-session';
import { ulid } from '../lib/ulid';
import { stepsFor } from '../tour';

const TRIGGER = 'tour-trigger';
const DOCK = 'tour-dock';
/** The gap kept between a target and the window's top edge or the bar. */
const GAP = 16;
/** How long after a step shows its target a change in the page's height shows the target again. */
const SETTLE_MS = 2000;

/**
 * Scroll the page so the target sits in the part of the window above the bar. A target already in
 * that part stays where it is, so the visitor keeps their place; one above it is brought down to
 * the top, one below it up to the bar, and one taller than the part is shown from its top.
 */
export function revealDelta(top: number, bottom: number, freeTop: number, freeBottom: number) {
  const room = freeBottom - freeTop;
  if (bottom - top > room) return top - freeTop;
  if (top < freeTop) return top - freeTop;
  if (bottom > freeBottom) return bottom - freeBottom;
  return 0;
}

function reveal(target: HTMLElement, calm: boolean): void {
  const dock = document.getElementById(DOCK);
  const rect = target.getBoundingClientRect();
  const freeTop = GAP;
  const freeBottom = (dock?.getBoundingClientRect().top ?? window.innerHeight) - GAP;
  const delta = revealDelta(rect.top, rect.bottom, freeTop, freeBottom);
  if (Math.abs(delta) < 1) return;
  window.scrollBy({ top: delta, behavior: calm ? 'auto' : 'smooth' });
}

/** localStorage may be missing, full or blocked: the tour works without it. */
function readSeen(): ReturnType<typeof parseSeen> {
  try {
    return parseSeen(window.localStorage.getItem(SEEN_KEY));
  } catch {
    return {};
  }
}

function writeSeen(seen: ReturnType<typeof parseSeen>): void {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // A per-viewer convenience only; nothing depends on it.
  }
}

/**
 * The guided tour (Q41 · Q-tour): one island on every screen, no third-party script. A button opens
 * a card that walks the screen's steps one at a time, ringing the element each step points at.
 * The card is docked in a bar at the foot of the window, its height capped (about 40% of a phone's
 * screen, with its own scroll), and the page keeps room for the bar. Each step scrolls its target
 * into the part of the window above the bar, so the card is below the target and never over it,
 * except for a target taller than that part, whose top is shown. The one Close control sits in the
 * bar, pinned at its foot beside Back and Next, so it covers no page button and the action row is
 * always in view while only the step's text scrolls above it. The card is not modal and traps no focus. Which screens the
 * visitor has seen is the only thing remembered, in localStorage.
 */
export default function Tour({ screen }: { screen: ScreenId }) {
  const steps = stepsFor(screen);
  const [state, dispatch] = useReducer(
    (s: typeof CLOSED, a: Parameters<typeof tourReduce>[1]) => tourReduce(s, a, steps.length),
    CLOSED,
  );
  const [seen, setSeen] = useState<ReturnType<typeof parseSeen>>({});
  // The button is drawn with the page but does nothing until the island has hydrated, so it is
  // disabled until then and no click is lost.
  const [ready, setReady] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    setSeen(readSeen());
    setReady(true);
  }, []);

  // While the bar is open the page keeps room under its last line for it, and the bar's height is
  // kept current in a custom property (set through the style object, not a style attribute).
  useLayoutEffect(() => {
    if (!state.open) return;
    const root = document.documentElement;
    const bar = document.getElementById(DOCK);
    const size = () =>
      root.style.setProperty('--tour-dock-h', `${bar?.getBoundingClientRect().height ?? 0}px`);
    size();
    root.classList.add('tour-open');
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(size);
    if (bar !== null) watch?.observe(bar);
    return () => {
      watch?.disconnect();
      root.classList.remove('tour-open');
      root.style.removeProperty('--tour-dock-h');
    };
  }, [state.open]);

  // Opening marks the screen seen; closing returns the focus to the button that opened it.
  useEffect(() => {
    if (state.open) {
      wasOpen.current = true;
      const next = withSeen(readSeen(), screen);
      writeSeen(next);
      setSeen(next);
    } else if (wasOpen.current) {
      wasOpen.current = false;
      trigger.current?.focus();
    }
  }, [state.open, screen]);

  // Escape closes from anywhere on the page while the card is open.
  useEffect(() => {
    if (!state.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dispatch({ type: 'close' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state.open]);

  if (steps.length === 0) return null;
  const step = steps[state.index];
  const button = (
    <button
      id={TRIGGER}
      ref={trigger}
      type="button"
      className="tour-trigger"
      aria-expanded={state.open}
      aria-controls={state.open ? 'tour-card' : undefined}
      disabled={!ready}
      onClick={() => dispatch(state.open ? { type: 'close' } : { type: 'open' })}
    >
      {state.open ? 'Close the tour' : seen[screen] ? 'Tour' : 'Take the tour'}
    </button>
  );
  if (!state.open || step === undefined) return button;
  return (
    <div id={DOCK} className="tour-dock">
      <TourCard
        step={step}
        index={state.index}
        total={steps.length}
        dispatch={dispatch}
        closer={button}
      />
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

type Dispatch = React.Dispatch<Parameters<typeof tourReduce>[1]>;

export function TourCard({
  step,
  index,
  total,
  dispatch,
  closer,
}: {
  step: TourStep;
  index: number;
  total: number;
  dispatch: Dispatch;
  /** The one Close control, drawn at the foot of the bar beside Back and Next. */
  closer?: React.ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [found, setFound] = useState(true);
  const phase = useSandboxPhase();
  const held = useSyncExternalStore(tokenStore.subscribe, tokenStore.get, () => null);
  const token = held === null ? null : liveToken(Date.now());
  const sandboxId = phase.name === 'live' || phase.name === 'seeding' ? phase.id : null;
  // One Idempotency-Key per step shown, so the copied command is valid and does not change as the
  // card redraws.
  const key = useMemo(() => ulid(), [step.id]);

  // The card takes the focus when the tour opens; after that the focus stays where the visitor put it.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  // Ring the step's element and bring it into view; take the ring off when the step changes.
  useEffect(() => {
    const target = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    setFound(target !== null);
    if (target === null) return;
    target.setAttribute('data-tour-current', 'true');
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    reveal(target, calm);
    // The console's panels fill in as their reads answer, which moves the target after it was
    // shown. For the first moments of a step, a change in the page's height shows it again.
    const watch =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => reveal(target, true));
    watch?.observe(document.body);
    const settled = window.setTimeout(() => watch?.disconnect(), SETTLE_MS);
    return () => {
      watch?.disconnect();
      window.clearTimeout(settled);
      target.removeAttribute('data-tour-current');
    };
  }, [step.target]);

  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => setCopied(null), [step.id]);

  const context = { origin: apiOrigin, sandboxId, token, key };

  async function copy() {
    try {
      await navigator.clipboard.writeText(curlText(step.api, context, 'copy'));
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <section
      id="tour-card"
      className="tour-card"
      aria-label="Guided tour"
      onKeyDown={(event) => {
        const onControl = (event.target as HTMLElement).closest('button, a') !== null;
        const action = keyAction(event.key, onControl);
        // Escape is the document's job above, so it is not handled twice.
        if (action === null || action.type === 'close') return;
        event.preventDefault();
        dispatch(action);
      }}
    >
      <div className="tour-body">
        <div aria-live="polite" aria-atomic="true">
          <p className="tour-progress">{progressText(index, total)}</p>
          <h2 ref={heading} tabIndex={-1}>
            {step.title}
          </h2>
          <p>{step.what}</p>
          {!found && (
            <p className="hint">
              This part of the screen is not showing right now. It appears once you are signed in
              and your sandbox is live.
            </p>
          )}
        </div>

        <Events step={step} phase={phase} />

        <Principle principle={step.principle} />

        <h3>Do the same through the API</h3>
        <p className="hint">{step.api.note}</p>
        <pre className="tour-curl" tabIndex={0} aria-label={`curl for ${step.api.routeId}`}>
          <code>{curlText(step.api, context, 'screen')}</code>
        </pre>
        <p className="hint">
          {token === null
            ? tokenHint(phase)
            : `Your token is held in this page’s memory (${maskToken(token)}); the copy has it whole.`}{' '}
          Route <code>{step.api.routeId}</code>.
        </p>
        <p className="actions">
          <button type="button" onClick={() => void copy()}>
            Copy the curl
          </button>
          <span aria-live="polite">
            {copied === 'copied' && 'Copied.'}
            {copied === 'failed' && 'Copy failed: select the command and copy it by hand.'}
          </span>
        </p>
      </div>

      <p className="actions tour-nav">
        <button type="button" disabled={index === 0} onClick={() => dispatch({ type: 'back' })}>
          Back
        </button>
        <button type="button" onClick={() => dispatch({ type: 'next' })}>
          {index === total - 1 ? 'Done' : 'Next'}
        </button>
        {closer}
      </p>
    </section>
  );
}

/**
 * The principle and where it is explained (Q32 · Q-links): its lab page on the site and its ADR on
 * GitHub, or, for a principle with no lab page, its section of the How it's built page and the
 * ADR; every principle has an essay, which the card adds by title. The URLs come with the principle
 * (lib/how-its-built.ts).
 */
export function Principle({ principle }: { principle: PrincipleData }) {
  return (
    <p className="hint tour-principle">
      <strong>Principle:</strong> {principle.name}. <strong>Read how it works:</strong>{' '}
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
      .
    </p>
  );
}

/**
 * The events this step's action produces, by name, and which of them the activity feed shows from
 * the last minute. The feed is the console's own list when it is fresh, else one GET of the API.
 */
function Events({ step, phase }: { step: TourStep; phase: ReturnType<typeof useSandboxPhase> }) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const live = phase.name === 'live' ? phase : null;
  const liveId = live?.id ?? null;
  const offsetS = live?.clockOffsetS ?? 0;

  useEffect(() => {
    if (liveId === null || step.events.length === 0) return;
    const fresh = tick === 0 ? activityFeed.fresh(liveId) : null;
    if (fresh !== null) {
      setEntries(fresh.entries);
      return;
    }
    let stopped = false;
    getActivity(liveId, 50).then(
      (answer) => {
        if (stopped) return;
        activityFeed.set(liveId, answer.entries);
        setEntries(answer.entries);
        setProblem(null);
      },
      (e: unknown) => {
        if (!stopped) setProblem(describeError(e).title);
      },
    );
    return () => {
      stopped = true;
    };
  }, [liveId, step.id, step.events.length, tick]);

  if (step.events.length === 0) {
    return <p className="hint">This action makes no new event of its own.</p>;
  }
  const recent =
    entries === null || liveId === null
      ? []
      : recentEvents(entries, step.events, Date.now() + offsetS * 1000);
  return (
    <div>
      <p>
        <strong>Events this action produces:</strong>{' '}
        {step.events.map((name, i) => (
          <span key={name}>
            {i > 0 && ', '}
            <code>{name}</code>
          </span>
        ))}
        .
      </p>
      <div aria-live="polite">
        {live === null ? (
          <p className="hint">
            Once your sandbox is live, the ones from the last minute show here.
          </p>
        ) : problem !== null ? (
          <p className="hint">The activity feed could not be read: {problem}.</p>
        ) : entries === null ? (
          <p className="hint">Reading the activity feed…</p>
        ) : recent.length === 0 ? (
          <p className="hint">
            None of them in your activity feed in the last minute. Do the action, then check again.
            The feed lists only the events the CRM logs.
          </p>
        ) : (
          <ul className="feed">
            {recent.map((entry) => (
              <li key={`${entry.at}-${entry.type}-${entry.summary}`}>
                <code>{entry.type}</code>: {entry.summary}
              </li>
            ))}
          </ul>
        )}
      </div>
      {live !== null && (
        <button type="button" className="link" onClick={() => setTick((n) => n + 1)}>
          Check again
        </button>
      )}
    </div>
  );
}
