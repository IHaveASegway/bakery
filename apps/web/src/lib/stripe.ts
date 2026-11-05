// Stripe.js, loaded once per page and only when the payment step asks for it. The `/pure` entry is
// the one that does not inject Stripe's script when imported, so the other pages of the island
// bundle and a build with no key never touch js.stripe.com.
import type { Stripe } from '@stripe/stripe-js';
import { loadStripe } from '@stripe/stripe-js/pure';

let loaded: { key: string; stripe: Promise<Stripe | null> } | null = null;

/** The one Stripe instance for this page and key. */
export function stripeFor(key: string): Promise<Stripe | null> {
  if (loaded === null || loaded.key !== key) {
    const stripe = loadStripe(key);
    // A failed load must not be remembered, or a retry would get the same failure.
    stripe.catch(() => {
      if (loaded?.stripe === stripe) loaded = null;
    });
    loaded = { key, stripe };
  }
  return loaded.stripe;
}
