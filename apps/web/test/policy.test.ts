import { describe, expect, test } from 'vitest';
import {
  CHALLENGE_PATHS,
  DEFAULT_API_ORIGIN,
  ISLAND_PATHS,
  PAYMENT_PATHS,
  RULE_PATHS,
  csp,
  directives,
  headersFile,
  normalizeOrigin,
  socketOrigin,
} from '../src/policy';

describe('connect-src follows the API origin', () => {
  test('the default is the production API, with wss:', () => {
    expect(directives('every', DEFAULT_API_ORIGIN)['connect-src']).toEqual([
      "'self'",
      'https://api.bakery.ihaveasegway.com',
      'wss://api.bakery.ihaveasegway.com',
    ]);
  });

  test('a local http origin gets ws:', () => {
    expect(directives('every', 'http://127.0.0.1:8788')['connect-src']).toEqual([
      "'self'",
      'http://127.0.0.1:8788',
      'ws://127.0.0.1:8788',
    ]);
  });

  test('a path or trailing slash in the setting cannot widen the policy', () => {
    expect(normalizeOrigin('https://api.example.com/v1/')).toBe('https://api.example.com');
    expect(socketOrigin('https://api.example.com/x')).toBe('wss://api.example.com');
  });

  test('anything but http(s) is refused', () => {
    expect(() => normalizeOrigin('javascript:alert(1)')).toThrow();
    expect(() => normalizeOrigin('not a url')).toThrow();
  });
});

describe('page classes', () => {
  test('only the challenge class names Turnstile, in script-src and frame-src', () => {
    const every = directives('every', DEFAULT_API_ORIGIN);
    const challenge = directives('challenge', DEFAULT_API_ORIGIN);
    expect(every['script-src']).toEqual(["'self'"]);
    expect(every['frame-src']).toEqual(["'none'"]);
    expect(challenge['script-src']).toContain('https://challenges.cloudflare.com');
    expect(challenge['frame-src']).toEqual(['https://challenges.cloudflare.com']);
    expect(csp('every', DEFAULT_API_ORIGIN)).not.toContain('cloudflare');
  });

  test('the island class is the strict policy: no Turnstile, no frames', () => {
    const island = directives('island', DEFAULT_API_ORIGIN);
    expect(island['script-src']).toEqual(["'self'"]);
    expect(island['frame-src']).toEqual(["'none'"]);
    expect(csp('island', DEFAULT_API_ORIGIN)).not.toContain('cloudflare');
    expect(island['connect-src']).toEqual(directives('every', DEFAULT_API_ORIGIN)['connect-src']);
  });

  test('the payment class adds exactly Stripe’s three origins to the island class', () => {
    const island = directives('island', DEFAULT_API_ORIGIN);
    const payment = directives('payment', DEFAULT_API_ORIGIN);
    expect(payment['script-src']).toEqual(["'self'", 'https://js.stripe.com']);
    expect(payment['frame-src']).toEqual(['https://js.stripe.com', 'https://hooks.stripe.com']);
    expect(payment['connect-src']).toEqual([...island['connect-src']!, 'https://api.stripe.com']);
    // Everything else is the island class, unchanged.
    for (const name of Object.keys(island)) {
      if (['script-src', 'frame-src', 'connect-src'].includes(name)) continue;
      expect(payment[name], name).toEqual(island[name]);
    }
    expect(csp('payment', DEFAULT_API_ORIGIN)).not.toContain('cloudflare');
  });

  test('no other class names a Stripe origin', () => {
    for (const pageClass of ['every', 'challenge', 'island'] as const) {
      expect(csp(pageClass, DEFAULT_API_ORIGIN)).not.toContain('stripe.com');
    }
  });

  test('the payment class keeps the page’s inline hashes', () => {
    const hashes = { script: ["'sha256-AAAA'"], style: ["'sha256-BBBB'"] };
    const payment = directives('payment', DEFAULT_API_ORIGIN, hashes);
    expect(payment['script-src']).toEqual(["'self'", 'https://js.stripe.com', "'sha256-AAAA'"]);
    expect(payment['style-src']).toEqual(["'self'", "'sha256-BBBB'"]);
  });

  test('the island class carries the page’s inline hashes, and the other classes can too', () => {
    const hashes = { script: ["'sha256-AAAA'"], style: ["'sha256-BBBB'"] };
    const island = directives('island', DEFAULT_API_ORIGIN, hashes);
    expect(island['script-src']).toEqual(["'self'", "'sha256-AAAA'"]);
    expect(island['style-src']).toEqual(["'self'", "'sha256-BBBB'"]);
  });

  test('nothing is unsafe in any class', () => {
    for (const pageClass of ['every', 'challenge', 'island', 'payment'] as const) {
      expect(csp(pageClass, DEFAULT_API_ORIGIN)).not.toMatch(/unsafe-|sha256-|\*/);
    }
  });
});

describe('headersFile', () => {
  test('never mentions HSTS outside a comment', () => {
    const body = headersFile(DEFAULT_API_ORIGIN)
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n');
    expect(body.toLowerCase()).not.toContain('strict-transport-security');
  });

  test('the menu and the inbox get an island rule, the checkout and catering pages a payment rule: detach, then their own policy and hashes', () => {
    expect(ISLAND_PATHS).toEqual(['/menu/*', '/inbox/*']);
    expect(PAYMENT_PATHS).toEqual(['/checkout/*', '/catering/*']);
    expect(RULE_PATHS).toEqual([...CHALLENGE_PATHS, ...ISLAND_PATHS, ...PAYMENT_PATHS]);
    const hashes = { script: ["'sha256-AAAA'"], style: ["'sha256-BBBB'"] };
    const file = headersFile(DEFAULT_API_ORIGIN, {
      '/menu/*': hashes,
      '/inbox/*': hashes,
      '/checkout/*': hashes,
      '/catering/*': hashes,
    });
    for (const path of [...ISLAND_PATHS, ...PAYMENT_PATHS]) {
      const at = file.split('\n').indexOf(path);
      expect(at).toBeGreaterThan(0);
      const lines = file.split('\n').slice(at + 1, at + 3);
      expect(lines[0]).toBe('  ! Content-Security-Policy');
      expect(lines[1]).toContain("'sha256-AAAA';");
      expect(lines[1]).not.toContain('challenges.cloudflare.com');
    }
    // Turnstile is named exactly by the challenge rules: two paths, script-src and frame-src each.
    expect(file.split('challenges.cloudflare.com').length - 1).toBe(CHALLENGE_PATHS.length * 2);
    // Stripe: script-src, two frame-src origins, connect-src; only in the payment rules.
    expect(file.split('stripe.com').length - 1).toBe(4 * PAYMENT_PATHS.length);
  });

  test('the inbox is an island page: the strict policy and its hashes, no Stripe and no Turnstile', () => {
    const lines = headersFile(DEFAULT_API_ORIGIN, {
      '/inbox/*': { script: ["'sha256-AAAA'"], style: [] },
    }).split('\n');
    const at = lines.indexOf('/inbox/*');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe('  ! Content-Security-Policy');
    expect(lines[at + 2]).toBe(
      `  Content-Security-Policy: ${csp('island', DEFAULT_API_ORIGIN, { script: ["'sha256-AAAA'"], style: [] })}`,
    );
    expect(lines[at + 2]).not.toContain('stripe.com');
    expect(lines[at + 2]).not.toContain('cloudflare');
  });

  test('the catering page is a payment page: its rule carries the payment policy, and nothing else does', () => {
    const lines = headersFile(DEFAULT_API_ORIGIN).split('\n');
    const at = lines.indexOf('/catering/*');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe('  ! Content-Security-Policy');
    expect(lines[at + 2]).toBe(`  Content-Security-Policy: ${csp('payment', DEFAULT_API_ORIGIN)}`);
    // The one rule that names Stripe and the page it belongs to are the same set as PAYMENT_PATHS.
    const withStripe = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.startsWith('/'))
      .filter(({ i }) => (lines[i + 2] ?? '').includes('stripe.com'))
      .map(({ line }) => line);
    expect(withStripe).toEqual(PAYMENT_PATHS);
  });

  test('puts the given API origin in every policy', () => {
    const file = headersFile('http://127.0.0.1:8788');
    expect(file).toContain("connect-src 'self' http://127.0.0.1:8788 ws://127.0.0.1:8788");
    expect(file).not.toContain('bakery.ihaveasegway.com;');
  });
});
