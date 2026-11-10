import type { Phase } from '../lib/use-session';

/** One sentence about the visitor's sandbox, for the storefront pages. A live region. */
export default function StatusLine({
  phase,
  signedOut,
  tour,
}: {
  phase: Phase;
  /** The guide's target on this line, where a page's story is about its sandbox's reads. */
  tour?: string;
  /** The sentence for a visitor with no sandbox, for a screen where "ordering is off" is not the point. */
  signedOut?: React.ReactNode;
}) {
  let text: React.ReactNode = null;
  switch (phase.name) {
    case 'loading':
      text = 'Looking for your sandbox…';
      break;
    case 'seeding':
      text = 'Seeding your bakery. This takes a few seconds; the page updates by itself.';
      break;
    case 'live':
      text = 'Your sandbox is live. Orders you place here go to it.';
      break;
    case 'offline':
      text = 'The API is unreachable, so the demo’s own menu is shown and nothing can be ordered.';
      break;
    case 'nosession':
    case 'nosandbox':
      text = (
        <>
          {signedOut ??
            'You have no sandbox yet, so this is the demo’s seed menu and ordering is off.'}{' '}
          <a href="/signin/">Sign in or try it as a guest</a>.
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
