// The order's live status page (/order/?id=<order id>), as pure functions: the steps an order
// takes, where an order's status puts it, and how the page folds what it hears into what it shows.
// The hook that owns the socket and the slow reads is lib/use-order-watch.ts; the page is
// components/OrderStatus.tsx.
//
// The page hears about its order from three places, each with the order stream's `seq`: the
// order itself (`GET .../orders/{oid}`, `events_seq`), the kitchen socket's snapshot (the card's
// `updated_seq`) and the socket's `evt` frames (the envelope's `seq`). Whatever is newest wins,
// so a frame that arrives late or twice changes nothing.
import type { OrderResponse, OrderStatus } from '../contracts';
import type { Card, CardState, Envelope } from './kitchen';

export type Stage =
  'placed' | 'paid' | 'in_production' | 'ready' | 'picked_up' | 'out_for_delivery' | 'delivered';

/** The badge tone of each step, the kitchen board's colours (design brief, 2026-11-09). */
export type Tone = 'pending' | 'confirmed' | 'making' | 'ready' | 'out' | 'done' | 'problem';

export const STAGE_LABEL: Record<Stage, string> = {
  placed: 'Placed',
  paid: 'Paid',
  in_production: 'In production',
  ready: 'Ready',
  picked_up: 'Picked up',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
};

export const STAGE_TONE: Record<Stage, Tone> = {
  placed: 'pending',
  paid: 'confirmed',
  in_production: 'making',
  ready: 'ready',
  picked_up: 'done',
  out_for_delivery: 'out',
  delivered: 'done',
};

const PICKUP: Stage[] = ['placed', 'paid', 'in_production', 'ready', 'picked_up'];
const DELIVERY: Stage[] = [
  'placed',
  'paid',
  'in_production',
  'ready',
  'out_for_delivery',
  'delivered',
];

/** The steps an order of this kind takes, in order. */
export const stagesFor = (kind: 'pickup' | 'delivery'): Stage[] =>
  kind === 'delivery' ? DELIVERY : PICKUP;

/** The statuses that leave the tracker: the order will not be made. */
export type OffTrack = 'expired' | 'cancelled' | 'refund_pending';

export function offTrack(status: OrderStatus): OffTrack | null {
  return status === 'expired' || status === 'cancelled' || status === 'refund_pending'
    ? status
    : null;
}

/**
 * How many of the kind's steps an order in this status has taken, counted from 1 (placed is 1).
 * An order off the track has taken the steps up to where it left, which the page does not show.
 */
export function stepsTaken(status: OrderStatus, kind: 'pickup' | 'delivery'): number {
  const stages = stagesFor(kind);
  switch (status) {
    case 'placed':
      return 1;
    case 'confirmed':
      return 2;
    case 'in_production':
      return 3;
    case 'ready':
      return 4;
    case 'picked_up':
    case 'out_for_delivery':
      return 5;
    case 'delivered':
      return 6;
    case 'closed':
      return stages.length;
    default:
      return 0;
  }
}

/** The step an order in this status is at, or null off the track. */
export function stageOf(status: OrderStatus, kind: 'pickup' | 'delivery'): Stage | null {
  const taken = stepsTaken(status, kind);
  return taken === 0 ? null : (stagesFor(kind)[taken - 1] ?? null);
}

/** Whether the page can stop listening: nothing the kitchen does will move this order again. */
export function finished(status: OrderStatus): boolean {
  return (
    status === 'picked_up' ||
    status === 'delivered' ||
    status === 'closed' ||
    status === 'expired' ||
    status === 'cancelled' ||
    status === 'refund_pending'
  );
}

/** The status each of the order's events leaves it in (docs/domain.md, "Order"). */
const STATUS_OF_EVENT: Record<string, OrderStatus> = {
  OrderPaid: 'confirmed',
  OrderProductionStarted: 'in_production',
  OrderReady: 'ready',
  OrderPickedUp: 'picked_up',
  OrderOutForDelivery: 'out_for_delivery',
  OrderDelivered: 'delivered',
  OrderExpired: 'expired',
  OrderCancelled: 'cancelled',
  OrderClosed: 'closed',
};

const STATUS_OF_CARD: Record<CardState, OrderStatus> = {
  pending: 'placed',
  confirmed: 'confirmed',
  in_production: 'in_production',
  ready: 'ready',
  out_for_delivery: 'out_for_delivery',
};

/** What the page knows: the order as last read, its status as last heard, and when each step was. */
export interface Track {
  order: OrderResponse;
  status: OrderStatus;
  /** The order stream's `seq` the status is as of. */
  seq: number;
  /** When each step happened, a business time, for the steps this page saw or read a time for. */
  times: Partial<Record<Stage, string>>;
  /** The last event this page heard for the order over the socket, for the page to say so. */
  heard: { type: string; at: string } | null;
}

const STAGES: Stage[] = [
  'placed',
  'paid',
  'in_production',
  'ready',
  'picked_up',
  'out_for_delivery',
  'delivered',
];

/**
 * When each step happened, from the order's own answer (`step_times`, since 2026-11-10, roadmap
 * R94): the order's events and their business times, so "Paid" has its time on the first load and
 * after a reload, though no tab heard the payment. An answer from before the field gives
 * `placed_at` alone.
 */
export function timesOf(order: OrderResponse): Track['times'] {
  const times: Track['times'] = { placed: order.placed_at };
  for (const stage of STAGES) {
    const at = order.step_times?.[stage];
    if (typeof at === 'string' && at !== '') times[stage] = at;
  }
  return times;
}

/**
 * A track from a fresh read of the order. The page reads the times from this answer first; an
 * event heard on the socket afterwards adds its own (`withEvent`). The socket's snapshot carries
 * no times, only each card's state and `seq`.
 */
export function trackFrom(order: OrderResponse): Track {
  return {
    order,
    status: order.status,
    seq: order.events_seq,
    times: timesOf(order),
    heard: null,
  };
}

/** A newer read of the order replaces what the page knew; an older one changes nothing. */
export function withOrder(track: Track, order: OrderResponse): Track {
  if (order.id !== track.order.id || order.events_seq < track.seq) return track;
  return {
    ...track,
    order,
    status: order.status,
    seq: order.events_seq,
    times: { ...track.times, ...timesOf(order) },
  };
}

/** The snapshot's card for the order, when it is newer than what the page knew. */
export function withCard(track: Track, card: Card): Track {
  if (card.order !== track.order.id || card.updated_seq <= track.seq) return track;
  return { ...track, status: STATUS_OF_CARD[card.state], seq: card.updated_seq };
}

/**
 * One `evt` frame. An envelope of another stream, or not newer than what the page knew, changes
 * nothing. An event of the order that does not move it (a refund, say) only moves `seq`, and the
 * caller reads the order again.
 */
export function withEvent(track: Track, env: Envelope): Track {
  if (env.seq <= track.seq) return track;
  const status = STATUS_OF_EVENT[env.type];
  const heard = { type: env.type, at: env.at };
  if (status === undefined) return { ...track, seq: env.seq, heard };
  const stage = stageOf(status, track.order.kind);
  const times = stage === null || env.at === '' ? track.times : { ...track.times, [stage]: env.at };
  return { ...track, status, seq: env.seq, times, heard };
}

/** Whether an envelope is about this order: its stream is `order:<sandbox>:<order id>`. */
export function isAbout(env: Envelope, orderId: string): boolean {
  return env.stream.startsWith('order:') && env.stream.split(':').pop() === orderId;
}

/** Whether an event leaves the page unsure what the order's state is, so it reads the order. */
export function needsRead(env: Envelope): boolean {
  const status = STATUS_OF_EVENT[env.type];
  return status === undefined || offTrack(status) !== null || status === 'closed';
}

/**
 * The open sockets a sandbox may hold (workers/api/src/objects/kitchen.rs, MAX_SOCKETS, as of
 * 2026-11-09). The status page gives its own socket up when the board says this many are open,
 * so it never holds the place a console would need.
 */
export const SOCKET_LIMIT = 4;

/** Whether the page should give its socket up, from a `presence` frame's count (its own included). */
export const shouldYield = (sockets: number): boolean => sockets >= SOCKET_LIMIT;

/** How often the page reads the order when it has no socket: every ten seconds. */
export const POLL_MS = 10_000;

/** The one sentence a screen reader hears when the order moves. */
export function movedText(status: OrderStatus, kind: 'pickup' | 'delivery'): string {
  switch (status) {
    case 'placed':
      return 'Your order is placed and waits for payment.';
    case 'confirmed':
      return 'Your order is paid. The kitchen has it.';
    case 'in_production':
      return 'Your order is in production.';
    case 'ready':
      return kind === 'pickup'
        ? 'Your order is ready to pick up.'
        : 'Your order is ready and waits for its van.';
    case 'picked_up':
      return 'Your order was picked up.';
    case 'out_for_delivery':
      return 'Your order is out for delivery.';
    case 'delivered':
      return 'Your order was delivered.';
    case 'closed':
      return 'Your order is done.';
    case 'expired':
      return 'Your order expired unpaid.';
    case 'cancelled':
      return 'Your order was cancelled.';
    case 'refund_pending':
      return 'Your order was cancelled and is being refunded.';
  }
}

/**
 * The unpaid order's hold as time left, said once: "14 min left to pay". `nowMs` is business
 * time (wall time plus the sandbox's clock offset), as `held_until` is.
 */
export function holdText(heldUntil: string, nowMs: number): string {
  const until = Date.parse(heldUntil);
  if (Number.isNaN(until)) return 'Held for 15 minutes of bakery time.';
  const left = until - nowMs;
  if (left <= 0) return 'The hold has ended, so the order is about to expire.';
  const minutes = Math.floor(left / 60_000);
  return minutes < 1 ? 'Under a minute left to pay.' : `${minutes} min left to pay.`;
}
