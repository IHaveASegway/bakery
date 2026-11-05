import { MAX_QTY, removeLine, setQty, type Cart } from '../lib/cart';
import { findVariant, type MenuView } from '../lib/menu';
import { dollars } from '../lib/money';

interface Props {
  cart: Cart;
  menu: MenuView;
  update(next: (cart: Cart) => Cart): void;
}

/** The cart's lines: what, how many, the price each, and a way to change or remove them. */
export default function CartLines({ cart, menu, update }: Props) {
  if (cart.lines.length === 0) return <p>The cart is empty.</p>;
  return (
    <ul className="cart-lines">
      {cart.lines.map((line) => {
        const found = findVariant(menu, line.variant);
        const name = found ? `${found.item.name}, ${found.variant.label}` : null;
        return (
          <li key={line.variant}>
            <span className="line-name">
              {name ?? 'No longer on the menu'}
              {found?.item.status === 'paused' && <span className="hint"> Paused right now.</span>}
            </span>
            <label className="qty">
              <span className="sr-only">Quantity of {name ?? 'this item'}</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_QTY}
                value={line.qty}
                onChange={(e) => update((c) => setQty(c, line.variant, e.target.valueAsNumber))}
              />
            </label>
            <span className="price">
              {found ? dollars(found.variant.price_cents * line.qty) : 'not priced'}
            </span>
            <button
              type="button"
              aria-label={`Remove ${name ?? 'this item'} from the cart`}
              onClick={() => update((c) => removeLine(c, line.variant))}
            >
              Remove
            </button>
          </li>
        );
      })}
    </ul>
  );
}
