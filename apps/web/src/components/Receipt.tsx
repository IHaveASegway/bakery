import type { OrderResponse } from '../contracts';
import { findVariant } from '../lib/menu';
import { dollars } from '../lib/money';
import { shortWhen, whenText, windowText } from '../lib/when';
import type { useLiveMenu } from '../lib/use-live-menu';

function lineName(menu: ReturnType<typeof useLiveMenu>, variant: string): string {
  const found = findVariant(menu.menu, variant);
  return found ? `${found.item.name}, ${found.variant.label.toLowerCase()}` : variant;
}

/**
 * What the API answered about an order: its numbers, not the page's. Paid once the webhook says
 * so. The order's status page (OrderStatus.tsx) shows it beside the tracker.
 */
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
    <section
      aria-labelledby="receipt-heading"
      className="panel receipt"
      data-tour="checkout-receipt"
    >
      <h2 id="receipt-heading">Your order</h2>
      <dl className="receipt-facts">
        <dt>Order</dt>
        <dd className="receipt-id">
          <code>{order.id}</code>
        </dd>
        <dt>
          {order.kind === 'pickup' ? 'Pickup' : `Delivery, zone ${(order.zone ?? '').slice(1)}`}
        </dt>
        <dd>
          <time dateTime={order.slot} title={whenText(order.slot)}>
            {order.kind === 'pickup'
              ? shortWhen(order.slot)
              : `${shortWhen(order.slot).split(', ')[0]}, ${windowText(order.slot)}`}
          </time>
        </dd>
        <dt>Menu version</dt>
        <dd>{order.menu_version}</dd>
      </dl>
      <ul className="receipt-lines">
        {order.lines.map((line) => (
          <li key={line.variant}>
            <span>
              {line.qty} × {lineName(menu, line.variant)}
            </span>
            <span className="price">{dollars(line.unit_cents * line.qty)}</span>
          </li>
        ))}
      </ul>
      <dl className="summary-totals">
        <dt>Subtotal</dt>
        <dd>{dollars(order.subtotal_cents)}</dd>
        <dt>Tax</dt>
        <dd>{dollars(order.tax_cents)}</dd>
        <dt className="total">Total</dt>
        <dd className="total">{dollars(order.total_cents)}</dd>
      </dl>
      {paid && (
        <p className="hint">
          <strong>Paid in Stripe’s sandbox.</strong> No money moved: it was a test payment.
        </p>
      )}
    </section>
  );
}
