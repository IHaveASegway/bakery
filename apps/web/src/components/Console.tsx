import { useCallback, useEffect, useRef, useState } from 'react';
import type { SandboxResponse, SessionResponse } from '../contracts';
import {
  ApiError,
  NetworkError,
  createSandbox,
  getSandbox,
  getSession,
  setFault,
  signOut,
  wipeSandbox,
} from '../lib/api';
import { formatCountdown, utcClock, utcStamp } from '../lib/countdown';
import { describeError, type Message as Text } from '../lib/messages';
import Activity from './Activity';
import Campaigns from './Campaigns';
import CapacityEditor from './CapacityEditor';
import CateringQueue from './CateringQueue';
import ClockControl from './ClockControl';
import Customers from './Customers';
import DeadLetters from './DeadLetters';
import GuestNote from './GuestNote';
import KitchenBoard from './KitchenBoard';
import LeadPipeline from './LeadPipeline';
import Ledger from './Ledger';
import MenuEditor from './MenuEditor';
import Message from './Message';
import Rebuild from './Rebuild';
import Segments from './Segments';
import Traffic from './Traffic';

// Nothing here is stored in the browser: the session is the cookie, and every load asks the API.
type View =
  | { name: 'loading' }
  | { name: 'offline' }
  | { name: 'signedout' }
  | { name: 'failed'; error: Text }
  | { name: 'none'; session: SessionResponse }
  | { name: 'deleted'; session: SessionResponse }
  | { name: 'wiped'; session: SessionResponse }
  | { name: 'sandbox'; session: SessionResponse; sandbox: SandboxResponse };

const KINDS: Record<SessionResponse['kind'], string> = {
  guest: 'Guest',
  google: 'Signed in with Google',
  github: 'Signed in with GitHub',
  demo: 'Signed in with a demo account',
};

export default function Console() {
  const [view, setView] = useState<View>({ name: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [ledgerTick, setLedgerTick] = useState(0);
  // Bumped when something the CRM screens derive from changes: a consent flag, a finished rebuild.
  const [crmTick, setCrmTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const session = await getSession();
      // The schema marks the claim optional as well as nullable; both mean no sandbox.
      const sandboxId = session.sandbox ?? null;
      if (sandboxId === null) return setView({ name: 'none', session });
      try {
        setView({ name: 'sandbox', session, sandbox: await getSandbox(sandboxId) });
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

  useEffect(() => {
    void load();
  }, [load]);

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

  /** Runs one action: busy while it runs, any problem shown in the live region. */
  async function act(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) await load();
      else setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  switch (view.name) {
    case 'loading':
      return <p aria-live="polite">Loading your session…</p>;
    case 'offline':
      return (
        <section>
          <h2>The API is unreachable</h2>
          <p>
            The console could not reach the bakery’s API. Check your connection, then try again.
            Nothing was changed.
          </p>
          <button
            type="button"
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
        <section>
          <h2>You are not signed in</h2>
          <p>
            The console shows your own sandbox, so it needs a session.{' '}
            <a href="/signin/">Sign in or try it as a guest</a>.
          </p>
        </section>
      );
    case 'failed':
      return (
        <section>
          <h2>The console could not load</h2>
          <Message error={view.error} />
          <button type="button" onClick={() => void load()}>
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
    act(async () => {
      if (
        replace &&
        !window.confirm(
          'Replace your sandbox? The current one is deleted now, with everything in it.',
        )
      ) {
        return;
      }
      const sandbox = await createSandbox({ replace });
      setView({ name: 'sandbox', session: { ...session, sandbox: sandbox.id }, sandbox });
    });

  const leave = () =>
    act(async () => {
      await signOut();
      window.location.assign('/signin/');
    });

  // A guest's new sandbox needs a Turnstile pass, and the widget lives on the sign-in page.
  const another = isGuest ? (
    <p>
      <a className="action" href="/signin/">
        Start another guest sandbox
      </a>
    </p>
  ) : (
    <p>
      <button type="button" disabled={busy} onClick={() => void newSandbox(false)}>
        New sandbox
      </button>
    </p>
  );

  const header = (
    <>
      <h2>{KINDS[session.kind]}</h2>
      <p>
        <button type="button" disabled={busy} onClick={() => void leave()}>
          Sign out
        </button>
      </p>
    </>
  );

  if (view.name === 'none') {
    return (
      <section>
        {header}
        <h3>You have no sandbox</h3>
        <p>A sandbox is yours until 10:00 UTC, when every sandbox is deleted.</p>
        {another}
        <Message error={error} />
      </section>
    );
  }

  if (view.name === 'deleted' || view.name === 'wiped') {
    return (
      <section>
        {header}
        <h3>
          {view.name === 'wiped'
            ? 'Your sandbox is wiped'
            : 'Your sandbox was deleted at 10:00 UTC'}
        </h3>
        <p>
          {view.name === 'wiped'
            ? 'Everything in it is gone. '
            : 'Every sandbox is deleted each night. '}
          Make a new one for a fresh start.
        </p>
        {another}
        <Message error={error} />
      </section>
    );
  }

  const { sandbox } = view;
  return (
    <section>
      {header}
      <h3>Your sandbox</h3>
      <dl>
        <dt>Sandbox</dt>
        <dd>
          <code>{sandbox.id}</code>
        </dd>
        <dt>Seed</dt>
        <dd>
          <code>{String(sandbox.seed)}</code>
        </dd>
        <dt>Born</dt>
        <dd>{utcStamp(sandbox.born)}</dd>
        <dt>Deleted</dt>
        <dd>
          <Countdown wipeAt={sandbox.wipe_at} onDue={() => void load()} />
        </dd>
      </dl>

      {sandbox.state === 'seeding' ? (
        <p aria-live="polite">
          <strong>Seeding your bakery.</strong> The menu, the kitchen and the day’s open orders are
          being made. This page updates by itself.
        </p>
      ) : (
        <>
          <KitchenBoard
            sandboxId={sandbox.id}
            isGuest={isGuest}
            clockOffsetS={sandbox.clock_offset_s}
            onWiped={() => void load()}
            onRefunded={() => setLedgerTick((n) => n + 1)}
          />
          <Ledger sandboxId={sandbox.id} refresh={ledgerTick} />
          <Traffic sandboxId={sandbox.id} isGuest={isGuest} />
          <MenuEditor sandboxId={sandbox.id} isGuest={isGuest} />
          <CapacityEditor
            sandboxId={sandbox.id}
            isGuest={isGuest}
            clockOffsetS={sandbox.clock_offset_s}
          />
          <CateringQueue sandboxId={sandbox.id} isGuest={isGuest} />
          <Customers
            sandboxId={sandbox.id}
            isGuest={isGuest}
            personaId={sandbox.persona}
            refresh={crmTick}
            onConsent={() => setCrmTick((n) => n + 1)}
          />
          <Segments sandboxId={sandbox.id} refresh={crmTick} />
          <Campaigns
            sandboxId={sandbox.id}
            isGuest={isGuest}
            clockOffsetS={sandbox.clock_offset_s}
          />
          <LeadPipeline sandboxId={sandbox.id} refresh={crmTick} />
          <Activity sandboxId={sandbox.id} refresh={crmTick} />
          <Rebuild
            sandboxId={sandbox.id}
            isGuest={isGuest}
            onFinished={() => setCrmTick((n) => n + 1)}
          />
          <p>
            <a href="/inbox/">Open the inbox</a>: every message the bakery sends lands there.
          </p>
          <p>
            <a href="/app/dispatch/">Open dispatch</a>: plan a day’s deliveries, with the server’s
            plan and VROOM’s side by side.
          </p>

          <h3>Faults</h3>
          <p>
            <label className="check">
              <input
                type="checkbox"
                checked={sandbox.faults.kitchen}
                disabled={busy || isGuest}
                onChange={(e) =>
                  void act(async () => {
                    const on = e.target.checked;
                    const { faults } = await setFault(sandbox.id, { fault: 'kitchen', on });
                    setView({ ...view, sandbox: { ...sandbox, faults } });
                  })
                }
              />{' '}
              Kitchen refuses deliveries
            </label>
          </p>
          <p>
            <label className="check">
              <input
                type="checkbox"
                checked={sandbox.faults.inbox}
                disabled={busy || isGuest}
                onChange={(e) =>
                  void act(async () => {
                    const on = e.target.checked;
                    const { faults } = await setFault(sandbox.id, { fault: 'inbox', on });
                    setView({ ...view, sandbox: { ...sandbox, faults } });
                  })
                }
              />{' '}
              Inbox refuses deliveries
            </label>
          </p>
          {isGuest && <GuestNote />}

          <DeadLetters sandboxId={sandbox.id} isGuest={isGuest} />
          <ClockControl
            sandboxId={sandbox.id}
            offsetSeconds={sandbox.clock_offset_s}
            isGuest={isGuest}
            onAdvanced={() => void load()}
          />
        </>
      )}

      <h3>Sandbox actions</h3>
      <p className="actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              if (!window.confirm('Wipe this sandbox now? Everything in it is deleted for good.'))
                return;
              await wipeSandbox(sandbox.id);
              setView({ name: 'wiped', session });
            })
          }
        >
          Wipe now
        </button>
        {!isGuest && (
          <button type="button" disabled={busy} onClick={() => void newSandbox(true)}>
            New sandbox
          </button>
        )}
      </p>
      <Message error={error} />
    </section>
  );
}

/** "deleted at 10:00 UTC, in 6 h 12 min", counting down; asks for a reload once it is due. */
function Countdown({ wipeAt, onDue }: { wipeAt: string; onDue: () => void }) {
  const due = new Date(wipeAt).getTime();
  const [now, setNow] = useState(() => Date.now());
  const fired = useRef(false);

  // Real timers are fine in the browser; the no-timers rule is for Durable Objects.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (now >= due && !fired.current) {
      fired.current = true;
      onDue();
    }
  }, [now, due, onDue]);

  return (
    <>
      at {utcClock(wipeAt)},{' '}
      <time dateTime={wipeAt}>{due <= now ? 'now' : `in ${formatCountdown(due - now)}`}</time>
    </>
  );
}
