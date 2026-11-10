import { useEffect, useRef, useState } from 'react';
import { formatCountdown } from '../../lib/countdown';
import ApiToken from '../ApiToken';
import ClockControl from '../ClockControl';
import { businessNowMs, utcMomentText, whenText } from '../../lib/when';
import Console, { type WorkspaceProps } from '../Console';
import DeadLetters from '../DeadLetters';
import GuestNote from '../GuestNote';
import Message from '../Message';
import SandboxActions from '../SandboxActions';
import Traffic from '../Traffic';

/**
 * /app/system/: the sandbox itself, the API token, the clock, simulated traffic, the faults, the
 * dead letters, and Wipe now. While the sandbox seeds, only the sandbox and its actions exist.
 */
export function SystemView({
  sandbox,
  isGuest,
  busy,
  error,
  onReload,
  onFault,
  onWipe,
  onReplace,
}: WorkspaceProps) {
  const live = sandbox.state !== 'seeding';
  // Business now, so a date says its year only when it is not the bakery's this year.
  const now = businessNowMs(sandbox.clock_offset_s);
  return (
    <div className="workspace panel-grid">
      <div className="panel third">
        <h3 id="sandbox-heading" tabIndex={-1}>
          Your sandbox
        </h3>
        <dl data-tour="console-sandbox">
          <dt>Sandbox</dt>
          {/* The id on a line of its own, whole: 26 characters do not fit beside the label in a third
              of the window, and an id cut mid-string reads as two. */}
          <dd className="sandbox-id">
            <code>{sandbox.id}</code>
          </dd>
          <dt>Seed</dt>
          <dd>
            <code>{String(sandbox.seed)}</code>
          </dd>
          <dt>Born</dt>
          <dd>
            <time dateTime={sandbox.born} title={whenText(sandbox.born)}>
              {utcMomentText(sandbox.born, { now })}
            </time>
          </dd>
          <dt>Deleted</dt>
          <dd>
            <Countdown wipeAt={sandbox.wipe_at} onDue={onReload} now={now} />
          </dd>
        </dl>
        {!live && (
          <p aria-live="polite" className="hint">
            <strong>Seeding your bakery.</strong> This page updates by itself.
          </p>
        )}
      </div>
      {live && (
        <>
          <div className="panel third">
            <ApiToken sandboxId={sandbox.id} isGuest={isGuest} />
          </div>
          <div className="panel third">
            <ClockControl
              sandboxId={sandbox.id}
              offsetSeconds={sandbox.clock_offset_s}
              isGuest={isGuest}
              onAdvanced={onReload}
            />
          </div>
          <div className="panel half">
            <Traffic sandboxId={sandbox.id} isGuest={isGuest} />
          </div>
          <div className="panel half">
            <h3 id="faults-heading" tabIndex={-1} data-tour="controls-faults">
              Faults
            </h3>
            <p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={sandbox.faults.kitchen}
                  disabled={busy || isGuest}
                  onChange={(e) => onFault('kitchen', e.target.checked)}
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
                  onChange={(e) => onFault('inbox', e.target.checked)}
                />{' '}
                Inbox refuses deliveries
              </label>
            </p>
            {isGuest && <GuestNote />}
          </div>
          <div className="panel half">
            <DeadLetters sandboxId={sandbox.id} isGuest={isGuest} now={now} />
          </div>
        </>
      )}
      <div className="panel half">
        <h3 id="actions-heading" tabIndex={-1}>
          Sandbox actions
        </h3>
        <div data-tour="controls-actions">
          <SandboxActions
            sandboxId={sandbox.id}
            isGuest={isGuest}
            busy={busy}
            onWipe={onWipe}
            onReplace={onReplace}
          />
        </div>
        <Message error={error} />
      </div>
    </div>
  );
}

/**
 * "at Wed 11 Nov, 10:00 am UTC, in 6 h 12 min", counting down; asks for a reload once it is due.
 * The wipe is set on the wall clock in UTC, so it says UTC (F18, 2026-11-10).
 */
function Countdown({
  wipeAt,
  onDue,
  now: business,
}: {
  wipeAt: string;
  onDue: () => void;
  now: number;
}) {
  const due = new Date(wipeAt).getTime();
  // "Wed 11 Nov, " may wrap; "10:00 am UTC" stays together.
  const text = utcMomentText(wipeAt, { now: business });
  const cut = text.lastIndexOf(', ');
  const day = cut < 0 ? '' : `${text.slice(0, cut + 1)} `;
  const clock = cut < 0 ? text : text.slice(cut + 2);
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
      at {day}
      <span className="whitespace-nowrap">{clock}</span>,{' '}
      <time dateTime={wipeAt}>{due <= now ? 'now' : `in ${formatCountdown(due - now)}`}</time>
    </>
  );
}

export default function SystemWorkspace() {
  return <Console workspace="system" View={SystemView} />;
}
