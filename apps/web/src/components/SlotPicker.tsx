import { blockerText, conflictText, freeText } from '../lib/schedule';
import { momentText } from '../lib/when';
import type { Choice, SlotConflict } from '../lib/schedule';
import type { LiveSchedule } from '../lib/use-schedule';
import { dayParts } from '../lib/when';

/**
 * The days on offer as chips, "Tue" over "10 Nov", one radio each (`name="day"`, the date as its
 * value). `quiet` dates are offered but have nothing for this cart by the page's own rules.
 */
export function DayChips({
  dates,
  day,
  today,
  quiet,
  onDay,
}: {
  dates: string[];
  day: string;
  today: string;
  quiet?: ReadonlySet<string> | undefined;
  onDay: (date: string) => void;
}) {
  return (
    <fieldset className="day-chips">
      <legend>Day</legend>
      <ul className="choices">
        {dates.map((d) => {
          const { weekday, day: date } = dayParts(d);
          return (
            <li key={d}>
              <label className="chip day-chip" data-quiet={quiet?.has(d) ? 'true' : undefined}>
                <input
                  type="radio"
                  name="day"
                  value={d}
                  checked={day === d}
                  onChange={() => onDay(d)}
                />
                <span className="day-weekday">{d === today ? 'Today' : weekday}</span>
                <span className="day-date">
                  {d === today && <span className="sr-only">{weekday} </span>}
                  {date}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/** "10:00 am · 6 left", one line that never wraps inside its chip. */
function SlotChip({
  choice,
  checked,
  onSlot,
}: {
  choice: Choice;
  checked: boolean;
  onSlot: (start: string) => void;
}) {
  const left = choice.blocked === null ? freeText(choice) : blockerText(choice.blocked);
  return (
    <label className="chip slot-chip" data-tone={choice.blocked === null ? undefined : 'blocked'}>
      <input
        type="radio"
        name="slot"
        value={choice.start}
        checked={checked}
        disabled={choice.blocked !== null}
        onChange={() => onSlot(choice.start)}
      />
      <span className="slot-time">{choice.label}</span>
      <span className="slot-sep"> · </span>
      <span className="slot-left">{left}</span>
    </label>
  );
}

/**
 * The checkout's "when" for a live sandbox: the days as chips, then one day's quarter-hour pickup
 * slots or the chosen zone's three windows, each with the places the API says are left. Full
 * slots and the ones the cart's lead time rules out are disabled and say why in words. All of
 * that is a hint; the order is checked again by the API, and a 409 `slot-full` brings the next
 * free place back here.
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
  quiet,
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
  quiet?: ReadonlySet<string> | undefined;
}) {
  const noun = kind === 'pickup' ? 'Pickup time' : 'Delivery window';
  const schedule = live.schedule;
  const open = choices.filter((c) => c.blocked === null).length;

  return (
    <>
      <DayChips dates={dates} day={day} today={today} quiet={quiet} onDay={onDay} />

      <fieldset aria-describedby="slot-status" className="slot-chips">
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
        {/* A day the bakery is shut or the cart cannot have offers nothing to pick: the line above
            says so, and no list of greyed-out times repeats it. */}
        {(schedule === null || (schedule.open && baked)) && (
          <ul className="choices" data-kind={kind}>
            {choices.map((c) => (
              <li key={c.start}>
                <SlotChip choice={c} checked={slot === c.start} onSlot={onSlot} />
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          Bakery time (Mountain). The next {dates.length} days are on offer; open Tuesday to Sunday,
          7:00 am to 3:00 pm.
        </p>
      </fieldset>

      {conflict !== null && (
        <div role="alert" className="problem">
          <p>
            <strong>That time is full.</strong> {conflictText(conflict)}
          </p>
          {conflict.next_free !== null && (
            <p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onTakeNext(conflict.next_free as string)}
              >
                Take {momentText(conflict.next_free)}
              </button>
            </p>
          )}
        </div>
      )}
    </>
  );
}
