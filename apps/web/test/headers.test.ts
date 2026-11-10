import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { inlineHashes } from '../scripts/inline-hashes.mjs';
import { SOLVER_CSP } from '../src/policy';

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
    '/app/dispatch/*',
    '/menu/*',
    '/inbox/*',
    '/privacy/*',
    '/docs/api/*',
    '/status/*',
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
    expect(policy).not.toContain('stripe.com');
    expect(directive(policy, 'frame-src')).toEqual(["'none'"]);
    // 'self' and the start page's two inline hashes (Astro's island loader and its style), which
    // ride here because the start page has no rule of its own (src/policy.ts, ISLAND_PATHS).
    const scripts = directive(policy, 'script-src');
    expect(scripts[0]).toBe("'self'");
    expect(scripts.slice(1)).not.toHaveLength(0);
    for (const source of scripts.slice(1)) expect(source).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);
    const styles = directive(policy, 'style-src');
    expect(styles[0]).toBe("'self'");
    for (const source of styles.slice(1)) expect(source).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);
  });

  test('every rule path ends in a splat: on production a rule for `/` alone was applied beside `/*`, and the start page got two policies (2026-11-06)', () => {
    const paths = text.split('\n').filter((line) => line.startsWith('/'));
    expect(paths).toContain('/*');
    for (const path of paths) expect(path, path).toMatch(/\/\*$/);
  });

  // The menu since 2026-11-10: its Start ordering makes a guest sandbox in place (audit F1).
  test.each(['/signin/*', '/app/*', '/menu/*'])(
    '%s adds Turnstile to script-src and frame-src',
    (path) => {
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
    },
  );

  test('/app/dispatch/* is the sign-in class plus worker-src self, and detaches the /app/* policy first', () => {
    const lines = rule(text, '/app/dispatch/*');
    expect(lines.indexOf('! Content-Security-Policy')).toBe(0);
    const policy = policyOf(lines);
    const app = policyOf(rule(text, '/app/*'));
    expect(directive(policy, 'worker-src')).toEqual(["'self'"]);
    expect(directive(app, 'worker-src')).toEqual([]);
    expect(directive(policy, 'script-src').slice(0, 2)).toEqual([
      "'self'",
      'https://challenges.cloudflare.com',
    ]);
    expect(directive(policy, 'frame-src')).toEqual(['https://challenges.cloudflare.com']);
    expect(directive(policy, 'connect-src')).toEqual(directive(app, 'connect-src'));
    expect(
      directive(policy, 'script-src').filter((s) => s.startsWith("'sha256-")),
    ).not.toHaveLength(0);
    // Nothing else differs from the /app/* policy.
    const names = (p: string) => p.split('; ').map((part) => part.split(' ')[0]);
    expect(names(policy).filter((n) => !names(app).includes(n))).toEqual(['worker-src']);
  });

  test('the solver’s folder carries its own policy, the site’s Route Lab policy, after the page rules that match it', () => {
    const lines = rule(text, '/app/dispatch/solver/*');
    expect(lines[0]).toBe('! Content-Security-Policy');
    const policy = policyOf(lines);
    expect(policy).toBe(SOLVER_CSP);
    expect(directive(policy, 'script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directive(policy, 'connect-src')).toEqual(["'self'"]);
    expect(directive(policy, 'default-src')).toEqual(["'none'"]);
    expect(lines).toContain('Cache-Control: public, max-age=31536000, immutable');
    // Later rules win: it must come after every rule whose path also matches its files.
    const order = text.split('\n').filter((l) => l.startsWith('/'));
    const at = order.indexOf('/app/dispatch/solver/*');
    for (const earlier of ['/*', '/app/*', '/app/dispatch/*']) {
      expect(order.indexOf(earlier), earlier).toBeLessThan(at);
    }
  });

  test('wasm-unsafe-eval appears once in the whole file, in the solver’s rule', () => {
    const code = text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    const holders = code.filter((line) => line.includes('wasm-unsafe-eval'));
    expect(holders).toHaveLength(1);
    expect(rule(text, '/app/dispatch/solver/*').join('\n')).toContain('wasm-unsafe-eval');
    // And no page policy has any other unsafe keyword.
    for (const path of rules) {
      expect(policyOf(rule(text, path)), path).not.toContain('wasm-unsafe-eval');
    }
  });

  test.each(['/inbox/*', '/privacy/*', '/docs/api/*', '/status/*'])(
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
      // The checkout also starts a guest sandbox in place (2026-11-10), so it names Turnstile too.
      const turnstile = path === '/checkout/*' ? ['https://challenges.cloudflare.com'] : [];
      if (turnstile.length === 0) expect(policy).not.toContain('challenges.cloudflare.com');
      expect(directive(policy, 'script-src').slice(0, 2 + turnstile.length)).toEqual([
        "'self'",
        ...turnstile,
        'https://js.stripe.com',
      ]);
      // The island hashes stay.
      expect(
        directive(policy, 'script-src').filter((s) => s.startsWith("'sha256-")),
      ).not.toHaveLength(0);
      expect(directive(policy, 'frame-src')).toEqual([
        ...turnstile,
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

  test('no rule carries unsafe-inline, unsafe-eval or a nonce; "/*" carries the start page’s hashes and no other source', () => {
    for (const path of rules) {
      expect(policyOf(rule(text, path))).not.toMatch(/unsafe-|nonce-/);
    }
    const every = policyOf(rule(text, '/*'));
    const home = inlineHashes(
      readFileSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)), 'utf8'),
    );
    expect(directive(every, 'script-src')).toEqual(["'self'", ...home.script]);
    expect(directive(every, 'style-src')).toEqual(["'self'", ...home.style]);
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
