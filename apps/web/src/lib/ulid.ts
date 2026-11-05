// A ULID (https://github.com/ulid/spec): 48 bits of milliseconds, then 80 random bits, in
// Crockford base32, 26 upper-case characters. The API wants one as the Idempotency-Key of every
// POST. Sorting the strings sorts them by time.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(
  now: number = Date.now(),
  fill: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  let time = '';
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
  const bytes = fill(new Uint8Array(10));
  // 80 bits are 16 groups of 5; take them through a bit buffer.
  let random = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      random += ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return time + random;
}
