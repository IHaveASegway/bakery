import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import type { Stripe } from '@stripe/stripe-js';
import { useEffect, useRef, useState } from 'react';
import type { PaymentResponse, PersonaAddress } from '../contracts';
import { getSandboxPersona } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import { dollars } from '../lib/money';
import { billingDetails, declineMessage, publishableKeyFor, returnUrl } from '../lib/payment';
import { stripeFor } from '../lib/stripe';
import Message from './Message';

type Persona = { name: string; address: PersonaAddress };

type Step =
  | { name: 'preparing' }
  | { name: 'unconfigured' }
  | { name: 'failed'; error: Text }
  | { name: 'ready'; stripe: Stripe; payment: PaymentResponse; persona: Persona };

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
 * Stripe's Payment Element with no billing fields, for any payment the API makes an intent for: an
 * order's (PaymentStep) or a catering deposit's (Catering). It asks `createIntent` for the
 * PaymentIntent, loads Stripe.js with the key (here and nowhere else, and only when there is one),
 * shows the Element and passes the sandbox persona's synthetic billing details on confirm.
 * `onSubmitted` runs once Stripe has the payment; what the page then waits for is the caller's.
 * `intentKey` names the thing being paid, so a different one asks again.
 */
export default function PaymentPanel({
  sandboxId,
  intentKey,
  createIntent,
  onSubmitted,
  unconfigured = 'Nothing here asks for a card.',
}: {
  sandboxId: string;
  intentKey: string;
  createIntent: () => Promise<PaymentResponse>;
  onSubmitted: () => void;
  /** What to add to "Payments are not configured on this build." when there is no key. */
  unconfigured?: string;
}) {
  const [step, setStep] = useState<Step>({ name: 'preparing' });
  const [tries, setTries] = useState(0);
  const create = useRef(createIntent);
  create.current = createIntent;

  // Ask for the PaymentIntent, then for Stripe.js with the key, then show the Element.
  useEffect(() => {
    let stopped = false;
    setStep({ name: 'preparing' });
    (async () => {
      try {
        const [payment, sandbox] = await Promise.all([
          create.current(),
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
  }, [sandboxId, intentKey, tries]);

  return (
    <>
      {step.name === 'preparing' && <p aria-live="polite">Getting the payment form ready…</p>}

      {step.name === 'unconfigured' && (
        <p aria-live="polite">
          <strong>Payments are not configured on this build.</strong> {unconfigured}
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
              onSubmitted={onSubmitted}
            />
          </Elements>
        </>
      )}
    </>
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
