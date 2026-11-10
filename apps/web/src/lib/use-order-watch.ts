// The status page's watch on one order. It reads the order once,
// then follows it over the sandbox's kitchen socket, the frames the board gets. It is a guest on
// that socket in every sense: it never sends a frame (no command, no ping), it sends no
// heartbeat (that is the console's, for the Simulator), and it gives its socket up when the
// board says four are open (kitchen.rs, MAX_SOCKETS), so a console opened after it still gets a
// place. Without a socket it reads the order every ten seconds. It closes the socket and stops
// reading when the order is finished or the tab is hidden, and starts again when the tab shows.
import { useEffect, useReducer } from 'react';
import { ApiError, NetworkError, getOrder, kitchenSocketUrl } from './api';
import { backoffMs, parseFrame } from './kitchen';
import {
  POLL_MS,
  finished,
  isAbout,
  needsRead,
  shouldYield,
  trackFrom,
  withCard,
  withEvent,
  withOrder,
  type Track,
} from './order-track';
import { watchSource } from './trace';

/**
 * Where the page's news comes from: `live` the socket, `polling` a read every ten seconds,
 * `paused` nothing while the tab is hidden, `done` nothing because the order is finished.
 */
export type Source = 'connecting' | 'live' | 'polling' | 'paused' | 'done';

/** Why the page is reading instead of listening. */
export type NoSocket = 'yielded' | 'limit' | 'unavailable' | null;

export interface Watch {
  phase: 'loading' | 'found' | 'missing' | 'offline';
  track: Track | null;
  source: Source;
  noSocket: NoSocket;
}

type Event =
  | { kind: 'order'; order: Parameters<typeof trackFrom>[0] }
  | { kind: 'missing' }
  | { kind: 'offline' }
  | { kind: 'source'; source: Source; noSocket?: NoSocket }
  | { kind: 'card'; card: Parameters<typeof withCard>[1] }
  | { kind: 'event'; env: Parameters<typeof withEvent>[1] };

const INITIAL: Watch = { phase: 'loading', track: null, source: 'connecting', noSocket: null };

function reduce(state: Watch, event: Event): Watch {
  switch (event.kind) {
    case 'order':
      return {
        ...state,
        phase: 'found',
        track: state.track === null ? trackFrom(event.order) : withOrder(state.track, event.order),
      };
    case 'missing':
      return { ...state, phase: 'missing' };
    case 'offline':
      return state.track === null ? { ...state, phase: 'offline' } : state;
    case 'source':
      return {
        ...state,
        source: event.source,
        noSocket: event.noSocket === undefined ? state.noSocket : event.noSocket,
      };
    case 'card':
      return state.track === null ? state : { ...state, track: withCard(state.track, event.card) };
    case 'event':
      return state.track === null ? state : { ...state, track: withEvent(state.track, event.env) };
  }
}

/** Reconnects after a socket that closed by itself, before the page settles for reading. */
const RECONNECTS = 3;

/**
 * @param sandboxId the session's sandbox, or null while it is not known (no socket, no read)
 * @param orderId the order to follow, from the page's `?id=`
 */
/**
 * The guide's store (lib/trace.ts) hears how the page listens: on the socket, reading every ten
 * seconds and why, paused or done. Connecting is not news, so it is not told.
 */
function tellListening(source: Source, why: NoSocket | undefined): void {
  if (source === 'connecting') return;
  const how = source === 'live' ? 'socket' : source === 'polling' ? 'reading' : source;
  watchSource.emit({
    kind: 'listening',
    how,
    why: how === 'reading' ? (why ?? null) : null,
    at: Date.now(),
  });
}

export function useOrderWatch(sandboxId: string | null, orderId: string): Watch {
  const [state, base] = useReducer(reduce, INITIAL);
  const dispatch = (event: Event) => {
    if (event.kind === 'source') tellListening(event.source, event.noSocket);
    base(event);
  };

  useEffect(() => {
    if (sandboxId === null || orderId === '') return;
    let stopped = false;
    let socket: WebSocket | null = null;
    let poll: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    // Once the board says it is full, the page stays off the socket until the tab is shown again.
    let yielded = false;
    let done = false;

    const stopSocket = () => {
      const s = socket;
      socket = null;
      if (s !== null) {
        s.onopen = s.onmessage = s.onerror = s.onclose = null;
        s.close(1000);
      }
      clearTimeout(retry);
    };
    const stopPolling = () => {
      clearInterval(poll);
      poll = undefined;
    };
    const finish = () => {
      done = true;
      stopSocket();
      stopPolling();
      dispatch({ kind: 'source', source: 'done' });
    };

    const read = async () => {
      try {
        const order = await getOrder(sandboxId, orderId);
        if (stopped) return;
        dispatch({ kind: 'order', order });
        if (finished(order.status)) finish();
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 410)) {
          dispatch({ kind: 'missing' });
          done = true;
          stopSocket();
          stopPolling();
        } else if (e instanceof NetworkError || e instanceof ApiError) {
          dispatch({ kind: 'offline' });
        }
      }
    };

    const startPolling = (why: NoSocket) => {
      dispatch({ kind: 'source', source: 'polling', noSocket: why });
      if (poll === undefined) poll = setInterval(() => void read(), POLL_MS);
    };

    const connect = () => {
      if (stopped || done || yielded || document.hidden) return;
      let s: WebSocket;
      try {
        s = new WebSocket(kitchenSocketUrl(sandboxId));
      } catch {
        startPolling('unavailable');
        return;
      }
      socket = s;
      if (poll === undefined) dispatch({ kind: 'source', source: 'connecting' });
      let ended: string | null = null;
      s.onmessage = (message) => {
        if (typeof message.data !== 'string') return;
        const frame = parseFrame(message.data);
        if (frame === null) return;
        switch (frame.t) {
          case 'snapshot': {
            attempts = 0;
            stopPolling();
            dispatch({ kind: 'source', source: 'live', noSocket: null });
            const card = frame.board.cards[orderId];
            // Off the board means finished or never paid for long: the order itself says which.
            if (card === undefined) void read();
            else dispatch({ kind: 'card', card });
            break;
          }
          case 'evt': {
            if (!isAbout(frame.env, orderId)) break;
            const { id, type, stream, seq, cause } = frame.env;
            watchSource.emit({ kind: 'heard', id, type, stream, seq, cause, at: Date.now() });
            dispatch({ kind: 'event', env: frame.env });
            if (needsRead(frame.env)) void read();
            else if (frame.env.type === 'OrderPickedUp' || frame.env.type === 'OrderDelivered') {
              finish();
            }
            break;
          }
          case 'presence':
            // Four open, this page's among them: give the place back to the board's screens.
            if (shouldYield(frame.sockets)) {
              yielded = true;
              stopSocket();
              startPolling('yielded');
            }
            break;
          case 'bye':
            ended = frame.reason;
            break;
          default:
            break;
        }
      };
      s.onerror = () => undefined;
      s.onclose = () => {
        if (socket !== s) return;
        socket = null;
        if (stopped || done) return;
        if (ended === 'wiped') {
          // The sandbox is gone, and the order with it.
          done = true;
          stopPolling();
          dispatch({ kind: 'missing' });
          return;
        }
        if (ended === 'limit') {
          yielded = true;
          startPolling('limit');
          return;
        }
        startPolling('unavailable');
        if (attempts < RECONNECTS) retry = setTimeout(connect, backoffMs(attempts++));
      };
    };

    const onVisibility = () => {
      if (stopped || done) return;
      if (document.hidden) {
        stopSocket();
        stopPolling();
        dispatch({ kind: 'source', source: 'paused' });
      } else {
        attempts = 0;
        yielded = false;
        void read().then(() => {
          if (!stopped && !done) connect();
        });
      }
    };

    void read().then(() => {
      if (stopped || done) return;
      if (document.hidden) dispatch({ kind: 'source', source: 'paused' });
      else connect();
    });
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      stopSocket();
      stopPolling();
    };
  }, [sandboxId, orderId]);

  return state;
}
