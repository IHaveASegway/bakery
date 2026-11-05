import { actionFor, groupByState, isSimulated, type Card } from '../lib/kitchen';
import { useKitchen, type Command } from '../lib/use-kitchen';
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

function CardView({
  card,
  sandboxId,
  canAct,
  open,
  onAct,
  onRefunded,
}: {
  card: Card;
  sandboxId: string;
  canAct: boolean;
  open: boolean;
  onAct: (card: Card) => void;
  onRefunded: () => void;
}) {
  const action = actionFor(card);
  return (
    <li className="card">
      <p>
        <strong>{card.kind === 'pickup' ? 'Pickup' : 'Delivery'}</strong>{' '}
        <time dateTime={card.slot}>{card.slot}</time> <code>{shortId(card.order)}</code>
      </p>
      <ul className="card-lines">
        {card.lines.map((l) => (
          <li key={l.variant}>
            {l.qty} × {variantWords(l.variant)}
          </li>
        ))}
      </ul>
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
  onWiped,
  onRefunded,
}: {
  sandboxId: string;
  isGuest: boolean;
  onWiped: () => void;
  /** Called after a refund, so the ledger beside the board looks again. */
  onRefunded: () => void;
}) {
  const kitchen = useKitchen(sandboxId, onWiped);
  const open = kitchen.status === 'open';
  const groups = groupByState(kitchen.board);
  const total = groups.reduce((n, g) => n + g.cards.length, 0);

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
      <h3>Kitchen board</h3>
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
        {kitchen.commands.slice(0, 3).map((c) => (
          <p key={c.id} className={c.status === 'nack' || c.status === 'lost' ? 'problem' : 'hint'}>
            {commandText(c)}
          </p>
        ))}
      </div>
      {groups.map((group) => (
        <section key={group.state} aria-labelledby={`board-${group.state}`} className="column">
          <h4 id={`board-${group.state}`}>
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
                  onRefunded={onRefunded}
                  canAct={!isGuest}
                  open={open}
                  onAct={(c) => {
                    const a = actionFor(c);
                    if (a) kitchen.send(c.order, a.action);
                  }}
                />
              ))}
            </ul>
          )}
        </section>
      ))}

      <h3 id="feed-heading">Activity feed</h3>
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
              , <time dateTime={e.time}>{e.time}</time>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
