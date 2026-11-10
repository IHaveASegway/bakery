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
import { BOARD_MOVES } from '../../guide/kitchen';
import {
  NEEDS_SIGN_IN,
  PATH_CLOSED,
  pathReduce,
  spotBox,
  spotFits,
  spotPlaces,
  screenOf,
  type Box,
  type GuideEntry,
  type PageId,
} from '../../lib/guide';
import { followWrite, sandboxOf, useRecorderState } from '../../lib/recorder';
import { traces, type Trace } from '../../lib/trace';
import { useSandboxPhase } from '../../lib/use-session';
import {
  byGesture,
  entryForGroup,
  expectedFor,
  gesturesIn,
  noteToOpen,
  routeIdOf,
  targetOf,
  unfollowable,
  watchKeysBefore,
  watchToOpen,
  type WatchNews,
} from './match';
import { clearOfPage, headingLine, textEnd } from './clear';
import { Note, around, barBoxes, flowPlace, resolveAnchor, topInset } from './Note';
import Panel from './Panel';
import {
  EntryBody,
  NoteHead,
  TraceChain,
  WatchChain,
  ReadStory,
  ReasonsOnce,
  RecorderSays,
  WhyLines,
  traceSentence,
  watchSentence,
} from './Views';

/**
 * What the page says came of a request, when it marks it (data-guide-result: the board's sentence,
 * the clock's readout), in the window or not: the one inside the entry's own element first.
 */
function resultInPage(target: string | null): Element | null {
  const inTarget =
    target === null
      ? null
      : document.querySelector(`[data-tour="${CSS.escape(target)}"] [data-guide-result]`);
  return inTarget ?? document.querySelector('[data-guide-result]');
}

/**
 * A control's name without the order it is for: "Start production for order 4KX2QF" and the same
 * button on the next card are one control. Empty when it has no name.
 */
function controlName(el: Element): string {
  const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
  return name.replace(/\s+for order\s+\S+$/i, '');
}

/**
 * Watch the page for about a second after an answer, a frame at a time: as soon as `kept` says
 * the note has something to sit by (its control, the page's result line), nothing happens;
 * otherwise, once the page has settled, `fold`. A page writes its result line when its own code
 * has handled the answer, some frames after the guide's trace has it (the board's one status line
 * waits for the board's own state). Returns the stop.
 */
function afterSettling(kept: () => boolean, fold: () => void): () => void {
  let frame = 0;
  let left = 60;
  const look = () => {
    if (kept()) return;
    left -= 1;
    if (left <= 0) fold();
    else frame = requestAnimationFrame(look);
  };
  frame = requestAnimationFrame(look);
  return () => cancelAnimationFrame(frame);
}

/** The width at and under which the guide's control and folded line sit in the masthead's row. */
const PHONE_ROW = '(max-width: 48rem)';

/** A menu open over the page, which an Escape closes before it closes any note. */
const OPEN_MENUS =
  '.board details.menu[open], .popover > [aria-expanded="true"], .guide-extra[data-open], .guide-full[data-open]';

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
  /** Pinned with the note's own pin, not just opened by a press: it stays as the visitor goes on. */
  held?: boolean;
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
    () => (live === null ? null : entryForGroup(group, screenGroup)),
    // The entry is chosen once the first request is known; later evidence does not change it.
    [live?.gesture, group[0]?.id, screenGroup],
  );
  // The pressed element; once it has gone (a card drawn again in its new column), the element the
  // page put the focus on; while the focus is elsewhere (the recorder), the last such element; and
  // only then the entry's own element.
  const lastFocused = useRef<Element | null>(null);
  // The part of the page each press was made in (its card, row, form or panel), taken at the
  // click: a control the page replaces with another (Schedule, which becomes Unschedule) leaves its
  // note with the part it was in, not at the entry's whole element far away.
  const homes = useRef(new WeakMap<Element, Element>());
  useEffect(() => {
    const press = (event: MouseEvent) => {
      const el = event.target instanceof Element ? event.target.closest('button, a[href]') : null;
      const home = el?.parentElement?.closest('li, tr, article, form, fieldset, section, .panel');
      // Only a part of the page's main column: a control in the top bar or a menu over the page
      // has no part of the page to sit in.
      if (el && home && home.closest('main') !== null) {
        homes.current.set(el, home);
      }
    };
    document.addEventListener('click', press, { capture: true });
    return () => document.removeEventListener('click', press, { capture: true });
  }, []);
  const story =
    live !== null && group[0]?.read !== undefined && traces.anchorOf(live.gesture) === null;
  // A story read whose entry is another screen's (the order page reads the menu for its lines'
  // names) is not this page's story: no note, and no line, for it.
  const offStory = story && liveEntry !== null && liveEntry.screen !== screenGroup;
  // A press's note that waits as a line, as a story read does: one with nothing to sit beside, one
  // with no place clear of the page's controls, or a phone's sheet the visitor scrolled or tapped
  // past. The line opens it again.
  const [lineFor, setLineFor] = useState<number | null>(null);
  // On the sign-in page every way in is a control, side by side, and a press there replaces its
  // own form: its note opens as its line, over nothing, and in full when the visitor taps it
  // (drawn first beside its form, it lay over Google's and GitHub's buttons).
  const asLine = story || (live !== null && (lineFor === live.gesture || screenGroup === 'signin'));
  const liveAnchor = useCallback(() => {
    const focused = focusInPage();
    if (focused !== null) lastFocused.current = focused;
    const target = () => (liveEntry === null ? null : targetOf(liveEntry.target));
    // A story read the page made by itself (the menu's first load, or Ask again in the note) has no
    // pressed element: its note sits by what it explains, wherever the focus is.
    if (story) return resolveAnchor(null, [target]);
    // A request whose pressed control has gone (a refunded card leaves the board) sits by what the
    // page says came of it, an element marked data-guide-result, before anything the focus is on:
    // ringing a card the focus fell to would tie the note to the wrong order (audit G2).
    const pressed = live === null ? null : traces.anchorOf(live.gesture);
    const gone = !(pressed instanceof Element && pressed.isConnected);
    const result = () =>
      gone && group[0]?.transport === 'http' ? resultInPage(liveEntry?.target ?? null) : null;
    const home = () =>
      pressed instanceof Element && gone ? (homes.current.get(pressed) ?? null) : null;
    return resolveAnchor(pressed, [result, home, () => focused, () => lastFocused.current, target]);
  }, [live, liveEntry, story, group]);
  useEffect(() => {
    lastFocused.current = null;
  }, [live?.gesture]);
  // The recorder: once a write the visitor made is answered 2xx, read its hops a few times, until
  // every event its action makes is observed (lib/recorder.ts holds the bounds and the cost). Every
  // such write is followed, with a note open or not (the recorder panel open, a note folded), so
  // the panel's row and the note say the same of it: the reading state is the trace's own.
  const recorder = useRecorderState();
  const followed = useRef(gesturesIn(traces.getSnapshot().traces, Date.now()));
  useEffect(() => {
    for (const mine of byGesture(snapshot.traces).slice(0, 3)) {
      const head = mine[0];
      if (head === undefined || head.gesture === null || followed.current.has(head.gesture))
        continue;
      if (head.transport !== 'http' || head.read !== undefined || head.outcome === 'pending') {
        continue;
      }
      followed.current.add(head.gesture);
      if (head.outcome !== 'ok') continue;
      // A write to the sandbox itself (its wipe) leaves nothing to read: the recorder goes with it.
      const sandbox = sandboxOf(head.path);
      if (sandbox === null || /^\/v1\/sandboxes\/[^/?]+$/.test(head.path)) continue;
      const expected = expectedFor(entryForGroup(mine, screenGroup), mine);
      const gesture = head.gesture;
      void followWrite(sandbox, head.id, () => {
        const now = traces.getSnapshot().traces.filter((t) => t.gesture === gesture);
        const seen = new Set(now.flatMap((t) => t.events.map((e) => e.type)));
        return expected.every((type) => seen.has(type));
      });
    }
  }, [snapshot.traces, screenGroup]);

  // One sentence, once, when the first answer is in.
  const first = group[0];
  useEffect(() => {
    if (live === null || first === undefined || first.outcome === 'pending') return;
    if (said.current.has(live.gesture)) return;
    said.current.add(live.gesture);
    announce(traceSentence(first, liveEntry));
  }, [live, first, liveEntry, announce]);
  const closeLive = useCallback(() => {
    setLive(null);
    setStoryOpen(false);
  }, []);
  // A note the page has nothing to set beside arrives folded to its line, never in a corner over
  // the page: the press was on the page before this one, or, once the answer is in, the pressed
  // control has gone with nothing on the page saying what came of it (the console's "Create a
  // sandbox", replaced by the board; audit F6). A board's move keeps its note by the moved card.
  const answered = group[0] !== undefined && group[0].outcome !== 'pending';
  useLayoutEffect(() => {
    if (live === null || story || group.length === 0) return;
    const pressed = traces.anchorOf(live.gesture);
    if (pressed === null || liveAnchor() === null) {
      setLineFor(live.gesture);
      return;
    }
    if (!answered || group[0]?.transport === 'socket') return;
    // Judged once the page has drawn the answer (its result line is set as the answer lands): with
    // the pressed control gone and nothing at all to sit by (no result line, no focus the page
    // moved, not the entry's own element), it folds. Later, the note itself folds if its element
    // goes (Note.tsx).
    const gesture = live.gesture;
    // On a phone a sheet by a fallback lies over what the page drew in the pressed control's
    // place, the next thing pressed (the menu's Add buttons after Start ordering): there
    // the note waits as its line unless the page wrote a result line for it.
    const small = window.matchMedia('(max-width: 40rem)').matches;
    const target = liveEntry?.target ?? null;
    return afterSettling(
      () => {
        const now = traces.anchorOf(gesture);
        if (now instanceof Element && now.isConnected) return true;
        return small ? resultInPage(target) !== null : liveAnchor() !== null;
      },
      () => setLineFor(gesture),
    );
    // When the note arrives and when its answer does: later evidence does not fold it.
  }, [live?.gesture, group.length > 0, answered]);
  const foldIfGone = useCallback((): boolean => {
    if (live === null) return false;
    // The sign-in page's ways in sit side by side, every one a control: a note with no place
    // clear of them all waits as its line at once, never over Google's and GitHub's buttons
    // even while its own button still says it is working.
    if (screenGroup === 'signin') {
      setLineFor(live.gesture);
      setStoryOpen(false);
      return true;
    }
    const pressed = traces.anchorOf(live.gesture);
    if (pressed instanceof Element && pressed.isConnected) return false;
    if (group[0]?.transport === 'socket') return false;
    // Not before the answer: a refund's card leaves the board on the socket's news before the
    // answer lands and the page writes its result line.
    if (group[0]?.outcome === 'pending') return false;
    // The page says what came of it: the note stays open by that, the least in the way (G2). The
    // page writes its result line as the answer lands, a frame or two after the trace has it, so
    // the fold is judged once the page has drawn the answer; the note keeps its place till then.
    if (resultInPage(liveEntry?.target ?? null) !== null) return false;
    const gesture = live.gesture;
    const target = liveEntry?.target ?? null;
    // While the page settles the note is not shown at all (Note.tsx hides it while this says
    // true): drawn at its fallback place meanwhile, it lay over the sign-in page's provider
    // buttons for a second or more before it folded.
    if (judging.current === gesture) return true;
    judging.current = gesture;
    afterSettling(
      () => {
        const now = traces.anchorOf(gesture);
        const kept = resultInPage(target) !== null || (now instanceof Element && now.isConnected);
        // Kept: the next placing judges afresh, and shows the note where it now belongs.
        if (kept) judging.current = null;
        return kept;
      },
      () => {
        judging.current = null;
        setLineFor(gesture);
        setStoryOpen(false);
      },
    );
    return true;
  }, [live, group, liveEntry, screenGroup]);
  const judging = useRef<number | null>(null);
  // What the live note must never cover (audit G3): the control that was pressed, the thing that
  // shows the result (the card where it is now, the readout that changed, the line that appeared:
  // the note's anchor and any data-guide-result), and what a visitor presses next (the same control
  // again, the same control on the next card of its column, the control the page put the focus on).
  const keepClear = useCallback((): Box[] | null => {
    if (live === null) return [];
    // A note by a fallback (its pressed control gone, no result line on the page: the checkout's
    // gate, replaced by the steps) keeps clear of every control, else waits as its line: null.
    const pressedNow = traces.anchorOf(live.gesture);
    if (
      group[0]?.transport === 'http' &&
      !(pressedNow instanceof Element && pressedNow.isConnected) &&
      resultInPage(liveEntry?.target ?? null) === null
    ) {
      return null;
    }
    const els = new Set<Element>();
    const pressed = traces.anchorOf(live.gesture);
    const anchorEl = liveAnchor();
    if (anchorEl !== null) {
      els.add(anchorEl);
      // What is pressed next is the controls of the part the note sits by: the step it opened,
      // the card that moved, the panel whose readout changed (its other buttons).
      const part = anchorEl.closest('section, article, li, tr, form, fieldset');
      const box = part?.getBoundingClientRect();
      // A part, not the page: the whole board is not one card.
      const small =
        box !== undefined && box.width * box.height < 0.4 * window.innerWidth * window.innerHeight;
      if (part !== null && small) {
        for (const c of part.querySelectorAll(
          'button, a[href], input, select, textarea, label, summary',
        )) {
          els.add(c);
        }
      }
    }
    for (const r of document.querySelectorAll('[data-guide-result]')) els.add(r);
    const focused = focusInPage();
    if (focused !== null) els.add(focused);
    if (pressed instanceof Element) {
      if (pressed.isConnected) {
        els.add(pressed);
        els.add(around(pressed));
        // Its row of controls: the clock's other steps beside the one pressed.
        for (const c of pressed.parentElement?.querySelectorAll('button, a[href], summary') ?? []) {
          els.add(c);
        }
      }
      const same = controlName(pressed);
      if (same !== '') {
        for (const c of document.querySelectorAll('main button, main a[href], main summary')) {
          if (controlName(c) === same) els.add(c);
        }
      }
    }
    return [...els].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    });
  }, [live, liveAnchor, group, liveEntry]);
  // On the console's workspaces a live note goes in the page's flow under what it explains.
  const liveFlow = useCallback(
    (anchorEl: Element | null) => {
      if (live === null || story || anchorEl === null) return null;
      const pressed = traces.anchorOf(live.gesture);
      const there = pressed instanceof Element && pressed.isConnected;
      // With the pressed control gone, only a part of the page that says what came of it (its
      // result line, the moved card, the card or row it was pressed in) takes the note into its
      // flow; a fallback such as the page's main column does not, and the note floats or waits as
      // its line as before.
      if (!there && !anchorEl.matches('[data-guide-result], li, tr')) return null;
      return flowPlace(anchorEl, there ? pressed : null);
    },
    [live, story],
  );
  const foldLive = useCallback(() => {
    if (live === null) return;
    setLineFor(live.gesture);
    setStoryOpen(false);
  }, [live]);

  // A note the page caused by itself (a story read on load) opens as one line, docked where it
  // covers nothing, until the visitor taps it; a press anywhere in the page outside it, unless it
  // is pinned, folds it back to the line. A note caused by a press opens in full, as ever. An
  // Ask again from the open note keeps it open: the visitor asked for it.
  const [storyOpen, setStoryOpen] = useState(false);
  // An open note folds back to its line when the visitor goes on with the page: a press outside
  // it, or a scroll (a wheel or a finger; the page moving by itself is not the visitor). On a
  // phone every live note's sheet does, so it never stays over what the visitor wants next; a
  // note the visitor pinned stays.
  const phone = () => window.matchMedia('(max-width: 40rem)').matches;
  const liveOpen = live !== null && (asLine ? storyOpen : phone());
  useEffect(() => {
    if (!liveOpen || live?.pinned === true) return;
    return onGoingOn(() => {
      if (asLine) setStoryOpen(false);
      else foldLive();
    });
  }, [liveOpen, asLine, live?.pinned, foldLive]);

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
  useEffect(() => {
    if (watch === null || watch.pinned || !phone()) return;
    return onGoingOn(closeWatch);
  }, [watch, closeWatch]);
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
  useEffect(() => {
    if (standing === null || standing.held === true || !phone()) return;
    return onGoingOn(closeStanding);
  }, [standing, closeStanding]);
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
    // The path's note is the one on screen: a line or a note in its place would hide step 1.
    setLive(null);
    setStoryOpen(false);
    setStanding(null);
    setWatch(null);
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
      // A menu open over the page (a board card's "…", the top bar's popovers, the guide's own
      // menu) is nearer: its own Escape closes it, and the next Escape comes here. Read on the
      // way down, before the page's own listeners have closed it.
      if (document.querySelector(OPEN_MENUS) !== null) return;
      if (live !== null || standing !== null) {
        setLive(null);
        setStanding(null);
      } else if (path.open) {
        pathEnd();
      } else if (panel) {
        onClosePanel();
      }
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, [live, standing, path.open, panel, pathEnd, onClosePanel]);

  // While the panel is open the page makes room for it: on a wide screen it is a column
  // beside the page, which narrows and stays usable; on a narrow one the page can scroll every
  // control clear of its sheet (guide.css reads data-guide-panel on the root).
  useLayoutEffect(() => {
    if (!panel) return;
    const html = document.documentElement;
    html.setAttribute('data-guide-panel', '');
    return () => html.removeAttribute('data-guide-panel');
  }, [panel]);

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

  // On a phone the folded line waits in the masthead's guide row; decided again whenever the
  // window crosses that width, so the line never stays in a row the page no longer shows
  // (pull request #143: it held the masthead 46 px taller after the window widened).
  const narrow = useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia(PHONE_ROW);
      query.addEventListener('change', changed);
      return () => query.removeEventListener('change', changed);
    },
    () => window.matchMedia(PHONE_ROW).matches,
    () => false,
  );
  const showLive = on && live !== null && group.length > 0 && !offStory;
  // What restarts the live note's timer: its own traces changing, not every event the page sees.
  const liveChanged = group
    .map(
      (t) =>
        `${t.outcome}:${t.events.length}:${t.reading}:${t.events.map((e) => e.deliveries?.length ?? -1).join(',')}`,
    )
    .join('|');
  const folded = showLive && asLine && !storyOpen;
  // The line stays while its note is open (the page does not jump under the visitor's finger).
  const lined = showLive && asLine;
  const lineSlot = lined && narrow ? document.querySelector('.guide-line-slot') : null;
  const line = lined ? (
    <p className="guide-line" role="group" aria-label="Under the hood, what this page read">
      <button
        type="button"
        className="guide-line-open"
        aria-expanded={storyOpen}
        aria-controls={storyOpen ? 'guide-live' : undefined}
        onClick={() => setStoryOpen((open) => !open)}
      >
        <span className="guide-eyebrow">Under the hood</span>{' '}
        <span className="guide-line-title">{liveEntry?.title ?? 'What this page read'}</span>{' '}
        {group[0] !== undefined && <code className="guide-chip">{lineStatus(group[0])}</code>}
      </button>
      <button
        type="button"
        className="guide-icon"
        aria-label="Close this note"
        title="Close"
        onClick={closeLive}
      >
        ×
      </button>
    </p>
  ) : null;
  // The layer lives in the body, so a note or a mark is placed against the page, wherever the
  // guide's bar is (the app shell's top bar is sticky, and would hold them otherwise).
  return (
    <>
      {line !== null &&
        lineSlot !== null &&
        createPortal(
          <div className="guide-layer guide-line-docked" data-guide-root="">
            {line}
          </div>,
          lineSlot,
        )}
      {createPortal(
        <div className="guide-layer guide-layer-page" data-guide-root="" ref={root}>
          {on && (
            <Hotspots
              notes={[
                showLive ? live?.gesture : '',
                folded ? 'line' : '',
                standing?.target ?? '',
                standing?.index ?? '',
                path.open ? path.index : '',
                watch === null ? '' : 'watch',
                panel ? 'panel' : '',
              ].join('|')}
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
                onPin={() =>
                  setStanding({ ...standing, pinned: !standing.pinned, held: !standing.pinned })
                }
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
              changed={`${snapshot.heard[0]?.id ?? ''}|${snapshot.listening?.how ?? ''}`}
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
          {/* The floating line is the note's handle: while the note is open it is not shown, so it
              never sits on its own note (audit G2). In the masthead it stays, in the page's flow. */}
          {line !== null && lineSlot === null && !storyOpen && line}
          {showLive && !folded && (
            <Note
              id="guide-live"
              anchor={liveAnchor}
              label={`Under the hood: ${liveEntry?.title ?? 'your last action'}`}
              pinned={live.pinned}
              changed={liveChanged}
              onClose={closeLive}
              // With no place clear of the page's controls, a note whose pressed control has gone
              // (the checkout's gate, replaced by the steps) waits as its line. One by a control
              // still there stays beside it, the least in the way, as a board's move does.
              onCrowded={asLine ? undefined : foldIfGone}
              keepClear={keepClear}
              flow={liveFlow}
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
                seen={snapshot.seen}
              />
              {group[0]?.transport === 'socket' && BOARD_MOVES[group[0].action ?? ''] && (
                <p className="guide-happened">{BOARD_MOVES[group[0].action ?? '']}</p>
              )}
              {unfollowable(group) !== null && <p className="guide-meta">{unfollowable(group)}</p>}
              <RecorderSays state={recorder} />
              {group[0]?.read !== undefined && <ReadStory trace={group[0]} />}
              {liveEntry?.happened !== undefined && (
                <p className="guide-happened">{liveEntry.happened}</p>
              )}
              {liveEntry !== null && <ReasonsOnce entry={liveEntry} note={live.gesture} />}
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
              {pathStep.signedIn === true && <NeedsSignIn />}
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
              hops={snapshot.hops}
              seen={snapshot.seen}
              heard={snapshot.heard}
              listening={snapshot.listening}
              onClose={onClosePanel}
            />
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Call `then` when the visitor goes on with the page under an open note: a press outside the
 * guide, a wheel or a finger moving the page. Returns the clean-up.
 */
function onGoingOn(then: () => void): () => void {
  const press = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-guide-root]')) return;
    then();
  };
  document.addEventListener('pointerdown', press, { capture: true });
  document.addEventListener('wheel', press, { capture: true, passive: true });
  document.addEventListener('touchmove', press, { capture: true, passive: true });
  return () => {
    document.removeEventListener('pointerdown', press, { capture: true });
    document.removeEventListener('wheel', press, { capture: true });
    document.removeEventListener('touchmove', press, { capture: true });
  };
}

/** A story read's answer in a chip: its status and, for a 200, whether the cache answered. */
function lineStatus(trace: Trace): string {
  // A board's move is answered on its socket, with no HTTP status: ack, or nack and its rule.
  if (trace.transport === 'socket') {
    if (trace.outcome === 'pending') return 'sent';
    if (trace.outcome === 'ok') return 'ack';
    return trace.outcome === 'refused' ? `nack ${trace.rule ?? ''}`.trim() : 'no answer';
  }
  if (trace.status === null) return 'no answer';
  if (trace.status === 304) return '304, current';
  const cache = trace.read?.cache;
  return cache === 'hit' || cache === 'miss'
    ? `${trace.status}, cache ${cache}`
    : String(trace.status);
}

/**
 * Whether the marks stand where the page's layout puts them now: `settling` from a change of the
 * page (a scroll, a resize, a redraw, a text change) until the marks are measured and placed
 * again, then `settled`. On the root element, for a check that must not read a mark mid-move.
 */
function settled(state: 'settling' | 'settled'): void {
  document.documentElement.dataset.guideMarks = state;
}

interface Spot {
  target: string;
  title: string;
  /** Where it sits: after its own words, after its heading's, or in the gutter (no words). */
  how: 'tail' | 'line' | 'gutter';
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
  notes,
}: {
  entries: readonly GuideEntry[];
  open: string | null;
  onOpen: (target: string, pinned: boolean) => void;
  /** Changes whenever a note opens, moves to another action or closes: the marks look again. */
  notes: string;
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
      // The bars, and whatever of the guide is open over the page: a mark half under a note's
      // edge reads as a glitch, so none is drawn under one while it is open.
      const taken = [
        ...barBoxes(),
        ...[
          ...document.querySelectorAll(
            '.guide-note, .guide-panel, .guide-layer > .guide-line, .guide-full[data-open]',
          ),
        ].map((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, left: r.left, width: r.width, height: r.height };
        }),
      ];
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
          // A sentence's own end, only for a target that is one paragraph of text.
          element.matches('p') ? textEnd(element) : null,
        ).find((place) => spotFits(place, view, taken) && clearOfPage(spotBox(place)));
        if (at === undefined) continue;
        taken.push(spotBox(at));
        next.push({
          target: entry.target,
          title: entry.title,
          how: at.how,
          top: Math.round(at.top + window.scrollY),
          left: Math.round(at.left + window.scrollX),
        });
      }
      setShown((before) => {
        if (JSON.stringify(before) !== JSON.stringify(next)) return next;
        settled('settled');
        return before;
      });
    };
    const soon = () => {
      settled('settling');
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', soon, { passive: true, capture: true });
    window.addEventListener('resize', soon);
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon);
    sizes?.observe(document.body);
    const main = document.querySelector('main');
    const changes = typeof MutationObserver === 'undefined' ? null : new MutationObserver(soon);
    // A line's own text moves the mark placed at its end (spotPlaces, `tail`), so a change of text
    // alone is a change too.
    if (main !== null) {
      changes?.observe(main, { childList: true, subtree: true, characterData: true });
    }
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', soon, { capture: true });
      window.removeEventListener('resize', soon);
      sizes?.disconnect();
      changes?.disconnect();
    };
  }, [targets, notes]);

  // Place each mark through the style object: the page's markup never carries a style attribute.
  useLayoutEffect(() => {
    for (const spot of shown) {
      const mark = marks.current.get(spot.target);
      if (mark === undefined) continue;
      mark.style.top = `${spot.top}px`;
      mark.style.left = `${spot.left}px`;
    }
    settled('settled');
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
          // Not a Tab stop (audit G10): the marks live at the page's end in the document, so Tab
          // would reach them after the footer, far from their words. A keyboard reaches every
          // entry in the Recorder, the dock's last stop; a pointer or a touch opens the mark.
          tabIndex={-1}
          data-guide-target={spot.target}
          data-guide-how={spot.how}
          aria-label={`Under the hood: ${spot.title}`}
          aria-expanded={open === spot.target}
          aria-controls={open === spot.target ? 'guide-standing' : undefined}
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') onOpen(spot.target, false);
          }}
          onFocus={() => onOpen(spot.target, false)}
          // On a phone a press is the only way to open it; it then goes as the visitor goes on,
          // unless they pin it (Layer: a standing note folds away on a scroll or a press).
          onClick={() => onOpen(spot.target, true)}
        >
          <span aria-hidden="true" />
        </button>
      ))}
    </>
  );
}

/**
 * A guest is never asked for what a guest cannot do: on a step only a signed-in session may take,
 * a guest reads that it needs a sign-in, and Next moves past it. The session is read only here,
 * on such a step, so no other page asks for it on the guide's behalf.
 */
function NeedsSignIn() {
  const phase = useSandboxPhase();
  const guest = (phase.name === 'live' || phase.name === 'seeding') && phase.kind === 'guest';
  if (!guest) return null;
  return (
    <p className="guide-meta guide-needs">
      {NEEDS_SIGN_IN} <a href="/signin/">Sign in</a>
    </p>
  );
}
