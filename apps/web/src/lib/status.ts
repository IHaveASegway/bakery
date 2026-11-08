// The status page's logic, apart from the island so that it can be tested without a browser: the
// response as the page reads it, the one localStorage key, the sentences for each state, and the
// poller that looks every minute while the page is visible and stops while it is hidden.
import type { StatusResponse } from '../contracts';

/** What PR 13 adds to `GET /v1/status` (docs/roadmap.md, PR 13). */
export interface StatusCounters {
  orders_24h: number;
  payments_24h: number;
  payment_failures_24h: number;
  refunds_24h: number;
  sandboxes_24h: number;
  dlq_24h: number;
  last_wipe: { at: string; sandboxes: number; objects: number; ms: number } | null;
}

/** `live`: refreshed within 20 minutes. `stale`: an older snapshot. `unavailable`: none yet. */
export type CountersState = 'live' | 'stale' | 'unavailable';

/** The cron breaker's state and last run, as the generated contract has them. */
export type BreakerStatus = StatusResponse['breaker'];
export type BreakerState = BreakerStatus['state'];

/**
 * The additions, typed here until the generated StatusResponse carries them. Once it does, this
 * intersection is the same type twice, so regenerating the contract needs no edit in this file.
 */
export interface StatusExtras {
  counters: StatusCounters | null;
  counters_as_of: string | null;
  counters_state: CountersState;
}

export type StatusData = StatusResponse & StatusExtras;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function readCounters(raw: unknown): StatusCounters | null {
  if (!isObject(raw)) return null;
  const keys = [
    'orders_24h',
    'payments_24h',
    'payment_failures_24h',
    'refunds_24h',
    'sandboxes_24h',
    'dlq_24h',
  ] as const;
  if (!keys.every((k) => isCount(raw[k]))) return null;
  const wipe = raw.last_wipe;
  const last =
    isObject(wipe) &&
    isIso(wipe.at) &&
    isCount(wipe.sandboxes) &&
    isCount(wipe.objects) &&
    isCount(wipe.ms)
      ? { at: wipe.at, sandboxes: wipe.sandboxes, objects: wipe.objects, ms: wipe.ms }
      : null;
  return {
    orders_24h: raw.orders_24h as number,
    payments_24h: raw.payments_24h as number,
    payment_failures_24h: raw.payment_failures_24h as number,
    refunds_24h: raw.refunds_24h as number,
    sandboxes_24h: raw.sandboxes_24h as number,
    dlq_24h: raw.dlq_24h as number,
    last_wipe: last,
  };
}

const BREAKER_STATES: readonly string[] = ['unconfigured', 'armed', 'read-only', 'off'];

/**
 * The breaker as the API states it. An API that predates the breaker, or an answer that is not
 * one, reads as "unconfigured": the page never shows an armed breaker it was not told about.
 */
function readBreaker(raw: unknown): BreakerStatus {
  const none: BreakerStatus = {
    state: 'unconfigured',
    since: null,
    last_run: null,
    last_usd: null,
    unread: [],
  };
  if (!isObject(raw) || typeof raw.state !== 'string' || !BREAKER_STATES.includes(raw.state)) {
    return none;
  }
  return {
    state: raw.state as BreakerState,
    since: isIso(raw.since) ? raw.since : null,
    last_run: isIso(raw.last_run) ? raw.last_run : null,
    last_usd: typeof raw.last_usd === 'string' ? raw.last_usd : null,
    unread: Array.isArray(raw.unread) ? raw.unread.filter((m) => typeof m === 'string') : [],
  };
}

/**
 * A status response, or null when it is not one. A response from an API that predates the
 * counters (or one whose counters are malformed) reads as "unavailable", never as zeros.
 */
export function readStatus(raw: unknown): StatusData | null {
  if (!isObject(raw)) return null;
  if (!isCount(raw.sandboxes_today) || !isCount(raw.sandbox_cap) || typeof raw.day !== 'string') {
    return null;
  }
  const counters = readCounters(raw.counters);
  const asOf = isIso(raw.counters_as_of) ? raw.counters_as_of : null;
  const stated = raw.counters_state;
  const state: CountersState =
    counters === null
      ? 'unavailable'
      : stated === 'live' || stated === 'stale' || stated === 'unavailable'
        ? stated
        : 'stale';
  return {
    ...(raw as unknown as StatusResponse),
    counters,
    counters_as_of: counters === null ? null : asOf,
    counters_state: state,
    breaker: readBreaker(raw.breaker),
  };
}

/** What the page knows: nothing yet, a fresh answer, or the API's silence (with the last answer). */
export type Model =
  | { kind: 'loading' }
  | { kind: 'answered'; data: StatusData; fetchedAt: string }
  | {
      kind: 'unreachable';
      cached: { data: StatusData; fetchedAt: string } | null;
      /** The HTTP status when the API did answer but not with a status; absent for a network failure. */
      status?: number;
    };

// ---- The one storage key -----------------------------------------------------------------

/** The page's only use of browser storage: the last good response, for the day the API is down. */
export const STORAGE_KEY = 'bakery.status.last-good';

/** localStorage, or null where the browser refuses it (private windows, blocked site data). */
export function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

type Store = Pick<Storage, 'getItem' | 'setItem'> | null;

export function saveSnapshot(store: Store, data: StatusData, fetchedAt: string): boolean {
  try {
    if (store === null) return false;
    store.setItem(STORAGE_KEY, JSON.stringify({ fetchedAt, data }));
    return true;
  } catch {
    return false;
  }
}

/** The kept response, or null when there is none, storage is closed or the text is not ours. */
export function loadSnapshot(store: Store): { data: StatusData; fetchedAt: string } | null {
  try {
    if (store === null) return null;
    const text = store.getItem(STORAGE_KEY);
    if (text === null) return null;
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed) || !isIso(parsed.fetchedAt)) return null;
    const data = readStatus(parsed.data);
    return data === null ? null : { data, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

// ---- Words -------------------------------------------------------------------------------

/** `2026-11-06 14:15 UTC`: absolute, so the server's first paint and the browser's agree. */
export function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'an unknown time';
  const text = new Date(ms).toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`;
}

/** The state's name, which the page sets in bold: words, never color alone. */
export function stateLabel(state: CountersState): string {
  return state === 'live'
    ? 'Live.'
    : state === 'stale'
      ? 'Older than it should be.'
      : 'Not available yet.';
}

/** The rest of the sentence for a state. */
export function stateWords(state: CountersState, asOf: string | null): string {
  switch (state) {
    case 'live':
      return asOf === null
        ? 'The counters were refreshed within the last 20 minutes.'
        : `The counters were refreshed within the last 20 minutes, as of ${formatTime(asOf)}.`;
    case 'stale':
      return asOf === null
        ? 'The last refresh of the counters failed, so these numbers are old.'
        : `The last refresh of the counters failed, so these numbers are from ${formatTime(asOf)}.`;
    case 'unavailable':
      return 'The bakery has not read its counters yet. They appear after the first refresh, which runs every 15 minutes.';
  }
}

/** The breaker's line: what it is doing and since when, in words. */
export function breakerWords(b: BreakerStatus): string {
  switch (b.state) {
    case 'unconfigured':
      return 'not configured';
    case 'armed':
      return b.last_run === null
        ? 'armed, no run recorded yet'
        : `armed, last run ${formatTime(b.last_run)}`;
    case 'read-only':
    case 'off':
      return `tripped: ${b.state} since ${b.since === null ? 'an unknown time' : formatTime(b.since)}`;
  }
}

/** The bold label for a failed look: an answer that was an error is not an unreachable API. */
export function failureLabel(status?: number): string {
  return status === undefined ? 'Unreachable.' : 'Not available.';
}

/**
 * The sentence for a failed look, with the kept response's time when there is one. A `status`
 * means the API answered with an error; without one the request got no answer at all.
 */
export function unreachableWords(cached: { fetchedAt: string } | null, status?: number): string {
  const lead =
    status === undefined
      ? 'The API is unreachable'
      : `The API answered ${status}, so it is not available`;
  return cached === null
    ? `${lead}, and this browser has no earlier answer to show.`
    : `${lead}. This is the last answer this browser saw, from ${formatTime(cached.fetchedAt)}.`;
}

/** The HTTP status carried by a rejected call (an ApiError), or undefined for a network failure. */
export function failureStatus(error: unknown): number | undefined {
  if (!isObject(error) && !(error instanceof Error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

// ---- The poller --------------------------------------------------------------------------

export interface PollerDeps {
  /** Asks the API once; a rejection means it could not be reached. */
  load: () => Promise<unknown>;
  /** Called with each outcome: the response, or null when the call failed (and why, if known). */
  deliver: (raw: unknown | null, failure?: unknown) => void;
  visible: () => boolean;
  every: (run: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  intervalMs?: number;
}

/** Looks on load and every minute while the page is visible; stops while it is hidden. */
export const POLL_MS = 60_000;

export function createPoller(deps: PollerDeps) {
  let handle: unknown = null;
  let stopped = false;
  const run = () => {
    deps.load().then(
      (raw) => {
        if (!stopped) deps.deliver(raw);
      },
      (failure) => {
        if (!stopped) deps.deliver(null, failure);
      },
    );
  };
  const begin = () => {
    if (handle !== null || stopped) return;
    run();
    handle = deps.every(run, deps.intervalMs ?? POLL_MS);
  };
  const pause = () => {
    if (handle === null) return;
    deps.cancel(handle);
    handle = null;
  };
  return {
    /** Starts if the page is visible now. */
    start: () => {
      if (deps.visible()) begin();
    },
    /** Call on every visibilitychange: a hidden page stops, a shown page looks at once and resumes. */
    visibilityChanged: () => (deps.visible() ? begin() : pause()),
    stop: () => {
      stopped = true;
      pause();
    },
    get running() {
      return handle !== null;
    },
  };
}
