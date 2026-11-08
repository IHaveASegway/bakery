import { useEffect, useRef, useState } from 'react';
import {
  actionFor,
  bakeListsByDate,
  groupByState,
  isSimulated,
  routeWords,
  type Card,
} from '../lib/kitchen';
import { AFTER_BOARD } from '../lib/console-sections';
import { dateOf, mountainLocal } from '../lib/slots';
import { useKitchen, type Command } from '../lib/use-kitchen';
import { whenText } from '../lib/when';
import BakeList from './BakeList';
import GuestNote from './GuestNote';
import RefundControls from './RefundControls';

const ACTION_WORDS = {
  start_production: 'Start production',
  mark_ready: 'Mark ready',
  mark_picked_up: 'Mark picked up',
} as const;

const RULES: Record<string, string> = {
  'guest-scope': 'guests cannot change the board',
  'out-of-order': 'the order is not in the right state for that',
};

/** `country-loaf/whole` as "country loaf, whole". */
const variantWords = (slug: string) => slug.replaceAll('-', ' ').replace('/', ', ');

/** The last six characters of a ULID: enough to tell cards apart. */
const shortId = (id: string) => id.slice(-6);

function commandText(c: Command): string {
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
  canAct,
  open,
  focusHere = false,
  onFocused,
  onAct,
  onRefunded,
}: {
  card: Card;
  sandboxId: string;
  canAct: boolean;
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
}) {
  const action = actionFor(card);
  const route = routeWords(card);
  const item = useRef<HTMLLIElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusHere) return;
    (button.current ?? item.current)?.focus();
    onFocused?.();
  }, [focusHere, onFocused]);
  return (
    <li className="card" ref={item} tabIndex={-1}>
      <p>
        <strong>{card.kind === 'pickup' ? 'Pickup' : 'Delivery'}</strong>{' '}
        <time dateTime={card.slot}>{whenText(card.slot)}</time> <code>{shortId(card.order)}</code>
      </p>
      <ul className="card-lines">
        {card.lines.map((l) => (
          <li key={l.variant}>
            {l.qty} × {variantWords(l.variant)}
          </li>
        ))}
      </ul>
      {route !== null && <p>{route}</p>}
      {card.note && <p>Note: {card.note}</p>}
      {(card.last || card.cause) && (
        <p className="hint">
          {card.last ?? 'Last event'}
          {card.cause && (
            <>
              , cause <code>{card.cause}</code>
              {isSimulated(card.cause) && ' (simulated)'}
            </>
          )}
        </p>
      )}
      {canAct && action && (
        <button
          ref={button}
          type="button"
          disabled={!open}
          aria-label={`${action.label} for order ${shortId(card.order)}`}
          onClick={() => onAct(card)}
        >
          {action.label}
        </button>
      )}
      {/* A pending card is unpaid, so there is nothing to refund yet. */}
      {canAct && card.state !== 'pending' && (
        <RefundControls
          sandboxId={sandboxId}
          order={card.order}
          label={shortId(card.order)}
          onRefunded={onRefunded}
        />
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
  const open = kitchen.status === 'open';
  const groups = groupByState(kitchen.board);
  const total = groups.reduce((n, g) => n + g.cards.length, 0);
  const today = dateOf(mountainLocal(Date.now() + clockOffsetS * 1000));
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

  return (
    <>
      <h3 id="board-heading" tabIndex={-1} data-tour="kitchen-board">
        Kitchen board
      </h3>
      <p aria-live="polite">{status}</p>
      <p className="hint">
        {kitchen.sockets === null
          ? 'Screens watching: not known yet.'
          : `${kitchen.sockets} ${kitchen.sockets === 1 ? 'screen is' : 'screens are'} watching this board.`}{' '}
        {total} {total === 1 ? 'card' : 'cards'} on the board.
      </p>
      {kitchen.status === 'ended' && kitchen.ended !== 'wiped' && (
        <p>
          <button type="button" onClick={kitchen.reconnect}>
            Connect again
          </button>
        </p>
      )}
      {isGuest && <GuestNote />}
      <div aria-live="polite" className="messages">
        {refunded !== null && (
          <p className="hint" ref={refundLine} tabIndex={-1}>
            {refunded.said}
          </p>
        )}
        {kitchen.commands.slice(0, 3).map((c) => (
          <p key={c.id} className={c.status === 'nack' || c.status === 'lost' ? 'problem' : 'hint'}>
            {commandText(c)}
          </p>
        ))}
      </div>
      <a className="skip-inline" href={`#${AFTER_BOARD}`}>
        Skip the board’s cards
      </a>
      {groups.map((group) => (
        <section key={group.state} aria-labelledby={`board-${group.state}`} className="column">
          <h4 id={`board-${group.state}`} tabIndex={-1}>
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
                  onRefunded={(said) => {
                    setRefunded({ said, order: card.order });
                    onRefunded();
                  }}
                  canAct={!isGuest}
                  open={open}
                  focusHere={
                    follow !== null && follow.order === card.order && follow.from !== card.state
                  }
                  onFocused={clearFollow}
                  onAct={(c) => {
                    const a = actionFor(c);
                    if (!a) return;
                    setFollow({ order: c.order, from: c.state });
                    kitchen.send(c.order, a.action);
                  }}
                />
              ))}
            </ul>
          )}
        </section>
      ))}

      <BakeList lists={bakeLists} today={today} />

      <h3 id="feed-heading" tabIndex={-1}>
        Activity feed
      </h3>
      <p className="hint">The last 50 events the board applied, newest first.</p>
      {kitchen.feed.length === 0 ? (
        <p className="hint">No events yet since this page connected.</p>
      ) : (
        <ol className="feed" role="log" aria-labelledby="feed-heading">
          {kitchen.feed.map((e) => (
            <li key={e.id}>
              <strong>{e.type}</strong> <code>{e.stream}</code> seq {e.seq}
              {e.cause && (
                <>
                  , cause <code>{e.cause}</code>
                  {isSimulated(e.cause) && ' (simulated)'}
                </>
              )}
              , <time dateTime={e.time}>{whenText(e.time, { seconds: true })}</time>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
