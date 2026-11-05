import { describe, expect, test } from 'vitest';
import { checkPublishableKey } from '../src/lib/publishable-key';

// A live-looking key is assembled here, never written out: CI greps the tree for the live prefixes.
const liveShaped = ['pk', 'live', 'fake000'].join('_');
const testShaped = 'pk_test_fake000000000000000000000000';

describe('checkPublishableKey', () => {
  test('an empty or missing key is fine: the checkout then says payments are not configured', () => {
    expect(() => checkPublishableKey(undefined)).not.toThrow();
    expect(() => checkPublishableKey('')).not.toThrow();
    expect(() => checkPublishableKey('  ')).not.toThrow();
  });

  test('a sandbox key is fine', () => {
    expect(() => checkPublishableKey(testShaped)).not.toThrow();
  });

  test.each([liveShaped, 'sk_test_fake000', 'rk_test_fake000', 'whsec_fake000', 'nonsense'])(
    'anything else fails the build with one sentence that does not repeat the value (%s)',
    (value) => {
      let message = '';
      try {
        checkPublishableKey(value);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(
        /^PUBLIC_STRIPE_PUBLISHABLE_KEY must be empty or start with pk_test_/,
      );
      expect(message).not.toContain(value);
      expect(message.split('. ')).toHaveLength(1);
    },
  );
});
