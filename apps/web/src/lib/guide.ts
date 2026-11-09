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
  /**
   * Docked with no corner clear of the anchor: how far to scroll the page (down, in pixels) so the
   * anchor sits above the note. Absent when nothing needs to move.
   */
  scroll?: number;
}

/** The gap between the anchor and the note, and the room kept from the window's edges. */
const GAP = 12;
const EDGE = 8;
const CARET_MIN = 16;

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

const overlaps = (a: Box, top: number, left: number, size: { width: number; height: number }) =>
  !(
    left >= a.left + a.width ||
    left + size.width <= a.left ||
    top >= a.top + a.height ||
    top + size.height <= a.top
  );

/**
 * Where a note of `note` size sits beside `anchor` in a `view` (all in window coordinates), never
 * over it: to the right if it fits, else to the left, else below, else above, with the caret
 * pointing at the anchor's middle. When no side has room it docks in a corner of the window (the
 * foot first, where the view already stops short of the guide's bar) that does not cover the
 * anchor, with no caret; the anchor keeps its ring so the eye still finds it. A phone's sheet does
 * not use this: CSS puts it at the foot.
 */
export function placeNote(
  anchor: Box,
  note: { width: number; height: number },
  view: { width: number; height: number },
): Placement {
  const middleY = anchor.top + anchor.height / 2;
  const middleX = anchor.left + anchor.width / 2;
  const tallEnough = note.height + 2 * EDGE <= view.height;
  const fitsRight =
    tallEnough && anchor.left + anchor.width + GAP + note.width + EDGE <= view.width;
  const fitsLeft = tallEnough && anchor.left - GAP - note.width >= EDGE;
  if (fitsRight || fitsLeft) {
    const left = fitsRight ? anchor.left + anchor.width + GAP : anchor.left - GAP - note.width;
    const top = clamp(middleY - note.height / 2, EDGE, view.height - note.height - EDGE);
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
  const fitsAbove = wideEnough && above >= EDGE;
  if (fitsBelow || fitsAbove) {
    const left = clamp(middleX - note.width / 2, EDGE, view.width - note.width - EDGE);
    return {
      top: fitsBelow ? below : above,
      left,
      side: fitsBelow ? 'top' : 'bottom',
      caret: clamp(middleX - left, CARET_MIN, note.width - CARET_MIN),
    };
  }
  const foot = Math.max(EDGE, view.height - note.height - EDGE);
  const right = Math.max(EDGE, view.width - note.width - EDGE);
  const corners = [
    { top: foot, left: right },
    { top: foot, left: EDGE },
    { top: EDGE, left: right },
    { top: EDGE, left: EDGE },
  ];
  const free = corners.find((c) => !overlaps(anchor, c.top, c.left, note));
  if (free !== undefined) return { ...free, side: 'none', caret: 0 };
  // No corner is clear: dock at the foot and bring the anchor up above the note, if it fits there.
  const dock = corners[0]!;
  const room = dock.top - GAP;
  const scroll =
    anchor.height <= room - EDGE ? Math.round(anchor.top + anchor.height - room) : undefined;
  return { ...dock, side: 'none', caret: 0, ...(scroll === undefined ? {} : { scroll }) };
}

// ---- The short path ("Show me around") ----

/** One stop of a short path: the entry it explains and what the visitor is asked to do. */
export interface PathStep {
  entry: string;
  /** What to do, one short sentence starting with a verb. */
  do: string;
}

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
export const takesToken = (path: string): boolean => path.startsWith('/v1/sandboxes/{id}');

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
