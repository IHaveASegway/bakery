// The build-time guard on Stripe's publishable key (docs/security.md, "Payments safety": the web
// build fails unless the key starts pk_test_). astro.config.mjs calls it with the resolved
// PUBLIC_STRIPE_PUBLISHABLE_KEY; an empty key is fine, because the checkout then says payments are
// not configured. The message never repeats the value it refused.

export const TEST_KEY_PREFIX = 'pk_test_';

/** Throws one plain sentence unless the key is empty or a sandbox (test-mode) publishable key. */
export function checkPublishableKey(value: string | undefined): void {
  const key = (value ?? '').trim();
  if (key === '' || key.startsWith(TEST_KEY_PREFIX)) return;
  throw new Error(
    `PUBLIC_STRIPE_PUBLISHABLE_KEY must be empty or start with ${TEST_KEY_PREFIX}, because this build takes Stripe sandbox keys only.`,
  );
}
