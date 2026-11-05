import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrderRequest, OrderResponse } from '../contracts';
import { placeOrder } from '../lib/api';
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
import { findVariant } from '../lib/menu';
import { dollars, DEFAULT_TAX_BP } from '../lib/money';
import { describeOrderError } from '../lib/order-errors';
import { ZONES, byDate, deliveryWindows, pickupSlots, type Zone } from '../lib/slots';
import { useCart } from '../lib/use-cart';
import { useLiveMenu } from '../lib/use-live-menu';
import { useSandboxPhase } from '../lib/use-session';
import CartLines from './CartLines';
import HowThisWorks from './HowThisWorks';
import Message from './Message';
import StatusLine from './StatusLine';

/** The /checkout/ island: the cart, how to receive it, a note, and the order's result. */
export default function Checkout() {
  const phase = useSandboxPhase();
  const menu = useLiveMenu(phase);
  const { cart, ready, update } = useCart();
  const [now, setNow] = useState<number | null>(null);
  const [day, setDay] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [retry, setRetry] = useState(false);
  const [result, setResult] = useState<OrderResponse | null>(null);
  const attempt = useRef<Attempt | null>(null);

  // The slot lists are computed from the clock, so refresh it while the page is open.
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const sum = totals(cart.lines, menu.menu);
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

  const reasons: string[] = [];
  if (cart.lines.length === 0) reasons.push('Add something to the cart.');
  if (sum.missing.length > 0) reasons.push('Take out what is no longer on the menu.');
  if (blocker) reasons.push(blocker);
  if (slots.length === 0 && now !== null && cart.lines.length > 0) {
    reasons.push('No time in the next 7 days suits everything in the cart. Take something out.');
  } else if (chosen === null) {
    reasons.push(
      cart.slot === ''
        ? `Choose a ${cart.kind === 'pickup' ? 'pickup time' : 'delivery window'}.`
        : 'That time has passed or no longer suits the cart. Choose another.',
    );
  }
  if (noteChars > NOTE_MAX) reasons.push(`Shorten the note by ${noteChars - NOTE_MAX}.`);

  const live = phase.name === 'live';

  async function place() {
    if (phase.name !== 'live' || chosen === null || reasons.length > 0) return;
    const body: OrderRequest = {
      kind: cart.kind,
      slot: chosen.value,
      ...(cart.kind === 'delivery' ? { zone: cart.zone } : {}),
      lines: cart.lines.map(({ variant, qty }) => ({ variant, qty })),
      ...(cart.note.trim() === '' ? {} : { note: cart.note }),
    };
    // The same body is the same intent: a retry keeps its key, a changed cart gets a new one.
    const current = attemptFor(attempt.current, JSON.stringify(body));
    attempt.current = current;
    setBusy(true);
    setError(null);
    try {
      const order = await placeOrder(phase.id, body, current.key);
      attempt.current = null;
      setRetry(false);
      update(() => EMPTY_CART);
      setResult(order);
    } catch (e) {
      const keep = keepKeyAfter(e);
      if (!keep) attempt.current = null;
      setRetry(keep);
      setError(describeOrderError(e));
    } finally {
      setBusy(false);
    }
  }

  if (result !== null) return <Receipt order={result} menu={menu} />;

  return (
    <>
      <StatusLine phase={phase} />

      <section aria-labelledby="cart-heading">
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
            <dt>Tax at {(DEFAULT_TAX_BP / 100).toFixed(2)}% (the demo’s rate)</dt>
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
              onChange={() => update((c) => ({ ...c, kind: 'pickup', slot: '' }))}
            />{' '}
            Pickup, in 15-minute slots
          </label>{' '}
          <label className="check">
            <input
              type="radio"
              name="kind"
              checked={cart.kind === 'delivery'}
              onChange={() => update((c) => ({ ...c, kind: 'delivery', slot: '' }))}
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
              onChange={(e) => update((c) => ({ ...c, zone: e.target.value as Zone }))}
            >
              {ZONES.map((z) => (
                <option key={z} value={z}>
                  Zone {z.slice(1)}
                </option>
              ))}
            </select>
          </p>
        )}

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
          <label htmlFor="time">{cart.kind === 'pickup' ? 'Pickup time' : 'Delivery window'}</label>
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

/** What the API answered: its numbers, not the page's. */
function Receipt({ order, menu }: { order: OrderResponse; menu: ReturnType<typeof useLiveMenu> }) {
  return (
    <section aria-labelledby="receipt-heading" aria-live="polite">
      <h2 id="receipt-heading">Order placed</h2>
      <dl>
        <dt>Order</dt>
        <dd>
          <code>{order.id}</code>
        </dd>
        <dt>Status</dt>
        <dd>{order.status}</dd>
        <dt>{order.kind === 'pickup' ? 'Pickup' : `Delivery, zone ${order.zone ?? ''}`}</dt>
        <dd>
          <time dateTime={order.slot}>{order.slot}</time>
        </dd>
        <dt>Held until</dt>
        <dd>
          <time dateTime={order.held_until}>{order.held_until}</time>
        </dd>
        <dt>Menu version</dt>
        <dd>{order.menu_version}</dd>
      </dl>
      <ul className="cart-lines">
        {order.lines.map((line) => (
          <li key={line.variant}>
            <span className="line-name">
              {findVariant(menu.menu, line.variant)?.item.name ?? line.variant}
              {' × '}
              {line.qty}
            </span>
            <span className="price">{dollars(line.unit_cents * line.qty)}</span>
          </li>
        ))}
      </ul>
      <dl className="totals">
        <dt>Subtotal</dt>
        <dd>{dollars(order.subtotal_cents)}</dd>
        <dt>Tax</dt>
        <dd>{dollars(order.tax_cents)}</dd>
        <dt>Total</dt>
        <dd>
          <strong>{dollars(order.total_cents)}</strong>
        </dd>
      </dl>
      <p>
        An unpaid order is held for 15 minutes of bakery time and then expires. Payment arrives in a
        later release.
      </p>
      <p className="actions">
        <a className="action" href="/app/">
          Watch it on the kitchen board
        </a>
        <a className="action" href="/menu/">
          Order something else
        </a>
      </p>
    </section>
  );
}
