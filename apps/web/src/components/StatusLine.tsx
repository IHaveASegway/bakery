import type { Phase } from '../lib/use-session';

/** One sentence about the visitor's sandbox, for the storefront pages. A live region. */
export default function StatusLine({ phase }: { phase: Phase }) {
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
          You have no sandbox yet, so this is the demo’s seed menu and ordering is off.{' '}
          <a href="/signin/">Sign in or try it as a guest</a>.
        </>
      );
      break;
  }
  return (
    <p className="hint" aria-live="polite">
      {text}
    </p>
  );
}
