import { useEffect, useState } from 'react';
import type { OrderResponse } from '../contracts';
import { createPayment, getOrder } from '../lib/api';
import { holdText } from '../lib/order-track';
import { isPaid, waitForPaid } from '../lib/payment';
import PaymentPanel from './PaymentPanel';

type After =
  | { name: 'paying' }
  | { name: 'waiting' }
  | { name: 'timeout' }
  | { name: 'closed'; order: OrderResponse }
  | { name: 'paid'; order: OrderResponse };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The order's own status page, where a paid order goes. */
export const orderPage = (id: string) => `/order/?id=${encodeURIComponent(id)}`;

/**
 * The checkout's third step, after the order is placed: the hold's time left, the Payment
 * Element with no billing fields (PaymentPanel), then a wait for the webhook to mark the order
 * paid, and on to the order's status page. Stripe.js is loaded there and nowhere else, and only
 * when there is a key.
 */
export default function PaymentStep({
  sandboxId,
  order,
  offsetS,
}: {
  sandboxId: string;
  order: OrderResponse;
  /** Business time minus wall time, in seconds: the hold is counted on the bakery's clock. */
  offsetS: number;
}) {
  const [step, setStep] = useState<After>({ name: 'paying' });
  const [waitId, setWaitId] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

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

  // Paid: the order's own page follows it from here.
  const paid = step.name === 'paid' && isPaid(step.order.status);
  useEffect(() => {
    if (paid) window.location.assign(orderPage(order.id));
  }, [paid, order.id]);

  return (
    <div className="pay-step" data-tour="checkout-pay">
      <p className="hold-line">
        <span className="badge" data-tone="pending">
          Held
        </span>{' '}
        {holdText(order.held_until, now + offsetS * 1000)}
      </p>

      {step.name === 'paying' && (
        <PaymentPanel
          sandboxId={sandboxId}
          intentKey={order.id}
          createIntent={() => createPayment(sandboxId, order.id)}
          unconfigured="The order is placed and held, and nothing here asks for a card."
          returnTo={orderPage(order.id)}
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
        {step.name === 'paid' && <p>Paid. Taking you to your order…</p>}
        {step.name === 'timeout' && (
          <p>
            <strong>Your payment is being confirmed.</strong> It has not shown up here yet. Your{' '}
            <a href={orderPage(order.id)}>order’s page</a> moves to Paid when the webhook arrives.
          </p>
        )}
        {step.name === 'closed' && (
          <p className="problem">
            <strong>This order is no longer open ({step.order.status}).</strong> It was not paid
            for. Order again from the <a href="/menu/">menu</a>.
          </p>
        )}
      </div>

      <p className="hint">
        <a href={orderPage(order.id)}>Follow this order</a> on its own page, paid or not.
      </p>
    </div>
  );
}
