import { useState } from 'react';
import { addLine, totals } from '../lib/cart';
import { dollars } from '../lib/money';
import { useCart } from '../lib/use-cart';
import { useLiveMenu } from '../lib/use-live-menu';
import { useSandboxPhase } from '../lib/use-session';
import CartLines from './CartLines';
import HowThisWorks from './HowThisWorks';
import MenuList from './MenuList';
import StatusLine from './StatusLine';

/** The /menu/ island: the menu with Add buttons, the cart beside it, and where the menu came from. */
export default function StoreMenu() {
  const phase = useSandboxPhase();
  const menu = useLiveMenu(phase);
  const { cart, update } = useCart();
  const [said, setSaid] = useState('');

  function add(variant: string, label: string) {
    if (addLine(cart, variant).refused) {
      setSaid('The cart holds at most 20 lines. Take one out first.');
      return;
    }
    update((c) => addLine(c, variant).cart);
    setSaid(`Added ${label}.`);
  }

  const sum = totals(cart.lines, menu.menu);
  const count = cart.lines.reduce((n, l) => n + l.qty, 0);

  // The cart comes first in the page, so a phone shows it first; on a wide screen the grid puts it
  // in the side column, where it stays in view beside the menu.
  return (
    <div className="shop-split">
      <StatusLine phase={phase} />
      <section aria-labelledby="cart-heading" className="cart" data-tour="menu-cart">
        <h2 id="cart-heading">Your cart</h2>
        <CartLines cart={cart} menu={menu.menu} update={update} />
        {cart.lines.length > 0 && (
          <p>
            {count} {count === 1 ? 'item' : 'items'}, {dollars(sum.subtotal_cents)} before tax.{' '}
            <a className="btn btn-primary" href="/checkout/">
              Check out
            </a>
          </p>
        )}
        <p aria-live="polite" className="hint">
          {said}
        </p>
      </section>
      <MenuList menu={menu.menu} onAdd={add} />
      {menu.error && (
        <p className="problem" role="alert">
          <strong>{menu.error.title}.</strong> {menu.error.detail}
        </p>
      )}
      <HowThisWorks
        menu={menu}
        onCheck={phase.name === 'live' ? () => void menu.refresh() : undefined}
      />
    </div>
  );
}
