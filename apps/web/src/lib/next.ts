// Where the sign-in page sends a visitor once a guest sandbox or a demo-account session exists
// (decision G2, 2026-11-09). The page reads `next` from its own address and takes it only when it
// is one of a few same-site paths, written exactly; anything else, a full URL, `//host`, a
// backslash or an encoded slash included, is ignored and the console is the default. A fixed list
// rather than a same-origin check, so no address the bakery did not name can be an open redirect.

/** The paths `next` may name, each with the words its "Continue" link says. */
export const NEXT_PATHS = {
  '/menu/': 'the menu',
  '/checkout/': 'checkout',
  '/app/': 'the console',
  '/catering/': 'catering',
  '/inbox/': 'the inbox',
} as const;

export type NextPath = keyof typeof NEXT_PATHS;

/** Where a visitor goes when `next` is missing or not on the list. */
export const DEFAULT_NEXT: NextPath = '/app/';

const isNextPath = (value: string): value is NextPath => Object.hasOwn(NEXT_PATHS, value);

/**
 * The `next` parameter of a query string ("?next=/menu/"), when it is on the list, else the
 * console. The first `next` is compared as written, before any decoding, so `/menu%2F` and every
 * other escaped spelling is refused rather than decoded into something that matches.
 */
export function nextFrom(search: string): NextPath {
  const pair = search
    .replace(/^\?/, '')
    .split('&')
    .find((p) => p.startsWith('next='));
  const raw = pair?.slice('next='.length);
  return raw !== undefined && isNextPath(raw) ? raw : DEFAULT_NEXT;
}

/** The sign-in page's address that comes back to `path` afterwards. */
export const signinFor = (path: NextPath): string =>
  path === DEFAULT_NEXT ? '/signin/' : `/signin/?next=${path}`;
