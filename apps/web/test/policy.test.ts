import { describe, expect, test } from 'vitest';
import {
  CHALLENGE_PATHS,
  DEFAULT_API_ORIGIN,
  ISLAND_PATHS,
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

  test('the island class carries the page’s inline hashes, and the other classes can too', () => {
    const hashes = { script: ["'sha256-AAAA'"], style: ["'sha256-BBBB'"] };
    const island = directives('island', DEFAULT_API_ORIGIN, hashes);
    expect(island['script-src']).toEqual(["'self'", "'sha256-AAAA'"]);
    expect(island['style-src']).toEqual(["'self'", "'sha256-BBBB'"]);
  });

  test('nothing is unsafe in any class', () => {
    for (const pageClass of ['every', 'challenge', 'island'] as const) {
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

  test('the menu and the checkout get an island rule: detach, then their own policy and hashes', () => {
    expect(ISLAND_PATHS).toEqual(['/menu/*', '/checkout/*']);
    expect(RULE_PATHS).toEqual([...CHALLENGE_PATHS, ...ISLAND_PATHS]);
    const hashes = { script: ["'sha256-AAAA'"], style: ["'sha256-BBBB'"] };
    const file = headersFile(DEFAULT_API_ORIGIN, { '/menu/*': hashes, '/checkout/*': hashes });
    for (const path of ISLAND_PATHS) {
      const at = file.split('\n').indexOf(path);
      expect(at).toBeGreaterThan(0);
      const lines = file.split('\n').slice(at + 1, at + 3);
      expect(lines[0]).toBe('  ! Content-Security-Policy');
      expect(lines[1]).toContain("script-src 'self' 'sha256-AAAA';");
      expect(lines[1]).not.toContain('challenges.cloudflare.com');
    }
    // Turnstile is named exactly by the challenge rules: two paths, script-src and frame-src each.
    expect(file.split('challenges.cloudflare.com').length - 1).toBe(CHALLENGE_PATHS.length * 2);
  });

  test('puts the given API origin in every policy', () => {
    const file = headersFile('http://127.0.0.1:8788');
    expect(file).toContain("connect-src 'self' http://127.0.0.1:8788 ws://127.0.0.1:8788");
    expect(file).not.toContain('bakery.ihaveasegway.com;');
  });
});
