import { useEffect, useState } from 'react';
import type { OrderResponse } from '../contracts';
import { createPayment, getOrder } from '../lib/api';
import { dollars } from '../lib/money';
import { isPaid, waitForPaid } from '../lib/payment';
import type { useLiveMenu } from '../lib/use-live-menu';
import PaymentPanel from './PaymentPanel';
import Receipt from './Receipt';

type After =
  | { name: 'paying' }
  | { name: 'waiting' }
  | { name: 'timeout' }
  | { name: 'closed'; order: OrderResponse }
  | { name: 'paid'; order: OrderResponse };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The checkout's payment step, after the order is placed: the Payment Element with no billing
 * fields (PaymentPanel), then a wait for the webhook to mark the order paid. Stripe.js is loaded
 * there and nowhere else, and only when there is a key.
 */
export default function PaymentStep({
  sandboxId,
  order,
  menu,
}: {
  sandboxId: string;
  order: OrderResponse;
  menu: ReturnType<typeof useLiveMenu>;
}) {
  const [step, setStep] = useState<After>({ name: 'paying' });
  const [waitId, setWaitId] = useState(0);

  // After the confirm: look every second for up to 30 seconds. The webhook marks the order paid,
  // never this page.
  useEffect(() => {
    if (waitId === 0) return;
    let stopped = false;
    void waitForPaid(() => getOrder(sandboxId, order.id), {
      sleep,
      stopped: () => stopped,
    }).then((result) => {
      if (stopped) return;
      if (result.kind === 'paid') setStep({ name: 'paid', order: result.order });
      else if (result.kind === 'closed') setStep({ name: 'closed', order: result.order });
      else if (result.kind === 'timeout') setStep({ name: 'timeout' });
    });
    return () => {
      stopped = true;
    };
  }, [waitId, sandboxId, order.id]);

  if (step.name === 'paid') {
    return <Receipt order={step.order} menu={menu} paid={isPaid(step.order.status)} />;
  }

  return (
    <section aria-labelledby="pay-heading" data-tour="checkout-pay">
      <h2 id="pay-heading">Pay for your order</h2>
      <dl className="totals">
        <dt>Order</dt>
        <dd>
          <code>{order.id}</code>
        </dd>
        <dt>Total</dt>
        <dd>
          <strong>{dollars(order.total_cents)}</strong>
        </dd>
      </dl>
      <p className="hint">
        An unpaid order is held for 15 minutes of bakery time and then expires.
      </p>

      {step.name === 'paying' && (
        <PaymentPanel
          sandboxId={sandboxId}
          intentKey={order.id}
          createIntent={() => createPayment(sandboxId, order.id)}
          unconfigured="The order is placed and held, and nothing here asks for a card."
          onSubmitted={() => {
            setStep({ name: 'waiting' });
            setWaitId((n) => n + 1);
          }}
        />
      )}

      <div aria-live="polite" className="messages">
        {step.name === 'waiting' && (
          <p>Payment received by Stripe. Waiting for the bakery to confirm it…</p>
        )}
        {step.name === 'timeout' && (
          <p>
            <strong>Your payment is being confirmed.</strong> It has not shown up here yet. Check
            the <a href="/app/">console</a> in a minute: the order moves to Confirmed when the
            webhook arrives.
          </p>
        )}
        {step.name === 'closed' && (
          <p className="problem">
            <strong>This order is no longer open ({step.order.status}).</strong> It was not paid
            for. Order again from the <a href="/menu/">menu</a>.
          </p>
        )}
      </div>
    </section>
  );
}
