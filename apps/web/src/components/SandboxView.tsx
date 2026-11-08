import { useEffect, useRef, useState } from 'react';
import type { SandboxResponse } from '../contracts';
import { CONSOLE_SECTIONS } from '../lib/console-sections';
import { formatCountdown, utcClock, utcStamp } from '../lib/countdown';
import type { Message as Text } from '../lib/messages';
import Activity from './Activity';
import ApiToken from './ApiToken';
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

interface Props {
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

/** The sandbox's page: an "On this page" list, then every section in the order the list gives. */
export default function SandboxView({
  sandbox,
  isGuest,
  busy,
  error,
  onReload,
  onBoardWiped,
  onFault,
  onWipe,
  onReplace,
}: Props) {
  const [ledgerTick, setLedgerTick] = useState(0);
  // Bumped when something the CRM screens derive from changes: a consent flag, a finished rebuild.
  const [crmTick, setCrmTick] = useState(0);
  const live = sandbox.state !== 'seeding';

  return (
    <>
      <nav aria-label="On this page" className="page-nav">
        <ul>
          {CONSOLE_SECTIONS.filter((section) => live || !section.live).map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.label}</a>
            </li>
          ))}
        </ul>
      </nav>
      <h3 id="sandbox-heading" tabIndex={-1}>
        Your sandbox
      </h3>
      <dl data-tour="console-sandbox">
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
          <Countdown wipeAt={sandbox.wipe_at} onDue={onReload} />
        </dd>
      </dl>

      {!live ? (
        <p aria-live="polite">
          <strong>Seeding your bakery.</strong> The menu, the kitchen and the day’s open orders are
          being made. This page updates by itself.
        </p>
      ) : (
        <>
          <ApiToken sandboxId={sandbox.id} isGuest={isGuest} />
          <KitchenBoard
            sandboxId={sandbox.id}
            isGuest={isGuest}
            clockOffsetS={sandbox.clock_offset_s}
            onWiped={onBoardWiped}
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

          <DeadLetters sandboxId={sandbox.id} isGuest={isGuest} />
          <ClockControl
            sandboxId={sandbox.id}
            offsetSeconds={sandbox.clock_offset_s}
            isGuest={isGuest}
            onAdvanced={onReload}
          />
        </>
      )}

      <h3 id="actions-heading" tabIndex={-1}>
        Sandbox actions
      </h3>
      <p className="actions" data-tour="controls-actions">
        <button type="button" disabled={busy} onClick={onWipe}>
          Wipe now
        </button>
        {!isGuest && (
          <button type="button" disabled={busy} onClick={onReplace}>
            New sandbox
          </button>
        )}
      </p>
      <Message error={error} />
    </>
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
