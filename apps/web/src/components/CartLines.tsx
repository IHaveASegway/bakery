import { useState } from 'react';
import { MAX_QTY, QTY_HINT, commitQty, removeLine, setQty, validQty, type Cart } from '../lib/cart';
import { findVariant, type MenuView } from '../lib/menu';
import { dollars } from '../lib/money';

interface Props {
  cart: Cart;
  menu: MenuView;
  update(next: (cart: Cart) => Cart): void;
}

/**
 * One quantity field. The text is the visitor's until they leave the field or press Enter, so it
 * can be cleared and retyped; a whole number in range reaches the cart as they type, and anything
 * else settles into range on blur with the range said once beside the field.
 */
function QtyField({ name, qty, onQty }: { name: string; qty: number; onQty(qty: number): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [clamped, setClamped] = useState(false);
  const settle = () => {
    if (draft === null) return;
    const done = commitQty(draft);
    onQty(done.qty);
    setDraft(null);
    setClamped(done.clamped);
  };
  return (
    <>
      <label className="qty">
        <span className="sr-only">Quantity of {name}</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_QTY}
          value={draft ?? String(qty)}
          onChange={(e) => {
            const text = e.target.value;
            setDraft(text);
            const valid = validQty(text);
            if (valid !== null) {
              onQty(valid);
              setClamped(false);
            }
          }}
          onBlur={settle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') settle();
          }}
        />
      </label>
      {clamped && (
        <span className="hint qty-hint" role="status">
          {QTY_HINT}
        </span>
      )}
    </>
  );
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
            <QtyField
              name={name ?? 'this item'}
              qty={line.qty}
              onQty={(qty) => update((c) => setQty(c, line.variant, qty))}
            />
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
