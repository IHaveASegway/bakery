import { blockerText, conflictText, dateLabel, freeText, startText } from '../lib/schedule';
import type { Choice, SlotConflict } from '../lib/schedule';
import type { LiveSchedule } from '../lib/use-schedule';

/**
 * The checkout's slot picker for a live sandbox: one day's quarter-hour pickup slots or the chosen
 * zone's three windows, each with the free count the API gave it. Full slots and the ones the
 * cart's lead time rules out are disabled and say why in words. All of that is a hint; the order
 * is checked again by the API, and a 409 `slot-full` brings the next free place back here.
 */
export default function SlotPicker({
  kind,
  today,
  dates,
  day,
  onDay,
  live,
  choices,
  slot,
  onSlot,
  conflict,
  onTakeNext,
  baked,
  leadHours,
}: {
  kind: 'pickup' | 'delivery';
  today: string;
  dates: string[];
  day: string;
  onDay: (date: string) => void;
  live: LiveSchedule;
  choices: Choice[];
  slot: string;
  onSlot: (start: string) => void;
  conflict: SlotConflict | null;
  onTakeNext: (start: string) => void;
  baked: boolean;
  leadHours: number;
}) {
  const noun = kind === 'pickup' ? 'Pickup time' : 'Delivery window';
  const schedule = live.schedule;
  const open = choices.filter((c) => c.blocked === null).length;

  return (
    <>
      <p>
        <label htmlFor="day">Day</label>
        <select id="day" value={day} onChange={(e) => onDay(e.target.value)}>
          {dates.map((d) => (
            <option key={d} value={d}>
              {dateLabel(d)}
              {d === today ? ' (today)' : ''}
            </option>
          ))}
        </select>
        <span className="hint">
          Bakery time (Mountain). The next {dates.length} days are on offer; open Tuesday to Sunday,
          7:00 am to 3:00 pm.
        </span>
      </p>

      <fieldset aria-describedby="slot-status">
        <legend>{noun}</legend>
        <p id="slot-status" aria-live="polite" className="hint">
          {live.error
            ? `The schedule could not be read. ${live.error.title}.`
            : schedule === null
              ? 'Reading the day’s schedule…'
              : !schedule.open
                ? 'The bakery is closed that day. Choose another day.'
                : !baked
                  ? 'Something in your cart is not baked that day. Choose another day.'
                  : `${open} of ${choices.length} ${kind === 'pickup' ? 'slots' : 'windows'} open.` +
                    (leadHours > 0
                      ? ` Your cart needs ${leadHours} ${leadHours === 1 ? 'hour' : 'hours'}’ notice at least.`
                      : '')}
        </p>
        <ul className="choices">
          {choices.map((c) => (
            <li key={c.start}>
              <label className="check">
                <input
                  type="radio"
                  name="slot"
                  value={c.start}
                  checked={slot === c.start}
                  disabled={c.blocked !== null}
                  onChange={() => onSlot(c.start)}
                />{' '}
                {c.label},{' '}
                {c.blocked === null || c.blocked === 'lead' ? freeText(c) : blockerText(c.blocked)}
                {c.blocked === 'lead' && ' (too soon)'}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      {conflict !== null && (
        <div role="alert" className="problem">
          <p>
            <strong>That time is full.</strong> {conflictText(conflict)}
          </p>
          {conflict.next_free !== null && (
            <p>
              <button type="button" onClick={() => onTakeNext(conflict.next_free as string)}>
                Take {startText(conflict.next_free)}
              </button>
            </p>
          )}
        </div>
      )}
    </>
  );
}
