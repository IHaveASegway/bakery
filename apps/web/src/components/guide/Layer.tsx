import { createPortal } from 'react-dom';
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
import {
  PATH_CLOSED,
  pathReduce,
  spotBox,
  spotFits,
  spotPlaces,
  screenOf,
  type GuideEntry,
  type PageId,
} from '../../lib/guide';
import { traces } from '../../lib/trace';
import {
  entryForTraces,
  expectedFor,
  gesturesIn,
  noteToOpen,
  routeIdOf,
  targetOf,
  watchKeysBefore,
  watchToOpen,
  type WatchNews,
} from './match';
import { clearOfPage, headingLine } from './clear';
import { Note, barBoxes, resolveAnchor, topInset } from './Note';
import Panel from './Panel';
import {
  EntryBody,
  NoteHead,
  TraceChain,
  WatchChain,
  ReadStory,
  WhyLines,
  traceSentence,
  watchSentence,
} from './Views';

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
  screen: PageId;
  on: boolean;
  panel: boolean;
  onClosePanel: () => void;
  /** Bumped each time the visitor presses "Show me around". */
  pathRun: number;
  announce: (sentence: string) => void;
}) {
  const snapshot = useSyncExternalStore(traces.subscribe, traces.getSnapshot, traces.getSnapshot);
  // The console's pages share one set of entries; each page has its own short path.
  const screenGroup = screenOf(screen);
  const entries = entriesFor(screenGroup);

  // ---- The live note: the visitor's latest action, while the guide is on ----
  const [live, setLive] = useState<{ gesture: number; pinned: boolean } | null>(null);
  // The layer mounts only while it is needed, so what the store held well before it mounted is old
  // news; a press made just before it loaded still opens its note.
  const opened = useRef(gesturesIn(traces.getSnapshot().traces, Date.now()));
  const said = useRef(gesturesIn(traces.getSnapshot().traces, Date.now()));
  const newest = snapshot.traces.find((t) => t.gesture !== null);
  useEffect(() => {
    const gesture = noteToOpen(snapshot.traces, opened.current, { on, panel });
    if (gesture === null) return;
    setLive({ gesture, pinned: false });
    setStanding(null);
  }, [on, panel, snapshot.traces]);
  useEffect(() => {
    if (!on) setLive(null);
  }, [on]);
  // The recorder shows what a note shows; while it is open, no note lies over it.
  useEffect(() => {
    if (!panel) return;
    setLive(null);
    setStanding(null);
  }, [panel]);

  const group = useMemo(
    () =>
      live === null ? [] : snapshot.traces.filter((t) => t.gesture === live.gesture).reverse(),
    [snapshot, live],
  );
  const liveEntry = useMemo(
    () =>
      live === null ? null : entryForTraces(group, screenGroup, traces.anchorOf(live.gesture)),
    // The entry is chosen once the first request is known; later evidence does not change it.
    [live?.gesture, group[0]?.id, screenGroup],
  );
  // The pressed element; once it has gone (a card drawn again in its new column), the element the
  // page put the focus on; while the focus is elsewhere (the recorder), the last such element; and
  // only then the entry's own element.
  const lastFocused = useRef<Element | null>(null);
  const story =
    live !== null && group[0]?.read !== undefined && traces.anchorOf(live.gesture) === null;
  const liveAnchor = useCallback(() => {
    const focused = focusInPage();
    if (focused !== null) lastFocused.current = focused;
    const target = () => (liveEntry === null ? null : targetOf(liveEntry.target));
    // A story read the page made by itself (the menu's first load, or Ask again in the note) has no
    // pressed element: its note sits by what it explains, wherever the focus is.
    if (story) return resolveAnchor(null, [target]);
    return resolveAnchor(live === null ? null : traces.anchorOf(live.gesture), [
      () => focused,
      () => lastFocused.current,
      target,
    ]);
  }, [live, liveEntry, story]);
  useEffect(() => {
    lastFocused.current = null;
  }, [live?.gesture]);
  // One sentence, once, when the first answer is in.
  const first = group[0];
  useEffect(() => {
    if (live === null || first === undefined || first.outcome === 'pending') return;
    if (said.current.has(live.gesture)) return;
    said.current.add(live.gesture);
    announce(traceSentence(first, liveEntry));
  }, [live, first, liveEntry, announce]);
  const closeLive = useCallback(() => setLive(null), []);

  // ---- The watch note: on a page that watches an order, what it heard and how it listens ----
  const watchSeen = useRef(
    watchKeysBefore(traces.getSnapshot().heard, traces.getSnapshot().listening, Date.now()),
  );
  const [watch, setWatch] = useState<{ news: WatchNews; pinned: boolean } | null>(null);
  useEffect(() => {
    const news = watchToOpen(snapshot.heard, snapshot.listening, watchSeen.current, { on, panel });
    if (news === null) return;
    setWatch({ news, pinned: false });
    setLive(null);
    setStanding(null);
    announce(watchSentence(news.kind === 'heard' ? news.event : null, snapshot.listening));
  }, [snapshot.heard, snapshot.listening, on, panel, announce]);
  useEffect(() => {
    if (!on || panel) setWatch(null);
  }, [on, panel]);
  const closeWatch = useCallback(() => setWatch(null), []);
  const watchEntry =
    watch === null
      ? null
      : (entries.find(
          (e) => e.id === (watch.news.kind === 'reading' ? 'order-watch' : 'order-tracker'),
        ) ?? null);
  const watchAnchor = useCallback(
    () => (watchEntry === null ? null : targetOf(watchEntry.target)),
    [watchEntry],
  );

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
    // Near the window's top, under any sticky bar, so a note's sheet at the foot leaves it in view.
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const target = targetOf(pathEntry.target);
    if (target !== null) {
      const top = target.getBoundingClientRect().top - 80;
      window.scrollBy({ top, behavior: calm ? 'auto' : 'smooth' });
    }
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

  // The panel opens under the top bar or masthead showing now (guide.css reads --guide-top), so
  // the switch that opened it stays in sight.
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layer = root.current;
    if (layer === null) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      layer.style.setProperty('--guide-top', `${topInset()}px`);
    };
    const soon = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', soon, { passive: true, capture: true });
    window.addEventListener('resize', soon);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', soon, { capture: true });
      window.removeEventListener('resize', soon);
    };
  }, []);

  const showLive = on && live !== null && group.length > 0;
  // The layer lives in the body, so a note or a mark is placed against the page, wherever the
  // guide's bar is (the app shell's top bar is sticky, and would hold them otherwise).
  return createPortal(
    <div className="guide-layer" data-guide-root="" ref={root}>
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
      {on && watch !== null && watchEntry !== null && !showLive && (
        <Note
          id="guide-watch"
          anchor={watchAnchor}
          label={`Under the hood: ${watchEntry.title}`}
          pinned={watch.pinned}
          changed={snapshot.version}
          onClose={closeWatch}
        >
          <NoteHead
            eyebrow="Under the hood · heard just now"
            title={watchEntry.title}
            pinned={watch.pinned}
            onPin={() => setWatch({ ...watch, pinned: !watch.pinned })}
            onClose={closeWatch}
          />
          <WatchChain
            heard={watch.news.kind === 'heard' ? watch.news.event : (snapshot.heard[0] ?? null)}
            listening={snapshot.listening}
          />
          <WhyLines entry={watchEntry} />
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
          {group[0]?.read !== undefined && <ReadStory trace={group[0]} />}
          {liveEntry?.happened !== undefined && (
            <p className="guide-happened">{liveEntry.happened}</p>
          )}
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
          screen={screenGroup}
          entries={entries}
          traces={snapshot.traces.filter((t) => t.gesture !== null)}
          feed={snapshot.feed}
          heard={snapshot.heard}
          listening={snapshot.listening}
          onClose={onClosePanel}
        />
      )}
    </div>,
    document.body,
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
      const view = { width: document.documentElement.clientWidth, height: window.innerHeight };
      const taken = barBoxes();
      const next: Spot[] = [];
      for (const entry of targets) {
        const element = targetOf(entry.target);
        if (element === null) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        // The first place that is in the window, off every bar and every mark already placed, and
        // clear of the page's controls and text; with none, the mark is not drawn, and the next
        // scroll looks again. The recorder lists every entry all the same.
        const at = spotPlaces(
          { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          view,
          headingLine(element),
        ).find((place) => spotFits(place, view, taken) && clearOfPage(spotBox(place)));
        if (at === undefined) continue;
        taken.push(spotBox(at));
        next.push({
          target: entry.target,
          title: entry.title,
          top: Math.round(at.top + window.scrollY),
          left: Math.round(at.left + window.scrollX),
        });
      }
      setShown((before) => (JSON.stringify(before) === JSON.stringify(next) ? before : next));
    };
    const soon = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', soon, { passive: true, capture: true });
    window.addEventListener('resize', soon);
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon);
    sizes?.observe(document.body);
    const main = document.querySelector('main');
    const changes = typeof MutationObserver === 'undefined' ? null : new MutationObserver(soon);
    if (main !== null) changes?.observe(main, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', soon, { capture: true });
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
