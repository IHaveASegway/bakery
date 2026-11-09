import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { PATHS } from '../guide/paths';
import { SWITCH_KEY, switchOn, type ScreenId } from '../lib/guide';
import '../styles/guide.css';

// The layer (notes, hotspots, the recorder panel, the short path) and the entries it reads are
// loaded after the island mounts, so a page's first paint never waits for them.
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
export default function Guide({ screen }: { screen: ScreenId }) {
  // The bar is drawn with the page but does nothing until the island has hydrated, so its buttons
  // are disabled until then and no press is lost.
  const [ready, setReady] = useState(false);
  const [on, setOn] = useState(true);
  const [panel, setPanel] = useState(false);
  const [path, setPath] = useState(0);
  const [said, setSaid] = useState('');
  const panelButton = useRef<HTMLButtonElement>(null);
  const hasPath = (PATHS[screen]?.length ?? 0) > 0;

  useEffect(() => {
    setOn(readSwitch());
    setReady(true);
  }, []);

  const flip = () => {
    const next = !on;
    setOn(next);
    writeSwitch(next);
    setSaid(next ? 'Under the hood is on.' : 'Under the hood is off.');
  };

  const closePanel = useCallback(() => {
    setPanel(false);
    panelButton.current?.focus();
  }, []);

  return (
    <div className="guide-layer" data-guide-root="">
      <div className="guide-bar" role="group" aria-label="Under the hood">
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
          Under the hood
        </button>
        {hasPath && on && (
          <button
            type="button"
            className="guide-quiet"
            disabled={!ready}
            onClick={() => setPath((n) => n + 1)}
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
          onClick={() => (panel ? closePanel() : setPanel(true))}
        >
          Recorder
        </button>
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {said}
      </p>
      {ready && (
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
}
