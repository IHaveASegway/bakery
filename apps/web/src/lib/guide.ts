// The guide's pure parts (docs/architecture.md, "The guide"; ADR 0014): what an entry is, how a
// request becomes a `curl` (masked on screen, real in the copy), which entry explains a trace, where
// a note sits beside the thing it explains, and how the short path moves. Nothing here touches the
// page, storage or the network, so each part has a plain test. The entries themselves are data in
// src/guide/, checked in test/guide.test.ts against the OpenAPI document.
import type { LabOrNone } from './links';
import type { Json } from './schema-check';

/** The screens that carry the guide: one island on each, mounted by the layout. */
export const SCREENS = [
  'home',
  'signin',
  'menu',
  'checkout',
  'order',
  'console',
  'catering',
  'inbox',
  'dispatch',
  'api',
  'privacy',
  'status',
] as const;
export type ScreenId = (typeof SCREENS)[number];

/**
 * The console's other pages (2026-11-09: the console is seven pages). They share the console's one
 * set of entries, and a hotspot shows only where its target is on the page; each has an id of its
 * own so it can have a short path of its own. The kitchen, /app/, is `console` itself.
 */
export const CONSOLE_PAGES = [
  'console-money',
  'console-menu',
  'console-catering',
  'console-customers',
  'console-system',
] as const;

/** A page that carries the guide: a screen, or one of the console's other pages. */
export type PageId = ScreenId | (typeof CONSOLE_PAGES)[number];
export const PAGES: readonly PageId[] = [...SCREENS, ...CONSOLE_PAGES];

/** The screen whose entries a page reads. */
export const screenOf = (page: PageId): ScreenId =>
  (CONSOLE_PAGES as readonly string[]).includes(page) ? 'console' : (page as ScreenId);

/**
 * The principle an entry teaches, with where it is explained (Q32 · Q-links). One per section of
 * the How it's built page, which is where they are written (lib/how-its-built.ts); the URLs are
 * derived there from the lab's name and the ADR's number (lib/links.ts), never typed.
 */
export interface Principle {
  /** The section's id on the How it's built page, such as "queue". */
  id: string;
  name: string;
  /** The lab page's name, or "none yet" for a principle with no lab page. */
  lab: LabOrNone;
  /** The ADR's number, such as "0004". */
  adr: string;
  /** The lab page on the site; absent for "none yet". */
  labUrl?: string;
  /** The ADR on GitHub. */
  adrUrl: string;
  /** The principle's section on the How it's built page, a path on this site. */
  howUrl: string;
  /** The essay that goes with it, a path on this site and its title; absent for one with none. */
  essay?: { url: string; title: string };
}

/** The request that does what the entry's element does, as the contracts name it. */
export interface GuideApi {
  /** An id from the route table (the OpenAPI operationId). */
  routeId: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** The path as the document writes it, such as `/v1/sandboxes/{id}/orders`. */
  path: string;
  /** A synthetic example body; absent for a request with none. */
  body?: Json;
  note: string;
}

/** One explainable thing: a hotspot's standing note, a live note's words and a decision row. */
export interface GuideEntry {
  id: string;
  screen: ScreenId;
  /** The `data-tour` value of the element the entry explains. */
  target: string;
  title: string;
  /** What the visitor is looking at, in at most three short sentences. */
  what: string;
  /** Why this tool does the work here: one sentence. */
  why: string;
  /** When this tool would be the wrong one: one sentence, starting "Not". */
  whenNot: string;
  /** The event types the action on this element produces, as the event catalog names them. */
  events: string[];
  principle: Principle;
  api: GuideApi;
  /**
   * The route ids and event types that open this entry as a live note: a request the visitor's
   * own click sent on one of these routes, or an event of one of these types that it caused.
   */
  triggers: string[];
  /**
   * What just happened, said in the live note under its chain when one of `triggers` opens it: one
   * or two sentences about the thing the visitor set off, such as a hold placed or a timer re-armed.
   */
  happened?: string;
  /**
   * Standing facts a page once said in its own "How this works" words, kept here so the page can
   * stop explaining: each a short sentence or two, shown under `what` in the standing note.
   */
  facts?: string[];
  /** The records to read, by title, beyond the principle's own (a runbook section, a postscript). */
  records?: { title: string; href: string }[];
  /**
   * A value the page itself read that the standing note shows as observed (lib/trace.ts,
   * `observations`): the status page's `flag`.
   */
  observe?: string;
}

/** The number of sentences in a text: a stop, a question or an exclamation and then a space or the end. */
export function sentenceCount(text: string): number {
  return text
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z“‘(0-9/])/)
    .filter((s) => s.trim() !== '').length;
}

// ---- Which route a request was ----

/** A route as the guide can recognise it from a request: its id, method and path template. */
export interface RouteShape {
  routeId: string;
  method: string;
  path: string;
}

/**
 * A matcher from a request's method and concrete path to the route id, built from route shapes
 * (the entries' `api`, which cover every write the page can make). The path's parameters match one
 * path segment each, and a query string is ignored. Unknown: null.
 */
export function routeMatcher(shapes: readonly RouteShape[]) {
  const compiled = shapes.map((shape) => ({
    routeId: shape.routeId,
    method: shape.method,
    pattern: new RegExp(
      `^${shape.path
        .split(/\{\w+\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]+')}$`,
    ),
    // A path with fewer parameters is the more specific: `/menu/publish` before `/menu/{x}`.
    params: (shape.path.match(/\{/g) ?? []).length,
  }));
  compiled.sort((a, b) => a.params - b.params);
  return (method: string, path: string): string | null => {
    const bare = path.split('?')[0] ?? path;
    const upper = method.toUpperCase();
    return compiled.find((r) => r.method === upper && r.pattern.test(bare))?.routeId ?? null;
  };
}

// ---- Which entry explains a trace ----

/**
 * The entry a live note shows for what the visitor did: one whose triggers name the route (or,
 * failing that, one of the event types seen), preferring the screen the visitor is on and, among
 * those, the one whose target holds the element they pressed (`inTarget`).
 */
export function pickEntry(
  entries: readonly GuideEntry[],
  screen: ScreenId,
  routeId: string | null,
  eventTypes: readonly string[],
  inTarget: (target: string) => boolean = () => false,
): GuideEntry | null {
  const byRoute =
    routeId === null ? [] : entries.filter((entry) => entry.triggers.includes(routeId));
  const candidates =
    byRoute.length > 0
      ? byRoute
      : entries.filter((entry) => eventTypes.some((type) => entry.triggers.includes(type)));
  if (candidates.length === 0) return null;
  const score = (entry: GuideEntry) =>
    (entry.screen === screen ? 2 : 0) + (inTarget(entry.target) ? 1 : 0);
  return candidates.reduce((best, entry) => (score(entry) > score(best) ? entry : best));
}

// ---- Where a note sits ----

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  /** The side of the note the caret is on, pointing at the anchor; `none` when docked. */
  side: 'left' | 'right' | 'top' | 'bottom' | 'none';
  /** The caret's offset along that side, from the note's corner. */
  caret: number;
}

/** The gap between the anchor and the note, and the room kept from the window's edges. */
const GAP = 12;
const EDGE = 8;
const CARET_MIN = 16;

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Where a note of `note` size sits beside `anchor` in a `view` (all in window coordinates), never
 * over it, and never over the page's top bar or masthead, whose bottom edge is `view.top`: to the right if it fits, else to the left, else below, else above, with the caret
 * pointing at the anchor's middle. When no side has room it docks in a corner of the window (the
 * foot first, where the view already stops short of the guide's bar) that does not cover the
 * anchor, or covers least of it, with no caret; the anchor keeps its ring so the eye still finds it. A phone's sheet does
 * not use this: CSS puts it at the foot.
 */
export function placeNote(
  anchor: Box,
  note: { width: number; height: number },
  view: { width: number; height: number; top?: number },
): Placement {
  const middleY = anchor.top + anchor.height / 2;
  const middleX = anchor.left + anchor.width / 2;
  // The highest a note's top edge may be: under the page's top bar or masthead, when one shows.
  const high = (view.top ?? 0) + EDGE;
  const tallEnough = note.height + high + EDGE <= view.height;
  const fitsRight =
    tallEnough && anchor.left + anchor.width + GAP + note.width + EDGE <= view.width;
  const fitsLeft = tallEnough && anchor.left - GAP - note.width >= EDGE;
  if (fitsRight || fitsLeft) {
    const left = fitsRight ? anchor.left + anchor.width + GAP : anchor.left - GAP - note.width;
    const top = clamp(middleY - note.height / 2, high, view.height - note.height - EDGE);
    return {
      top,
      left,
      side: fitsRight ? 'left' : 'right',
      caret: clamp(middleY - top, CARET_MIN, note.height - CARET_MIN),
    };
  }
  const wideEnough = note.width + 2 * EDGE <= view.width;
  const below = anchor.top + anchor.height + GAP;
  const above = anchor.top - GAP - note.height;
  const fitsBelow = wideEnough && below + note.height + EDGE <= view.height;
  const fitsAbove = wideEnough && above >= high;
  if (fitsBelow || fitsAbove) {
    const left = clamp(middleX - note.width / 2, EDGE, view.width - note.width - EDGE);
    return {
      top: fitsBelow ? below : above,
      left,
      side: fitsBelow ? 'top' : 'bottom',
      caret: clamp(middleX - left, CARET_MIN, note.width - CARET_MIN),
    };
  }
  const foot = Math.max(high, view.height - note.height - EDGE);
  const right = Math.max(EDGE, view.width - note.width - EDGE);
  const corners = [
    { top: foot, left: right },
    { top: foot, left: EDGE },
    { top: high, left: right },
    { top: high, left: EDGE },
  ];
  // The corner clear of the anchor; with none clear, the one that covers least of it. The page is
  // never scrolled for the note: that would move what the visitor is looking at.
  const covered = (c: { top: number; left: number }) =>
    Math.max(
      0,
      Math.min(c.left + note.width, anchor.left + anchor.width) - Math.max(c.left, anchor.left),
    ) *
    Math.max(
      0,
      Math.min(c.top + note.height, anchor.top + anchor.height) - Math.max(c.top, anchor.top),
    );
  const best = corners.reduce((a, b) => (covered(b) < covered(a) ? b : a));
  return { ...best, side: 'none', caret: 0 };
}

/** A hotspot's size, with the ring drawn around it, and the clear margin it keeps. */
const SPOT = 28;
const CLEAR = 8;
/** After a heading's text, room for the mark's pulse (it grows to about 14 px past the mark). */
const LINE_GAP = 18;

/** Whether two boxes overlap. */
export const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  a.left + a.width > b.left &&
  a.top < b.top + b.height &&
  a.top + a.height > b.top;

/**
 * Where a hotspot for `target` may sit, in window coordinates, best first. In the gutter outside the
 * target's top-right corner, when the window has room for the mark and a clear margin there; else,
 * when the target has a heading, in that heading's own line, after its text (`line` is the box of
 * the heading's last line of text), so the mark reads as part of the line it explains. Never on
 * the target's edge where the gutter is too narrow: that is where it sat on a button or a word.
 * For a target that is one paragraph, after its own last line of text (`tail`) comes before the
 * heading's line: two paragraphs under one heading, such as the status page's breaker and kill
 * switch, then each keep a mark by their own words, and opening a note never swaps them.
 */
export function spotPlaces(
  target: Box,
  view: { width: number; height: number },
  line: Box | null,
  tail: Box | null = null,
): { top: number; left: number; how: 'gutter' | 'line' | 'tail' }[] {
  const places: { top: number; left: number; how: 'gutter' | 'line' | 'tail' }[] = [];
  const gutterLeft = target.left + target.width + CLEAR;
  if (gutterLeft + SPOT + CLEAR <= view.width) {
    places.push({ top: target.top, left: gutterLeft, how: 'gutter' });
  }
  if (tail !== null) {
    const left = tail.left + tail.width + LINE_GAP;
    if (left + SPOT + CLEAR <= view.width) {
      places.push({ top: tail.top + (tail.height - SPOT) / 2, left, how: 'tail' });
    }
  }
  if (line !== null) {
    const left = line.left + line.width + LINE_GAP;
    if (left + SPOT + CLEAR <= view.width) {
      places.push({ top: line.top + (line.height - SPOT) / 2, left, how: 'line' });
    }
  }
  return places;
}

/**
 * Whether a hotspot may be drawn at `at`: wholly in the window, and touching none of `bars` (the
 * top bar, the masthead, a tab bar, the cart bar, the guide's own control) nor a mark already
 * placed. A mark that may not waits until its target scrolls into view; it is never pushed onto a
 * bar. The page's own text and controls are checked by the layer, which can see them.
 */
export function spotFits(
  at: { top: number; left: number },
  view: { width: number; height: number },
  bars: readonly Box[],
): boolean {
  const box = { top: at.top, left: at.left, width: SPOT, height: SPOT };
  if (box.top < 0 || box.left < 0 || box.top + SPOT > view.height || box.left + SPOT > view.width) {
    return false;
  }
  return !bars.some((bar) => overlaps(box, bar));
}

/** The box a hotspot at `at` takes, ring included. */
export const spotBox = (at: { top: number; left: number }): Box => ({
  top: at.top,
  left: at.left,
  width: SPOT,
  height: SPOT,
});

// ---- The short path ("Show me around") ----

/** One stop of a short path: the entry it explains and what the visitor is asked to do. */
export interface PathStep {
  entry: string;
  /** What to do, one short sentence starting with a verb. */
  do: string;
  /**
   * The step's action is a signed-in session's only (docs/security.md, "Sandbox isolation"): a
   * guest is shown what it does and why, told it needs a sign-in, and Next moves past it.
   */
  signedIn?: true;
}

/** What a guest reads on a step that needs a sign-in, beside a link to sign in. */
export const NEEDS_SIGN_IN = 'This step needs a sign-in: a guest can read it here, not do it.';

export interface PathState {
  open: boolean;
  index: number;
}

export type PathAction =
  { type: 'start' } | { type: 'done'; entry: string } | { type: 'skip' } | { type: 'end' };

export const PATH_CLOSED: PathState = { open: false, index: 0 };

/**
 * The next state. A step moves on only when the visitor has done its thing (`done` naming that
 * step's entry) or chosen to skip it; doing something else changes nothing. After the last step the
 * path closes, and `end` closes it at once.
 */
export function pathReduce(state: PathState, action: PathAction, steps: readonly PathStep[]) {
  switch (action.type) {
    case 'start':
      return { open: steps.length > 0, index: 0 };
    case 'done':
      if (!state.open || steps[state.index]?.entry !== action.entry) return state;
      return state.index + 1 >= steps.length
        ? { open: false, index: state.index }
        : { open: true, index: state.index + 1 };
    case 'skip':
      if (!state.open) return state;
      return state.index + 1 >= steps.length
        ? { open: false, index: state.index }
        : { open: true, index: state.index + 1 };
    case 'end':
      return { open: false, index: state.index };
  }
}

// ---- The switch, remembered for the tab ----

/** The one thing the guide stores: "off" while the visitor has turned it off, in sessionStorage. */
export const SWITCH_KEY = 'bakery-guide';

/** On unless the stored text says off; anything else, or nothing, is on. */
export const switchOn = (raw: string | null): boolean => raw !== 'off';

// ---- The request, as a curl ----

/** Where `{id}` and the other path parameters go when the visitor has not filled them in. */
const PLACEHOLDER: Record<string, string> = { id: '<sandbox id>' };

/** The path with `{id}` filled from the sandbox when there is one, and `{x}` shown as `<x>`. */
export function fillPath(path: string, sandboxId: string | null): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) =>
    name === 'id' && sandboxId !== null ? sandboxId : (PLACEHOLDER[name] ?? `<${name}>`),
  );
}

/** Whether the API takes the sandbox's token on this path: the sandbox's routes do. */
/** A sandbox's routes take its API token, but never its sockets: those are the cookie only. */
export const takesToken = (path: string): boolean =>
  path.startsWith('/v1/sandboxes/{id}') && !path.endsWith('/ws');

/** The 6 + 4 form the API's `masked` uses; a token under 16 characters is shown as `…` alone. */
export function maskToken(token: string): string {
  return token.length < 16 ? '…' : `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/** Single-quoted for a POSIX shell: a quote inside becomes `'\''`. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

export interface CurlContext {
  /** The API's origin, such as `https://api.bakery.ihaveasegway.com`. */
  origin: string;
  sandboxId: string | null;
  /** The token the page holds in memory, or null. */
  token: string | null;
  /** A ULID for this request's `Idempotency-Key`. */
  key: string;
}

/**
 * The entry's request as a multi-line `curl`. `copy` carries the real token; `screen` shows only
 * its masked form. Without a token both say `<your token>`. A route the token is not accepted on
 * (the public ones) carries no Authorization header, and a POST carries an Idempotency-Key.
 */
export function curlText(api: GuideApi, context: CurlContext, mode: 'screen' | 'copy'): string {
  const parts = [
    `curl${api.method === 'GET' ? '' : ` -X ${api.method}`} ${shellQuote(`${context.origin}${fillPath(api.path, context.sandboxId)}`)}`,
  ];
  if (takesToken(api.path)) {
    const shown =
      context.token === null
        ? '<your token>'
        : mode === 'copy'
          ? context.token
          : maskToken(context.token);
    parts.push(`-H ${shellQuote(`Authorization: Bearer ${shown}`)}`);
  }
  if (api.method === 'POST') parts.push(`-H ${shellQuote(`Idempotency-Key: ${context.key}`)}`);
  if (api.body !== undefined) {
    parts.push(`-H ${shellQuote('Content-Type: application/json')}`);
    parts.push(`-d ${shellQuote(JSON.stringify(api.body))}`);
  }
  return parts.join(' \\\n  ');
}

/** The last six characters of an id, as the board shows an order. */
export const shortId = (id: string): string => (id.length > 8 ? `…${id.slice(-6)}` : id);
