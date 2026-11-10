import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  actionFor,
  bakeListsByDate,
  eventWords,
  followedOrders,
  groupByState,
  isSimulated,
  routeWords,
  waitingFor,
  type Card,
} from '../lib/kitchen';
import { AFTER_BOARD, WORKSPACES } from '../lib/console-sections';
import { dateOf, mountainLocal } from '../lib/slots';
import { useKitchen, type Command } from '../lib/use-kitchen';
import { clockOfText, shortDate, whenText } from '../lib/when';
import BakeList from './BakeList';
import GuestNote from './GuestNote';
import RefundControls from './RefundControls';

const ACTION_WORDS = {
  start_production: 'Start production',
  mark_ready: 'Mark ready',
  mark_picked_up: 'Mark picked up',
} as const;

const RULES: Record<string, string> = {
  'out-of-order': 'the order is not in the right state for that',
  // The sandbox's command budget, 60 at once then one a second (objects/kitchen.rs).
  'rate-limit': 'too many moves at once; wait a moment and press it again',
  // The demo's flag (roadmap R85): the board can be watched but not moved.
  'read-only': 'the demo is read-only for now, so the board can be watched but not moved',
};

/** The board's open card menus, which the listeners below close. */
const openMenus = () => [
  ...document.querySelectorAll<HTMLDetailsElement>('.board details.menu[open]'),
];

let menuListeners = false;

/**
 * The listeners every card menu shares, installed once for the page: Escape closes the open menu
 * and puts focus back on its button, and a press outside a menu closes it.
 */
function listenForMenus() {
  if (menuListeners) return;
  menuListeners = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const menu of openMenus()) {
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
  });
  document.addEventListener('mousedown', (e) => {
    for (const menu of openMenus()) if (!menu.contains(e.target as Node)) menu.open = false;
  });
}

/**
 * A card's "…" menu, a <details>, with the manners of the top bar's popovers (ConsoleTopBar.tsx,
 * Popover; F15, 2026-11-10): Escape closes it and puts focus back on its button, a press outside
 * closes it, and opening one closes the one that was open, so two are never open at once.
 */
function useCardMenu() {
  // A callback ref, so a menu that appears later (a card paid while on screen) is wired too.
  return useCallback((details: HTMLDetailsElement | null) => {
    if (details === null) return;
    listenForMenus();
    const toggled = () => {
      if (!details.open) return;
      for (const other of openMenus()) if (other !== details) other.open = false;
    };
    details.addEventListener('toggle', toggled);
    return () => details.removeEventListener('toggle', toggled);
  }, []);
}

/** `country-loaf/whole` as "country loaf, whole". */
const variantWords = (slug: string) => slug.replaceAll('-', ' ').replace('/', ', ');

/** The words on a card's one button, short enough for a column; its accessible name keeps the
 *  whole label ("Start production for order 4KX2QF"), which these words are part of. */
const SHORT_LABELS = {
  start_production: 'Start',
  mark_ready: 'Mark ready',
  mark_picked_up: 'Picked up',
} as const;

/** A card shows this many lines, then "+2 more" that opens to the rest. */
const LINES_SHOWN = 3;

/** Each column's status tone (components.css, .badge[data-tone]). */
const TONE: Record<Card['state'], string> = {
  pending: 'pending',
  confirmed: 'confirmed',
  in_production: 'making',
  ready: 'ready',
  out_for_delivery: 'out',
};

/** The Dispatch page, where a ready delivery's van is planned and published. */
const DISPATCH_PATH = WORKSPACES.find((w) => w.id === 'dispatch')?.path ?? '/app/dispatch/';

/** The last six characters of a ULID: enough to tell cards apart. */
const shortId = (id: string) => id.slice(-6);

/**
 * An id as its last six characters, the whole id in its title and read out in full: a ULID's 26
 * characters wrapped over three lines on a card and were cut off on a phone. A stream's kind
 * (`schedule:`) stays in front of the tail, and a short key such as a day is printed whole.
 */
function IdTail({ id }: { id: string }) {
  const colon = id.indexOf(':');
  const kind = colon > 0 ? id.slice(0, colon + 1) : '';
  const rest = id.slice(kind.length);
  return (
    <code title={id}>
      <span aria-hidden="true">{rest.length > 12 ? `${kind}…${rest.slice(-6)}` : id}</span>
      <span className="sr-only">{id}</span>
    </code>
  );
}

/** The line under the board for a command the page sent. */
export function commandText(c: Command): string {
  const what = `${ACTION_WORDS[c.action]} for ${shortId(c.order)}`;
  switch (c.status) {
    case 'sent':
      return `${what}: sent, waiting for the kitchen.`;
    case 'ack':
      return `${what}: acknowledged.`;
    case 'nack':
      return `${what}: refused, ${RULES[c.rule ?? ''] ?? c.rule ?? 'no reason given'}.`;
    case 'lost':
      return `${what}: the connection closed before an answer.`;
  }
}

export function CardView({
  card,
  sandboxId,
  canRefund,
  open,
  focusHere = false,
  onFocused,
  onAct,
  onRefunded,
  now,
  yours = false,
}: {
  card: Card;
  sandboxId: string;
  /** Refunds are a signed-in session's; every session moves the card on (roadmap R72). */
  canRefund: boolean;
  open: boolean;
  /**
   * The card moved column after this page pressed its button. Its button is a new element in the
   * new column, so focus is put on it (or on the card, when the new state has no button), never
   * left on the page's body.
   */
  focusHere?: boolean;
  onFocused?: () => void;
  onAct: (card: Card) => void;
  onRefunded: (said: string, whole: boolean) => void;
  /** Business now (wall clock plus the sandbox's offset), so "this year" is the bakery's. */
  now?: number | undefined;
  /** The order this browser tab followed on the order's page: the visitor's own (G7). */
  yours?: boolean;
}) {
  const action = actionFor(card);
  const route = routeWords(card);
  const waits = waitingFor(card);
  const item = useRef<HTMLLIElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusHere) return;
    (button.current ?? item.current)?.focus();
    onFocused?.();
  }, [focusHere, onFocused]);
  const shown = card.lines.slice(0, LINES_SHOWN);
  const rest = card.lines.slice(LINES_SHOWN);
  const refundable = canRefund && card.state !== 'pending';
  const more = useCardMenu();
  return (
    <li className="card" ref={item} tabIndex={-1} data-yours={yours || undefined}>
      <p className="card-head">
        <span className="badge" data-tone="kind">
          {card.kind === 'pickup' ? 'Pickup' : 'Delivery'}
        </span>{' '}
        {yours && (
          <>
            <span className="badge" data-tone="yours" title="The order you placed in this tab">
              Yours
            </span>{' '}
          </>
        )}
        <code className="card-id">{shortId(card.order)}</code>
      </p>
      <p className="card-when">
        <time dateTime={card.slot} title={whenText(card.slot)}>
          <span className="card-clock">{clockOfText(card.slot)}</span>{' '}
          <span className="card-date">{shortDate(card.slot, { now })}</span>
        </time>
      </p>
      <ul className="card-lines">
        {shown.map((l) => (
          <li key={l.variant}>
            {l.qty} × {variantWords(l.variant)}
          </li>
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="card-more">
          <summary>+{rest.length} more</summary>
          <ul className="card-lines">
            {rest.map((l) => (
              <li key={l.variant}>
                {l.qty} × {variantWords(l.variant)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {route !== null && <p>{route}</p>}
      {card.note && <p className="card-note">Note: {card.note}</p>}
      {(card.last || card.cause) && (
        <p className="hint">
          {card.last ? (
            <span className="badge card-event" data-tone="kind">
              {eventWords(card.last).map((word, i) => (
                <Fragment key={i}>
                  {i > 0 && <wbr />}
                  {word}
                </Fragment>
              ))}
            </span>
          ) : (
            'Last event'
          )}
          {card.cause && (
            <>
              {' '}
              cause <IdTail id={card.cause} />
              {isSimulated(card.cause) && ' (simulated)'}
            </>
          )}
        </p>
      )}
      {waits !== null && (
        <p className="card-waits">
          {waits.text}
          {waits.dispatch && (
            <>
              {' '}
              <a href={DISPATCH_PATH}>Dispatch</a>.
            </>
          )}
        </p>
      )}
      {(action || refundable) && (
        <div className="card-actions">
          {action && (
            <button
              ref={button}
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!open}
              aria-label={`${action.label} for order ${shortId(card.order)}`}
              onClick={() => onAct(card)}
            >
              {SHORT_LABELS[action.action]}
            </button>
          )}
          {/* A pending card is unpaid, so there is nothing to refund yet. Refunds are destructive,
              so they wait in the card's overflow menu, never beside the next step. */}
          {refundable && (
            <details className="menu" ref={more}>
              <summary
                className="btn btn-quiet btn-sm btn-icon"
                aria-label={`More for order ${shortId(card.order)}`}
                title="More: refunds"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <circle cx="3" cy="8" r="1.5" />
                  <circle cx="8" cy="8" r="1.5" />
                  <circle cx="13" cy="8" r="1.5" />
                </svg>
              </summary>
              <div className="menu-panel">
                <RefundControls
                  sandboxId={sandboxId}
                  order={card.order}
                  label={shortId(card.order)}
                  onRefunded={onRefunded}
                />
              </div>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

/** The live kitchen board and the activity feed under it, over one WebSocket. */
export default function KitchenBoard({
  sandboxId,
  isGuest,
  clockOffsetS = 0,
  onWiped,
  onRefunded,
}: {
  sandboxId: string;
  isGuest: boolean;
  /** Business time minus wall time, to tell which bake list is today's. */
  clockOffsetS?: number;
  onWiped: () => void;
  /** Called after a refund, so the ledger beside the board looks again. */
  onRefunded: () => void;
}) {
  const kitchen = useKitchen(sandboxId, onWiped);
  // The card whose button this page pressed, and the column it was in: when the Kitchen moves it,
  // focus follows it to its new column; when it leaves the board, focus goes to its old column.
  const [follow, setFollow] = useState<{ order: string; from: Card['state'] } | null>(null);
  // What the last refund did, said here and not on the card: a full refund removes the card.
  const [refunded, setRefunded] = useState<{ said: string; order: string } | null>(null);
  const refundLine = useRef<HTMLParagraphElement>(null);
  const clearFollow = useRef(() => setFollow(null)).current;
  // The column a phone shows; null until the visitor picks one.
  const [shown, setShown] = useState<Card['state'] | null>(null);
  // The orders this tab followed on the order's page, marked "Yours" (G7). Read after the first
  // paint: the server has no storage, and the page's first render must match its.
  const [yours, setYours] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let store: Storage | null = null;
    try {
      store = window.sessionStorage;
    } catch {
      // Blocked storage: no card is marked.
    }
    setYours(followedOrders(store));
  }, []);
  // Which of the last two things this page said is the newer: a refund's line or a move's (G8).
  const [latest, setLatest] = useState<'refund' | 'command'>('command');
  const open = kitchen.status === 'open';
  const groups = groupByState(kitchen.board);
  const total = groups.reduce((n, g) => n + g.cards.length, 0);
  // Business now: the bake list's today, and "this year" for every date the board prints.
  const now = Date.now() + clockOffsetS * 1000;
  const today = dateOf(mountainLocal(now));
  const bakeLists = bakeListsByDate(kitchen.board, today);
  const followed = follow === null ? undefined : kitchen.board.cards[follow.order];

  useEffect(() => {
    if (follow === null) return;
    // A refusal or a lost answer leaves the card where it is, and the focus on its button.
    const answer = kitchen.commands.find((c) => c.order === follow.order);
    if (answer?.status === 'nack' || answer?.status === 'lost') return setFollow(null);
    if (followed === undefined) {
      document.getElementById(`board-${follow.from}`)?.focus();
      setFollow(null);
    } else if (followed.state !== follow.from) {
      // On a phone only one column shows: show the card's new one, so the focus can land on it.
      setShown(followed.state);
    }
  }, [follow, followed, kitchen.commands]);

  // A full refund cancels the order and its card leaves; if the focus went with it, it comes here.
  useEffect(() => {
    if (refunded === null || kitchen.board.cards[refunded.order] !== undefined) return;
    if (document.activeElement === null || document.activeElement === document.body) {
      refundLine.current?.focus();
    }
  }, [refunded, kitchen.board.cards]);

  const status = {
    connecting: 'Connecting to the kitchen…',
    open: 'Live. Changes appear here as they happen.',
    closed: 'Disconnected. Reconnecting, waiting up to 30 seconds between tries.',
    ended:
      kitchen.ended === 'wiped'
        ? 'The sandbox was wiped, so the board is closed.'
        : 'The kitchen closed this connection: this sandbox already has 4 boards open.',
  }[kitchen.status];

  // On a phone the columns become one list under a segmented control; until the visitor picks, it
  // shows the first column that has cards.
  // A card this page moved shows its new column at once, in the same paint its button takes focus.
  const moved =
    follow !== null && followed !== undefined && followed.state !== follow.from
      ? followed.state
      : null;
  // The visitor's own order, when the board has it, is the column it opens on.
  const own = groups.find((g) => g.cards.some((c) => yours.has(c.order)))?.state;
  const showing =
    moved ?? shown ?? own ?? groups.find((g) => g.cards.length > 0)?.state ?? 'pending';
  // One line above the board, the latest; the activity feed under it keeps the rest (G8).
  const command = kitchen.commands[0];
  const line =
    latest === 'refund' && refunded !== null
      ? 'refund'
      : command !== undefined
        ? 'command'
        : refunded !== null
          ? 'refund'
          : null;

  return (
    <>
      <section className="panel board-panel" aria-labelledby="board-heading">
        <div className="panel-head">
          <h3 id="board-heading" tabIndex={-1} data-tour="kitchen-board">
            Kitchen board
          </h3>
          <div className="board-status">
            <p aria-live="polite" className="live-status" data-status={kitchen.status}>
              {status}
            </p>
            <p className="hint">
              {kitchen.sockets === null
                ? 'Screens watching: not known yet.'
                : `${kitchen.sockets} ${kitchen.sockets === 1 ? 'screen is' : 'screens are'} watching this board.`}{' '}
              {total} {total === 1 ? 'card' : 'cards'} on the board.
            </p>
          </div>
        </div>
        {kitchen.status === 'ended' && kitchen.ended !== 'wiped' && (
          <p>
            <button type="button" className="btn btn-primary" onClick={kitchen.reconnect}>
              Connect again
            </button>
          </p>
        )}
        {isGuest && (
          <GuestNote tour="kitchen-guest">
            You can move any order here; a refund needs a sign-in.
          </GuestNote>
        )}
        <div aria-live="polite" className="messages board-said">
          {line === 'refund' && refunded !== null && (
            <p className="hint" ref={refundLine} tabIndex={-1}>
              {refunded.said}
            </p>
          )}
          {line === 'command' && command !== undefined && (
            <p
              className={
                command.status === 'nack' || command.status === 'lost' ? 'problem' : 'hint'
              }
            >
              {commandText(command)}
            </p>
          )}
        </div>
        <a className="skip-inline" href={`#${AFTER_BOARD}`}>
          Skip the board’s cards
        </a>
        <div className="segmented board-switch" role="group" aria-label="Column to show">
          {groups.map((group) => (
            <button
              key={group.state}
              type="button"
              aria-pressed={group.state === showing}
              onClick={() => setShown(group.state)}
            >
              {group.label} ({group.cards.length})
            </button>
          ))}
        </div>
        <div className="board" data-show={showing}>
          {groups.map((group) => (
            <section
              key={group.state}
              aria-labelledby={`board-${group.state}`}
              className="column"
              data-state={group.state}
            >
              <h4 id={`board-${group.state}`} tabIndex={-1} data-tone={TONE[group.state]}>
                {group.label} ({group.cards.length})
              </h4>
              {group.cards.length === 0 ? (
                <p className="hint">Nothing here.</p>
              ) : (
                <ul className="cards">
                  {group.cards.map((card) => (
                    <CardView
                      key={card.order}
                      card={card}
                      sandboxId={sandboxId}
                      yours={yours.has(card.order)}
                      onRefunded={(said) => {
                        setRefunded({ said, order: card.order });
                        setLatest('refund');
                        onRefunded();
                      }}
                      canRefund={!isGuest}
                      open={open}
                      now={now}
                      focusHere={
                        follow !== null && follow.order === card.order && follow.from !== card.state
                      }
                      onFocused={clearFollow}
                      onAct={(c) => {
                        const a = actionFor(c);
                        if (!a) return;
                        setFollow({ order: c.order, from: c.state });
                        setLatest('command');
                        kitchen.send(c.order, a.action);
                      }}
                    />
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </section>

      <section className="panel feed-strip" aria-labelledby="feed-heading">
        <div className="panel-head">
          <h3 id="feed-heading" tabIndex={-1}>
            Activity feed
          </h3>
          <p className="hint">The last 50 events the board applied, newest first.</p>
        </div>
        {kitchen.feed.length === 0 ? (
          <p className="hint">No events yet since this page connected.</p>
        ) : (
          <div role="log" aria-labelledby="feed-heading" className="strip" tabIndex={0}>
            <ol className="strip-list">
              {kitchen.feed.map((e) => (
                <li key={e.id}>
                  <span className="badge" data-tone="kind">
                    {e.type}
                  </span>{' '}
                  <time dateTime={e.time} title={whenText(e.time, { seconds: true })}>
                    {whenText(e.time, { seconds: true }).split(' on ')[0]}
                  </time>
                  <span className="strip-stream">
                    <IdTail id={e.stream} /> seq {e.seq}
                  </span>
                  {e.cause && (
                    <span className="strip-cause">
                      cause <IdTail id={e.cause} />
                      {isSimulated(e.cause) && ' (simulated)'}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      <div className="panel">
        <BakeList lists={bakeLists} today={today} now={now} />
      </div>
    </>
  );
}
