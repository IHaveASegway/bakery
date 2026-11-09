import { useEffect, useRef, useState } from 'react';
import type { SandboxResponse } from '../contracts';
import { WORKSPACES, type WorkspaceId } from '../lib/console-sections';
import { formatCountdown, utcClock, utcStamp } from '../lib/countdown';
import type { Message as Text } from '../lib/messages';
import Activity from './Activity';
import ApiToken from './ApiToken';
import Campaigns from './Campaigns';
import CapacityEditor from './CapacityEditor';
import CateringQueue from './CateringQueue';
import ConsoleNav from './ConsoleNav';
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

/** The sandbox's page: the sidebar, then every workspace's panels in the order the sidebar gives. */
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
  // Bumped, with the version it reached, when the menu is published or an item is paused or
  // resumed: the capacity panel reads the day again, since the day's caps follow the menu.
  const [menuChange, setMenuChange] = useState({ tick: 0, version: 0 });
  const live = sandbox.state !== 'seeding';

  const faults = (
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
  );

  return (
    <>
      <ConsoleNav live={live} />

      {live ? (
        <>
          <Group id="kitchen">
            <KitchenBoard
              sandboxId={sandbox.id}
              isGuest={isGuest}
              clockOffsetS={sandbox.clock_offset_s}
              onWiped={onBoardWiped}
              onRefunded={() => setLedgerTick((n) => n + 1)}
            />
          </Group>
          <Group id="money">
            <div className="panel">
              <Ledger sandboxId={sandbox.id} refresh={ledgerTick} />
            </div>
          </Group>
          <Group id="menu">
            <div className="panel two-thirds">
              <MenuEditor
                sandboxId={sandbox.id}
                isGuest={isGuest}
                onPublished={(version) => setMenuChange((c) => ({ tick: c.tick + 1, version }))}
              />
            </div>
            <div className="panel third">
              <CapacityEditor
                sandboxId={sandbox.id}
                isGuest={isGuest}
                clockOffsetS={sandbox.clock_offset_s}
                menuTick={menuChange.tick}
                menuVersion={menuChange.version}
              />
            </div>
          </Group>
          <Group id="catering">
            <div className="panel two-thirds">
              <CateringQueue sandboxId={sandbox.id} isGuest={isGuest} />
            </div>
            <div className="panel third">
              <LeadPipeline sandboxId={sandbox.id} refresh={crmTick} />
            </div>
          </Group>
          <Group id="customers">
            <div className="panel two-thirds">
              <Customers
                sandboxId={sandbox.id}
                isGuest={isGuest}
                personaId={sandbox.persona}
                refresh={crmTick}
                onConsent={() => setCrmTick((n) => n + 1)}
              />
            </div>
            <div className="panel third">
              <Segments sandboxId={sandbox.id} refresh={crmTick} />
            </div>
            <div className="panel two-thirds">
              <Campaigns
                sandboxId={sandbox.id}
                isGuest={isGuest}
                clockOffsetS={sandbox.clock_offset_s}
              />
            </div>
            <div className="panel third">
              <Activity sandboxId={sandbox.id} refresh={crmTick} />
            </div>
            <div className="panel half">
              <Rebuild
                sandboxId={sandbox.id}
                isGuest={isGuest}
                onFinished={() => setCrmTick((n) => n + 1)}
              />
            </div>
            <div className="panel half panel-link">
              <p>Every message the bakery sends lands in the inbox, not in an email.</p>
              <a className="btn btn-secondary" href="/inbox/">
                Open the inbox
              </a>
            </div>
          </Group>
          <Group id="dispatch">
            <div className="panel panel-link">
              <p>Plan a day’s deliveries, with the server’s plan and VROOM’s side by side.</p>
              <a className="btn btn-secondary" href="/app/dispatch/">
                Open dispatch
              </a>
            </div>
          </Group>
        </>
      ) : (
        <p aria-live="polite" className="empty">
          <strong>Seeding your bakery.</strong> The menu, the kitchen and the day’s open orders are
          being made. This page updates by itself.
        </p>
      )}

      <Group id="system">
        <div className="panel third">
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
            {faults}
            <div className="panel half">
              <DeadLetters sandboxId={sandbox.id} isGuest={isGuest} />
            </div>
          </>
        )}
        <div className="panel half">
          <h3 id="actions-heading" tabIndex={-1}>
            Sandbox actions
          </h3>
          <p className="actions" data-tour="controls-actions">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={onWipe}>
              Wipe now
            </button>
            {!isGuest && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={onReplace}
              >
                New sandbox
              </button>
            )}
          </p>
          <Message error={error} />
        </div>
      </Group>
    </>
  );
}

/** One workspace's group: its name, sticky while its panels scroll, then the panels on the grid. */
function Group({ id, children }: { id: WorkspaceId; children: React.ReactNode }) {
  const label = WORKSPACES.find((w) => w.id === id)?.label ?? id;
  return (
    <div className="workspace-group">
      <h2 id={`ws-${id}`} className="group-head">
        {label}
      </h2>
      <div className="panel-grid">{children}</div>
    </div>
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
