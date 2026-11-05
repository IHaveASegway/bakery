// The kitchen board's socket, protocol v1, as the storefront reads it (the PR 4 build spec's
// "Kitchen" section). Pure functions only: parsing a frame, folding events into the board and the
// reconnect delay. The hook that owns the WebSocket is lib/use-kitchen.ts.
//
// Server to client: `snapshot` on open, `evt` for each applied event, `presence`, `bye`, and the
// `ack` or `nack` that answers a `cmd`. Client to server: `cmd` only.

export type CardState = 'pending' | 'confirmed' | 'in_production' | 'ready' | 'out_for_delivery';

/** The board's columns, in the order an order moves through them. */
export const STATES: { state: CardState; label: string }[] = [
  { state: 'pending', label: 'Pending' },
  { state: 'confirmed', label: 'Confirmed' },
  { state: 'in_production', label: 'In production' },
  { state: 'ready', label: 'Ready' },
  { state: 'out_for_delivery', label: 'Out for delivery' },
];

export interface CardLine {
  variant: string;
  qty: number;
}

export interface Card {
  order: string;
  state: CardState;
  lines: CardLine[];
  /** The visitor's order note: shown as text, never as markup. */
  note: string | null;
  slot: string;
  kind: 'pickup' | 'delivery';
  updated_seq: number;
  /** The `cause` of the last event this page saw for the card, `sim:<ulid>` when simulated. */
  cause: string | null;
  /** The last event's type, when this page saw one. */
  last: string | null;
}

export interface BoardState {
  cards: Record<string, Card>;
  /** The highest `seq` applied per order, kept after the card leaves, as the domain's board does. */
  heads: Record<string, number>;
}

export const EMPTY_BOARD: BoardState = { cards: {}, heads: {} };

export interface Envelope {
  id: string;
  stream: string;
  seq: number;
  type: string;
  at: string;
  recorded_at: string;
  cause: string | null;
  data: Record<string, unknown>;
}

export type Action = 'start_production' | 'mark_ready' | 'mark_picked_up';

export type Frame =
  | { t: 'snapshot'; board: BoardState; seq: number }
  | { t: 'evt'; env: Envelope }
  | { t: 'presence'; sockets: number }
  | { t: 'bye'; reason: string }
  | { t: 'ack'; id: string }
  | { t: 'nack'; id: string; rule: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;
const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const STATE_NAMES = new Set<string>(STATES.map((s) => s.state));

function readLines(value: unknown): CardLine[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((l) => ({ variant: str(l['variant']), qty: num(l['qty']) }));
}

function readCard(raw: unknown, fallbackOrder = ''): Card | null {
  if (!isObject(raw)) return null;
  const state = str(raw['state']);
  const order = str(raw['order'], fallbackOrder);
  if (order === '' || !STATE_NAMES.has(state)) return null;
  return {
    order,
    state: state as CardState,
    lines: readLines(raw['lines']),
    note: typeof raw['note'] === 'string' ? raw['note'] : null,
    slot: str(raw['slot']),
    kind: raw['kind'] === 'delivery' ? 'delivery' : 'pickup',
    updated_seq: num(raw['updated_seq']),
    cause: typeof raw['cause'] === 'string' ? raw['cause'] : null,
    last: typeof raw['last'] === 'string' ? raw['last'] : null,
  };
}

/**
 * The board from a snapshot frame's `board`. The spec leaves its exact shape to the API, so this
 * takes the three natural ones: a list of cards, `{cards: [...]}`, or `{cards: {<order>: card}}`.
 */
export function boardFromSnapshot(raw: unknown): BoardState {
  const list: unknown[] = [];
  let source: unknown = raw;
  if (isObject(raw) && 'cards' in raw) source = raw['cards'];
  if (Array.isArray(source)) list.push(...source);
  else if (isObject(source)) {
    for (const [order, card] of Object.entries(source)) {
      list.push(isObject(card) && card['order'] === undefined ? { ...card, order } : card);
    }
  }
  const board: BoardState = { cards: {}, heads: {} };
  for (const entry of list) {
    const card = readCard(entry);
    if (card === null) continue;
    board.cards[card.order] = card;
    board.heads[card.order] = card.updated_seq;
  }
  return board;
}

function readEnvelope(raw: unknown): Envelope | null {
  if (!isObject(raw)) return null;
  const id = str(raw['id']);
  const type = str(raw['type']);
  if (id === '' || type === '') return null;
  return {
    id,
    stream: str(raw['stream']),
    seq: num(raw['seq']),
    type,
    at: str(raw['at']),
    recorded_at: str(raw['recorded_at']),
    cause: typeof raw['cause'] === 'string' ? raw['cause'] : null,
    data: isObject(raw['data']) ? raw['data'] : {},
  };
}

/** One frame, or null when the text is not a v1 frame this page understands. */
export function parseFrame(text: string): Frame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value) || value['v'] !== 1) return null;
  switch (value['t']) {
    case 'snapshot':
      return { t: 'snapshot', board: boardFromSnapshot(value['board']), seq: num(value['seq']) };
    case 'evt': {
      const env = readEnvelope(value['env']);
      return env === null ? null : { t: 'evt', env };
    }
    case 'presence':
      return { t: 'presence', sockets: num(value['sockets']) };
    case 'bye':
      return { t: 'bye', reason: str(value['reason']) };
    case 'ack':
      return { t: 'ack', id: str(value['id']) };
    case 'nack':
      return { t: 'nack', id: str(value['id']), rule: str(value['rule'], 'refused') };
    default:
      return null;
  }
}

/** The text of a `cmd` frame. `id` is a ULID and doubles as the command's idempotency key. */
export function commandFrame(id: string, order: string, action: Action): string {
  return JSON.stringify({ t: 'cmd', v: 1, id, order, action });
}

/** The order id is the stream's last part: `order:<sandbox>:<ulid>` or `order:<ulid>`. */
export function orderOf(stream: string): string | null {
  if (!stream.startsWith('order:')) return null;
  return stream.split(':').pop() || null;
}

const MOVES: Record<string, CardState> = {
  OrderPaid: 'confirmed',
  OrderProductionStarted: 'in_production',
  OrderReady: 'ready',
  OrderOutForDelivery: 'out_for_delivery',
};
const LEAVES = new Set(['OrderPickedUp', 'OrderDelivered', 'OrderExpired', 'OrderCancelled']);

/**
 * Folds one `evt` frame into the board, the way the Kitchen's own board does: ordered per order
 * by `seq` (anything not newer is ignored), a card is added by `OrderPlaced`, moved by the
 * production events and removed when the order is picked up, delivered, expired or cancelled.
 * An event for an order this page has no card for is ignored; the next snapshot repairs it.
 */
export function applyEvent(board: BoardState, env: Envelope): BoardState {
  const order = orderOf(env.stream);
  if (order === null) return board;
  const head = board.heads[order];
  if (head !== undefined && env.seq <= head) return board;
  const heads = { ...board.heads, [order]: env.seq };
  const cards = { ...board.cards };

  if (env.type === 'OrderPlaced') {
    const data = env.data;
    cards[order] = {
      order,
      state: 'pending',
      lines: readLines(data['lines']),
      note: typeof data['note'] === 'string' ? data['note'] : null,
      slot: str(data['slot']),
      kind: data['kind'] === 'delivery' ? 'delivery' : 'pickup',
      updated_seq: env.seq,
      cause: env.cause,
      last: env.type,
    };
    return { cards, heads };
  }
  const card = cards[order];
  if (card === undefined) return board;
  if (LEAVES.has(env.type)) {
    delete cards[order];
    return { cards, heads };
  }
  const state = MOVES[env.type];
  if (state === undefined) return board;
  cards[order] = { ...card, state, updated_seq: env.seq, cause: env.cause, last: env.type };
  return { cards, heads };
}

/** The cards in each column, by slot and then order id, empty columns kept. */
export function groupByState(
  board: BoardState,
): { state: CardState; label: string; cards: Card[] }[] {
  const all = Object.values(board.cards);
  return STATES.map(({ state, label }) => ({
    state,
    label,
    cards: all
      .filter((c) => c.state === state)
      .sort((a, b) => a.slot.localeCompare(b.slot) || a.order.localeCompare(b.order)),
  }));
}

/** What a staff member can do with a card in this state, if anything. */
export function actionFor(card: Card): { action: Action; label: string } | null {
  switch (card.state) {
    case 'confirmed':
      return { action: 'start_production', label: 'Start production' };
    case 'in_production':
      return { action: 'mark_ready', label: 'Mark ready' };
    case 'ready':
      // A delivery leaves with its route (PR 9), not from this button.
      return card.kind === 'pickup' ? { action: 'mark_picked_up', label: 'Mark picked up' } : null;
    default:
      return null;
  }
}

/** The activity feed's entries: the last 50 events, newest first. */
export const FEED_MAX = 50;

export interface FeedEntry {
  id: string;
  type: string;
  stream: string;
  seq: number;
  cause: string | null;
  /** Wall time of the recording, else the business time. */
  time: string;
}

export function pushFeed(feed: FeedEntry[], env: Envelope): FeedEntry[] {
  const entry: FeedEntry = {
    id: env.id,
    type: env.type,
    stream: env.stream,
    seq: env.seq,
    cause: env.cause,
    time: env.recorded_at || env.at,
  };
  return [entry, ...feed.filter((e) => e.id !== env.id)].slice(0, FEED_MAX);
}

/** True for a cause the Simulator set. */
export const isSimulated = (cause: string | null) => cause !== null && cause.startsWith('sim:');

/** Milliseconds to wait before reconnect number `attempt` (0 first): doubling from 1 s up to 30 s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}
