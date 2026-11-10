import { useEffect, useRef, useState } from 'react';
import { addLine, totals } from '../lib/cart';
import { dollars } from '../lib/money';
import { useCart } from '../lib/use-cart';
import { useLiveMenu } from '../lib/use-live-menu';
import { hydrating, useMounted } from '../lib/use-mounted';
import { useSandboxPhase, type Phase } from '../lib/use-session';
import CartLines from './CartLines';
import { StartHere } from './Guest';
import MenuList from './MenuList';
import StatusLine, { ORDERS_LIVE } from './StatusLine';

/** Where the cart is a bar and a sheet rather than a panel beside the list (shop.css). */
const SHEET = '(max-width: 60rem)';

/** No sandbox yet, or one still seeding: the gate, the checkout's own, in the banner's place. */
const gated = (phase: Phase) =>
  phase.name === 'nosession' || phase.name === 'nosandbox' || phase.name === 'seeding';

/**
 * The /menu/ island: a bar of the categories, the menu with Add buttons, the cart beside it, and
 * where the menu came from. On a wide screen the cart is a panel that stays in view beside the
 * grid; on a phone it is a bar at the foot of the window that opens the same panel as a sheet.
 */
export default function StoreMenu() {
  const phase = useSandboxPhase();
  const menu = useLiveMenu(phase);
  const { cart, update } = useCart();
  const [said, setSaid] = useState('');
  const [open, setOpen] = useState(false);
  // The variant whose Add was pressed last: the way to the cart follows that button alone.
  const [added, setAdded] = useState<string | null>(null);
  const mounted = useMounted();
  const heading = useRef<HTMLHeadingElement>(null);
  const bar = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLDivElement>(null);
  // Browsing and filling the cart need no sandbox. Once the gate's sandbox is live, the focus,
  // left on a button that is gone, goes to the line that says so.
  const wasGated = useRef(false);
  useEffect(() => {
    if (gated(phase)) wasGated.current = true;
    else if (phase.name === 'live' && wasGated.current) {
      wasGated.current = false;
      status.current?.focus();
    }
  }, [phase]);

  function add(variant: string, label: string) {
    setAdded(variant);
    if (addLine(cart, variant).refused) {
      setSaid('The cart holds at most 20 lines. Take one out first.');
      return;
    }
    update((c) => addLine(c, variant).cart);
    setSaid(`Added ${label}.`);
  }

  /**
   * From the link after a pressed Add: on a wide screen the cart is the panel beside the list, and
   * its heading takes the focus; on a phone the bar opens the cart as a sheet, which takes it.
   */
  function toCart() {
    if (window.matchMedia(SHEET).matches) return setOpen(true);
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'nearest' });
  }

  // The sheet takes the focus when it opens and gives it back to the bar when it closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) heading.current?.focus();
    else if (wasOpen.current) bar.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const sum = totals(cart.lines, menu.menu);
  const count = cart.lines.reduce((n, l) => n + l.qty, 0);
  const items = `${count} ${count === 1 ? 'item' : 'items'}`;

  // The cart comes first in the page after the status, so the tour and a screen reader meet it
  // before the long list; the grid puts it in the side column on a wide screen.
  return (
    <div className="shop-split menu-shop">
      <div
        className="menu-status"
        ref={status}
        tabIndex={-1}
        data-tour={gated(phase) ? 'menu-start' : undefined}
      >
        {gated(phase) ? (
          <StartHere here="/menu/" seeding={phase.name === 'seeding'} className="start-banner" />
        ) : (
          <StatusLine phase={phase} live={ORDERS_LIVE} />
        )}
      </div>
      <nav className="category-bar" aria-label="Menu categories" data-tour="menu-categories">
        <ul>
          {menu.menu.categories.map((category) => (
            <li key={category.slug}>
              <a className="cat-link" href={`#cat-${category.slug}`}>
                {category.name}
                <span className="count" aria-hidden="true">
                  {category.items.length}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <section
        aria-labelledby="cart-heading"
        className="cart"
        data-tour="menu-cart"
        data-open={open ? '' : undefined}
      >
        <button
          ref={bar}
          type="button"
          className="cart-bar"
          aria-expanded={open}
          aria-controls="cart-sheet"
          disabled={!mounted}
          {...hydrating(mounted)}
          onClick={() => setOpen(true)}
        >
          <span>
            Cart <span aria-hidden="true">·</span> {count === 0 ? 'empty' : items}
          </span>
          {count > 0 && <span className="price">{dollars(sum.subtotal_cents)}</span>}
        </button>
        {open && <div className="cart-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
        <div
          id="cart-sheet"
          className="cart-sheet"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && open) setOpen(false);
          }}
        >
          <div className="cart-head">
            <h2 id="cart-heading" ref={heading} tabIndex={-1}>
              Your cart
            </h2>
            <button
              type="button"
              className="btn btn-quiet btn-sm cart-close"
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
          <CartLines cart={cart} menu={menu.menu} update={update} />
          {cart.lines.length > 0 && (
            <>
              <dl className="totals">
                <dt>Subtotal, {items}</dt>
                <dd className="price">{dollars(sum.subtotal_cents)}</dd>
              </dl>
              <p className="hint">Tax and the pickup or delivery slot come at checkout.</p>
              <a className="btn btn-primary checkout-go" href="/checkout/">
                Check out
              </a>
            </>
          )}
        </div>
        <p aria-live="polite" className="hint said">
          {said}
        </p>
      </section>
      <MenuList menu={menu.menu} onAdd={add} added={added} onToCart={toCart} />
      {menu.error && (
        <p className="problem" role="alert">
          <strong>{menu.error.title}.</strong> {menu.error.detail}
        </p>
      )}
    </div>
  );
}
