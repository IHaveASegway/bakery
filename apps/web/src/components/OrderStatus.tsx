import { useEffect, useState } from 'react';
import { clockOfText, shortWhen, whenText, windowText } from '../lib/when';
import {
  STAGE_LABEL,
  STAGE_TONE,
  holdText,
  movedText,
  offTrack,
  stagesFor,
  stepsTaken,
  type Track,
} from '../lib/order-track';
import { isPaid } from '../lib/payment';
import { useLiveMenu } from '../lib/use-live-menu';
import { useOrderWatch, type Watch } from '../lib/use-order-watch';
import { useSandboxPhase } from '../lib/use-session';
import Receipt from './Receipt';

const shortId = (id: string) => id.slice(-6);

/** "Pickup Tue 10 Nov, 2:30 pm" or "Delivery Tue 10 Nov, 9:00 am to 11:00 am". */
function whenLine(track: Track): string {
  const { kind, slot } = track.order;
  if (kind === 'pickup') return `Pickup ${shortWhen(slot)}`;
  return `Delivery ${shortWhen(slot).split(', ')[0]}, ${windowText(slot)}`;
}

/** One sentence on where the page's news comes from. */
function sourceText(watch: Watch): string {
  switch (watch.source) {
    case 'connecting':
      return 'Connecting to the kitchen…';
    case 'live':
      return 'Live: this page moves when the kitchen moves your order.';
    case 'polling':
      return watch.noSocket === 'unavailable'
        ? 'The kitchen’s live feed is not reachable, so this page checks every 10 seconds.'
        : 'The kitchen’s screens are using every live place, so this page checks every 10 seconds.';
    case 'paused':
      return 'Paused while this tab is hidden.';
    case 'done':
      return 'Nothing more will change, so this page stopped listening.';
  }
}

/** Where this tab keeps the times it saw for an order's steps, so a reload still shows them. */
const timesKey = (id: string) => `bakery.order-times.v1.${id}`;

/** The times this tab saw for an order's steps; empty when storage is missing or blocked. */
export function keptTimes(id: string, store: Pick<Storage, 'getItem'> | null): Track['times'] {
  try {
    const raw = store?.getItem(timesKey(id));
    const read: unknown = raw ? JSON.parse(raw) : null;
    if (read === null || typeof read !== 'object') return {};
    return Object.fromEntries(
      Object.entries(read).filter(([, at]) => typeof at === 'string' && at !== ''),
    ) as Track['times'];
  } catch {
    return {};
  }
}

function keepTimes(id: string, times: Track['times']): void {
  try {
    window.sessionStorage.setItem(timesKey(id), JSON.stringify(times));
  } catch {
    // A per-tab convenience only: without it a reload shows the steps without their times.
  }
}

/**
 * The steps the order has taken and has left, each done one with its time when this tab saw it.
 * A step done before the tab watched has no time to show: its tick says it is done, and no word
 * pretends to be a time.
 */
function Tracker({ track }: { track: Track }) {
  const stages = stagesFor(track.order.kind);
  const taken = stepsTaken(track.status, track.order.kind);
  return (
    <ol className="tracker" aria-label="Your order’s steps" data-tour="order-tracker">
      {stages.map((stage, i) => {
        const state = i < taken - 1 ? 'done' : i === taken - 1 ? 'current' : 'todo';
        const at = track.times[stage];
        return (
          <li
            key={stage}
            className="tracker-step"
            data-state={state}
            data-tone={STAGE_TONE[stage]}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="tracker-dot" aria-hidden="true">
              {state !== 'todo' && (
                <svg viewBox="0 0 16 16" focusable="false">
                  <path d="M3.5 8.5l3 3 6-7" />
                </svg>
              )}
            </span>
            <span className="tracker-label">{STAGE_LABEL[stage]}</span>
            <span className="tracker-time">
              {state === 'todo' ? (
                <span className="sr-only">to come</span>
              ) : at ? (
                <time dateTime={at} title={whenText(at)}>
                  {clockOfText(at)}
                </time>
              ) : (
                <span className="sr-only">done</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The plain words and the one action for an order that left the track. */
function OffTrackNote({ track }: { track: Track }) {
  const status = offTrack(track.status);
  if (status === null) return null;
  const [title, text] =
    status === 'expired'
      ? [
          'Expired',
          'It was not paid within 15 minutes of bakery time, so its places were released.',
        ]
      : status === 'cancelled'
        ? ['Cancelled', 'The order will not be made. Any payment it had was refunded.']
        : [
            'Being refunded',
            'The order was cancelled and its refund is on its way through Stripe’s sandbox.',
          ];
  return (
    <div className="order-off">
      <span className="badge" data-tone="problem">
        {title}
      </span>
      <p>{text}</p>
      <p>
        <a className="btn btn-primary" href="/menu/">
          Order again
        </a>
      </p>
    </div>
  );
}

/** The /order/ island: one order of this session's sandbox, followed live. */
export default function OrderStatus() {
  const phase = useSandboxPhase();
  const menu = useLiveMenu(phase);
  const [id, setId] = useState<string | null>(null);
  const offsetS = phase.name === 'live' ? phase.clockOffsetS : 0;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setId(new URLSearchParams(window.location.search).get('id')?.trim() ?? '');
  }, []);

  const watch = useOrderWatch(phase.name === 'live' ? phase.id : null, id ?? '');
  // The times this tab saw survive a reload: the order's answer carries only when it was placed.
  const [kept, setKept] = useState<Track['times']>({});
  useEffect(() => {
    if (!id) return;
    let store: Storage | null = null;
    try {
      store = window.sessionStorage;
    } catch {
      // Blocked storage: no kept times.
    }
    setKept(keptTimes(id, store));
  }, [id]);
  const seenTimes = watch.track?.times;
  useEffect(() => {
    if (!id || seenTimes === undefined) return;
    const merged = { ...kept, ...seenTimes };
    if (JSON.stringify(merged) === JSON.stringify(kept)) return;
    setKept(merged);
    keepTimes(id, merged);
  }, [id, seenTimes]);
  const track =
    watch.track === null ? null : { ...watch.track, times: { ...kept, ...watch.track.times } };
  const placed = track?.status === 'placed';

  // The hold's time left, while there is one to count.
  useEffect(() => {
    if (!placed) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [placed]);

  const looking =
    id === null ||
    phase.name === 'loading' ||
    phase.name === 'seeding' ||
    watch.phase === 'loading';
  const missing =
    id === '' ||
    phase.name === 'nosession' ||
    phase.name === 'nosandbox' ||
    watch.phase === 'missing';

  if (missing) {
    return (
      <div className="empty order-missing">
        <h2>We cannot find that order</h2>
        <p>
          An order lives in the sandbox of the browser that placed it, and goes when that sandbox is
          wiped.
        </p>
        <p>
          <a className="btn btn-primary" href="/menu/">
            Back to the menu
          </a>
        </p>
      </div>
    );
  }
  if (phase.name === 'offline' || watch.phase === 'offline') {
    return (
      <div className="empty" role="status">
        <p>The API is unreachable, so this order cannot be read right now. Try again shortly.</p>
      </div>
    );
  }
  if (looking || track === null) {
    return (
      <div className="order-layout" aria-busy="true">
        <p className="hint" role="status">
          Reading your order…
        </p>
        <span className="skeleton order-skeleton" />
      </div>
    );
  }

  const order = track.order;
  const stage = stagesFor(order.kind)[stepsTaken(track.status, order.kind) - 1];
  const off = offTrack(track.status) !== null;
  const tone = off ? 'problem' : stage ? STAGE_TONE[stage] : 'done';
  const badge = off
    ? track.status === 'refund_pending'
      ? 'Being refunded'
      : track.status === 'expired'
        ? 'Expired'
        : 'Cancelled'
    : placed
      ? 'Waiting for payment'
      : track.status === 'closed'
        ? 'Done'
        : stage
          ? STAGE_LABEL[stage]
          : track.status;

  return (
    <div className="order-layout">
      <section className="panel order-track" aria-labelledby="track-heading">
        <div className="panel-head">
          <h2 id="track-heading">
            Order <code title={order.id}>{shortId(order.id)}</code>
          </h2>
          <span className="badge" data-tone={tone}>
            {badge}
          </span>
        </div>
        <p className="order-when">
          <time dateTime={order.slot} title={whenText(order.slot)}>
            {whenLine(track)}
          </time>
        </p>

        {off ? <OffTrackNote track={track} /> : <Tracker track={track} />}

        {placed && (
          <div className="order-pay" data-tour="order-pay">
            <p>
              <strong>Not paid yet.</strong> {holdText(order.held_until, now + offsetS * 1000)}
            </p>
            <a
              className="btn btn-primary"
              href={`/checkout/?order=${encodeURIComponent(order.id)}`}
            >
              Pay for this order
            </a>
          </div>
        )}

        <p className="order-source" data-source={watch.source}>
          <span className="live-dot" aria-hidden="true" />
          {sourceText(watch)}
        </p>
        {track.heard !== null && (
          <p className="hint order-heard">
            Last heard: <code>{track.heard.type}</code>
            {track.heard.at !== '' && <> at {clockOfText(track.heard.at)}</>}, from the kitchen’s
            socket.
          </p>
        )}

        <p className="actions order-links">
          <a className={placed || off ? 'btn btn-secondary' : 'btn btn-primary'} href="/app/">
            Play the kitchen
          </a>
          <a className="btn btn-secondary" href="/inbox/">
            Read your receipt in the inbox
          </a>
        </p>
        {!placed && !off && track.status !== 'closed' && (
          <p className="hint order-play">
            On the kitchen board you can move this order on yourself, and this page shows each step.
          </p>
        )}
        <p className="sr-only" aria-live="polite">
          {movedText(track.status, order.kind)}
        </p>
      </section>

      <Receipt order={order} menu={menu} paid={isPaid(track.status)} />
    </div>
  );
}
