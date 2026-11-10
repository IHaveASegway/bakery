// The kitchen board's socket, protocol v1, as the storefront reads it (the PR 4 build spec's
// "Kitchen" section). Pure functions only: parsing a frame, folding events into the board and the
// reconnect delay. The hook that owns the WebSocket is lib/use-kitchen.ts.
//
// Server to client: `snapshot` on open, `evt` for each applied event, `presence`, `bye`, and the
// `ack` or `nack` that answers a `cmd`. Client to server: `cmd` only.
import { PACKAGES } from './catering';
import { itemName } from './words';

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
  /** A delivery's van in the published plan, `van-2`; null until a van has it. */
  van: string | null;
  /** The delivery's stop number across the plan's vans, counted from 1; null until a van has it. */
  stop: number | null;
}

/** One line of a day's plan: how many of an item to have ready for a slot or window start. */
export interface BakeLine {
  item: string;
  qty: number;
  start: string;
}

/** One day's bake list as the board shows it: the Schedule's latest plan and the reserved count. */
export interface BakeList {
  /** The bakery day, `YYYY-MM-DD`. */
  date: string;
  /** The plan's version; 0 until the day's first `BakeListChanged`. */
  version: number;
  lines: BakeLine[];
  /** How many places (orders, catering events) are reserved that day. */
  reserved: number;
}

/** Whether one ref is reserved on its day, as of the `seq` of the event that said so. */
export interface SlotMark {
  seq: number;
  reserved: boolean;
}

export interface BoardState {
  cards: Record<string, Card>;
  /** The highest `seq` applied per order, kept after the card leaves, as the domain's board does. */
  heads: Record<string, number>;
  /** The bake lists by date. */
  bakeLists: Record<string, BakeList>;
  /**
   * The reservations this page has seen events for, per day and ref, so a repeated or reordered
   * `SlotReserved` or `SlotReleased` does not count twice. A snapshot starts it over.
   */
  marks: Record<string, Record<string, SlotMark>>;
  /**
   * The highest `plan_v` of a `RoutePublished` this page has applied, per day, as the Kitchen's
   * `routes` map: a plan no newer than it changes nothing. Not in a snapshot, so the hook carries
   * it across one.
   */
  routes: Record<string, number>;
}

export const EMPTY_BOARD: BoardState = {
  cards: {},
  heads: {},
  bakeLists: {},
  marks: {},
  routes: {},
};

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
  | { t: 'evt'; env: Envelope; bakeList: BakeList | null }
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

const readVan = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
const readStop = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;

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
    van: readVan(raw['van']),
    stop: readStop(raw['stop']),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function readBakeLines(value: unknown): BakeLine[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .map((l) => ({ item: str(l['item']), qty: num(l['qty']), start: str(l['start']) }))
    .filter((l) => l.item !== '');
}

/** One day's `{date, version, lines: [{item, qty, start}], reserved}`, or null when it has no date. */
function readBakeList(entry: unknown): BakeList | null {
  if (!isObject(entry)) return null;
  const date = str(entry['date']);
  if (!DATE.test(date)) return null;
  return {
    date,
    version: num(entry['version']),
    lines: readBakeLines(entry['lines']),
    reserved: Math.max(0, num(entry['reserved'])),
  };
}

/** The snapshot's `board.bake_lists`: `[{date, version, lines: [{item, qty, start}], reserved}]`. */
function readBakeLists(value: unknown): BakeList[] {
  if (!Array.isArray(value)) return [];
  return value.map(readBakeList).filter((b): b is BakeList => b !== null);
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
  const board: BoardState = { cards: {}, heads: {}, bakeLists: {}, marks: {}, routes: {} };
  if (isObject(raw)) {
    for (const bakeList of readBakeLists(raw['bake_lists']))
      board.bakeLists[bakeList.date] = bakeList;
  }
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
      return env === null ? null : { t: 'evt', env, bakeList: readBakeList(value['bake_list']) };
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
 * `bakeList` is the frame's `bake_list`, the day as the Kitchen holds it after a Schedule event.
 */
export function applyEvent(
  board: BoardState,
  env: Envelope,
  bakeList: BakeList | null = null,
): BoardState {
  if (SCHEDULE_EVENTS.has(env.type)) return applyScheduleEvent(board, env, bakeList);
  if (env.type === 'RoutePublished') return applyRoutePublished(board, env);
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
      van: null,
      stop: null,
    };
    return { ...board, cards, heads };
  }
  const card = cards[order];
  if (card === undefined) return board;
  if (LEAVES.has(env.type)) {
    delete cards[order];
    return { ...board, cards, heads };
  }
  const state = MOVES[env.type];
  if (state === undefined) return board;
  const moved = { ...card, state, updated_seq: env.seq, cause: env.cause, last: env.type };
  if (env.type === 'OrderOutForDelivery') {
    // The van leaving sets the pair again, so the fold agrees with a snapshot (kitchen.rs does too).
    moved.van = readVan(env.data['route']) ?? card.van;
    moved.stop = readStop(env.data['stop']) ?? card.stop;
  }
  cards[order] = moved;
  return { ...board, cards, heads };
}

/**
 * `RoutePublished`, folded the way crates/domain/src/kitchen.rs `apply_route` does. A plan no newer
 * than the day's last one (`plan_v <=` the highest seen) changes nothing; otherwise the day's
 * highest is recorded and each order of the plan that has a card gets `van-<n>` and its stop
 * number, counted from 1 across the vans in order (`deliveries()`). A card the plan does not name
 * keeps whatever it had (a plan never clears a label), an order with no card is skipped, and no
 * card's `seq`, state, cause or `last` moves: the event is not the order's.
 */
function applyRoutePublished(board: BoardState, env: Envelope): BoardState {
  const date = str(env.data['date']);
  const planV = env.data['plan_v'];
  const vans = env.data['vans'];
  if (!DATE.test(date) || typeof planV !== 'number' || !Number.isInteger(planV)) return board;
  if (!Array.isArray(vans)) return board;
  const seen = board.routes[date];
  if (seen !== undefined && planV <= seen) return board;
  const cards = { ...board.cards };
  let stop = 0;
  for (const route of vans.filter(isObject)) {
    const van = num(route['van'], -1);
    const stops = Array.isArray(route['stops']) ? route['stops'] : [];
    for (const order of stops) {
      stop += 1;
      if (typeof order !== 'string' || van < 0) continue;
      const card = cards[order];
      if (card !== undefined) cards[order] = { ...card, van: `van-${van}`, stop };
    }
  }
  return { ...board, cards, routes: { ...board.routes, [date]: planV } };
}

const SCHEDULE_EVENTS = new Set(['BakeListChanged', 'SlotReserved', 'SlotReleased']);

/** The day an envelope of the Schedule's stream (`schedule:<sandbox>:<date>`) is about. */
function scheduleDate(env: Envelope): string | null {
  const fromData = str(env.data['date']);
  if (DATE.test(fromData)) return fromData;
  const fromStream = env.stream.split(':').pop() ?? '';
  return DATE.test(fromStream) ? fromStream : null;
}

const emptyDay = (date: string): BakeList => ({ date, version: 0, lines: [], reserved: 0 });

/**
 * The Schedule's events. When the frame carries the day as the Kitchen now holds it (`bake_list`,
 * since 2026-11-06), the page sets the day from it: the Kitchen has seen every reservation since
 * the sandbox's birth, so its count is right where this page's cannot be. A place reserved before
 * the page's snapshot and released while it watches is one this page never saw reserved, so an
 * adjusted count would stay one too high. A set is idempotent and survives a missed frame.
 *
 * Without `bake_list` (a frame from a Kitchen built before it) the events are folded the way the
 * Kitchen's own board does (crates/domain/src/kitchen.rs). `BakeListChanged` carries the plan's
 * `version`: a higher one replaces the day's plan, an equal or lower one is ignored, whatever
 * order they arrive in. `SlotReserved` and `SlotReleased` move the day's `reserved` count by ref,
 * the latest `seq` of a ref winning, so a repeat counts once. A release of a ref this page never
 * saw reserved changes nothing: it may have been a hold, and a count from the snapshot cannot say
 * which. The next snapshot repairs that drift.
 */
function applyScheduleEvent(
  board: BoardState,
  env: Envelope,
  bakeList: BakeList | null = null,
): BoardState {
  const date = scheduleDate(env);
  if (date === null) return board;
  if (bakeList !== null && bakeList.date === date) {
    return { ...board, bakeLists: { ...board.bakeLists, [date]: bakeList } };
  }
  const day = board.bakeLists[date] ?? emptyDay(date);

  if (env.type === 'BakeListChanged') {
    const version = num(env.data['version']);
    if (version <= day.version) return board;
    const next: BakeList = { ...day, version, lines: readBakeLines(env.data['lines']) };
    return { ...board, bakeLists: { ...board.bakeLists, [date]: next } };
  }

  const ref = str(env.data['ref']);
  if (ref === '') return board;
  const reserved = env.type === 'SlotReserved';
  const known = board.marks[date]?.[ref];
  if (known !== undefined && env.seq <= known.seq) return board;
  const marks = {
    ...board.marks,
    [date]: { ...board.marks[date], [ref]: { seq: env.seq, reserved } },
  };
  // A reservation counts once; a release counts only for a reservation this page saw.
  const delta = reserved ? (known?.reserved ? 0 : 1) : known?.reserved ? -1 : 0;
  if (delta === 0) return { ...board, marks };
  const next: BakeList = { ...day, reserved: Math.max(0, day.reserved + delta) };
  return { ...board, marks, bakeLists: { ...board.bakeLists, [date]: next } };
}

/** The bake lists by date, earliest first, from `today` on when it is given. */
export function bakeListsByDate(board: BoardState, today: string | null = null): BakeList[] {
  return Object.values(board.bakeLists)
    .filter((b) => today === null || b.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface BakeGroup {
  /** The slot or window start, a business time. */
  start: string;
  items: { item: string; qty: number }[];
}

/** A plan's lines grouped by start (in time order) and then item (by name); same item and start summed. */
export function groupBakeLines(lines: BakeLine[]): BakeGroup[] {
  const groups = new Map<string, Map<string, number>>();
  for (const line of lines) {
    const items = groups.get(line.start) ?? new Map<string, number>();
    items.set(line.item, (items.get(line.item) ?? 0) + line.qty);
    groups.set(line.start, items);
  }
  const at = (start: string) => {
    const ms = Date.parse(start);
    return Number.isNaN(ms) ? Infinity : ms;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => at(a) - at(b) || a.localeCompare(b))
    .map(([start, items]) => ({
      start,
      items: [...items.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([item, qty]) => ({ item, qty })),
    }));
}

/**
 * One line of a bake list in words: "12 × Country loaf" for a menu item, and "Breakfast spread for
 * 40 people" for a catering event, whose line is the package's slug with the headcount as its
 * quantity (crates/domain/src/schedule.rs, "The catering place"). The API marks such a line
 * `catering: true` since 2026-11-08; a frame from before that is told apart by the package slug.
 */
export function bakeLineText(line: { item: string; qty: number; catering?: boolean }): string {
  const pack = PACKAGES.find((p) => p.slug === line.item);
  if (line.catering === true || pack !== undefined) {
    const label = pack?.label ?? itemName(line.item);
    return `${label} for ${line.qty} ${line.qty === 1 ? 'person' : 'people'}`;
  }
  return `${line.qty} × ${itemName(line.item)}`;
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

/**
 * Where a delivery's card is in the published plan: "Van 2, stop 3". Null when no van has it. The
 * van is the plan's label, `van-2`; a label of another shape is shown as it came, dashes as spaces.
 */
export function routeWords(card: Pick<Card, 'van' | 'stop'>): string | null {
  const number = card.van === null ? undefined : /^van-(\d+)$/.exec(card.van)?.[1];
  const van =
    card.van === null
      ? null
      : number
        ? `Van ${number}`
        : card.van.replaceAll('-', ' ').replace(/^./, (c) => c.toUpperCase());
  if (van !== null) return card.stop === null ? van : `${van}, stop ${card.stop}`;
  return card.stop === null ? null : `Stop ${card.stop}`;
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

/**
 * What a card with no button waits for, in words, or null when it has a button (the audit of 2026-11-10).
 * A ready delivery leaves with a van, not from the board: once the day's plan is published on
 * Dispatch, a delivery that is ready goes out on it, at the publish or as soon as Dispatch hears it
 * is ready (workers/api/src/objects/order.rs: `RoutePublished` and `StopReady` become
 * `MarkOutForDelivery`). `dispatch` is true when the next step is on the Dispatch page.
 */
export function waitingFor(
  card: Pick<Card, 'state' | 'kind' | 'van'>,
): { text: string; dispatch: boolean } | null {
  if (card.state !== 'ready' || card.kind !== 'delivery') return null;
  if (card.van !== null)
    return { text: 'Goes out with its van, from the published plan.', dispatch: false };
  return {
    text: 'Waits for a van: it goes out when the day’s plan is published on',
    dispatch: true,
  };
}

/**
 * An event's type in its words, `OrderProductionStarted` as `Order`, `Production`, `Started`, so a
 * chip can break between them inside a narrow card instead of running past its edge.
 */
export const eventWords = (type: string): string[] => type.split(/(?=[A-Z][a-z])/);

/**
 * An event's type for a card's chip: its words joined by soft hyphens, so a narrow card breaks it
 * only between two words, with a hyphen at the break, and never inside one. The text reads as the
 * type when nothing breaks it.
 */
export const chipText = (type: string): string => eventWords(type).join('\u00AD');

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
