// Stripe.js, loaded once per page and only when the payment step asks for it. The `/pure` entry is
// the one that does not inject Stripe's script when imported, so the other pages of the island
// bundle and a build with no key never touch js.stripe.com.
import type { Stripe } from '@stripe/stripe-js';
import { loadStripe } from '@stripe/stripe-js/pure';

let loaded: { key: string; stripe: Promise<Stripe | null> } | null = null;

/**
 * The one Stripe instance for this page and key, or null when Stripe.js could not load. A blocked
 * or unreachable js.stripe.com makes `loadStripe` reject rather than resolve null, so the
 * rejection is turned into null here: the payment panel then says Stripe's form could not load,
 * not that something went wrong.
 */
export function stripeFor(key: string): Promise<Stripe | null> {
  if (loaded === null || loaded.key !== key) {
    const stripe: Promise<Stripe | null> = loadStripe(key).then(
      (s) => s,
      () => null,
    );
    // A failed load must not be remembered, or a retry would get the same failure.
    void stripe.then((s) => {
      if (s === null && loaded?.stripe === stripe) loaded = null;
    });
    loaded = { key, stripe };
  }
  return loaded.stripe;
}
