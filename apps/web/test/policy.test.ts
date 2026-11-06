import { describe, expect, test } from 'vitest';
import {
  CHALLENGE_PATHS,
  DEFAULT_API_ORIGIN,
  DISPATCH_PATHS,
  ISLAND_PATHS,
  PAYMENT_PATHS,
  RULE_PATHS,
  SOLVER_CSP,
  SOLVER_PATH,
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

  test('the dispatch class is the challenge class plus worker-src self, and nothing else', () => {
    const challenge = directives('challenge', DEFAULT_API_ORIGIN);
    const dispatch = directives('dispatch', DEFAULT_API_ORIGIN);
    expect(dispatch['worker-src']).toEqual(["'self'"]);
    for (const name of Object.keys(challenge))
      expect(dispatch[name], name).toEqual(challenge[name]);
    expect(Object.keys(dispatch).filter((name) => !(name in challenge))).toEqual(['worker-src']);
    // No other class lets a page start a worker: they fall back to script-src, which has no wasm.
    for (const pageClass of ['every', 'challenge', 'island', 'payment'] as const) {
      expect(directives(pageClass, DEFAULT_API_ORIGIN)['worker-src']).toBeUndefined();
    }
  });

  test('no other class names a Stripe origin', () => {
    for (const pageClass of ['every', 'challenge', 'dispatch', 'island'] as const) {
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
    // The start page has no rule of its own (ISLAND_PATHS), so its hashes ride in the `/*` rule.
    const every = directives('every', DEFAULT_API_ORIGIN, hashes);
    expect(every['script-src']).toEqual(["'self'", "'sha256-AAAA'"]);
    expect(every['style-src']).toEqual(["'self'", "'sha256-BBBB'"]);
  });

  test('no rule path is without a splat: production applied a `/` rule beside `/*`, not in its place (2026-11-06)', () => {
    for (const path of RULE_PATHS) expect(path, path).toMatch(/\/\*$/);
    const paths = headersFile(DEFAULT_API_ORIGIN)
      .split('\n')
      .filter((line) => line.startsWith('/'));
    expect(paths).not.toHaveLength(0);
    for (const path of paths) expect(path, path).toMatch(/\/\*$/);
  });

  test('nothing is unsafe in any class', () => {
    for (const pageClass of ['every', 'challenge', 'dispatch', 'island', 'payment'] as const) {
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
    expect(ISLAND_PATHS).toEqual(['/menu/*', '/inbox/*', '/privacy/*', '/docs/api/*', '/status/*']);
    expect(PAYMENT_PATHS).toEqual(['/checkout/*', '/catering/*']);
    expect(RULE_PATHS).toEqual([
      ...CHALLENGE_PATHS,
      ...DISPATCH_PATHS,
      ...ISLAND_PATHS,
      ...PAYMENT_PATHS,
    ]);
    const hashes = { script: ["'sha256-AAAA'"], style: ["'sha256-BBBB'"] };
    const file = headersFile(DEFAULT_API_ORIGIN, {
      '/menu/*': hashes,
      '/inbox/*': hashes,
      '/privacy/*': hashes,
      '/docs/api/*': hashes,
      '/status/*': hashes,
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
    // Turnstile is named by the challenge rules and the dispatch rule: script-src and frame-src each.
    expect(file.split('challenges.cloudflare.com').length - 1).toBe(
      (CHALLENGE_PATHS.length + DISPATCH_PATHS.length) * 2,
    );
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

  test('the dispatch screen gets a rule that detaches the policy and sets the dispatch class, with its hashes', () => {
    expect(DISPATCH_PATHS).toEqual(['/app/dispatch/*']);
    const hashes = { script: ["'sha256-AAAA'"], style: ["'sha256-BBBB'"] };
    const lines = headersFile(DEFAULT_API_ORIGIN, { '/app/dispatch/*': hashes }).split('\n');
    const at = lines.indexOf('/app/dispatch/*');
    expect(at).toBeGreaterThan(lines.indexOf('/app/*'));
    expect(lines[at + 1]).toBe('  ! Content-Security-Policy');
    expect(lines[at + 2]).toBe(
      `  Content-Security-Policy: ${csp('dispatch', DEFAULT_API_ORIGIN, hashes)}`,
    );
    expect(lines[at + 2]).toContain("worker-src 'self'");
    expect(lines[at + 2]).toContain('challenges.cloudflare.com');
  });

  test('the solver folder is the one place wasm-unsafe-eval appears, in a rule that detaches the page policy first', () => {
    expect(SOLVER_PATH).toBe('/app/dispatch/solver/*');
    expect(SOLVER_CSP).toBe(
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    const file = headersFile(DEFAULT_API_ORIGIN);
    const lines = file.split('\n');
    const at = lines.indexOf(SOLVER_PATH);
    // After the dispatch page's rule, so its policy is the one detached.
    expect(at).toBeGreaterThan(lines.indexOf('/app/dispatch/*'));
    expect(lines[at + 1]).toBe('  ! Content-Security-Policy');
    expect(lines[at + 2]).toBe(`  Content-Security-Policy: ${SOLVER_CSP}`);
    expect(lines[at + 3]).toBe('  Cache-Control: public, max-age=31536000, immutable');
    // Once in the file's rules, and in no page class.
    const rules = lines.filter((line) => !line.startsWith('#'));
    expect(rules.filter((line) => line.includes('wasm-unsafe-eval'))).toHaveLength(1);
    for (const pageClass of ['every', 'challenge', 'dispatch', 'island', 'payment'] as const) {
      expect(csp(pageClass, DEFAULT_API_ORIGIN)).not.toContain('wasm-unsafe-eval');
    }
  });

  test('puts the given API origin in every policy', () => {
    const file = headersFile('http://127.0.0.1:8788');
    expect(file).toContain("connect-src 'self' http://127.0.0.1:8788 ws://127.0.0.1:8788");
    expect(file).not.toContain('bakery.ihaveasegway.com;');
  });
});
