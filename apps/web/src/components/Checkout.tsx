import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrderRequest, OrderResponse } from '../contracts';
import { ApiError, getOrder, placeOrder } from '../lib/api';
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
import { findVariant, taxBpOf } from '../lib/menu';
import { dollars, taxPercent } from '../lib/money';
import { describeOrderError } from '../lib/order-errors';
import { isPaid } from '../lib/payment';
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
import { shortWhen, windowText } from '../lib/when';
import CartLines from './CartLines';
import Message from './Message';
import PaymentStep, { orderPage } from './PaymentStep';
import SlotPicker, { DayChips } from './SlotPicker';
import StatusLine from './StatusLine';
import { hydrating, useMounted } from '../lib/use-mounted';

type StepId = 'how' | 'when' | 'pay';

/**
 * One step's frame: its number and title, then either its body (open), one line of what was
 * chosen with "Change" (done), or nothing (still to come).
 */
function Step({
  id,
  n,
  title,
  state,
  summary,
  onChange,
  children,
}: {
  id: StepId;
  n: number;
  title: string;
  state: 'open' | 'done' | 'todo';
  summary?: React.ReactNode;
  onChange?: (() => void) | undefined;
  children?: React.ReactNode;
}) {
  return (
    <section
      className="step"
      data-state={state}
      aria-labelledby={`${id}-heading`}
      aria-current={state === 'open' ? 'step' : undefined}
    >
      <div className="step-head">
        <span className="step-n" aria-hidden="true">
          {state === 'done' ? (
            <svg viewBox="0 0 16 16" focusable="false">
              <path d="M3.5 8.5l3 3 6-7" />
            </svg>
          ) : (
            n
          )}
        </span>
        <h2 id={`${id}-heading`}>
          <span className="sr-only">Step {n} of 3: </span>
          {title}
        </h2>
        {state === 'done' && summary !== undefined && <p className="step-summary">{summary}</p>}
        {state === 'done' && onChange !== undefined && (
          <button
            type="button"
            className="btn btn-quiet btn-sm step-change"
            aria-label={`Change ${title.toLowerCase()}`}
            onClick={onChange}
          >
            Change
          </button>
        )}
      </div>
      {state === 'open' && <div className="step-body">{children}</div>}
    </section>
  );
}

/**
 * Delivery's zone. The API will derive it from the customer's place (roadmap R69); when it does,
 * this field and the `zone` in the order body go, and nothing else in the step changes.
 */
function ZoneField({ zone, onZone }: { zone: Zone; onZone: (zone: Zone) => void }) {
  return (
    <p className="field zone-field">
      <label htmlFor="zone">Delivery zone</label>
      <select id="zone" value={zone} onChange={(e) => onZone(e.target.value as Zone)}>
        {ZONES.map((z) => (
          <option key={z} value={z}>
            Zone {z.slice(1)}
          </option>
        ))}
      </select>
    </p>
  );
}

/** "Tue 10 Nov, 9:15 am" for a pickup, "Tue 10 Nov, 9:00 am to 11:00 am" for a delivery. */
function slotWords(kind: 'pickup' | 'delivery', start: string): string {
  return kind === 'pickup'
    ? shortWhen(start)
    : `${shortWhen(start).split(', ')[0]}, ${windowText(start)}`;
}

/** The /checkout/ island: how, when, pay, with the cart or the placed order beside the steps. */
export default function Checkout() {
  const phase = useSandboxPhase();
  const menu = useLiveMenu(phase);
  const { cart, ready, update } = useCart();
  const [now, setNow] = useState<number | null>(null);
  const [day, setDay] = useState('');
  // The day the visitor picked; until then, the cart's slot's day, else the first open day.
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [conflict, setConflict] = useState<SlotConflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [retry, setRetry] = useState(false);
  const [result, setResult] = useState<{ order: OrderResponse; sandboxId: string } | null>(null);
  const [open, setOpen] = useState<'how' | 'when'>('how');
  // The method choice and Continue are in the server's HTML: until the island has hydrated, a
  // press would do nothing, so they wait, drawn as they will be (lib/use-mounted.ts).
  const mounted = useMounted();
  // `?order=<id>`: the status page's "Pay for this order" comes back here for the payment step.
  const [resume, setResume] = useState<string | null>(null);
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

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('order')?.trim() ?? '';
    if (id !== '') setResume(id);
  }, []);

  // An order to pay for, from the status page: unpaid, it opens the payment step; anything else
  // belongs on its own page.
  useEffect(() => {
    if (resume === null || sandboxId === null) return;
    let stopped = false;
    getOrder(sandboxId, resume).then(
      (order) => {
        if (stopped) return;
        if (order.status === 'placed') setResult({ order, sandboxId });
        else window.location.replace(orderPage(order.id));
      },
      (e: unknown) => {
        if (stopped) return;
        setResume(null);
        setError(
          e instanceof ApiError && e.status === 404
            ? { title: 'That order is not in your sandbox', detail: 'Start a new one below.' }
            : describeOrderError(e),
        );
      },
    );
    return () => {
      stopped = true;
    };
  }, [resume, sandboxId]);

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
  // Until the visitor picks a day, the picker opens on the first day with a time that suits the
  // cart (the bakery's hours, its lead time, its baking days), never on a closed today.
  const firstOpen = groups[0]?.date ?? today;
  const wanted = pickedDay ?? (cartDay === '' ? firstOpen : cartDay);
  const liveDay = dates.includes(wanted) ? wanted : today;
  const schedule = useSchedule(live && open === 'when' ? sandboxId : null, live ? liveDay : '');
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
  // Days the page's own rules find nothing on for this cart: offered, but quiet.
  const quiet = useMemo(
    () => new Set(dates.filter((d) => !groups.some((g) => g.date === d))),
    [dates, groups],
  );

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

  const placed = result?.order ?? null;
  const kind = placed?.kind ?? cart.kind;
  const howWords =
    kind === 'pickup'
      ? 'Pickup at the bakery'
      : `Delivery to zone ${(placed?.zone ?? cart.zone).slice(1)}`;
  const whenStart = placed?.slot ?? chosenStart;

  // Nothing to check out: one sentence and the way back.
  if (placed === null && resume === null && ready && cart.lines.length === 0) {
    return (
      <div className="checkout-empty">
        <StatusLine phase={phase} />
        <div className="empty">
          <h2>Your cart is empty</h2>
          <p>Add something from the menu, and come back here to choose a time and pay.</p>
          <p>
            <a className="btn btn-primary" href="/menu/">
              Browse the menu
            </a>
          </p>
          <Message error={error} />
        </div>
      </div>
    );
  }

  const state = (id: StepId): 'open' | 'done' | 'todo' => {
    if (placed !== null) return id === 'pay' ? 'open' : 'done';
    if (id === 'pay') return 'todo';
    if (id === open) return 'open';
    return id === 'how' ? 'done' : 'todo';
  };

  return (
    <div className="checkout">
      <div className="checkout-status">
        <StatusLine phase={phase} tour="checkout-menu" />
      </div>

      <form
        className="checkout-steps"
        aria-label="Checkout"
        data-tour="checkout-form"
        onSubmit={(e) => {
          e.preventDefault();
          void place();
        }}
      >
        <Step
          id="how"
          n={1}
          title="How you get it"
          state={state('how')}
          summary={howWords}
          onChange={placed === null ? () => setOpen('how') : undefined}
        >
          <fieldset className="how-choice">
            <legend className="sr-only">Pickup or delivery</legend>
            {(
              [
                ['pickup', 'Pickup', 'At the bakery, in 15-minute slots'],
                ['delivery', 'Delivery', 'To your door, in 2-hour windows'],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={value} className="how-option">
                <input
                  type="radio"
                  name="kind"
                  value={value}
                  checked={cart.kind === value}
                  disabled={!mounted}
                  {...hydrating(mounted)}
                  onChange={() => {
                    setConflict(null);
                    update((c) => ({ ...c, kind: value, slot: '' }));
                  }}
                />
                <span className="how-label">{label}</span>
                <span className="how-hint">{hint}</span>
              </label>
            ))}
          </fieldset>
          {cart.kind === 'delivery' && (
            <ZoneField
              zone={cart.zone}
              onZone={(zone) => {
                setConflict(null);
                update((c) => ({ ...c, zone }));
              }}
            />
          )}
          {blocker !== null && <p className="problem">{blocker}</p>}
          <p className="step-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!mounted}
              {...hydrating(mounted)}
              onClick={() => setOpen('when')}
            >
              Continue
            </button>
          </p>
        </Step>

        <Step
          id="when"
          n={2}
          title="When"
          state={state('when')}
          summary={
            whenStart === null ? undefined : (
              <time dateTime={whenStart}>{slotWords(kind, whenStart)}</time>
            )
          }
        >
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
              quiet={quiet}
            />
          ) : (
            <>
              <DayChips
                dates={groups.map((g) => g.date)}
                day={shownDay}
                today={today}
                onDay={(date) => {
                  setDay(date);
                  update((c) => ({ ...c, slot: '' }));
                }}
              />
              <fieldset className="slot-chips">
                <legend>{cart.kind === 'pickup' ? 'Pickup time' : 'Delivery window'}</legend>
                <ul className="choices" data-kind={cart.kind}>
                  {timesOfDay.map((s) => (
                    <li key={s.value}>
                      <label className="chip slot-chip">
                        <input
                          type="radio"
                          name="slot"
                          value={s.value}
                          checked={chosen?.value === s.value}
                          onChange={() => update((c) => ({ ...c, slot: s.value }))}
                        />
                        <span className="slot-time">{s.label}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="hint">
                  Bakery time (Mountain). Open Tuesday to Sunday, 7:00 am to 3:00 pm.
                  {lead > 0 && ` Your cart needs ${Math.round(lead / 60)} hours’ notice at least.`}
                </p>
              </fieldset>
            </>
          )}

          <p className="field note-field">
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
              <p className="step-actions">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={busy || reasons.length > 0 || !mounted}
                  {...hydrating(mounted || busy || reasons.length > 0)}
                >
                  {busy ? 'Placing your order…' : retry ? 'Try again' : 'Place order'}
                </button>
              </p>
              {reasons.length > 0 && cart.lines.length > 0 && (
                <ul className="hint reasons">
                  {reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              {retry && (
                <p className="hint">
                  Trying again sends the same request with the same key, so the order cannot be
                  placed twice.
                </p>
              )}
            </>
          ) : phase.name === 'seeding' || phase.name === 'loading' ? (
            <p>Seeding your bakery… You can order as soon as it is ready.</p>
          ) : (
            <p>
              Ordering needs a sandbox. <a href="/signin/">Sign in or try it as a guest</a>; your
              cart stays in this tab.
            </p>
          )}
          <Message error={error} />
        </Step>
      </form>

      <aside
        className="panel checkout-summary"
        aria-labelledby="cart-heading"
        data-tour="checkout-cart"
      >
        <h2 id="cart-heading">{placed === null ? 'Your cart' : 'Your order'}</h2>
        {placed === null ? (
          <>
            <CartLines cart={cart} menu={menu.menu} update={update} />
            {cart.lines.length > 0 && (
              <dl className="summary-totals">
                <dt>Subtotal</dt>
                <dd>{dollars(sum.subtotal_cents)}</dd>
                <dt>Tax at {taxPercent(taxBp)}% (the demo’s rate)</dt>
                <dd>{dollars(sum.tax_cents)}</dd>
                <dt className="total">Total</dt>
                <dd className="total">{dollars(sum.total_cents)}</dd>
              </dl>
            )}
            <p className="hint">
              The cart lives in this tab and is cleared when the order is placed. The order goes to
              your private sandbox and is deleted with it at 10:00 UTC.{' '}
              <a href="/menu/">Back to the menu</a>
            </p>
          </>
        ) : (
          <>
            <p className="hint">
              Order <code title={placed.id}>{placed.id.slice(-6)}</code>, priced by the API from
              menu version {placed.menu_version}.
            </p>
            <ul className="receipt-lines">
              {placed.lines.map((line) => {
                const found = findVariant(menu.menu, line.variant);
                return (
                  <li key={line.variant}>
                    <span>
                      {line.qty} ×{' '}
                      {found
                        ? `${found.item.name}, ${found.variant.label.toLowerCase()}`
                        : line.variant}
                    </span>
                    <span className="price">{dollars(line.unit_cents * line.qty)}</span>
                  </li>
                );
              })}
            </ul>
            <dl className="summary-totals">
              <dt>Subtotal</dt>
              <dd>{dollars(placed.subtotal_cents)}</dd>
              <dt>Tax</dt>
              <dd>{dollars(placed.tax_cents)}</dd>
              <dt className="total">Total</dt>
              <dd className="total">{dollars(placed.total_cents)}</dd>
            </dl>
          </>
        )}
      </aside>

      <div className="checkout-pay">
        <Step id="pay" n={3} title="Pay" state={state('pay')}>
          {result !== null && !isPaid(result.order.status) && (
            <PaymentStep sandboxId={result.sandboxId} order={result.order} offsetS={offsetS} />
          )}
        </Step>
      </div>
    </div>
  );
}
