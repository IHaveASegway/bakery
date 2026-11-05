import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// security.md, "Headers, CSP and CORS": the storefront's headers as built by src/policy.ts. Run
// after `pnpm build`; the file under test is the one the Worker serves.

const file = fileURLToPath(new URL('../dist/_headers', import.meta.url));

/** The lines of one rule: the header lines under a path, until the next path or a blank line. */
function rule(text: string, path: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === path);
  if (start < 0) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(' ')) break;
    body.push(line.trim());
  }
  return body;
}

const policyOf = (lines: string[]) =>
  lines
    .find((line) => line.startsWith('Content-Security-Policy: '))
    ?.slice('Content-Security-Policy: '.length) ?? '';

/** One directive's sources, split. */
function directive(policy: string, name: string): string[] {
  const found = policy.split('; ').find((part) => part.startsWith(`${name} `));
  return found ? found.slice(name.length + 1).split(' ') : [];
}

describe('dist/_headers', () => {
  expect(existsSync(file), 'run pnpm build first').toBe(true);
  const text = readFileSync(file, 'utf8');
  const rules = [
    '/*',
    '/signin/*',
    '/app/*',
    '/menu/*',
    '/inbox/*',
    '/checkout/*',
    '/catering/*',
    '/_astro/*',
  ];
  const paymentRules = ['/checkout/*', '/catering/*'];

  test('the "/*" rule carries the policy and the other security headers', () => {
    const all = rule(text, '/*');
    const policy = policyOf(all);
    expect(directive(policy, 'default-src')).toEqual(["'self'"]);
    expect(directive(policy, 'object-src')).toEqual(["'none'"]);
    expect(directive(policy, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(policy, 'connect-src')[0]).toBe("'self'");
    expect(all).toContain('X-Content-Type-Options: nosniff');
    expect(all).toContain('Referrer-Policy: strict-origin-when-cross-origin');
    expect(all).toContain('Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=()');
    expect(all).toContain('Cross-Origin-Opener-Policy: same-origin');
  });

  test('"/*" names no third party: a visitor reading a page loads nothing from Cloudflare', () => {
    const policy = policyOf(rule(text, '/*'));
    expect(policy).not.toContain('challenges.cloudflare.com');
    expect(directive(policy, 'frame-src')).toEqual(["'none'"]);
    expect(directive(policy, 'script-src')).toEqual(["'self'"]);
  });

  test.each(['/signin/*', '/app/*'])('%s adds Turnstile to script-src and frame-src', (path) => {
    const lines = rule(text, path);
    // Detach first, then set: otherwise Cloudflare appends a second policy and both are enforced.
    expect(lines.indexOf('! Content-Security-Policy')).toBe(0);
    const policy = policyOf(lines);
    expect(directive(policy, 'script-src').slice(0, 2)).toEqual([
      "'self'",
      'https://challenges.cloudflare.com',
    ]);
    expect(directive(policy, 'frame-src')).toEqual(['https://challenges.cloudflare.com']);
    expect(directive(policy, 'connect-src')).toEqual(
      directive(policyOf(rule(text, '/*')), 'connect-src'),
    );
  });

  test.each(['/menu/*', '/inbox/*'])(
    '%s is an island page: its own policy with hashes, and no third party',
    (path) => {
      const lines = rule(text, path);
      expect(lines.indexOf('! Content-Security-Policy')).toBe(0);
      const policy = policyOf(lines);
      expect(policy).not.toContain('challenges.cloudflare.com');
      expect(policy).not.toContain('stripe.com');
      expect(directive(policy, 'frame-src')).toEqual(["'none'"]);
      // Astro's island loader and its one-rule style are allowed by hash, never by 'unsafe-inline'.
      expect(
        directive(policy, 'script-src').filter((s) => s.startsWith("'sha256-")),
      ).not.toHaveLength(0);
      expect(directive(policy, 'script-src')[0]).toBe("'self'");
      expect(directive(policy, 'connect-src')).toEqual(
        directive(policyOf(rule(text, '/*')), 'connect-src'),
      );
    },
  );

  test.each(paymentRules)(
    '%s is a payment page: the island policy plus exactly Stripe’s three origins',
    (path) => {
      const lines = rule(text, path);
      expect(lines.indexOf('! Content-Security-Policy')).toBe(0);
      const policy = policyOf(lines);
      const base = policyOf(rule(text, '/*'));
      expect(policy).not.toContain('challenges.cloudflare.com');
      expect(directive(policy, 'script-src')[0]).toBe("'self'");
      expect(directive(policy, 'script-src')[1]).toBe('https://js.stripe.com');
      // The island hashes stay.
      expect(
        directive(policy, 'script-src').filter((s) => s.startsWith("'sha256-")),
      ).not.toHaveLength(0);
      expect(directive(policy, 'frame-src')).toEqual([
        'https://js.stripe.com',
        'https://hooks.stripe.com',
      ]);
      expect(directive(policy, 'connect-src')).toEqual([
        ...directive(base, 'connect-src'),
        'https://api.stripe.com',
      ]);
    },
  );

  test('exactly /checkout/* and /catering/* carry a Stripe origin', () => {
    for (const path of rules) {
      const names = rule(text, path).join('\n').includes('stripe.com');
      expect(names, path).toBe(paymentRules.includes(path));
    }
    // And the file names Stripe nowhere outside those rules: four origins in each.
    expect(text.split('stripe.com').length - 1).toBe(4 * paymentRules.length);
  });

  test('no rule carries unsafe-inline, unsafe-eval or a nonce; "/*" carries no hash either', () => {
    for (const path of rules) {
      expect(policyOf(rule(text, path))).not.toMatch(/unsafe-|nonce-/);
    }
    expect(policyOf(rule(text, '/*'))).not.toContain('sha256-');
  });

  test('bundles are cached for a year, immutable, and drop the document-only headers', () => {
    const bundle = rule(text, '/_astro/*');
    expect(bundle).toContain('Cache-Control: public, max-age=31536000, immutable');
    expect(bundle).toContain('! Content-Security-Policy');
    expect(bundle).toContain('! Permissions-Policy');
    expect(bundle).toContain('! Cross-Origin-Opener-Policy');
  });

  test('Strict-Transport-Security is the zone’s alone', () => {
    const lines = text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    expect(lines.join('\n').toLowerCase()).not.toContain('strict-transport-security');
  });
});
