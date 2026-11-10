// The guide's reader of the server's flight recorder (ADR 0015; docs/architecture.md, "The guide").
// It turns the recorder's hops into evidence for the trace store (lib/trace.ts, recorderSource),
// so a note can say what happened to the events an action wrote instead of what to expect.
//
// Two ways, each bounded by what it is for:
// - A note reads `GET /v1/sandboxes/{id}/trace?after=<cursor>` at most three times after the
//   visitor's write is answered 2xx, at growing gaps (about 0.4 s, 1.2 s and 3 s after it), and
//   stops at the first read that holds every event the note expects. The route spends no rate
//   limit (`Limit::None` in workers/api/src/http/routes.rs); each read is one Worker request and
//   one Recorder request, and a page of at most 50 batches. So a note costs at most three reads,
//   plus at most two follow-on pages when a read says `more`; none while the tab is hidden.
// - The recorder panel, while it is open and the tab is shown, holds the recorder's socket
//   (`/trace/ws`: the session cookie, the exact Origin, the session's upgrade limit, which it
//   shares with the kitchen socket, and at most 4 sockets a Recorder). When the upgrade is refused
//   (a preview's Origin is not the API's), it reads every 5 seconds instead, and says so.
//
// What the recorder cannot promise, as a reader meets it: a hop can be lost (recording runs after
// the acks), so an event no hop shows stays "expected" and is never said not to have happened;
// `missed` says older hops left the ring of 200 batches; a 410 `wiped` stops everything.
import { useSyncExternalStore } from 'react';
import type { TraceFrame, TraceResponse } from '../contracts';
import { ApiError, getTrace, traceSocketUrl } from './api';
import { fromHop, recorderSource, type Reading } from './trace';

/**
 * The gaps between a note's reads of the recorder, after its write is answered: three in the first
 * 3 s, when an event usually shows, then more spaced out until about 30 s (audit G4, 2026-11-10).
 * An event not seen after the first three is said to be late, and listened for until the last.
 */
export const NOTE_READS_MS = [400, 800, 1_800, 3_000, 5_000, 8_000, 12_000] as const;
/** After this many reads an event not yet seen is late: about 3 s after the answer. */
export const NOTE_READS_ON_TIME = 3;
/** A follow-on page when a read says `more`, at most this many a read. */
const MORE_PAGES = 2;
/** The panel's read when its socket is refused. */
export const PANEL_POLL_MS = 5_000;

export interface RecorderState {
  /** Older hops left the ring between two reads: what they held is not known. */
  missed: boolean;
  /** The sandbox is wiped: nothing more is read. */
  wiped: boolean;
  /** The panel's link: its socket, polling because the socket was refused, or nothing. */
  panel: 'off' | 'socket' | 'polling';
}

// The hops themselves are not kept here: they go to the trace store (lib/trace.ts), which holds
// both what a note shows and what the panel lists, by one rule (audit H1, 2026-11-10).
let state: RecorderState = {
  missed: false,
  wiped: false,
  panel: 'off',
};
const listeners = new Set<() => void>();
const set = (change: Partial<RecorderState>) => {
  state = { ...state, ...change };
  for (const listener of listeners) listener();
};
export const recorderState = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
export const useRecorderState = () =>
  useSyncExternalStore(recorderState.subscribe, recorderState.get, recorderState.get);

/** One cursor a sandbox, in memory: the next read starts after the last batch seen. */
const cursors = new Map<string, number>();

/** Hands a page of hops to the trace store and keeps its cursor. */
function take(sandboxId: string, page: Pick<TraceResponse, 'hops' | 'cursor'>, missed: boolean) {
  const now = Date.now();
  for (const hop of page.hops) recorderSource.emit(fromHop(hop, now));
  // The first read of a sandbox starts from the oldest batch kept, so `missed` says nothing there.
  if (missed && cursors.has(sandboxId)) set({ missed: true });
  cursors.set(sandboxId, page.cursor);
}

/**
 * One read, with up to MORE_PAGES follow-on pages; false when the sandbox is gone. Two notes
 * whose reads fall due together share one read in flight: the second waits for the first.
 */
const inFlight = new Map<string, Promise<boolean>>();
function readOnce(sandboxId: string): Promise<boolean> {
  const running = inFlight.get(sandboxId);
  if (running !== undefined) return running;
  const read = readPages(sandboxId).finally(() => inFlight.delete(sandboxId));
  inFlight.set(sandboxId, read);
  return read;
}

async function readPages(sandboxId: string): Promise<boolean> {
  try {
    for (let page = 0; page <= MORE_PAGES; page++) {
      const answer = await getTrace(sandboxId, cursors.get(sandboxId) ?? 0);
      take(sandboxId, answer, answer.missed);
      if (!answer.more) break;
    }
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 410) {
      set({ wiped: true });
      return false;
    }
    // Offline, or the API refused: the note keeps its expected events, and says nothing worse.
    return true;
  }
}

/** The sandbox a page path names, if it is a sandbox's own route. */
export function sandboxOf(path: string): string | null {
  const m = /^\/v1\/sandboxes\/([^/?]+)/.exec(path);
  return m === null ? null : decodeURIComponent(m[1] ?? '');
}

/**
 * After the visitor's write is answered: read the recorder at most NOTE_READS_MS.length times (late
 * after NOTE_READS_ON_TIME of them), stopping as soon as `seen` says every expected event is
 * observed, or the tab is hidden, or the sandbox is wiped. How far the reads got is told to the
 * trace store as evidence on the write's trace (`key`), so the note and the recorder panel read
 * it from one place. A newer write's reads run beside these; a read both are due for is shared.
 */
export async function followWrite(
  sandboxId: string,
  key: string,
  seen: () => boolean,
): Promise<void> {
  const say = (reading: Reading) => recorderSource.emit({ kind: 'reads', key, state: reading });
  set({ missed: false });
  say('reading');
  for (const [i, gap] of NOTE_READS_MS.entries()) {
    await new Promise((done) => setTimeout(done, gap));
    if (state.wiped) break;
    if (typeof document !== 'undefined' && document.hidden) break;
    if (!(await readOnce(sandboxId))) break;
    if (seen()) break;
    if (i + 1 === NOTE_READS_ON_TIME) say('late');
  }
  say('done');
}

/**
 * The panel's live tail: the recorder's socket while the panel is open and the tab shown, else a
 * read every PANEL_POLL_MS. Returns the stop.
 */
export function tailForPanel(sandboxId: string): () => void {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let opened = false;

  const poll = () => {
    if (timer !== null || stopped) return;
    set({ panel: 'polling' });
    void readOnce(sandboxId);
    timer = setInterval(() => {
      if (!document.hidden) void readOnce(sandboxId);
    }, PANEL_POLL_MS);
  };
  const close = () => {
    socket?.close();
    socket = null;
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const open = () => {
    if (stopped || document.hidden) return;
    try {
      socket = new WebSocket(traceSocketUrl(sandboxId));
    } catch {
      poll();
      return;
    }
    socket.onopen = () => {
      opened = true;
      set({ panel: 'socket' });
    };
    socket.onmessage = (message) => {
      if (typeof message.data !== 'string') return;
      let frame: TraceFrame;
      try {
        frame = JSON.parse(message.data) as TraceFrame;
      } catch {
        return;
      }
      if (frame.t === 'snapshot' || frame.t === 'hops') {
        take(sandboxId, frame, false);
      } else if (frame.t === 'bye' && frame.reason === 'wiped') {
        set({ wiped: true });
        stop();
      }
    };
    // A refused upgrade (a preview's Origin, a spent upgrade limit) never opens: read instead.
    socket.onclose = () => {
      socket = null;
      if (!stopped && !opened) poll();
      else if (!stopped && !document.hidden) poll();
    };
  };
  const visibility = () => {
    if (document.hidden) {
      close();
      set({ panel: 'off' });
    } else {
      opened = false;
      open();
    }
  };
  const stop = () => {
    stopped = true;
    close();
    document.removeEventListener('visibilitychange', visibility);
    set({ panel: 'off' });
  };
  document.addEventListener('visibilitychange', visibility);
  open();
  return stop;
}
