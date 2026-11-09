import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrderRequest, OrderResponse } from '../contracts';
import { ApiError, placeOrder } from '../lib/api';
import { attemptFor, keepKeyAfter, type Attempt } from '../lib/attempt';
import {
  EMPTY_CART,
  NOTE_MAX,
  dayAccepts,
  deliveryBlocker,
  leadMinutesFor,
  noteLength,
  totals,
} from '../lib/cart';
import { type Message as Text } from '../lib/messages';
import { taxBpOf } from '../lib/menu';
import { dollars, taxPercent } from '../lib/money';
import { describeOrderError } from '../lib/order-errors';
import {
  HORIZON_DAYS,
  horizonDates,
  dateOfStart,
  pickable,
  pickupChoices,
  slotConflict,
  windowChoices,
  type SlotConflict,
} from '../lib/schedule';
import {
  ZONES,
  byDate,
  deliveryWindows,
  mountainLocal,
  mountainToMs,
  pickupSlots,
  type Zone,
} from '../lib/slots';
import { useCart } from '../lib/use-cart';
import { useSchedule } from '../lib/use-schedule';
import { useLiveMenu } from '../lib/use-live-menu';
import { useSandboxPhase } from '../lib/use-session';
import CartLines from './CartLines';
import HowThisWorks from './HowThisWorks';
import Message from './Message';
import PaymentStep from './PaymentStep';
import SlotPicker from './SlotPicker';
import StatusLine from './StatusLine';

/** The /checkout/ island: the cart, how to receive it, a note, and the order's result. */
export default function Checkout() {
  const phase = useSandboxPhase();
  const menu = useLiveMenu(phase);
  const { cart, ready, update } = useCart();
  const [now, setNow] = useState<number | null>(null);
  const [day, setDay] = useState('');
  // The day the visitor picked in the slot picker; until then, the cart's slot's day, else today.
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [conflict, setConflict] = useState<SlotConflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [retry, setRetry] = useState(false);
  const [result, setResult] = useState<{ order: OrderResponse; sandboxId: string } | null>(null);
  const attempt = useRef<Attempt | null>(null);

  const live = phase.name === 'live';
  const sandboxId = phase.name === 'live' ? phase.id : null;
  const offsetS = phase.name === 'live' ? phase.clockOffsetS : 0;

  // The slot lists are computed from business time (wall time plus the sandbox's clock offset),
  // so refresh it while the page is open.
  useEffect(() => {
    setNow(Date.now() + offsetS * 1000);
    const timer = setInterval(() => setNow(Date.now() + offsetS * 1000), 30_000);
    return () => clearInterval(timer);
  }, [offsetS]);

  // The rate is the published menu's, so the preview matches what the Order will charge.
  const taxBp = taxBpOf(menu.menu);
  const sum = totals(cart.lines, menu.menu, taxBp);
  const noteChars = noteLength(cart.note);
  const lead = leadMinutesFor(cart.lines, menu.menu);
  const slots = useMemo(() => {
    if (now === null) return [];
    const rules = { leadMinutes: lead, accept: dayAccepts(menu.menu, cart.lines) };
    return cart.kind === 'pickup' ? pickupSlots(now, rules) : deliveryWindows(now, rules);
  }, [now, lead, menu.menu, cart.lines, cart.kind]);
  const groups = byDate(slots);
  const chosen = slots.find((s) => s.value === cart.slot) ?? null;
  const shownDay =
    chosen?.date ?? (groups.some((g) => g.date === day) ? day : (groups[0]?.date ?? ''));
  const timesOfDay = groups.find((g) => g.date === shownDay)?.slots ?? [];
  const blocker = cart.kind === 'delivery' ? deliveryBlocker(cart.lines, menu.menu) : null;

  // A live sandbox reads the day's schedule from the API; the lists above serve the page before
  // there is a sandbox to read from.
  const dates = useMemo(() => (now === null ? [] : horizonDates(now, HORIZON_DAYS)), [now]);
  const today = dates[0] ?? '';
  const cartDay = cart.slot === '' ? '' : dateOfStart(cart.slot);
  const wanted = pickedDay ?? (cartDay === '' ? today : cartDay);
  const liveDay = dates.includes(wanted) ? wanted : today;
  const schedule = useSchedule(live ? sandboxId : null, live ? liveDay : '');
  const baked = useMemo(
    () =>
      liveDay === '' ||
      dayAccepts(menu.menu, cart.lines)(mountainLocal(mountainToMs(liveDay, 12 * 60))),
    [menu.menu, cart.lines, liveDay],
  );
  const choices = useMemo(() => {
    if (schedule.schedule === null || now === null) return [];
    const ctx = { nowMs: now, leadMinutes: lead, baked };
    return cart.kind === 'pickup'
      ? pickupChoices(schedule.schedule, ctx)
      : windowChoices(schedule.schedule, cart.zone, ctx);
  }, [schedule.schedule, now, lead, baked, cart.kind, cart.zone]);
  const chosenLive = choices.find((c) => c.start === cart.slot && pickable(c)) ?? null;
  const chosenStart = live ? (chosenLive?.start ?? null) : (chosen?.value ?? null);

  const reasons: string[] = [];
  if (cart.lines.length === 0) reasons.push('Add something to the cart.');
  if (sum.missing.length > 0) reasons.push('Take out what is no longer on the menu.');
  if (blocker) reasons.push(blocker);
  if (!live && slots.length === 0 && now !== null && cart.lines.length > 0) {
    reasons.push('No time in the next 7 days suits everything in the cart. Take something out.');
  } else if (live && schedule.schedule === null && cart.slot === '') {
    reasons.push(
      schedule.error ? 'The schedule could not be read. Try again.' : 'Reading the day’s schedule…',
    );
  } else if (chosenStart === null) {
    reasons.push(
      cart.slot === ''
        ? `Choose a ${cart.kind === 'pickup' ? 'pickup time' : 'delivery window'}.`
        : 'That time has passed or no longer suits the cart. Choose another.',
    );
  }
  if (noteChars > NOTE_MAX) reasons.push(`Shorten the note by ${noteChars - NOTE_MAX}.`);

  async function place() {
    if (phase.name !== 'live' || chosenStart === null || reasons.length > 0) return;
    const body: OrderRequest = {
      kind: cart.kind,
      slot: chosenStart,
      ...(cart.kind === 'delivery' ? { zone: cart.zone } : {}),
      lines: cart.lines.map(({ variant, qty }) => ({ variant, qty })),
      ...(cart.note.trim() === '' ? {} : { note: cart.note }),
    };
    // The same body is the same intent: a retry keeps its key, a changed cart gets a new one.
    const current = attemptFor(attempt.current, JSON.stringify(body));
    attempt.current = current;
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const order = await placeOrder(phase.id, body, current.key);
      attempt.current = null;
      setRetry(false);
      update(() => EMPTY_CART);
      setResult({ order, sandboxId: phase.id });
    } catch (e) {
      const keep = keepKeyAfter(e);
      if (!keep) attempt.current = null;
      setRetry(keep);
      // A slot that filled first comes back with the next free one: offer it in the picker. Any
      // refusal about the day's places means the page's copy of the schedule is stale.
      const full = slotConflict(e);
      setConflict(full);
      setError(full === null ? describeOrderError(e) : null);
      if (e instanceof ApiError && (e.status === 409 || e.status === 422)) void schedule.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (result !== null) {
    return <PaymentStep sandboxId={result.sandboxId} order={result.order} menu={menu} />;
  }

  return (
    <>
      <StatusLine phase={phase} />

      <section aria-labelledby="cart-heading" data-tour="checkout-cart">
        <h2 id="cart-heading">Your cart</h2>
        <CartLines cart={cart} menu={menu.menu} update={update} />
        {cart.lines.length === 0 && ready && (
          <p>
            <a href="/menu/">Back to the menu</a>
          </p>
        )}
        {cart.lines.length > 0 && (
          <dl className="totals">
            <dt>Subtotal</dt>
            <dd>{dollars(sum.subtotal_cents)}</dd>
            <dt>Tax at {taxPercent(taxBp)}% (the demo’s rate)</dt>
            <dd>{dollars(sum.tax_cents)}</dd>
            <dt>Total</dt>
            <dd>
              <strong>{dollars(sum.total_cents)}</strong>
            </dd>
          </dl>
        )}
      </section>

      <form
        aria-labelledby="receive-heading"
        data-tour="checkout-form"
        onSubmit={(e) => {
          e.preventDefault();
          void place();
        }}
      >
        <h2 id="receive-heading">Pickup or delivery</h2>
        <fieldset>
          <legend>How do you want it?</legend>
          <label className="check">
            <input
              type="radio"
              name="kind"
              checked={cart.kind === 'pickup'}
              onChange={() => {
                setConflict(null);
                update((c) => ({ ...c, kind: 'pickup', slot: '' }));
              }}
            />{' '}
            Pickup, in 15-minute slots
          </label>{' '}
          <label className="check">
            <input
              type="radio"
              name="kind"
              checked={cart.kind === 'delivery'}
              onChange={() => {
                setConflict(null);
                update((c) => ({ ...c, kind: 'delivery', slot: '' }));
              }}
            />{' '}
            Delivery, in 2-hour windows
          </label>
        </fieldset>

        {cart.kind === 'delivery' && (
          <p>
            <label htmlFor="zone">Delivery zone</label>
            <select
              id="zone"
              value={cart.zone}
              onChange={(e) => {
                setConflict(null);
                update((c) => ({ ...c, zone: e.target.value as Zone }));
              }}
            >
              {ZONES.map((z) => (
                <option key={z} value={z}>
                  Zone {z.slice(1)}
                </option>
              ))}
            </select>
          </p>
        )}

        {live ? (
          <SlotPicker
            kind={cart.kind}
            today={today}
            dates={dates}
            day={liveDay}
            onDay={(date) => {
              setPickedDay(date);
              setConflict(null);
              update((c) => ({ ...c, slot: '' }));
            }}
            live={schedule}
            choices={choices}
            slot={cart.slot}
            onSlot={(start) => {
              setConflict(null);
              update((c) => ({ ...c, slot: start }));
            }}
            conflict={conflict}
            onTakeNext={(start) => {
              setPickedDay(dateOfStart(start));
              setConflict(null);
              update((c) => ({ ...c, slot: start }));
            }}
            baked={baked}
            leadHours={Math.round(lead / 60)}
          />
        ) : (
          <>
            <p>
              <label htmlFor="day">Day</label>
              <select
                id="day"
                value={shownDay}
                disabled={groups.length === 0}
                onChange={(e) => {
                  setDay(e.target.value);
                  update((c) => ({ ...c, slot: '' }));
                }}
              >
                {groups.map((g) => (
                  <option key={g.date} value={g.date}>
                    {g.label}
                  </option>
                ))}
              </select>
            </p>
            <p>
              <label htmlFor="time">
                {cart.kind === 'pickup' ? 'Pickup time' : 'Delivery window'}
              </label>
              <select
                id="time"
                value={chosen?.value ?? ''}
                disabled={timesOfDay.length === 0}
                onChange={(e) => update((c) => ({ ...c, slot: e.target.value }))}
              >
                <option value="">Choose…</option>
                {timesOfDay.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <span className="hint">
                Bakery time (Mountain). Open Tuesday to Sunday, 7:00 am to 3:00 pm.
                {lead > 0 && ` Your cart needs ${Math.round(lead / 60)} hours’ notice at least.`}
              </span>
            </p>
          </>
        )}

        <p>
          <label htmlFor="note">Note for the kitchen (optional)</label>
          <textarea
            id="note"
            rows={2}
            value={cart.note}
            aria-describedby="note-count"
            onChange={(e) => update((c) => ({ ...c, note: e.target.value }))}
          />
          <span id="note-count" className="hint">
            {noteChars} of {NOTE_MAX} characters. No emails, phone numbers, card numbers or web
            addresses: the bakery refuses them and keeps no personal details.
          </span>
        </p>
        <p aria-live="polite" className="problem-slot">
          {noteChars > NOTE_MAX && (
            <span className="problem">
              The note is {noteChars - NOTE_MAX} characters over the limit.
            </span>
          )}
        </p>

        {live ? (
          <>
            <p>
              <button type="submit" disabled={busy || reasons.length > 0}>
                {busy ? 'Placing your order…' : retry ? 'Try again' : 'Place order'}
              </button>
            </p>
            {reasons.length > 0 && cart.lines.length > 0 && (
              <ul className="hint">
                {reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {retry && (
              <p className="hint">
                Trying again sends the same request with the same key, so the order cannot be placed
                twice.
              </p>
            )}
          </>
        ) : phase.name === 'seeding' || phase.name === 'loading' ? (
          <p>Seeding your bakery… You can order as soon as it is ready.</p>
        ) : (
          <p>
            Ordering needs a sandbox. <a href="/signin/">Sign in or try it as a guest</a>; your cart
            stays in this tab.
          </p>
        )}
        <Message error={error} />
      </form>

      <HowThisWorks menu={menu} />
    </>
  );
}
