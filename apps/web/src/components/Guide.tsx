import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PATHS } from '../guide/paths';
import { SWITCH_KEY, switchOn, type PageId } from '../lib/guide';
import '../styles/guide.css';

// The layer (notes, hotspots, the recorder panel, the short path) and the entries it reads are
// loaded after the island mounts, so a page's first paint never waits for them, and only while the
// guide is on or the recorder is open.
const Layer = lazy(() => import('./guide/Layer'));

/** sessionStorage may be missing, full or blocked: the guide is then on, and forgets nothing. */
function readSwitch(): boolean {
  try {
    return switchOn(window.sessionStorage.getItem(SWITCH_KEY));
  } catch {
    return true;
  }
}

function writeSwitch(on: boolean): void {
  try {
    if (on) window.sessionStorage.removeItem(SWITCH_KEY);
    else window.sessionStorage.setItem(SWITCH_KEY, 'off');
  } catch {
    // A per-tab convenience only; nothing depends on it.
  }
}

/**
 * The guide, "Under the hood" (docs/architecture.md, "The guide"; ADR 0014): one island on every
 * screen. Its bar holds the switch (on by default, remembered for the tab), the recorder panel's
 * button and, where the screen has one, the short path's. While it is on, what the visitor does
 * opens a live note beside the thing they pressed, and the parts worth explaining carry a hotspot.
 * Nothing here is a dialog and nothing takes the focus but the panel the visitor opens.
 */
export default function Guide({
  screen,
  placement = 'dock',
}: {
  screen: PageId;
  /**
   * A dock (the shop and prose shells: at the window's foot on a wide screen, moved to the page's
   * end once hydrated; on a phone one labelled button in a row of the masthead's own, on every
   * page), or in the app shell's top bar.
   */
  placement?: 'dock' | 'topbar';
}) {
  // The bar is drawn with the page but does nothing until the island has hydrated, so its buttons
  // are disabled until then and no press is lost.
  const [ready, setReady] = useState(false);
  const [on, setOn] = useState(true);
  const [panel, setPanel] = useState(false);
  const [path, setPath] = useState(0);
  const [said, setSaid] = useState('');
  const panelButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const compactButton = useRef<HTMLButtonElement>(null);
  // On a phone the bar is one pill: the switch, and a small menu for the rest (CSS hides one or
  // the other by width, so nothing here depends on the window's size).
  const [more, setMore] = useState(false);
  // On a narrow screen the dock is one 44 px button showing on or off, and the whole control opens
  // from it on a tap (CSS shows one or the other by width and by whether the page has a cart bar).
  const [full, setFull] = useState(false);
  const hasPath = (PATHS[screen]?.length ?? 0) > 0;

  useEffect(() => {
    setOn(readSwitch());
    setReady(true);
  }, []);

  // On a wide screen the dock floats at the window's foot, so it is moved to the end of the page
  // once the island has hydrated: a keyboard reaches it after the main content and the footer, and
  // nothing of the guide stands between the page's nav and its main action (audit G10). On a phone
  // it stays in the masthead's own row, where it is seen.
  const [floating, setFloating] = useState(false);
  useEffect(() => {
    if (placement !== 'dock') return;
    const wide = window.matchMedia('(min-width: 48.01rem)');
    const update = () => setFloating(wide.matches);
    update();
    wide.addEventListener('change', update);
    return () => wide.removeEventListener('change', update);
  }, [placement]);

  // The control's menu closes on Escape and on a press anywhere outside the control, as a menu
  // does; Escape gives the focus back to the button that opened it.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more && !full) return;
    const close = (focus: boolean) => {
      const opener = more ? moreButton.current : compactButton.current;
      setMore(false);
      setFull(false);
      if (focus && opener !== null && opener.offsetParent !== null) opener.focus();
    };
    // Caught on the way down, so this Escape closes the menu only, not a note under it too.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(true);
    };
    const onPress = (event: PointerEvent) => {
      if (event.target instanceof Node && bar.current?.contains(event.target)) return;
      close(false);
    };
    document.addEventListener('keydown', onKey, { capture: true });
    document.addEventListener('pointerdown', onPress, { capture: true });
    return () => {
      document.removeEventListener('keydown', onKey, { capture: true });
      document.removeEventListener('pointerdown', onPress, { capture: true });
    };
  }, [more, full]);

  const flip = () => {
    const next = !on;
    setOn(next);
    writeSwitch(next);
    setSaid(next ? 'Under the hood is on.' : 'Under the hood is off.');
  };

  const closePanel = useCallback(() => {
    setPanel(false);
    setMore(false);
    setFull(false);
    // The focus goes back to the button that opened the panel, or on a phone to the menu's.
    const back = panelButton.current;
    if (back !== null && back.offsetParent !== null) back.focus();
    else if (moreButton.current?.offsetParent) moreButton.current.focus();
    else compactButton.current?.focus();
  }, []);

  const control = (
    <div className="guide-layer" data-guide-root="">
      <div
        ref={bar}
        className={`guide-bar guide-bar-${placement}`}
        role="group"
        aria-label="Under the hood"
      >
        {placement === 'dock' && (
          <button
            ref={compactButton}
            type="button"
            className="guide-compact"
            aria-expanded={full}
            aria-controls="guide-full"
            aria-label={`Under the hood, ${on ? 'on' : 'off'}`}
            data-on={on || undefined}
            disabled={!ready}
            onClick={() => setFull((f) => !f)}
          >
            <span className="guide-switch-track" aria-hidden="true">
              <span className="guide-switch-thumb" />
            </span>
            {/* Words a stranger reads without pressing anything (audit G6). */}
            <span className="guide-compact-text" aria-hidden="true">
              Under the hood
            </span>
          </button>
        )}
        <div id="guide-full" className="guide-full" data-open={full || undefined}>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            className="guide-switch"
            disabled={!ready}
            onClick={flip}
          >
            <span className="guide-switch-track" aria-hidden="true">
              <span className="guide-switch-thumb" />
            </span>
            <span className="guide-switch-text">Under the hood</span>
          </button>
          <button
            ref={moreButton}
            type="button"
            className="guide-more"
            aria-expanded={more}
            aria-controls="guide-extra"
            aria-label="More of Under the hood"
            disabled={!ready}
            onClick={() => setMore((m) => !m)}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <circle cx="3" cy="8" r="1.5" fill="currentColor" />
              <circle cx="8" cy="8" r="1.5" fill="currentColor" />
              <circle cx="13" cy="8" r="1.5" fill="currentColor" />
            </svg>
          </button>
          <div id="guide-extra" className="guide-extra" data-open={more || undefined}>
            {hasPath && on && (
              <button
                type="button"
                className="guide-quiet"
                disabled={!ready}
                onClick={() => {
                  setMore(false);
                  setFull(false);
                  setPath((n) => n + 1);
                }}
              >
                Show me around
              </button>
            )}
            <button
              ref={panelButton}
              type="button"
              className="guide-quiet"
              aria-expanded={panel}
              aria-controls={panel ? 'guide-panel' : undefined}
              disabled={!ready}
              onClick={() => {
                setMore(false);
                setFull(false);
                if (panel) closePanel();
                else setPanel(true);
              }}
            >
              Recorder
            </button>
          </div>
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {said}
      </p>
      {/* The layer is loaded only while it is needed: the guide is on, or the recorder is open.
          A visitor who turned the guide off downloads none of it on later pages. */}
      {ready && (on || panel) && (
        <Suspense fallback={null}>
          <Layer
            screen={screen}
            on={on}
            panel={panel}
            onClosePanel={closePanel}
            pathRun={path}
            announce={setSaid}
          />
        </Suspense>
      )}
    </div>
  );
  return floating ? createPortal(control, document.body) : control;
}
