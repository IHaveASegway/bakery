// The landing of a sign-in with Google or GitHub (audit G11, 2026-11-10): the provider links come
// back to /app/start/, a path the API's return-path rule keeps as it is (crates/app/src/auth/
// oauth.rs, `return_path`: a slash, then lower-case letters, digits, slashes and hyphens, never a
// query, or the API falls back to /app/), and the page that path builds mounts the console with
// `start`, while /app/ itself does not.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { SIGNIN_RETURN, apiOrigin, signinUrl } from '../src/lib/api';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

describe('the sign-in’s landing', () => {
  test('the provider links come back to /app/start/, a path the API keeps', () => {
    expect(SIGNIN_RETURN).toBe('/app/start/');
    expect(SIGNIN_RETURN).toMatch(/^\/[a-z0-9/-]*$/);
    for (const provider of ['google', 'github'] as const) {
      expect(signinUrl(provider)).toBe(`${apiOrigin}/v1/auth/${provider}/start?return=/app/start/`);
    }
  });

  test('the landing starts a sandbox and /app/ does not', () => {
    expect(read('../src/pages/app/start/index.astro')).toContain('<StartConsole client:load />');
    expect(read('../src/components/StartConsole.tsx')).toMatch(/<Console [^>]*\bstart\b/);
    expect(read('../src/pages/app/index.astro')).not.toContain('StartConsole');
  });

  test('the landing is a step, not a page to find: noindex, the console’s screen', () => {
    const page = read('../src/pages/app/start/index.astro');
    expect(page).toContain('noindex');
    expect(page).toContain('screen="console"');
  });
});
