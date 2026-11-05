/*
  The storefront's page policy: one module owns every directive and every security header, and the
  build writes them to dist/_headers (docs/security.md, "The storefront's policy"). This replaces the
  static public/_headers, which could not name the API origin the build was given. It follows the
  site's ADR 0018 (page policy as a header):
  https://github.com/IHaveASegway/website/blob/main/docs/adr/0018-page-policy-as-a-header.md

  Two page classes. Every page gets the strict policy, which names no third party, so a visitor
  reading the privacy page loads nothing from Cloudflare. Pages that create a sandbox or an account
  (/signin/ now, /app/ because it can create a sandbox too) add Turnstile's origin to script-src
  and frame-src, and nothing else.

  No page of ours holds inline code, but Astro writes two small inline pieces into a page with a
  hydrated island: the <astro-island> definition script and a one-rule style. So /signin/ and /app/
  allow those by SHA-256 hash, read from the built HTML by scripts/inline-hashes.mjs, and never by
  'unsafe-inline' or 'unsafe-eval'. Pages with no island, which are all the others, get no hash.

  Strict-Transport-Security is the zone's alone and never appears (site ADR 0011).
*/

export type PageClass = 'every' | 'challenge';

/** Where the browser reaches the API when nothing says otherwise. */
export const DEFAULT_API_ORIGIN = 'https://api.bakery.ihaveasegway.com';

const TURNSTILE = 'https://challenges.cloudflare.com';

/** The origin alone, so a stray path or a trailing slash in the setting cannot widen the policy. */
export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`PUBLIC_API_ORIGIN must be an http(s) origin, got ${value}`);
  }
  return url.origin;
}

/** The WebSocket origin that goes with an API origin: wss: for https:, ws: for http:. */
export function socketOrigin(apiOrigin: string): string {
  return normalizeOrigin(apiOrigin).replace(/^http/, 'ws');
}

/** The directives for one page class, in the order they are written. */
export function directives(
  pageClass: PageClass,
  apiOrigin: string,
  hashes: Hashes = NO_HASHES,
): Record<string, string[]> {
  const api = normalizeOrigin(apiOrigin);
  const challenge = pageClass === 'challenge';
  return {
    'default-src': ["'self'"],
    'script-src': ["'self'", ...(challenge ? [TURNSTILE] : []), ...hashes.script],
    'style-src': ["'self'", ...hashes.style],
    'img-src': ["'self'"],
    'font-src': ["'self'"],
    'connect-src': ["'self'", api, socketOrigin(api)],
    'frame-src': challenge ? [TURNSTILE] : ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
  };
}

/** SHA-256 sources (`'sha256-...'`) for the inline code a page class holds. */
export interface Hashes {
  script: string[];
  style: string[];
}

const NO_HASHES: Hashes = { script: [], style: [] };

export function csp(pageClass: PageClass, apiOrigin: string, hashes: Hashes = NO_HASHES): string {
  return Object.entries(directives(pageClass, apiOrigin, hashes))
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/** The headers that do not vary by page class. */
export const OTHER_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Not `payment`, which the Payment Element may use (PR 5).
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** Pages that load Turnstile. Cloudflare serves a trailing-slash path with the splat matching empty. */
export const CHALLENGE_PATHS = ['/signin/*', '/app/*'];

/**
 * The contents of dist/_headers. Cloudflare applies every matching rule in file order; a header a
 * later rule sets again is appended, which for the policy would mean two policies, both enforced.
 * So a challenge rule first detaches the policy and then sets its own.
 */
export function headersFile(apiOrigin: string, hashes: Record<string, Hashes> = {}): string {
  const of = (path: string) => hashes[path] ?? NO_HASHES;
  const lines = [
    '# Written by src/policy.ts at build. Do not edit: the next build replaces this file.',
    '# Strict-Transport-Security is the zone’s alone and never appears here.',
    '/*',
    `  Content-Security-Policy: ${csp('every', apiOrigin, of('/*'))}`,
    ...Object.entries(OTHER_HEADERS).map(([name, value]) => `  ${name}: ${value}`),
    '',
  ];
  for (const path of CHALLENGE_PATHS) {
    lines.push(
      '# Sign-in and sandbox creation load Turnstile, and only they do.',
      path,
      '  ! Content-Security-Policy',
      `  Content-Security-Policy: ${csp('challenge', apiOrigin, of(path))}`,
      '',
    );
  }
  lines.push(
    '# Bundles named by content hash never change at their URL, so a year and immutable are safe.',
    '# HTML keeps Cloudflare’s default, so a promoted version is what the next page view gets.',
    '# Policies that only documents obey are detached: they would cost header bytes on every bundle.',
    '/_astro/*',
    '  ! Content-Security-Policy',
    '  ! Permissions-Policy',
    '  ! Cross-Origin-Opener-Policy',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  );
  return lines.join('\n');
}
