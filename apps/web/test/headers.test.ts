import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// security.md, "Headers and Content Security Policy": the storefront's headers as built. Run after
// `pnpm build`; the file under test is the one the Worker serves.

const file = fileURLToPath(new URL('../dist/_headers', import.meta.url));

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self' https://api.bakery.ihaveasegway.com wss://api.bakery.ihaveasegway.com",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

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

describe('dist/_headers', () => {
  expect(existsSync(file), 'run pnpm build first').toBe(true);
  const text = readFileSync(file, 'utf8');

  test('the "/*" rule carries the policy and the other security headers', () => {
    const all = rule(text, '/*');
    expect(all).toContain(`Content-Security-Policy: ${CSP}`);
    expect(all).toContain('X-Content-Type-Options: nosniff');
    expect(all).toContain('Referrer-Policy: strict-origin-when-cross-origin');
    expect(all).toContain('Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=()');
    expect(all).toContain('Cross-Origin-Opener-Policy: same-origin');
  });

  test('the policy has no unsafe keyword and no hash: the pages hold no inline code', () => {
    expect(CSP).not.toMatch(/unsafe-|sha256-/);
  });

  test('bundles are cached for a year, immutable', () => {
    expect(rule(text, '/_astro/*')).toContain('Cache-Control: public, max-age=31536000, immutable');
  });

  test('Strict-Transport-Security is the zone’s alone', () => {
    const lines = text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    expect(lines.join('\n').toLowerCase()).not.toContain('strict-transport-security');
  });
});
