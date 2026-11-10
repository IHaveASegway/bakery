import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SandboxResponse, SessionResponse, TrafficResponse } from '../contracts';
import { getTraffic, startTraffic, stopTraffic } from '../lib/api';
import { businessNowMs } from '../lib/clock';
import type { WorkspaceId } from '../lib/console-sections';
import { roughCountdown } from '../lib/countdown';
import { clockOfText, shortDate, utcMomentText, whenText } from '../lib/when';
import ClockControl from './ClockControl';
import SandboxActions from './SandboxActions';

/** The same, short, for a top bar that has run out of room (console.css): the long one is still read out. */
const SHORT: Record<SessionResponse['kind'], string> = {
  guest: 'Guest',
  google: 'Google',
  github: 'GitHub',
  demo: 'Demo account',
};

const KINDS: Record<SessionResponse['kind'], string> = {
  guest: 'Guest',
  google: 'Signed in with Google',
  github: 'Signed in with GitHub',
  demo: 'Signed in with a demo account',
};

/**
 * The way out, by who is here. A signed-in session signs out and can sign back in to the same
 * sandbox. A guest's sign-out only clears the cookie: no account holds the sandbox, so nothing can
 * reach it again, and the word is "Leave".
 */
export const leaveLabel = (kind: SessionResponse['kind']) =>
  kind === 'guest' ? 'Leave' : 'Sign out';

/** The rate the top bar's switch starts simulated traffic at; the System page offers the others. */
const TRAFFIC_RATE = 3;

/** Where the shell's top bar keeps a place for these controls (layouts/Base.astro). */
const SLOT = 'topbar-live';

/**
 * What is true on every console page, in the shell's top bar (design brief, 2026-11-09): who is
 * signed in, the sandbox and when it is wiped, the business clock and its steps, simulated
 * traffic on or off, and the way out. Drawn into the bar once the page has mounted; the bar's
 * static parts (the name, the link to the shop) need no script.
 */
export default function ConsoleTopBar(props: {
  kind: SessionResponse['kind'];
  sandbox: SandboxResponse | null;
  isGuest: boolean;
  busy: boolean;
  here: WorkspaceId;
  onLeave: () => void;
  onWipe: () => void;
  onReplace: () => void;
  onAdvanced: () => void;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById(SLOT)), []);
  if (slot === null) return null;
  return createPortal(<Controls {...props} />, slot);
}

function Controls({
  kind,
  sandbox,
  isGuest,
  busy,
  onLeave,
  onWipe,
  onReplace,
  onAdvanced,
}: Parameters<typeof ConsoleTopBar>[0]) {
  const [wall, setWall] = useState(() => Date.now());
  // Real timers are fine in the browser; the no-timers rule is for Durable Objects.
  useEffect(() => {
    const timer = setInterval(() => setWall(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const live = sandbox !== null && sandbox.state !== 'seeding';

  const business = new Date(businessNowMs(wall, sandbox?.clock_offset_s ?? 0)).toISOString();
  const [weekday, ...date] = shortDate(business).split(' ');
  return (
    <>
      <div className="topbar-status">
        {sandbox !== null && (
          <Popover
            id="topbar-sandbox"
            buttonClass="btn btn-secondary btn-sm topbar-chip"
            caret
            label={
              <>
                <span className="long-only">Sandbox </span>
                <code>{sandbox.id.slice(-6)}</code>
                <span className="topbar-muted">
                  {' '}
                  · <span className="long-only">wiped in </span>
                  {roughCountdown(new Date(sandbox.wipe_at).getTime() - wall)}
                </span>
              </>
            }
            panelLabel="Your sandbox"
          >
            <dl className="topbar-facts">
              <dt>Sandbox</dt>
              <dd>
                <code>{sandbox.id}</code>
              </dd>
              <dt>Born</dt>
              <dd>{utcMomentText(sandbox.born)}</dd>
              <dt>Wiped</dt>
              <dd>at {utcMomentText(sandbox.wipe_at)}</dd>
            </dl>
            <SandboxActions
              sandboxId={sandbox.id}
              isGuest={isGuest}
              busy={busy}
              small
              onWipe={onWipe}
              onReplace={onReplace}
            />
          </Popover>
        )}
        {live && (
          <Popover
            id="topbar-clock"
            buttonClass="btn btn-secondary btn-sm topbar-chip"
            caret
            title={whenText(business)}
            label={
              <>
                <span className="sr-only">Business clock: </span>
                {weekday}
                <span className="long-only"> {date.join(' ')},</span> {clockOfText(business)}
              </>
            }
            panelLabel="Business clock"
          >
            <ClockControl
              variant="popover"
              sandboxId={sandbox.id}
              offsetSeconds={sandbox.clock_offset_s}
              isGuest={isGuest}
              onAdvanced={onAdvanced}
            />
          </Popover>
        )}
        {live && <TrafficSwitch sandboxId={sandbox.id} isGuest={isGuest} />}
      </div>
      <div className="topbar-account">
        <h2 className="topbar-who">
          <span className="who-long">{KINDS[kind]}</span>
          <span className="who-short" aria-hidden="true">
            {SHORT[kind]}
          </span>
        </h2>
        {isGuest ? (
          // A guest confirms in the bar, as the sandbox's own popover holds Wipe now: two true
          // sentences, then Leave or Stay. The route lets a guest wipe its own sandbox.
          <Popover
            id="topbar-leave"
            buttonClass="btn btn-secondary btn-sm"
            label={leaveLabel(kind)}
            panelLabel="Leave this sandbox"
          >
            {(close) => (
              <>
                <p>You cannot come back to this sandbox once you leave.</p>
                <p>
                  It is wiped at 10:00 UTC, or at once with Wipe now, under the{' '}
                  {sandbox === null ? (
                    'sandbox’s'
                  ) : (
                    <code className="topbar-name">{sandbox.id.slice(-6)}</code>
                  )}{' '}
                  button in this bar.
                </p>
                <p className="actions">
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={onLeave}
                  >
                    Leave
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={close}>
                    Stay
                  </button>
                </p>
              </>
            )}
          </Popover>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={onLeave}
          >
            {leaveLabel(kind)}
          </button>
        )}
      </div>
    </>
  );
}

/** Simulated traffic, on or off, at one rate; the System page has the rates and the minutes. */
function TrafficSwitch({ sandboxId, isGuest }: { sandboxId: string; isGuest: boolean }) {
  const [info, setInfo] = useState<TrafficResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setInfo(await getTraffic(sandboxId));
    } catch {
      // A guest or a hiccup: the switch stays as it was.
    }
  }, [sandboxId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const on = info?.running ?? false;
  return (
    <button
      type="button"
      className="btn btn-quiet btn-sm topbar-chip traffic-switch"
      aria-pressed={on}
      disabled={isGuest || info === null}
      aria-disabled={busy || undefined}
      title={
        on
          ? `Simulated traffic: ${info?.rate ?? TRAFFIC_RATE} orders a minute`
          : `Start simulated traffic at ${TRAFFIC_RATE} orders a minute`
      }
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void (on ? stopTraffic(sandboxId) : startTraffic(sandboxId, TRAFFIC_RATE))
          .then(refresh, () => undefined)
          .finally(() => setBusy(false));
      }}
    >
      Traffic {on ? 'on' : 'off'}
    </button>
  );
}

/** A button that opens a small panel under it; Escape or a click outside closes it. */
function Popover({
  id,
  label,
  ariaLabel,
  title,
  buttonClass,
  panelLabel,
  caret = false,
  children,
}: {
  id: string;
  label: ReactNode;
  ariaLabel?: string;
  title?: string;
  buttonClass: string;
  panelLabel: string;
  /** A small chevron after the label, so a chip that opens a panel reads as a button. */
  caret?: boolean;
  /** The panel's content, or a function of how to close it (for a panel with its own Cancel). */
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="popover" ref={root}>
      <button
        ref={button}
        type="button"
        className={buttonClass}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {/* One span, so the button's flex gap does not space the label's words apart. */}
        <span>{label}</span>
        {caret && (
          <svg className="chip-caret" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        )}
      </button>
      {open && (
        <div id={id} className="menu-panel popover-panel" role="group" aria-label={panelLabel}>
          {typeof children === 'function'
            ? children(() => {
                setOpen(false);
                button.current?.focus();
              })
            : children}
        </div>
      )}
    </div>
  );
}
