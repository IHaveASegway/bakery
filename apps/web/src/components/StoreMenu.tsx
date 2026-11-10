import { useEffect, useRef, useState } from 'react';
import { addLine, totals } from '../lib/cart';
import { dollars } from '../lib/money';
import { signinFor } from '../lib/next';
import { useCart } from '../lib/use-cart';
import { useLiveMenu } from '../lib/use-live-menu';
import { hydrating, useMounted } from '../lib/use-mounted';
import { useSandboxPhase, type Phase } from '../lib/use-session';
import CartLines from './CartLines';
import MenuList from './MenuList';
import StatusLine from './StatusLine';

/** A visitor with no sandbox: one banner, one button, to the sign-in page and back to the menu. */
function StartBanner() {
  return (
    <div className="start-banner" data-tour="menu-start">
      <div>
        <p className="start-title">Ordering starts with your own sandbox.</p>
        <p className="hint">
          This is the demo’s seed menu. A guest sandbox takes a few seconds and is wiped tonight.
        </p>
      </div>
      <a className="btn btn-primary" href={signinFor('/menu/')}>
        Start ordering
      </a>
    </div>
  );
}

const noSandbox = (phase: Phase) => phase.name === 'nosession' || phase.name === 'nosandbox';

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
  const mounted = useMounted();
  const heading = useRef<HTMLHeadingElement>(null);
  const bar = useRef<HTMLButtonElement>(null);

  function add(variant: string, label: string) {
    if (addLine(cart, variant).refused) {
      setSaid('The cart holds at most 20 lines. Take one out first.');
      return;
    }
    update((c) => addLine(c, variant).cart);
    setSaid(`Added ${label}.`);
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
      <div className="menu-status">
        {noSandbox(phase) ? <StartBanner /> : <StatusLine phase={phase} />}
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
      <MenuList menu={menu.menu} onAdd={add} />
      {menu.error && (
        <p className="problem" role="alert">
          <strong>{menu.error.title}.</strong> {menu.error.detail}
        </p>
      )}
    </div>
  );
}
