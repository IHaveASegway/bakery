import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { PATHS, entriesFor } from '../../guide';
import { PATH_CLOSED, pathReduce, type GuideEntry, type ScreenId } from '../../lib/guide';
import { traces } from '../../lib/trace';
import { entryForTraces, expectedFor, routeIdOf, targetOf } from './match';
import { Note, resolveAnchor } from './Note';
import Panel from './Panel';
import { EntryBody, NoteHead, TraceChain, WhyLines, traceSentence } from './Views';

/** The element with the focus, if it is part of the page and not the page itself. */
const focusInPage = (): Element | null => {
  const active = document.activeElement;
  return active instanceof Element && active !== document.body && active.closest('main') !== null
    ? active
    : null;
};

interface Standing {
  target: string;
  index: number;
  pinned: boolean;
}

export default function Layer({
  screen,
  on,
  panel,
  onClosePanel,
  pathRun,
  announce,
}: {
  screen: ScreenId;
  on: boolean;
  panel: boolean;
  onClosePanel: () => void;
  /** Bumped each time the visitor presses "Show me around". */
  pathRun: number;
  announce: (sentence: string) => void;
}) {
  const snapshot = useSyncExternalStore(traces.subscribe, traces.getSnapshot, traces.getSnapshot);
  const entries = entriesFor(screen);

  // ---- The live note: the visitor's latest action, while the guide is on ----
  const [live, setLive] = useState<{ gesture: number; pinned: boolean } | null>(null);
  const opened = useRef(new Set<number>());
  const said = useRef(new Set<number>());
  const newest = snapshot.traces.find((t) => t.gesture !== null);
  useEffect(() => {
    const gesture = newest?.gesture ?? null;
    if (!on || gesture === null || opened.current.has(gesture)) return;
    opened.current.add(gesture);
    setLive({ gesture, pinned: false });
    setStanding(null);
  }, [on, newest?.gesture]);
  useEffect(() => {
    if (!on) setLive(null);
  }, [on]);

  const group = useMemo(
    () =>
      live === null ? [] : snapshot.traces.filter((t) => t.gesture === live.gesture).reverse(),
    [snapshot, live],
  );
  const liveEntry = useMemo(
    () => (live === null ? null : entryForTraces(group, screen, traces.anchorOf(live.gesture))),
    // The entry is chosen once the first request is known; later evidence does not change it.
    [live?.gesture, group[0]?.id, screen],
  );
  const liveAnchor = useCallback(
    () =>
      resolveAnchor(live === null ? null : traces.anchorOf(live.gesture), [
        focusInPage,
        () => (liveEntry === null ? null : targetOf(liveEntry.target)),
      ]),
    [live, liveEntry],
  );
  // One sentence, once, when the first answer is in.
  const first = group[0];
  useEffect(() => {
    if (live === null || first === undefined || first.outcome === 'pending') return;
    if (said.current.has(live.gesture)) return;
    said.current.add(live.gesture);
    announce(traceSentence(first, liveEntry));
  }, [live, first, liveEntry, announce]);
  const closeLive = useCallback(() => setLive(null), []);

  // ---- Hotspots and the standing note ----
  const [standing, setStanding] = useState<Standing | null>(null);
  const closeStanding = useCallback(() => setStanding(null), []);
  const standingEntries =
    standing === null ? [] : entries.filter((e) => e.target === standing.target);
  const standingEntry = standingEntries[standing?.index ?? 0] ?? null;
  const standingAnchor = useCallback(
    () => (standing === null ? null : targetOf(standing.target)),
    [standing],
  );

  // ---- The short path ----
  const steps = PATHS[screen] ?? [];
  const [path, step] = useReducer(
    (s: typeof PATH_CLOSED, a: Parameters<typeof pathReduce>[1]) => pathReduce(s, a, steps),
    PATH_CLOSED,
  );
  // Only what the visitor does after pressing "Show me around" counts towards a step.
  const pathSince = useRef(0);
  useEffect(() => {
    if (pathRun === 0) return;
    pathSince.current = Date.now();
    step({ type: 'start' });
    onClosePanel();
  }, [pathRun]);
  const pathStep = path.open ? steps[path.index] : undefined;
  const pathEntry =
    pathStep === undefined ? null : (entries.find((e) => e.id === pathStep.entry) ?? null);
  // A step is done when the visitor's request is one of its triggers...
  useEffect(() => {
    if (pathEntry === null || newest === undefined) return;
    if (newest.startedAt < pathSince.current) return;
    const route = routeIdOf(newest);
    if (route !== null && pathEntry.triggers.includes(route)) {
      step({ type: 'done', entry: pathEntry.id });
    }
  }, [newest?.id, pathEntry]);
  // ...or when they press something inside its element.
  useEffect(() => {
    if (pathEntry === null) return;
    const onClick = (event: MouseEvent) => {
      const pressed = event.target instanceof Element ? event.target : null;
      if (pressed?.closest('button, a[href], input, select, label') === null) return;
      if (pressed?.closest(`[data-tour="${CSS.escape(pathEntry.target)}"]`)) {
        step({ type: 'done', entry: pathEntry.id });
      }
    };
    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, [pathEntry]);
  // Each step brings its element into view, as the visitor is asked to use it.
  useEffect(() => {
    if (pathEntry === null) return;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    targetOf(pathEntry.target)?.scrollIntoView({
      block: 'center',
      behavior: calm ? 'auto' : 'smooth',
    });
  }, [pathEntry]);
  const pathAnchor = useCallback(
    () => (pathEntry === null ? null : targetOf(pathEntry.target)),
    [pathEntry],
  );

  const pathEnd = useCallback(() => step({ type: 'end' }), []);

  // ---- Escape closes the nearest thing: a note, then the path, then the panel ----
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (live !== null || standing !== null) {
        setLive(null);
        setStanding(null);
      } else if (path.open) {
        pathEnd();
      } else if (panel) {
        onClosePanel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [live, standing, path.open, panel, pathEnd, onClosePanel]);

  const showLive = on && live !== null && group.length > 0;
  return (
    <>
      {on && (
        <Hotspots
          entries={entries}
          open={standing?.target ?? null}
          onOpen={(target, pinned) =>
            setStanding((now) =>
              now?.target === target
                ? { ...now, pinned: pinned ? !now.pinned : now.pinned }
                : { target, index: 0, pinned },
            )
          }
        />
      )}
      {on && standing !== null && standingEntry !== null && (
        <Note
          id="guide-standing"
          anchor={standingAnchor}
          label={`Under the hood: ${standingEntry.title}`}
          pinned={standing.pinned}
          changed={`${standing.target}-${standing.index}`}
          onClose={closeStanding}
        >
          <NoteHead
            eyebrow="Under the hood"
            title={standingEntry.title}
            pinned={standing.pinned}
            onPin={() => setStanding({ ...standing, pinned: !standing.pinned })}
            onClose={closeStanding}
          />
          {standingEntries.length > 1 && (
            <p className="guide-tabs" role="group" aria-label="Also here">
              {standingEntries.map((e, i) => (
                <button
                  key={e.id}
                  type="button"
                  className="guide-tab"
                  aria-pressed={i === standing.index}
                  onClick={() => setStanding({ ...standing, index: i, pinned: true })}
                >
                  {e.title}
                </button>
              ))}
            </p>
          )}
          <EntryBody entry={standingEntry} />
        </Note>
      )}
      {showLive && (
        <Note
          id="guide-live"
          anchor={liveAnchor}
          label={`Under the hood: ${liveEntry?.title ?? 'your last action'}`}
          pinned={live.pinned}
          changed={snapshot.version}
          onClose={closeLive}
        >
          <NoteHead
            eyebrow="Under the hood · just now"
            title={liveEntry?.title ?? 'Your last action'}
            pinned={live.pinned}
            onPin={() => setLive({ ...live, pinned: !live.pinned })}
            onClose={closeLive}
          />
          <TraceChain
            traces={group}
            expected={expectedFor(liveEntry, group)}
            feed={snapshot.feed}
          />
          {liveEntry !== null && <WhyLines entry={liveEntry} />}
        </Note>
      )}
      {on && !showLive && pathStep !== undefined && pathEntry !== null && (
        <Note
          id="guide-path"
          anchor={pathAnchor}
          label={`Show me around, step ${path.index + 1} of ${steps.length}`}
          pinned
          changed={path.index}
          onClose={pathEnd}
        >
          <NoteHead
            eyebrow={`Show me around · ${path.index + 1} of ${steps.length}`}
            title={pathEntry.title}
            onClose={pathEnd}
          />
          <p className="guide-do">{pathStep.do}</p>
          <p className="guide-meta">{pathEntry.what}</p>
          <p className="guide-actions">
            <button
              type="button"
              className="guide-secondary"
              onClick={() => step({ type: 'skip' })}
            >
              {path.index + 1 === steps.length ? 'Done' : 'Next'}
            </button>
          </p>
        </Note>
      )}
      {panel && (
        <Panel
          screen={screen}
          entries={entries}
          traces={snapshot.traces.filter((t) => t.gesture !== null)}
          feed={snapshot.feed}
          onClose={onClosePanel}
        />
      )}
    </>
  );
}

interface Spot {
  target: string;
  title: string;
  top: number;
  left: number;
}

/**
 * A mark beside each part worth explaining: a real button named for what it explains. Pointing at
 * it or focusing it opens its note; pressing it keeps the note open. The marks sit in the guide's
 * own layer, placed in page coordinates beside their element after each layout change.
 */
function Hotspots({
  entries,
  open,
  onOpen,
}: {
  entries: readonly GuideEntry[];
  open: string | null;
  onOpen: (target: string, pinned: boolean) => void;
}) {
  const targets = useMemo(() => {
    const seen = new Map<string, GuideEntry>();
    for (const entry of entries) if (!seen.has(entry.target)) seen.set(entry.target, entry);
    return [...seen.values()];
  }, [entries]);
  const [shown, setShown] = useState<Spot[]>([]);
  const marks = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const width = document.documentElement.clientWidth;
      const next: Spot[] = [];
      for (const entry of targets) {
        const element = targetOf(entry.target);
        if (element === null) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        // Outside the element's top-right corner when there is room, else just inside it.
        const outside = rect.right + 8 + 28 <= width;
        next.push({
          target: entry.target,
          title: entry.title,
          top: Math.round(rect.top + window.scrollY),
          left: Math.round((outside ? rect.right + 8 : rect.right - 28) + window.scrollX),
        });
      }
      setShown((before) => (JSON.stringify(before) === JSON.stringify(next) ? before : next));
    };
    const soon = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('resize', soon);
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon);
    sizes?.observe(document.body);
    const main = document.querySelector('main');
    const changes = typeof MutationObserver === 'undefined' ? null : new MutationObserver(soon);
    if (main !== null) changes?.observe(main, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', soon);
      sizes?.disconnect();
      changes?.disconnect();
    };
  }, [targets]);

  // Place each mark through the style object: the page's markup never carries a style attribute.
  useLayoutEffect(() => {
    for (const spot of shown) {
      const mark = marks.current.get(spot.target);
      if (mark === undefined) continue;
      mark.style.top = `${spot.top}px`;
      mark.style.left = `${spot.left}px`;
    }
  }, [shown]);

  return (
    <>
      {shown.map((spot) => (
        <button
          key={spot.target}
          ref={(element) => {
            if (element === null) marks.current.delete(spot.target);
            else marks.current.set(spot.target, element);
          }}
          type="button"
          className="guide-spot"
          aria-label={`Under the hood: ${spot.title}`}
          aria-expanded={open === spot.target}
          aria-controls={open === spot.target ? 'guide-standing' : undefined}
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') onOpen(spot.target, false);
          }}
          onFocus={() => onOpen(spot.target, false)}
          onClick={() => onOpen(spot.target, true)}
        >
          <span aria-hidden="true" />
        </button>
      ))}
    </>
  );
}
