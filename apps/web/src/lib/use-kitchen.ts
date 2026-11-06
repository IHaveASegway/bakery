// The hook that owns the kitchen board's WebSocket (docs/architecture.md, "Durable Object
// topology"; the PR 4 build spec's "Kitchen"). It connects on mount, takes the snapshot the
// Kitchen sends on open, folds each `evt` into the board, reconnects with exponential backoff up
// to 30 s (each reconnect gets a fresh snapshot), and sends the console's heartbeat every 30 s
// while the socket is not open, so the Simulator can tell the console is still there.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { heartbeat, kitchenSocketUrl } from './api';
import {
  EMPTY_BOARD,
  applyEvent,
  backoffMs,
  commandFrame,
  parseFrame,
  pushFeed,
  type Action,
  type BoardState,
  type FeedEntry,
  type Frame,
} from './kitchen';
import { ulid } from './ulid';

export type Status = 'connecting' | 'open' | 'closed' | 'ended';

/** A command this page sent and what came back. `lost`: the socket closed before an answer. */
export interface Command {
  id: string;
  order: string;
  action: Action;
  status: 'sent' | 'ack' | 'nack' | 'lost';
  rule: string | null;
}

export interface KitchenState {
  status: Status;
  board: BoardState;
  feed: FeedEntry[];
  /** Sockets open on this sandbox's board, from the last `presence` frame. */
  sockets: number | null;
  commands: Command[];
  /** Why the server ended the connection for good (`wiped` or `limit`). */
  ended: string | null;
}

const INITIAL: KitchenState = {
  status: 'connecting',
  board: EMPTY_BOARD,
  feed: [],
  sockets: null,
  commands: [],
  ended: null,
};

type Event =
  | { kind: 'status'; status: Status }
  | { kind: 'frame'; frame: Frame }
  | { kind: 'sent'; command: Command }
  | { kind: 'closed' };

const KEEP_COMMANDS = 10;

function reduce(state: KitchenState, event: Event): KitchenState {
  switch (event.kind) {
    case 'status':
      // A fresh connection forgets why the last one ended.
      return {
        ...state,
        status: event.status,
        ended: event.status === 'connecting' ? null : state.ended,
      };
    case 'sent':
      return { ...state, commands: [event.command, ...state.commands].slice(0, KEEP_COMMANDS) };
    case 'closed':
      return {
        ...state,
        status: state.ended === null ? 'closed' : 'ended',
        sockets: null,
        commands: state.commands.map((c) => (c.status === 'sent' ? { ...c, status: 'lost' } : c)),
      };
    case 'frame': {
      const frame = event.frame;
      switch (frame.t) {
        case 'snapshot': {
          // A snapshot has no causes; keep the ones this page already saw for a card that did not move.
          const cards = { ...frame.board.cards };
          for (const [order, card] of Object.entries(cards)) {
            const before = state.board.cards[order];
            if (card.cause === null && before && before.updated_seq === card.updated_seq) {
              cards[order] = { ...card, cause: before.cause, last: before.last };
            }
          }
          // The Kitchen keeps its published-plan versions across a snapshot, and so does the page.
          return { ...state, board: { ...frame.board, cards, routes: state.board.routes } };
        }
        case 'evt':
          return {
            ...state,
            board: applyEvent(state.board, frame.env, frame.bakeList),
            feed: pushFeed(state.feed, frame.env),
          };
        case 'presence':
          return { ...state, sockets: frame.sockets };
        case 'bye':
          return { ...state, ended: frame.reason };
        case 'ack':
        case 'nack':
          return {
            ...state,
            commands: state.commands.map((c) =>
              c.id === frame.id
                ? {
                    ...c,
                    status: frame.t,
                    rule: frame.t === 'nack' ? frame.rule : null,
                  }
                : c,
            ),
          };
      }
    }
  }
}

export interface Kitchen extends KitchenState {
  /** Sends a staff command; the id comes back, or null when the socket is not open. */
  send(order: string, action: Action): string | null;
  /** Connects again after the server ended the connection for a reason that is not the wipe. */
  reconnect(): void;
}

/**
 * @param sandboxId the sandbox whose board to watch
 * @param onWiped called once when the server says the sandbox was wiped (`bye` with `wiped`)
 */
export function useKitchen(sandboxId: string, onWiped: () => void): Kitchen {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const [nonce, setNonce] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const wipedRef = useRef(onWiped);
  wipedRef.current = onWiped;

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ended: string | null = null;

    const connect = () => {
      dispatch({ kind: 'status', status: 'connecting' });
      let socket: WebSocket;
      try {
        socket = new WebSocket(kitchenSocketUrl(sandboxId));
      } catch {
        dispatch({ kind: 'closed' });
        timer = setTimeout(connect, backoffMs(attempt++));
        return;
      }
      socketRef.current = socket;
      socket.onopen = () => dispatch({ kind: 'status', status: 'open' });
      socket.onmessage = (message) => {
        if (typeof message.data !== 'string') return;
        const frame = parseFrame(message.data);
        if (frame === null) return;
        if (frame.t === 'snapshot') attempt = 0;
        if (frame.t === 'bye') ended = frame.reason;
        dispatch({ kind: 'frame', frame });
      };
      // An error is always followed by a close, which does the work.
      socket.onerror = () => undefined;
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (stopped) return;
        dispatch({ kind: 'closed' });
        if (ended === 'wiped') wipedRef.current();
        if (ended !== null) return;
        timer = setTimeout(connect, backoffMs(attempt++));
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(timer);
      socketRef.current?.close(1000);
      socketRef.current = null;
    };
  }, [sandboxId, nonce]);

  // The heartbeat: while the socket is not open, tell the API the console is still here.
  const open = state.status === 'open';
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    const beat = () => void heartbeat(sandboxId).catch(() => undefined);
    // A socket that just closed beats at once, so the Simulator's 90 s window starts fresh.
    if (wasOpen.current) beat();
    wasOpen.current = false;
    const timer = setInterval(beat, 30_000);
    return () => clearInterval(timer);
  }, [open, sandboxId]);

  const send = useCallback((order: string, action: Action) => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return null;
    const id = ulid();
    socket.send(commandFrame(id, order, action));
    dispatch({ kind: 'sent', command: { id, order, action, status: 'sent', rule: null } });
    return id;
  }, []);

  const reconnect = useCallback(() => setNonce((n) => n + 1), []);

  return { ...state, send, reconnect };
}
