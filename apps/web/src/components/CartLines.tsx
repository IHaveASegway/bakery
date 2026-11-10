import { useState } from 'react';
import { MAX_QTY, QTY_HINT, commitQty, removeLine, setQty, validQty, type Cart } from '../lib/cart';
import { findVariant, type MenuView } from '../lib/menu';
import { dollars } from '../lib/money';

interface Props {
  cart: Cart;
  menu: MenuView;
  update(next: (cart: Cart) => Cart): void;
}

/** The stepper's two marks, drawn inline (the policy allows no image from elsewhere). */
const MINUS = (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <rect x="3" y="7" width="10" height="2" rx="1" />
  </svg>
);
const PLUS = (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <rect x="3" y="7" width="10" height="2" rx="1" />
    <rect x="7" y="3" width="2" height="10" rx="1" />
  </svg>
);

/**
 * One quantity field between a fewer and a more button. The text is the visitor's until they leave
 * the field or press Enter, so it can be cleared and retyped; a whole number in range reaches the
 * cart as they type, and anything else settles into range on blur with the range said once beside
 * the field. A step drops any half-typed text and moves the cart's number by one, within 1 to 24.
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
  const step = (by: number) => {
    setDraft(null);
    setClamped(false);
    onQty(Math.min(MAX_QTY, Math.max(1, qty + by)));
  };
  return (
    <>
      <span className="stepper">
        <button
          type="button"
          className="btn btn-quiet btn-sm btn-icon"
          aria-label={`One fewer ${name}`}
          disabled={qty <= 1}
          onClick={() => step(-1)}
        >
          {MINUS}
        </button>
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
        <button
          type="button"
          className="btn btn-quiet btn-sm btn-icon"
          aria-label={`One more ${name}`}
          disabled={qty >= MAX_QTY}
          onClick={() => step(1)}
        >
          {PLUS}
        </button>
      </span>
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
              className="btn btn-quiet btn-sm remove"
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
