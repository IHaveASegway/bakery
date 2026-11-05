import { describe, expect, test } from 'vitest';
import { ulid } from '../src/lib/ulid';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('ulid', () => {
  test('is 26 upper-case Crockford base32 characters', () => {
    for (let i = 0; i < 50; i++) expect(ulid()).toMatch(CROCKFORD);
  });

  test('sorts by time', () => {
    const times = [0, 1, 1_000, 1_700_000_000_000, 1_700_000_000_001, 2 ** 48 - 1];
    const ids = times.map((t) => ulid(t));
    expect([...ids].sort()).toEqual(ids);
  });

  test('encodes the time in the first 10 characters', () => {
    expect(ulid(0, (b) => b).slice(0, 10)).toBe('0000000000');
    expect(ulid(32, (b) => b).slice(0, 10)).toBe('0000000010');
    expect(ulid(2 ** 48 - 1, (b) => b).slice(0, 10)).toBe('7ZZZZZZZZZ');
  });

  test('encodes 80 random bits in the last 16', () => {
    expect(ulid(0, (b) => b.fill(0)).slice(10)).toBe('0000000000000000');
    expect(ulid(0, (b) => b.fill(255)).slice(10)).toBe('ZZZZZZZZZZZZZZZZ');
  });

  test('two ids in the same millisecond differ', () => {
    expect(ulid(5)).not.toBe(ulid(5));
  });
});
