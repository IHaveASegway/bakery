import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import type { SandboxResponse, SessionResponse } from '../contracts';
import {
  ApiError,
  NetworkError,
  createSandbox,
  getSandbox,
  setFault,
  signOut,
  wipeSandbox,
} from '../lib/api';
import type { WorkspaceId } from '../lib/console-sections';
import { describeError, type Message as Text } from '../lib/messages';
import { forgetSession, readSession, refreshSession } from '../lib/session';
import { readSandbox } from '../lib/use-session';
import { signinFor } from '../lib/next';
import ConsoleTopBar from './ConsoleTopBar';
import Message from './Message';

/** What a workspace's view is given: the sandbox, and the actions the frame owns. */
export interface WorkspaceProps {
  sandbox: SandboxResponse;
  isGuest: boolean;
  /** An action is running: the buttons wait. */
  busy: boolean;
  error: Text | null;
  /** Ask the API for the sandbox again. */
  onReload: () => void;
  /** The board's socket closed with "wiped". */
  onBoardWiped: () => void;
  onFault: (fault: 'kitchen' | 'inbox', on: boolean) => void;
  onWipe: () => void;
  onReplace: () => void;
}

// Nothing here is stored in the browser: the session is the cookie, and every load asks the API.
type View =
  | { name: 'loading' }
  | { name: 'starting' }
  | { name: 'offline' }
  | { name: 'signedout' }
  | { name: 'failed'; error: Text }
  | { name: 'none'; session: SessionResponse }
  | { name: 'deleted'; session: SessionResponse }
  | { name: 'wiped'; session: SessionResponse }
  | { name: 'sandbox'; session: SessionResponse; sandbox: SandboxResponse };

/**
 * The frame of every console page (design brief, 2026-11-09): it reads the session and the
 * sandbox once, says what is wrong when there is no sandbox to show, fills the top bar's live
 * controls, and hands the sandbox to the page's own workspace view.
 */
export default function Console({
  workspace,
  View,
  start = false,
}: {
  workspace: WorkspaceId;
  View: ComponentType<WorkspaceProps>;
  /**
   * The landing of a sign-in through the sign-in page (/app/start/, Google's and GitHub's return
   * path): a session with no live sandbox gets one made here, without a press, then the console
   * shows at /app/. Off everywhere else, so a session that outlives its sandbox and opens /app/
   * still gets the empty state with its button.
   */
  start?: boolean;
}) {
  const [view, setView] = useState<View>({ name: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  // This page's own Wipe now or replace, while its request is in flight. The board's socket closes
  // with "wiped" before that request answers. A reload then would ask for the old sandbox with
  // whichever cookie the browser holds when it asks: the old one names the sandbox and gets 410,
  // the one the answer re-issues names none and gets 404 (the e2e race of 2026-11-08). So the
  // request's own answer decides the view, and a close it hid reloads only if the request fails.
  const ownWipe = useRef<'idle' | 'running' | 'closed'>('idle');

  /** `fresh`: ask again; the first look shares the page's one answer with the other islands. */
  const load = useCallback(async (fresh = true) => {
    try {
      const session = await (fresh ? refreshSession() : readSession());
      // The schema marks the claim optional as well as nullable; both mean no sandbox.
      const sandboxId = session.sandbox ?? null;
      if (sandboxId === null) return setView({ name: 'none', session });
      try {
        const sandbox = await (fresh ? getSandbox(sandboxId) : readSandbox(sandboxId));
        setView({ name: 'sandbox', session, sandbox });
      } catch (e) {
        // 410: wiped. 404: the cookie names a sandbox the API does not know; same page for both.
        if (e instanceof ApiError && e.status === 410) return setView({ name: 'deleted', session });
        if (e instanceof ApiError && e.status === 404) return setView({ name: 'none', session });
        throw e;
      }
    } catch (e) {
      if (e instanceof NetworkError) return setView({ name: 'offline' });
      if (e instanceof ApiError && e.status === 401) return setView({ name: 'signedout' });
      setView({ name: 'failed', error: describeError(e) });
    }
  }, []);

  /**
   * /app/start/: the sign-in page promises each way in a sandbox (audit G11, 2026-11-10), and a
   * first sign-in with Google or GitHub, or a return after the night's wipe, came back with none.
   * The live sandbox the session names is shown as it is; with none, one is made, once: a refusal
   * (a cap, the one-a-minute limit, the API out of reach) is said in the API's words over the
   * empty state, whose button is the way on. No retry. Either way the address becomes /app/, so
   * Back does not come here again. With no session, the sign-in page.
   */
  const begin = useCallback(async () => {
    const landed = () =>
      window.history.replaceState(window.history.state, '', `/app/${window.location.hash}`);
    try {
      const session = await readSession();
      const sandboxId = session.sandbox ?? null;
      if (sandboxId !== null) {
        try {
          const sandbox = await readSandbox(sandboxId);
          landed();
          return setView({ name: 'sandbox', session, sandbox });
        } catch (e) {
          // Gone or unknown: make one, as for a session that names none.
          if (!(e instanceof ApiError && (e.status === 410 || e.status === 404))) throw e;
        }
      }
      setView({ name: 'starting' });
      try {
        const sandbox = await createSandbox({ replace: false });
        landed();
        setView({ name: 'sandbox', session: { ...session, sandbox: sandbox.id }, sandbox });
      } catch (e) {
        setError(describeError(e));
        landed();
        setView({ name: 'none', session });
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        return window.location.replace(signinFor('/app/'));
      }
      landed();
      if (e instanceof NetworkError) return setView({ name: 'offline' });
      setView({ name: 'failed', error: describeError(e) });
    }
  }, []);

  useEffect(() => {
    void (start ? begin() : load(false));
  }, [start, begin, load]);

  // The first alarm seeds a new sandbox (ADR 0005); until it is live, ask every second.
  const seedingId =
    view.name === 'sandbox' && view.sandbox.state === 'seeding' ? view.sandbox.id : null;
  useEffect(() => {
    if (seedingId === null) return;
    const timer = setInterval(() => {
      getSandbox(seedingId).then(
        (sandbox) => {
          if (sandbox.state !== 'seeding') {
            setView((v) => (v.name === 'sandbox' ? { ...v, sandbox } : v));
          }
        },
        () => undefined,
      );
    }, 1_000);
    return () => clearInterval(timer);
  }, [seedingId]);

  // A link from elsewhere names a section (`/app/money/#ledger-heading`). The workspace is drawn
  // after the sandbox is read, too late for the browser's own jump, so once it is drawn the
  // section's heading is shown and takes the focus, as an in-page link would give it.
  const shown = view.name === 'sandbox' && view.sandbox.state !== 'seeding';
  useEffect(() => {
    if (!shown || window.location.hash.length < 2) return;
    const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (target === null) return;
    target.scrollIntoView();
    target.focus({ preventScroll: true });
  }, [shown]);

  /**
   * Runs one action: busy while it runs, any problem shown in the live region. `wipes`: the
   * action wipes this sandbox (Wipe now, or a replace), so the board's "wiped" close waits for it.
   */
  async function act(run: () => Promise<void>, wipes = false) {
    setBusy(true);
    setError(null);
    if (wipes) ownWipe.current = 'running';
    try {
      await run();
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) await load();
      else {
        setError(describeError(e));
        if (ownWipe.current === 'closed') await load();
      }
    } finally {
      if (wipes) ownWipe.current = 'idle';
      setBusy(false);
    }
  }

  /** The board's socket closed with "wiped": the nightly wipe, or this page's own. */
  const boardWiped = useCallback(() => {
    if (ownWipe.current === 'idle') void load();
    else ownWipe.current = 'closed';
  }, [load]);

  switch (view.name) {
    case 'loading':
      return <p aria-live="polite">Loading your session…</p>;
    case 'starting':
      return <p aria-live="polite">Starting your sandbox…</p>;
    case 'offline':
      return (
        <section className="empty">
          <h2>The API is unreachable</h2>
          <p>
            The console could not reach the bakery’s API. Check your connection, then try again.
            Nothing was changed.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setView({ name: 'loading' });
              void load();
            }}
          >
            Try again
          </button>
        </section>
      );
    case 'signedout':
      return (
        <section className="empty">
          <h2>You are not signed in</h2>
          <p>The console shows your own sandbox, so it needs a session.</p>
          <a className="btn btn-primary" href={signinFor('/app/')}>
            Sign in or try it as a guest
          </a>
        </section>
      );
    case 'failed':
      return (
        <section className="empty">
          <h2>The console could not load</h2>
          <Message error={view.error} />
          <button type="button" className="btn btn-primary" onClick={() => void load()}>
            Try again
          </button>
        </section>
      );
    default:
      break;
  }

  const { session } = view;
  const isGuest = session.kind === 'guest';

  const newSandbox = (replace: boolean) =>
    // A replace was asked for in the page first (SandboxActions, ConfirmStep).
    act(async () => {
      const sandbox = await createSandbox({ replace });
      setView({ name: 'sandbox', session: { ...session, sandbox: sandbox.id }, sandbox });
    }, replace);

  const leave = () =>
    act(async () => {
      await signOut();
      forgetSession();
      window.location.assign('/signin/');
    });

  const wipe = (sandbox: SandboxResponse) =>
    // Asked for in the page first (SandboxActions, ConfirmStep).
    act(async () => {
      await wipeSandbox(sandbox.id);
      setView({ name: 'wiped', session });
    }, true);

  const sandbox = view.name === 'sandbox' ? view.sandbox : null;
  const topBar = (
    <ConsoleTopBar
      kind={session.kind}
      sandbox={sandbox}
      isGuest={isGuest}
      busy={busy}
      here={workspace}
      onLeave={() => void leave()}
      onWipe={() => sandbox && void wipe(sandbox)}
      onReplace={() => void newSandbox(true)}
      onAdvanced={() => void load()}
    />
  );

  // A guest's new sandbox needs a Turnstile pass, and the widget lives on the sign-in page.
  const another = isGuest ? (
    <p>
      <a className="btn btn-primary" href="/signin/">
        Start another guest sandbox
      </a>
    </p>
  ) : (
    <p>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => void newSandbox(false)}
      >
        New sandbox
      </button>
    </p>
  );

  if (view.name === 'none') {
    return (
      <>
        {topBar}
        <section className="empty">
          <h2>You have no sandbox</h2>
          <p>A sandbox is yours until 10:00 UTC, when every sandbox is deleted.</p>
          {another}
        </section>
        <Message error={error} />
      </>
    );
  }

  if (view.name === 'deleted' || view.name === 'wiped') {
    return (
      <>
        {topBar}
        <Gone wiped={view.name === 'wiped'} header={null} another={another} error={error} />
      </>
    );
  }

  return (
    <>
      {topBar}
      <View
        sandbox={view.sandbox}
        isGuest={isGuest}
        busy={busy}
        error={error}
        onReload={() => void load()}
        onBoardWiped={boardWiped}
        onFault={(fault, on) =>
          void act(async () => {
            const { faults } = await setFault(view.sandbox.id, { fault, on });
            setView({ ...view, sandbox: { ...view.sandbox, faults } });
          })
        }
        onWipe={() => void wipe(view.sandbox)}
        onReplace={() => void newSandbox(true)}
      />
    </>
  );
}

/**
 * The view after a sandbox is gone. After this page's own Wipe now the button that had the focus is
 * gone with the sandbox, so the heading takes it; a sandbox deleted by the night's wipe arrives
 * unasked, and leaves the focus where it was.
 */
export function Gone({
  wiped,
  header,
  another,
  error,
}: {
  wiped: boolean;
  header: React.ReactNode;
  another: React.ReactNode;
  error: Text | null;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (wiped) heading.current?.focus();
  }, [wiped]);
  return (
    <section>
      {header}
      <div className="empty">
        <h3 id="gone-heading" ref={heading} tabIndex={-1}>
          {wiped ? 'Your sandbox is wiped' : 'Your sandbox was deleted at 10:00 UTC'}
        </h3>
        <p>
          {wiped ? 'Everything in it is gone. ' : 'Every sandbox is deleted each night. '}
          Make a new one for a fresh start.
        </p>
        {another}
      </div>
      <Message error={error} />
    </section>
  );
}
