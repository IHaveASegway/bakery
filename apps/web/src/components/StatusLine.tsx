import { useEffect, useState } from 'react';
import { listedPath, signinFor, type NextPath } from '../lib/next';
import type { Phase } from '../lib/use-session';

/** The live sentence where nothing more is true for every page: the catering page, the inbox. */
export const LIVE_DEFAULT = 'Your sandbox is live.';

/** The live sentence where an order placed on the page goes to the sandbox: the menu, the checkout. */
export const ORDERS_LIVE = 'Your sandbox is live. Orders you place here go to it.';

/** The offline sentence where a page has no more to say: the console's pages. */
export const OFFLINE_DEFAULT =
  'The API is unreachable, so nothing here can be read or changed right now.';

/**
 * The offline sentence, true on each page: what cannot be done there while the API is unreachable
 * (2026-11-10: the catering page and the inbox said the demo's own menu was shown, and they show
 * none). A page not named here gets the general one.
 */
export const OFFLINE: Record<NextPath, string> = {
  '/menu/': 'The API is unreachable, so the demo’s own menu is shown and nothing can be ordered.',
  '/checkout/': 'The API is unreachable, so nothing can be ordered or paid for right now.',
  '/catering/':
    'The API is unreachable, so no event can be asked about and your events cannot be shown.',
  '/inbox/': 'The API is unreachable, so your messages cannot be shown.',
  '/app/': OFFLINE_DEFAULT,
};

/** The offline sentence for a page, by its listed path (null for a page not on the list). */
export const offlineFor = (here: NextPath | null): string =>
  here === null ? OFFLINE_DEFAULT : OFFLINE[here];

/** One sentence about the visitor's sandbox, for the storefront pages. A live region. */
export default function StatusLine({
  phase,
  signedOut,
  live,
  tour,
}: {
  phase: Phase;
  /** The guide's target on this line, where a page's story is about its sandbox's reads. */
  tour?: string;
  /** The sentence for a visitor with no sandbox, for a screen where "ordering is off" is not the point. */
  signedOut?: React.ReactNode;
  /**
   * The sentence once the sandbox is live, where the page has more to say that is true of it: the
   * menu and the checkout say orders placed there go to it (2026-11-10: the catering page and the
   * inbox said so too, where it is not true).
   */
  live?: React.ReactNode;
}) {
  // The sign-in link comes back to this page when it is on next.ts's list; read after mount, so
  // the server's HTML and the first render agree (the line has no link until the phase is known).
  const [here, setHere] = useState<NextPath | null>(null);
  useEffect(() => setHere(listedPath(window.location.pathname)), []);

  let text: React.ReactNode = null;
  switch (phase.name) {
    case 'loading':
      text = 'Looking for your sandbox…';
      break;
    case 'seeding':
      text = 'Seeding your bakery. This takes a few seconds; the page updates by itself.';
      break;
    case 'live':
      text = live ?? LIVE_DEFAULT;
      break;
    case 'offline':
      text = offlineFor(here);
      break;
    case 'nosession':
    case 'nosandbox':
      text = (
        <>
          {signedOut ??
            'You have no sandbox yet, so this is the demo’s seed menu and ordering is off.'}{' '}
          <a href={signinFor(here)}>Sign in or try it as a guest</a>.
        </>
      );
      break;
  }
  return (
    <p className="hint" aria-live="polite" data-tour={tour}>
      {text}
    </p>
  );
}
