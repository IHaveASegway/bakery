// lib/stripe.ts: a Stripe.js that cannot load (a blocked or unreachable js.stripe.com) reads as
// null, which the payment panel turns into "Stripe's payment form could not load", and the failure
// is not remembered, so "Try again" loads again.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const loadStripe = vi.fn();
vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe: (key: string) => loadStripe(key) }));

describe('stripeFor', () => {
  beforeEach(() => {
    vi.resetModules();
    loadStripe.mockReset();
  });

  test('a script that fails to load gives null, not a rejection', async () => {
    loadStripe.mockImplementation(() => Promise.reject(new Error('Failed to load Stripe.js')));
    const { stripeFor } = await import('../src/lib/stripe');
    await expect(stripeFor('pk_test_x')).resolves.toBeNull();
  });

  test('a failure is forgotten, so the next call loads again', async () => {
    const stripe = { elements: () => undefined };
    loadStripe
      .mockImplementationOnce(() => Promise.reject(new Error('Failed to load Stripe.js')))
      .mockImplementationOnce(() => Promise.resolve(stripe));
    const { stripeFor } = await import('../src/lib/stripe');
    await expect(stripeFor('pk_test_x')).resolves.toBeNull();
    await expect(stripeFor('pk_test_x')).resolves.toBe(stripe);
    expect(loadStripe).toHaveBeenCalledTimes(2);
  });

  test('a loaded Stripe is kept for the key', async () => {
    const stripe = { elements: () => undefined };
    loadStripe.mockReturnValue(Promise.resolve(stripe));
    const { stripeFor } = await import('../src/lib/stripe');
    await stripeFor('pk_test_x');
    await expect(stripeFor('pk_test_x')).resolves.toBe(stripe);
    expect(loadStripe).toHaveBeenCalledTimes(1);
  });
});
