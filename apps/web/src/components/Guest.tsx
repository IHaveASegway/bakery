import { useEffect, useId, useRef, useState } from 'react';
import type { SessionResponse } from '../contracts';
import { createSandbox } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import {
  DEFAULT_NEXT,
  GUEST_NEXT,
  NEXT_PATHS,
  nextFrom,
  signinFor,
  type NextPath,
} from '../lib/next';
import { readSession, rememberedSignedIn } from '../lib/session';
import { lookAgain, readSandbox } from '../lib/use-session';
import Message from './Message';
import Turnstile from './Turnstile';

/**
 * The one way a guest begins (ADR 0006): a Turnstile pass buys a sandbox and a cookie, nothing
 * else. The sign-in page's form and the in-place Start ordering both come here.
 */
const makeGuest = (token: string) => createSandbox({ turnstile_token: token, replace: false });

/**
 * The visitor's session when it holds a sandbox that is still there (live or seeding), else null.
 * Asked only when this browser last saw a session, so a stranger's visit logs no 401; a guest whose
 * sandbox was wiped gets null and is offered a new one. The sign-in page's islands share the one
 * request each (lib/session.ts, lib/use-session.ts).
 */
function useLiveSandbox(): SessionResponse | null {
  const [session, setSession] = useState<SessionResponse | null>(null);
  useEffect(() => {
    if (!rememberedSignedIn()) return;
    readSession()
      .then(async (found) => {
        if (!found.sandbox) return;
        const sandbox = await readSandbox(found.sandbox);
        if (sandbox.state === 'live' || sandbox.state === 'seeding') setSession(found);
      })
      .catch(() => undefined);
  }, []);
  return session;
}

/**
 * "Continue as a guest", the sign-in page's first choice: the visitor goes on to the page that
 * sent them here (`next`, G2), or to the menu, since a guest came to order.
 */
export default function Guest() {
  const [token, setToken] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [resetKey, setResetKey] = useState(0);
  // Read after mount, so the server's HTML and the first render agree.
  const [next, setNext] = useState<NextPath>(GUEST_NEXT);
  useEffect(() => setNext(nextFrom(window.location.search, GUEST_NEXT)), []);
  // A visitor who already has a sandbox is not offered a second start (AlreadyIn says why).
  const existing = useLiveSandbox();

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      await makeGuest(token);
      window.location.assign(next);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
      setResetKey((k) => k + 1);
    }
  }

  if (existing !== null) return null;
  return (
    <form
      onSubmit={submit}
      aria-labelledby="guest-heading"
      className="way-in way-in-first"
      data-tour="signin-guest"
    >
      <p className="way-in-tag">Quickest</p>
      <h2 id="guest-heading">Continue as a guest</h2>
      <p>
        Order, pay with a test card and move your order through the kitchen yourself. No account, no
        email.
      </p>
      <Turnstile
        onToken={setToken}
        resetKey={resetKey}
        onUnavailable={() => setUnavailable(true)}
      />
      <button
        type="submit"
        className="btn btn-primary"
        disabled={busy || unavailable || token === null}
      >
        {busy ? 'Making your sandbox…' : 'Continue as a guest'}
      </button>
      <p className="hint">Then on to {NEXT_PATHS[next]}.</p>
      <Message error={error} />
    </form>
  );
}

/** What the gate says, on the menu and the checkout alike: one title, one sentence (audit F3). */
export const START_TITLE = 'Ordering starts with your own sandbox.';
/** The gate's button on the menu and the checkout; a page that takes no order names its own. */
export const START_ACTION = 'Start ordering';
export const START_SENTENCE =
  'A sandbox is your own private copy of the bakery: made in a few seconds, no account needed, wiped at 10:00 UTC.';

/**
 * The gate, shown one way wherever a page needs a sandbox (audit F1 and F3, 2026-11-10; the
 * catering page since the same day's follow-up): one sentence, a button (Start ordering on the menu
 * and the checkout) that makes a guest sandbox right here and leaves the visitor where they were,
 * with their cart, and a quieter Sign in that comes back to this page. Turnstile's script loads
 * only once the button is pressed, so a visitor who only reads the page still loads nothing from
 * Cloudflare.
 */
export function StartHere({
  here,
  seeding = false,
  className = '',
  title = START_TITLE,
  action = START_ACTION,
}: {
  /** This page, for the sign-in link's way back. */
  here: NextPath;
  /**
   * The title and the button's label, where ordering is not what the page does (the catering
   * page, 2026-11-10). The sentence on what a sandbox is stays the same everywhere.
   */
  title?: string;
  action?: string;
  /** The sandbox exists and its first alarm is seeding it: the gate says so and waits. */
  seeding?: boolean;
  className?: string;
}) {
  const id = useId();
  const [asked, setAsked] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [resetKey, setResetKey] = useState(0);
  // A press waits for the challenge's token, then goes on by itself; one press, one sandbox.
  const wanted = useRef(false);
  const [presses, setPresses] = useState(0);

  useEffect(() => {
    if (!wanted.current || token === null || busy) return;
    wanted.current = false;
    setBusy(true);
    setError(null);
    makeGuest(token).then(
      () => {
        setMade(true);
        // The islands and the header look again; the page swaps the gate for what it gated.
        lookAgain();
      },
      (e: unknown) => {
        setError(describeError(e));
        setBusy(false);
        setResetKey((k) => k + 1);
      },
    );
  }, [token, busy, presses]);

  const working = busy || made || seeding;
  const waiting = asked && token === null && error === null;
  const words =
    seeding || made ? 'Setting up your sandbox…' : busy || waiting ? 'Starting…' : action;

  return (
    <section
      className={`start-here ${className}`.trim()}
      aria-labelledby={`${id}-title`}
      aria-busy={working || undefined}
    >
      <div className="start-words">
        <h2 id={`${id}-title`} className="start-title">
          {title}
        </h2>
        <p className="hint">{START_SENTENCE}</p>
      </div>
      <div className="start-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={working || unavailable || waiting}
          onClick={() => {
            wanted.current = true;
            setAsked(true);
            setError(null);
            // A token already in hand (after a refused try) is used at once.
            setPresses((n) => n + 1);
          }}
        >
          {words}
        </button>
        <a className="btn btn-quiet" href={signinFor(here)}>
          Sign in
        </a>
      </div>
      {asked && !made && !seeding && (
        <Turnstile
          onToken={setToken}
          resetKey={resetKey}
          onUnavailable={() => setUnavailable(true)}
        />
      )}
      <Message error={error}>
        {(made || seeding) && <p className="sr-only">Setting up your sandbox.</p>}
      </Message>
    </section>
  );
}

/**
 * The sign-in page for a visitor who already has a sandbox: the header's "Your bakery" comes here
 * from a page with no script (audit F14), so this page says so and offers the way on, rather than
 * suggesting the sandbox is gone. Nothing shows until the API has answered.
 */
export function AlreadyIn() {
  const session = useLiveSandbox();
  const [next, setNext] = useState<NextPath>(DEFAULT_NEXT);
  useEffect(() => setNext(nextFrom(window.location.search)), []);
  if (session === null || !session.sandbox) return null;
  const guest = session.kind === 'guest';
  return (
    <section className="already-in" aria-labelledby="already-heading">
      <h2 id="already-heading">You already have a sandbox</h2>
      <p className="hint">
        Sandbox <code>{session.sandbox.slice(-6)}</code>, as a{' '}
        {guest ? 'guest' : 'signed-in visitor'}. It stays until 10:00 UTC.
      </p>
      {guest && (
        <p className="hint">
          Signing in to an account below leaves this guest sandbox behind for good: no account holds
          it.
        </p>
      )}
      <p className="start-actions">
        <a className="btn btn-primary" href={next}>
          Go to {NEXT_PATHS[next]}
        </a>
        {next !== '/menu/' && (
          <a className="btn btn-quiet" href="/menu/">
            Order from the menu
          </a>
        )}
      </p>
    </section>
  );
}
