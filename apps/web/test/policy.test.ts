import { describe, expect, test } from 'vitest';
import {
  DEFAULT_API_ORIGIN,
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

  test('nothing is unsafe in either class', () => {
    for (const pageClass of ['every', 'challenge'] as const) {
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

  test('puts the given API origin in every policy', () => {
    const file = headersFile('http://127.0.0.1:8788');
    expect(file).toContain("connect-src 'self' http://127.0.0.1:8788 ws://127.0.0.1:8788");
    expect(file).not.toContain('bakery.ihaveasegway.com;');
  });
});
