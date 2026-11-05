// The cart as React state, backed by sessionStorage (lib/cart.ts). It starts empty so the server's
// HTML and the first client render agree, reads the stored cart once mounted, and saves every
// change after that.
import { useCallback, useEffect, useState } from 'react';
import { EMPTY_CART, browserStorage, loadCart, saveCart, type Cart } from './cart';

export function useCart(): {
  cart: Cart;
  ready: boolean;
  update(next: (cart: Cart) => Cart): void;
} {
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setCart(loadCart(browserStorage()));
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) saveCart(browserStorage(), cart);
  }, [cart, ready]);

  const update = useCallback((next: (cart: Cart) => Cart) => setCart((c) => next(c)), []);
  return { cart, ready, update };
}
