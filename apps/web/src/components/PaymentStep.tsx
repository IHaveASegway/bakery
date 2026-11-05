import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import type { Stripe } from '@stripe/stripe-js';
import { useEffect, useState } from 'react';
import type { OrderResponse, PaymentResponse, PersonaAddress } from '../contracts';
import { createPayment, getOrder, getSandboxPersona } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import { dollars } from '../lib/money';
import {
  billingDetails,
  declineMessage,
  isPaid,
  publishableKeyFor,
  returnUrl,
  waitForPaid,
} from '../lib/payment';
import { stripeFor } from '../lib/stripe';
import type { useLiveMenu } from '../lib/use-live-menu';
import Message from './Message';
import Receipt from './Receipt';

type Persona = { name: string; address: PersonaAddress };

type Step =
  | { name: 'preparing' }
  | { name: 'unconfigured' }
  | { name: 'failed'; error: Text }
  | { name: 'ready'; stripe: Stripe; payment: PaymentResponse; persona: Persona }
  | { name: 'waiting' }
  | { name: 'timeout' }
  | { name: 'closed'; order: OrderResponse }
  | { name: 'paid'; order: OrderResponse };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The sentence ADR 0007 decision 10 asks for, above the Element. */
function TestCardNote() {
  return (
    <p>
      This is Stripe’s sandbox, so no money moves. Use the test card{' '}
      <code>4242 4242 4242 4242</code> with any future date and any CVC. Stripe lists{' '}
      <a href="https://docs.stripe.com/testing" rel="noreferrer">
        test cards that decline or ask for 3-D Secure
      </a>
      . This page never asks for a real card.
    </p>
  );
}

/**
 * The checkout's payment step, after the order is placed: the Payment Element with no billing
 * fields, the persona's synthetic details passed on confirm, then a wait for the webhook to mark
 * the order paid. Stripe.js is loaded here and nowhere else, and only when there is a key.
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
  const [step, setStep] = useState<Step>({ name: 'preparing' });
  const [tries, setTries] = useState(0);
  const [waitId, setWaitId] = useState(0);

  // Ask for the PaymentIntent, then for Stripe.js with the key, then show the Element.
  useEffect(() => {
    let stopped = false;
    setStep({ name: 'preparing' });
    (async () => {
      try {
        const [payment, sandbox] = await Promise.all([
          createPayment(sandboxId, order.id),
          getSandboxPersona(sandboxId),
        ]);
        if (stopped) return;
        const key = publishableKeyFor(
          import.meta.env.PUBLIC_STRIPE_PUBLISHABLE_KEY,
          payment.publishable_key,
        );
        if (key === null) return setStep({ name: 'unconfigured' });
        const stripe = await stripeFor(key);
        if (stopped) return;
        if (stripe === null) throw new Error('stripe-unavailable');
        setStep({
          name: 'ready',
          stripe,
          payment,
          persona: { name: sandbox.persona_name, address: sandbox.persona_address },
        });
      } catch (e) {
        if (stopped) return;
        setStep({
          name: 'failed',
          error:
            e instanceof Error && e.message === 'stripe-unavailable'
              ? {
                  title: 'Stripe’s payment form could not load',
                  detail: 'Check your connection and try again. Nothing was charged.',
                }
              : describeError(e),
        });
      }
    })();
    return () => {
      stopped = true;
    };
  }, [sandboxId, order.id, tries]);

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
    <section aria-labelledby="pay-heading">
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

      {step.name === 'preparing' && <p aria-live="polite">Getting the payment form ready…</p>}

      {step.name === 'unconfigured' && (
        <p aria-live="polite">
          <strong>Payments are not configured on this build.</strong> The order is placed and held,
          and nothing here asks for a card.
        </p>
      )}

      {step.name === 'failed' && (
        <>
          <Message error={step.error} />
          <p>
            <button type="button" onClick={() => setTries((n) => n + 1)}>
              Try again
            </button>
          </p>
        </>
      )}

      {step.name === 'ready' && (
        <>
          <TestCardNote />
          <Elements
            stripe={step.stripe}
            options={{
              clientSecret: step.payment.client_secret,
              appearance: {
                theme: window.matchMedia('(prefers-color-scheme: dark)').matches
                  ? 'night'
                  : 'stripe',
              },
            }}
          >
            <PayForm
              persona={step.persona}
              amountCents={step.payment.amount_cents}
              onSubmitted={() => {
                setStep({ name: 'waiting' });
                setWaitId((n) => n + 1);
              }}
            />
          </Elements>
        </>
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

/** The Element and its button. A decline shows the Element’s own message and lets the visitor retry. */
function PayForm({
  persona,
  amountCents,
  onSubmitted,
}: {
  persona: Persona;
  amountCents: number;
  onSubmitted: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);

  async function pay() {
    if (stripe === null || elements === null || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          // The Element shows no billing fields, so the persona’s synthetic details go here.
          payment_method_data: { billing_details: billingDetails(persona) },
          return_url: returnUrl(window.location),
        },
        redirect: 'if_required',
      });
      if (error) {
        setProblem(declineMessage(error));
        setBusy(false);
        return;
      }
      onSubmitted();
    } catch {
      setProblem('The payment could not be sent to Stripe. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <form
      className="pay-form"
      aria-labelledby="pay-heading"
      onSubmit={(e) => {
        e.preventDefault();
        void pay();
      }}
    >
      <PaymentElement
        options={{ fields: { billingDetails: 'never' } }}
        onChange={(e) => setComplete(e.complete)}
      />
      <p>
        <button type="submit" disabled={stripe === null || busy || !complete}>
          {busy ? 'Paying…' : `Pay ${dollars(amountCents)}`}
        </button>
      </p>
      <div aria-live="polite" className="messages">
        {problem !== null && (
          <p className="problem">
            <strong>The payment was not accepted.</strong> {problem}
          </p>
        )}
      </div>
    </form>
  );
}
