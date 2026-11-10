import type { LiveMenu } from '../lib/use-live-menu';
import { HOW } from '../guide/how';

/**
 * The small "How this works" line under the menu: where the menu came from and, for a sandbox's own
 * menu, the two headers the API answered with, `Bakery-Cache` and `ETag` (docs/domain.md, "The
 * principle map": the Cache Lab's principle in production code).
 */
export default function HowThisWorks({
  menu,
  onCheck,
}: {
  menu: LiveMenu;
  onCheck?: (() => void) | undefined;
}) {
  if (!menu.live) {
    return (
      <p className="hint" data-tour="menu-how">
        How this works: {HOW.menuSeed}
      </p>
    );
  }
  return (
    <p className="hint" aria-live="polite" data-tour="menu-how">
      How this works: this is your sandbox’s menu, version {menu.menu.version ?? '?'}. The API
      answered {menu.status === 304 ? 'with 304, nothing changed' : 'with the menu'}; its cache said{' '}
      <code>Bakery-Cache: {menu.cache ?? 'not sent'}</code> for the key{' '}
      <code>ETag: {menu.etag ?? 'not sent'}</code>. Asking again with that ETag costs a 304 and no
      body until you publish a change in the console.{' '}
      {onCheck && (
        <button type="button" className="link" disabled={menu.checking} onClick={onCheck}>
          Ask again
        </button>
      )}
    </p>
  );
}
