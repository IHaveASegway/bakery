// Where the sign-in page sends a visitor once a guest sandbox or a demo-account session exists
// (decision G2, 2026-11-09). The page reads `next` from its own address and takes it only when it
// is one of a few same-site paths, written exactly; anything else, a full URL, `//host`, a
// backslash or an encoded slash included, is ignored and the default for that way in is used. A
// fixed list rather than a same-origin check, so no address the bakery did not name can be an open
// redirect.

/** The paths `next` may name, each with the words its "Continue" link says. */
export const NEXT_PATHS = {
  '/menu/': 'the menu',
  '/checkout/': 'checkout',
  '/app/': 'the console',
  '/catering/': 'catering',
  '/inbox/': 'the inbox',
} as const;

export type NextPath = keyof typeof NEXT_PATHS;

/** Where a signed-in visitor (a demo account) goes when `next` is missing or not on the list. */
export const DEFAULT_NEXT: NextPath = '/app/';

/**
 * Where a new guest goes when `next` is missing or not on the list: the menu, since a guest came to
 * order (the start page's first button is "Order something") and the console is one press away in
 * the header. Decided on 2026-11-10 from the audit's walk, which found a guest dropped in the
 * kitchen with the checkout gone.
 */
export const GUEST_NEXT: NextPath = '/menu/';

const isNextPath = (value: string): value is NextPath => Object.hasOwn(NEXT_PATHS, value);

/**
 * The `next` parameter of a query string ("?next=/menu/"), when it is on the list, else
 * `fallback` (the console unless said otherwise). The first `next` is compared as written, before
 * any decoding, so `/menu%2F` and every other escaped spelling is refused rather than decoded into
 * something that matches.
 */
export function nextFrom(search: string, fallback: NextPath = DEFAULT_NEXT): NextPath {
  const pair = search
    .replace(/^\?/, '')
    .split('&')
    .find((p) => p.startsWith('next='));
  const raw = pair?.slice('next='.length);
  return raw !== undefined && isNextPath(raw) ? raw : fallback;
}

/**
 * The listed path a page is at ("/catering/" for "/catering/"), or null for a page not on the list.
 * Exact, as `nextFrom` is: a page further down ("/app/dispatch/") is not its parent.
 */
export const listedPath = (pathname: string): NextPath | null =>
  isNextPath(pathname) ? pathname : null;

/**
 * The sign-in page's address that comes back to `path` afterwards. Always named, since a guest and
 * a signed-in visitor have different defaults; with no listed page, the bare sign-in page.
 */
export const signinFor = (path: NextPath | null): string =>
  path === null ? '/signin/' : `/signin/?next=${path}`;
