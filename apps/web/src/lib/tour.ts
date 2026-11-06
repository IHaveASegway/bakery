// The guided tour's pure parts (Q41 · Q-tour, docs/architecture.md, "The tour"): what a step is,
// how a tour moves, which keys do what, how a step's API request becomes a `curl` (masked on
// screen, real in the copy), and which activity entries a step may claim as the last action's.
// Nothing here touches the page, storage or the network, so each part has a plain test. The steps
// themselves are data in src/tour/, checked in test/tour.test.ts against the OpenAPI document.
import type { ActivityEntry } from '../contracts';
import type { LabOrNone } from './links';
import type { Json } from './schema-check';

/** The screens that carry a tour: one island on each, mounted by the layout. */
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
 * The principle a step teaches, with where it is explained (Q32 · Q-links). One per section of the
 * How it's built page, which is where they are written (lib/how-its-built.ts); the URLs are derived
 * there from the lab's name and the ADR's number (lib/links.ts), never typed.
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

/** The request that does what the step's element does, as the contracts name it. */
export interface TourApi {
  /** An id from the route table (the OpenAPI operationId). */
  routeId: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** The path as the document writes it, such as `/v1/sandboxes/{id}/orders`. */
  path: string;
  /** A synthetic example body; absent for a request with none. */
  body?: Json;
  note: string;
}

export interface TourStep {
  id: string;
  screen: ScreenId;
  /** The `data-tour` value of the element the step points at. */
  target: string;
  title: string;
  /** What the visitor is looking at. */
  what: string;
  /** The event types the last action on this element produces, as the event catalog names them. */
  events: string[];
  principle: Principle;
  api: TourApi;
}

// ---- Moving through a tour ----

export interface TourState {
  open: boolean;
  index: number;
}

export type TourAction =
  | { type: 'open'; index?: number }
  | { type: 'close' }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'first' }
  | { type: 'last' };

export const CLOSED: TourState = { open: false, index: 0 };

/** The next state. "Next" on the last step ends the tour; "back" on the first stays put. */
export function tourReduce(state: TourState, action: TourAction, total: number): TourState {
  const last = Math.max(0, total - 1);
  switch (action.type) {
    case 'open':
      return { open: total > 0, index: Math.min(Math.max(0, action.index ?? 0), last) };
    case 'close':
      return { open: false, index: state.index };
    case 'next':
      if (!state.open) return state;
      return state.index >= last
        ? { open: false, index: state.index }
        : { ...state, index: state.index + 1 };
    case 'back':
      return state.open ? { ...state, index: Math.max(0, state.index - 1) } : state;
    case 'first':
      return state.open ? { ...state, index: 0 } : state;
    case 'last':
      return state.open ? { ...state, index: last } : state;
  }
}

/** "3 of 9", counting from one. */
export function progressText(index: number, total: number): string {
  return `${index + 1} of ${total}`;
}

/**
 * What a key does inside the open card. Arrows move (right and down go forward), Home and End
 * jump, Escape closes, and Enter goes forward only when the focus is on the card itself: on a
 * button or a link, Enter belongs to that control.
 */
export function keyAction(key: string, onControl: boolean): TourAction | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return { type: 'next' };
    case 'ArrowLeft':
    case 'ArrowUp':
      return { type: 'back' };
    case 'Home':
      return { type: 'first' };
    case 'End':
      return { type: 'last' };
    case 'Escape':
      return { type: 'close' };
    case 'Enter':
      return onControl ? null : { type: 'next' };
    default:
      return null;
  }
}

// ---- "Seen", the one thing the tour remembers (localStorage, per viewer, never read by the API) ----

export const SEEN_KEY = 'bakery-tour-seen';

/** The screens recorded as seen, from the stored text; anything unreadable is "none seen". */
export function parseSeen(raw: string | null): Partial<Record<ScreenId, true>> {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const seen: Partial<Record<ScreenId, true>> = {};
    for (const screen of SCREENS) {
      if ((value as Record<string, unknown>)[screen] === true) seen[screen] = true;
    }
    return seen;
  } catch {
    return {};
  }
}

export function withSeen(
  seen: Partial<Record<ScreenId, true>>,
  screen: ScreenId,
): Partial<Record<ScreenId, true>> {
  return { ...seen, [screen]: true };
}

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
 * The step's request as a multi-line `curl`. `copy` carries the real token; `screen` shows only
 * its masked form. Without a token both say `<your token>`. A route the token is not accepted on
 * (the public ones) carries no Authorization header, and a POST carries an Idempotency-Key.
 */
export function curlText(api: TourApi, context: CurlContext, mode: 'screen' | 'copy'): string {
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

// ---- The events of the last action ----

/** How far back "the last action" reaches. */
export const RECENT_MS = 60_000;

/**
 * The activity entries of the step's event types from the last minute, newest first as the feed
 * is. `nowMs` is business time (wall time plus the sandbox's clock offset), because the feed's
 * times are business times; an entry a few seconds ahead of `nowMs` still counts.
 */
export function recentEvents(
  entries: readonly ActivityEntry[],
  types: readonly string[],
  nowMs: number,
  windowMs: number = RECENT_MS,
): ActivityEntry[] {
  return entries.filter((entry) => {
    if (!types.includes(entry.type)) return false;
    const age = nowMs - Date.parse(entry.at);
    return Number.isFinite(age) && age >= -5_000 && age <= windowMs;
  });
}
