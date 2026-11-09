import { isIPv6 } from 'node:net';
import { describe, expect, it } from 'vitest';
import { clientAddresses } from '../e2e/addresses';

// The e2e suite's client addresses (e2e/addresses.ts): never two tests on one address.
describe('e2e client addresses', () => {
  it('never repeat within a worker', () => {
    const next = clientAddresses();
    const seen = new Set(Array.from({ length: 5000 }, () => next(0)));
    expect(seen.size).toBe(5000);
  });

  it('never repeat across workers, a restarted worker included', () => {
    // A worker that fails is replaced by one with a new index and a fresh counter.
    const all = [0, 1, 2, 15, 16].flatMap((worker) => {
      const next = clientAddresses();
      return Array.from({ length: 300 }, () => next(worker));
    });
    expect(new Set(all).size).toBe(all.length);
  });

  it('are IPv6 documentation addresses', () => {
    const next = clientAddresses();
    for (let i = 0; i < 300; i += 1) {
      const address = next(3);
      expect(isIPv6(address), address).toBe(true);
      expect(address.startsWith('2001:db8:')).toBe(true);
    }
  });
});
