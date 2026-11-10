import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScheduleResponse } from '../contracts';
import { setCapacity } from '../lib/api';
import {
  KINDS,
  MAX_CAPACITY,
  buildTarget,
  capacityRequest,
  catchUpToMenu,
  changedText,
  describeCapacityError,
  parseCapacity,
  slotTime,
  type TargetKind,
} from '../lib/capacity';
import { dateLabel, horizonDates } from '../lib/schedule';
import { ZONES, clockLabel, mountainLocal } from '../lib/slots';
import { useSchedule } from '../lib/use-schedule';
import { type Message as Text } from '../lib/messages';
import GuestNote from './GuestNote';
import Message from './Message';

const itemWords = (slug: string) => slug.replaceAll('-', ' ');

function slotWords(start: string): string {
  const l = mountainLocal(Date.parse(start));
  return clockLabel(l.hour * 60 + l.minute);
}

/**
 * How full a place is, as a thin bar: a tenth's step of taken over capacity, drawn by one of
 * eleven classes (console.css), since the page policy allows no style attribute. The numbers
 * beside it say the same, so the bar is hidden from assistive technology.
 */
function Fill({ taken, capacity }: { taken: number; capacity: number }) {
  const tenths = capacity <= 0 ? 10 : Math.min(10, Math.round((taken / capacity) * 10));
  return (
    <span className="bar-track" aria-hidden="true">
      <span className={`bar-fill bar-${tenths}`} />
    </span>
  );
}

/** The day's places and caps as the Schedule reports them, as compact tables. */
export function Day({ schedule }: { schedule: ScheduleResponse }) {
  return (
    <>
      <p className="hint">
        {schedule.open
          ? 'The bakery is open.'
          : 'The bakery is closed this day: it refuses every hold.'}{' '}
        Menu version {schedule.menu_version} set the item caps.
      </p>
      <table className="table capacity-table">
        <caption>Pickup slots</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col" className="num">
              Taken
            </th>
            <th scope="col" className="num">
              Free
            </th>
            <th scope="col">
              <span className="sr-only">How full</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {schedule.slots.map((s) => (
            <tr key={s.start}>
              <th scope="row">{slotWords(s.start)}</th>
              <td className="num">
                {s.taken} of {s.capacity}
              </td>
              <td className="num">{s.free}</td>
              <td>
                <Fill taken={s.taken} capacity={s.capacity} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="table capacity-table">
        <caption>Delivery zones</caption>
        <thead>
          <tr>
            <th scope="col">Zone</th>
            <th scope="col" className="num">
              Stops taken
            </th>
            <th scope="col" className="num">
              Free
            </th>
            <th scope="col">
              <span className="sr-only">How full</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {schedule.zones.map((z) => (
            <tr key={z.zone}>
              <th scope="row">
                Zone {z.zone.slice(1)}{' '}
                <span className="hint-inline">{z.windows.length} windows</span>
              </th>
              <td className="num">
                {z.taken} of {z.capacity}
              </td>
              <td className="num">{z.free}</td>
              <td>
                <Fill taken={z.taken} capacity={z.capacity} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {schedule.items.length === 0 ? (
        <p className="hint">No item has a cap or a use this day.</p>
      ) : (
        <table className="table capacity-table">
          <caption>Item caps</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="num">
                Used
              </th>
              <th scope="col" className="num">
                Free
              </th>
              <th scope="col">
                <span className="sr-only">How full</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {schedule.items.map((i) => {
              const cap = i.daily_cap ?? null;
              return (
                <tr key={i.item}>
                  <th scope="row">{itemWords(i.item)}</th>
                  <td className="num">{cap === null ? i.used : `${i.used} of ${cap}`}</td>
                  <td className="num">{cap === null ? 'no cap' : Math.max(0, cap - i.used)}</td>
                  <td>{cap !== null && <Fill taken={i.used} capacity={cap} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="capacity-catering">
        <strong>Catering:</strong> {schedule.catering.taken} of {schedule.catering.capacity} events
        taken, {Math.max(0, schedule.catering.capacity - schedule.catering.taken)} free.
      </p>
    </>
  );
}

/**
 * Staff set one capacity for a bakery day: a pickup slot, a delivery zone, an item's daily cap or
 * the catering events. The form builds the target the API's grammar names (`slot:14:45`, `zone:z1`,
 * `item:croissant`, `catering`); the API checks it. A guest sees the schedule and cannot change it.
 */
export default function CapacityEditor({
  sandboxId,
  isGuest,
  clockOffsetS,
  menuTick = 0,
  menuVersion = 0,
}: {
  sandboxId: string;
  isGuest: boolean;
  clockOffsetS: number;
  /** Rises each time the menu changes on this page; the day is read again on it. */
  menuTick?: number;
  /** The version the menu reached then. */
  menuVersion?: number;
}) {
  // The editor looks at the bakery's days from business today on, like the checkout.
  const dates = useMemo(() => horizonDates(Date.now() + clockOffsetS * 1000), [clockOffsetS]);
  const [date, setDate] = useState('');
  const day = dates.includes(date) ? date : (dates[0] ?? '');
  const live = useSchedule(sandboxId, day);
  const [kind, setKind] = useState<TargetKind>('slot');
  const [value, setValue] = useState('');
  const [capacity, setCapacityText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [said, setSaid] = useState('');
  const schedule = live.schedule;

  // The day's item caps follow the menu, a moment after a publish (the Schedule hears of it by an
  // event), so read the day again until it reports the version that was published.
  const refreshDay = useRef(live.refresh);
  refreshDay.current = live.refresh;
  const wanted = useRef(menuVersion);
  wanted.current = menuVersion;
  useEffect(() => {
    if (menuTick === 0) return;
    let stopped = false;
    void catchUpToMenu(
      async () => (await refreshDay.current())?.menu_version ?? null,
      wanted.current,
      {
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        stopped: () => stopped,
      },
    );
    return () => {
      stopped = true;
    };
  }, [menuTick]);

  const firstSlot = schedule?.slots[0] ? slotTime(schedule.slots[0].start) : '';
  const chosen = kind === 'slot' ? value || firstSlot : kind === 'zone' ? value || 'z1' : value;

  const built = buildTarget(kind, chosen);

  async function submit() {
    setError(null);
    setSaid('');
    if (!built.ok) {
      setError({ title: 'That is not a target', detail: built.reason });
      return;
    }
    const count = parseCapacity(capacity);
    if (count === null) {
      setError({
        title: 'That is not a capacity',
        detail: `Type a whole number from 0 to ${MAX_CAPACITY.toLocaleString('en-US')}.`,
      });
      return;
    }
    setBusy(true);
    try {
      const answer = await setCapacity(sandboxId, day, capacityRequest(built.target, count));
      live.set(answer);
      setSaid(changedText(built.target, count, answer));
    } catch (e) {
      setError(describeCapacityError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3 id="capacity-heading" tabIndex={-1} data-tour="controls-capacity">
        Capacity
      </h3>
      <p className="hint">
        Held and reserved places never pass a capacity; lowering one stops new ones.
      </p>
      {isGuest && <GuestNote />}
      <p>
        <label htmlFor="capacity-day">Day</label>
        <select id="capacity-day" value={day} onChange={(e) => setDate(e.target.value)}>
          {dates.map((d) => (
            <option key={d} value={d}>
              {dateLabel(d)}
            </option>
          ))}
        </select>
      </p>
      {live.error && (
        <Message error={live.error}>
          <button type="button" className="btn btn-secondary" onClick={() => void live.refresh()}>
            Try again
          </button>
        </Message>
      )}
      {schedule === null && !live.error && <p className="hint">Reading the day’s schedule…</p>}
      {schedule !== null && <Day schedule={schedule} />}

      <form
        aria-label="Set a capacity"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p>
          <label htmlFor="capacity-kind">What to change</label>
          <select
            id="capacity-kind"
            value={kind}
            disabled={isGuest}
            onChange={(e) => {
              setKind(e.target.value as TargetKind);
              setValue('');
            }}
          >
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </p>
        {kind === 'slot' && (
          <p>
            <label htmlFor="capacity-slot">Slot</label>
            <select
              id="capacity-slot"
              value={chosen}
              disabled={isGuest || schedule === null}
              onChange={(e) => setValue(e.target.value)}
            >
              {(schedule?.slots ?? []).map((s) => (
                <option key={s.start} value={slotTime(s.start)}>
                  {slotWords(s.start)}
                </option>
              ))}
            </select>
          </p>
        )}
        {kind === 'zone' && (
          <p>
            <label htmlFor="capacity-zone">Zone</label>
            <select
              id="capacity-zone"
              value={chosen}
              disabled={isGuest}
              onChange={(e) => setValue(e.target.value)}
            >
              {ZONES.map((z) => (
                <option key={z} value={z}>
                  Zone {z.slice(1)}
                </option>
              ))}
            </select>
          </p>
        )}
        {kind === 'item' && (
          <p>
            <label htmlFor="capacity-item">Item slug</label>
            <input
              id="capacity-item"
              type="text"
              list="capacity-items"
              value={value}
              disabled={isGuest}
              autoComplete="off"
              onChange={(e) => setValue(e.target.value)}
            />
            <datalist id="capacity-items">
              {(schedule?.items ?? []).map((i) => (
                <option key={i.item} value={i.item} />
              ))}
            </datalist>
            <span className="hint">The item’s slug from the menu, such as croissant.</span>
          </p>
        )}
        <p>
          <label htmlFor="capacity-value">New capacity</label>
          <input
            id="capacity-value"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_CAPACITY}
            value={capacity}
            disabled={isGuest}
            onChange={(e) => setCapacityText(e.target.value)}
          />
          <span className="hint">
            Target sent: <code>{built.ok ? built.target : '…'}</code>
          </span>
        </p>
        <p>
          <button type="submit" className="btn btn-primary" disabled={busy || isGuest}>
            {busy ? 'Saving…' : 'Set capacity'}
          </button>
        </p>
        <Message error={error}>{said && <p className="hint">{said}</p>}</Message>
      </form>
    </>
  );
}
