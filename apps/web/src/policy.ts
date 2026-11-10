/*
  The storefront's page policy: one module owns every directive and every security header, and the
  build writes them to dist/_headers (docs/security.md, "The storefront's policy"). This replaces the
  static public/_headers, which could not name the API origin the build was given. It follows the
  site's ADR 0018 (page policy as a header):
  https://github.com/IHaveASegway/website/blob/main/docs/adr/0018-page-policy-as-a-header.md

  Four page classes. Every page gets the strict policy, which names no third party, so a visitor
  reading the privacy page loads nothing from Cloudflare. Pages that create a sandbox or an account
  (/signin/ now, /app/ because it can create a sandbox too) are the challenge class: they add
  Turnstile's origin to script-src and frame-src, and nothing else. Pages with an island but no
  third party (/menu/ and /inbox/, and since the tour, now the guide, /privacy/ and /docs/api/, and since PR 13
  /status/, and since 2026-11-09 the order's status page, /order/) are the island class: the strict
  policy plus the hashes below. The start page carries the guide too, but it has no rule of its own:
  it is the one page whose rule would have no splat (`/`), and on launch day, 2026-11-06, production
  applied both that rule's policy and `/*`'s to it, the detach notwithstanding, while wrangler dev
  applied the file as written. So the start page's hashes ride in the `/*` rule, which hashesByRule
  gives the pages no other rule claims, and no rule in the file is without a splat
  (test/headers.test.ts). The checkout (/checkout/) and the catering page (/catering/) are the
  payment class, the island class plus the three Stripe origins the Payment Element needs: its
  script, its frames (3-D Secure included) and its API. No other page names a Stripe origin, and
  these two load Stripe.js only once an order has been placed or a quote accepted, for the deposit
  (docs/security.md, "The storefront's policy";
  https://docs.stripe.com/security/guide#content-security-policy).

  No page of ours holds inline code of its own, but Astro writes two small inline pieces into a
  page with a hydrated island: the <astro-island> definition script and a one-rule style. So every
  page of the challenge and island classes allows those by SHA-256 hash, read from the built HTML
  by scripts/inline-hashes.mjs, and never by 'unsafe-inline' or 'unsafe-eval'. Pages with no
  island get no hash: as of 2026-11-09 seventeen of them, About, How it's built, its fourteen
  essays and the 404.

  The dispatch screen (/app/dispatch/) is a fifth class, the challenge class plus worker-src 'self'
  so its module Web Worker can load. The solver that worker runs sits in /app/dispatch/solver/,
  whose files get a policy of their own. A worker takes its policy from its own response, never
  from the page that starts it, and compiling WebAssembly needs 'wasm-unsafe-eval', so that one
  folder is the one place the keyword appears, exactly as in the site's Route Lab (its _headers,
  and ADR 0016: https://github.com/IHaveASegway/website/blob/main/docs/adr/0016-route-lab-in-the-browser.md).
  No page's policy may hold it (docs/security.md, "The storefront's policy").

  Strict-Transport-Security is the zone's alone and never appears (site ADR 0011).
*/

export type PageClass = 'every' | 'challenge' | 'dispatch' | 'island' | 'payment';

/** Where the browser reaches the API when nothing says otherwise. */
export const DEFAULT_API_ORIGIN = 'https://api.bakery.ihaveasegway.com';

const TURNSTILE = 'https://challenges.cloudflare.com';
const STRIPE_SCRIPT = 'https://js.stripe.com';
const STRIPE_FRAMES = ['https://js.stripe.com', 'https://hooks.stripe.com'];
const STRIPE_API = 'https://api.stripe.com';

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
  // The dispatch screen is under /app/, so it keeps the challenge class and adds the worker.
  const dispatch = pageClass === 'dispatch';
  const challenge = pageClass === 'challenge' || dispatch;
  const payment = pageClass === 'payment';
  return {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      ...(challenge ? [TURNSTILE] : []),
      ...(payment ? [STRIPE_SCRIPT] : []),
      ...hashes.script,
    ],
    'style-src': ["'self'", ...hashes.style],
    'img-src': ["'self'"],
    'font-src': ["'self'"],
    'connect-src': ["'self'", api, socketOrigin(api), ...(payment ? [STRIPE_API] : [])],
    'frame-src': challenge ? [TURNSTILE] : payment ? STRIPE_FRAMES : ["'none'"],
    ...(dispatch ? { 'worker-src': ["'self'"] } : {}),
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

/** The dispatch screen: the challenge class, plus `worker-src 'self'` for the solver's module worker. */
export const DISPATCH_PATHS = ['/app/dispatch/*'];

/**
 * The solver's folder: VROOM compiled to WebAssembly and the worker that runs it, fetched at build
 * (scripts/fetch-solver.mjs). Its files carry this policy and no other, the site's Route Lab policy
 * for the same files. `connect-src 'self'` lets the glue fetch vroom.wasm beside it. base-uri,
 * form-action and frame-ancestors do not fall back to default-src, so they are named: a worker
 * ignores them, and the 404 a missing file here gets stays as unframeable as every other response.
 */
export const SOLVER_PATH = '/app/dispatch/solver/*';
export const SOLVER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Pages with a hydrated island and no third party: the menu and the inbox, and since PR 10 the
 * privacy page and the API reference, which carry the guide (components/Guide.tsx; the tour until
 * 2026-11-09) and nothing else. The start page carries the guide as well but is not here: its rule would be `/`, the one
 * path without a splat, which production applied beside `/*` instead of in its place (2026-11-06,
 * the header comment above), so its hashes go to the `/*` rule. An order's status page (/order/,
 * since 2026-11-09) is here too: it reads the order and the kitchen socket, both on the API's
 * origins, and loads no third party.
 */
export const ISLAND_PATHS = [
  '/menu/*',
  '/inbox/*',
  '/privacy/*',
  '/docs/api/*',
  '/status/*',
  '/order/*',
];

/** Pages that load Stripe: the checkout's payment step and the catering page's deposit step. */
export const PAYMENT_PATHS = ['/checkout/*', '/catering/*'];

/** Every path that gets a rule of its own, which scripts/inline-hashes.mjs reads hashes for. */
export const RULE_PATHS = [
  ...CHALLENGE_PATHS,
  ...DISPATCH_PATHS,
  ...ISLAND_PATHS,
  ...PAYMENT_PATHS,
];

/**
 * The contents of dist/_headers. Cloudflare applies every matching rule in file order; a header a
 * later rule sets again is appended, which for the policy would mean two policies, both enforced.
 * So a challenge or island rule first detaches the policy and then sets its own. Every rule's path
 * ends in a splat: the start page, whose rule would not, got both policies on production
 * (2026-11-06), so the `/*` rule carries its hashes instead.
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
  for (const path of DISPATCH_PATHS) {
    lines.push(
      '# The dispatch screen: the sign-in class plus a module Web Worker for the solver.',
      path,
      '  ! Content-Security-Policy',
      `  Content-Security-Policy: ${csp('dispatch', apiOrigin, of(path))}`,
      '',
    );
  }
  lines.push(
    '# The solver (ADR 0012): VROOM as WebAssembly, run in a module Web Worker. A worker takes its policy',
    "# from its own response, and compiling WebAssembly needs 'wasm-unsafe-eval', the one place the",
    "# keyword appears. The page rules above have none, so this rule detaches the page policy first ('!'):",
    "# two policies would both be enforced, and the page's would refuse the compile. The folder is named for",
    "# the solver's version and a hash of its files (solver.lock.json), so a year is safe.",
    SOLVER_PATH,
    '  ! Content-Security-Policy',
    `  Content-Security-Policy: ${SOLVER_CSP}`,
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  );
  for (const path of ISLAND_PATHS) {
    lines.push(
      '# These pages hold an island (the menu, the inbox, the tour) and load nothing from a third party.',
      path,
      '  ! Content-Security-Policy',
      `  Content-Security-Policy: ${csp('island', apiOrigin, of(path))}`,
      '',
    );
  }
  for (const path of PAYMENT_PATHS) {
    lines.push(
      '# The checkout and the catering page load Stripe for a payment step, and only they do.',
      path,
      '  ! Content-Security-Policy',
      `  Content-Security-Policy: ${csp('payment', apiOrigin, of(path))}`,
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
