import type { OrderResponse } from '../contracts';
import { findVariant } from '../lib/menu';
import { dollars } from '../lib/money';
import type { useLiveMenu } from '../lib/use-live-menu';

/** What the API answered about an order: its numbers, not the page's. Paid once the webhook says so. */
export default function Receipt({
  order,
  menu,
  paid,
}: {
  order: OrderResponse;
  menu: ReturnType<typeof useLiveMenu>;
  paid: boolean;
}) {
  return (
    <section aria-labelledby="receipt-heading" aria-live="polite">
      <h2 id="receipt-heading">{paid ? 'Paid, with thanks' : 'Order placed'}</h2>
      <dl>
        <dt>Order</dt>
        <dd>
          <code>{order.id}</code>
        </dd>
        <dt>Status</dt>
        <dd>{order.status}</dd>
        <dt>{order.kind === 'pickup' ? 'Pickup' : `Delivery, zone ${order.zone ?? ''}`}</dt>
        <dd>
          <time dateTime={order.slot}>{order.slot}</time>
        </dd>
        <dt>Menu version</dt>
        <dd>{order.menu_version}</dd>
      </dl>
      <ul className="cart-lines">
        {order.lines.map((line) => (
          <li key={line.variant}>
            <span className="line-name">
              {findVariant(menu.menu, line.variant)?.item.name ?? line.variant}
              {' × '}
              {line.qty}
            </span>
            <span className="price">{dollars(line.unit_cents * line.qty)}</span>
          </li>
        ))}
      </ul>
      <dl className="totals">
        <dt>Subtotal</dt>
        <dd>{dollars(order.subtotal_cents)}</dd>
        <dt>Tax</dt>
        <dd>{dollars(order.tax_cents)}</dd>
        <dt>Total</dt>
        <dd>
          <strong>{dollars(order.total_cents)}</strong>
        </dd>
      </dl>
      {paid && (
        <p>
          <strong>Paid in Stripe’s sandbox.</strong> No money moved: it was a test payment.
        </p>
      )}
      <p className="actions">
        <a className="action" href="/app/">
          Watch it on the kitchen board
        </a>
        <a className="action" href="/menu/">
          Order something else
        </a>
      </p>
    </section>
  );
}
