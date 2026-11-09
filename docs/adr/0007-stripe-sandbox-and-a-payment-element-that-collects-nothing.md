# ADR 0007: Stripe's sandbox for payments and billing, through a Payment Element that collects no billing details

Status: Proposed · 2026-11-04 · Deciders: Joseph Peterson

## Context

The made-up bakery takes money in four ways: a one-off order, a catering deposit of 25%, a catering balance invoiced after the event, and refunds, full and partial (Q19 · Q-billing-scope). Joseph asked for "some vendor like Stripe or Worldpay" (Q17 · Q-psp). Visitors are engineers, hiring managers and recruiters playing a customer and the bakery's staff in their own sandbox ([ADR 0005](0005-a-private-sandbox-per-visitor-wiped-nightly.md)). Every payment is a demonstration, and the bakery holds no personal data by construction: no email, no name, no address from a real person ([ADR 0006](0006-sign-in-that-learns-nothing.md), [security.md](../security.md)). The `Billing` Durable Object (DO), one per sandbox, owns the ledger: payment intents, invoices, refunds, Stripe ids and the webhook events it has seen ([ADR 0003](0003-durable-objects-as-the-system-of-record.md)).

What Stripe offers, as of 2026-11-04:

- **Sandboxes.** A sandbox is an isolated test environment with its own API keys and its own webhook endpoints. Payments in it are not processed by card networks, so no money moves, and sandboxes are free. ([Sandboxes](https://docs.stripe.com/sandboxes))
- **Test cards.** 4242 4242 4242 4242 succeeds; Stripe publishes further numbers that decline, that require 3-D Secure authentication, and that fail in other named ways. ([Testing](https://docs.stripe.com/testing))
- **The Payment Element's fields option.** With `fields.billingDetails: 'never'`, the Element does not collect name, email, phone or address, and the integration must then pass those details itself when it calls `confirmPayment`. `defaultValues.billingDetails` only prefills fields the Element still shows. ([Create the Payment Element](https://docs.stripe.com/js/elements_object/create_payment_element))
- **Stripe's recommended API.** Stripe recommends the Checkout Sessions API together with the Payment Element; the Element also works with the PaymentIntents API, and either works in a sandbox. ([Payment Element](https://docs.stripe.com/payments/payment-element))
- **Webhook signatures.** The `Stripe-Signature` header carries a timestamp and an HMAC-SHA256 of the string `t.payload` under the endpoint's secret; Stripe's libraries reject an event whose timestamp is more than 5 minutes old, and a manual check should do the same. ([Verify manually](https://docs.stripe.com/webhooks#verify-manually))

What the runtime offers. The API is a Rust Worker, `bakery-api`, compiled to `wasm32-unknown-unknown` with workers-rs (`worker` 0.8.7, as of 2026-11-04; [ADR 0002](0002-rust-for-every-backend.md), [workers-rs](https://github.com/cloudflare/workers-rs)). Stripe publishes no official Rust SDK, and the community crates were written for native runtimes with an async executor; whether any of them builds for wasm32 without Tokio is untested here. The Worker has `fetch` and a `crypto` module, and the `hmac` and `sha2` crates compile to wasm32 with no platform dependency. The bakery calls about a dozen Stripe endpoints, so a small typed client is a few hundred lines.

## Decision

1. **The test-mode sandbox of Joseph's Stripe account** (Q20 · Q-stripe-account). Stripe refuses another sandbox until the business is verified (seen in the dashboard on 2026-11-04), and a made-up bakery has nothing to verify, so this is the only one and it is never deleted. Its keys are Worker secrets on `bakery-api`. Live keys are never created for this integration and never stored anywhere the bakery can read.
2. **A guard on every key, in two places.** The Worker checks the secret key's prefix before every call to Stripe and refuses to call with any key that is not a sandbox key, answering `503` with a problem+json body and a log line; it does the same check once per isolate on first use, so a misconfigured deploy fails its first smoke request. CI refuses a build whose publishable key, which the storefront compiles in, is not a sandbox key, and the firewall job fails on any live-key prefix anywhere in the repository or the built bundle. The secret key is a restricted key holding only the permissions the client uses (confirm the list when building, in spike S3). A sandbox's keys carry `pk_test_`, `sk_test_` and `rk_test_`, read from the dashboard on 2026-11-04.
3. **PaymentIntents for one-off orders and catering deposits.** The `Billing` object creates the intent with the amount it computed, the sandbox id and the order or inquiry id in `metadata` (random ids, nothing personal), and an `Idempotency-Key` derived from the command id ([Idempotent requests](https://docs.stripe.com/api/idempotent_requests)). PaymentIntents keep every field the bakery sends to Stripe explicit, which is what the privacy rule needs; Checkout Sessions with the Payment Element, Stripe's recommended path, stays open behind the port, and spike S3 checks whether it can run with no billing fields at all.
4. **Stripe Invoicing, in the sandbox, for catering balances.** The invoice is raised against a Stripe customer object that carries the persona's synthetic id and no email, and its delivery is the sandbox's own Inbox screen ([Q22 · Q-email](../product.md)). The collection method that makes Stripe send nothing is confirmed in spike S3.
5. **Refunds through the API**, full and partial, from the staff console; the `Billing` object refuses a refund larger than what remains captured.
6. **The embedded Payment Element with `fields.billingDetails: 'never'`** (Q18 · Q-payment-ui). On confirm, the page passes the persona's synthetic billing details, generated by `crates/seed` and labelled synthetic, so the visitor never types a name, email, phone or address into Stripe. Card numbers go into Stripe's own fields; the bakery's code never sees them.
7. **Webhooks to the API, verified, deduplicated, turned into domain events.** Stripe posts to `api.bakery.ihaveasegway.com` ([ADR 0009](0009-the-api-on-its-own-hostname.md)). The Worker reads the raw body, checks the signature with `hmac` and `sha2` in constant time, rejects a timestamp outside 5 minutes, reads the sandbox id from the object's metadata and forwards the event to that sandbox's `Billing` object. The object records the Stripe event id in its `seen` table in the same transaction as the domain event it appends (`PaymentSucceeded`, `RefundIssued`, and through the order and catering consumers `OrderPaid` and `CateringDepositPaid`), so a replay is acknowledged and changes nothing ([ADR 0004](0004-queues-between-objects-and-alarms-for-time.md), [domain.md](../domain.md)). An event for a sandbox that no longer exists is acknowledged with `200` and dropped.
8. **A `PaymentGateway` port in `crates/app`.** The domain asks for "create intent", "confirm status", "raise invoice" and "refund"; the Stripe client in `workers/api/src/stripe/` is one adapter, and a fake in Rust is another, used by every test. A second provider is a third adapter.
9. **Cleanup.** At the nightly wipe ([ADR 0005](0005-a-private-sandbox-per-visitor-wiped-nightly.md)) the `Sandbox` object asks `Billing` to remove what it created in Stripe where the API allows: delete customers, void open invoices, cancel unconfirmed intents. Objects Stripe keeps (succeeded intents, charges, finalized invoices) stay until the sandbox's test data is cleared, which [operations.md](../operations.md) schedules quarterly, with the keys and webhook secret rotated at the same time. How a reset is done is confirmed when building.
10. **What the checkout page says.** Above the Element: this is Stripe's sandbox, no money moves, use the test card 4242 4242 4242 4242 with any future date and any CVC, and a link to Stripe's list of cards that decline or ask for 3-D Secure. The page never asks for a real card.

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **A. Stripe sandbox, embedded Payment Element, no billing fields (chosen)** | Real webhooks, real 3-D Secure challenges and real declines to show; free; isolated keys; the visitor types nothing personal into a third party | Security: one third-party script on the checkout page and its origins in the policy. Evolvability: a hand-written client to keep current with Stripe's API versions. Operability: a sandbox that accumulates objects until reset | Chosen |
| B. Worldpay | A second large provider, closer to some readers' own stacks | Operability: its sandbox access goes through a merchant application, and the developer tooling a demo leans on (sandbox webhooks, test-card catalogue, a client-side element with a fields option) is thinner by Joseph's reading; the specifics are not sourced here, so confirm when building. Cost and latency: unknown until access exists | Rejected as the first provider; a candidate second adapter behind the port |
| C. Adyen's test environment | A mature test environment and embeddable components | Operability: a test account to apply for and a second dashboard; whether its components can run with no billing fields is unchecked (confirm when building) | Rejected for now |
| D. A fake gateway in Rust only | Cost: $0 and no third party. Testability: deterministic | Fidelity: no real webhooks, no 3-D Secure, no real declines, so the demo shows a mock where a reader expects an integration | Rejected as the main path; kept as the test double behind the port |
| E. Stripe's hosted Checkout page | Least code; Stripe owns the form | Security and privacy: the visitor types a name and email into Stripe's sandbox, which the "no personal data" rule forbids. Latency: a redirect off the bakery and back | Rejected: a weaker fit for the privacy rule |
| F. Payment Links | No code at all | The same hosted form as E, and amounts fixed ahead of time, which a cart and a deposit cannot use | Rejected |

## Consequences

Good:

- Every payment on the page is a test, by construction: the Worker cannot call Stripe with a live key, and the build cannot ship one.
- Stripe receives a random sandbox id, an order id, amounts and synthetic billing details. Nothing it holds identifies a visitor.
- Webhook handling is the Queue Lab's principle in production code: at-least-once delivery from Stripe, an idempotent consumer keyed by event id, and a ledger that cannot count a payment twice.
- A Stripe outage degrades payments only. Carts, the menu, the kitchen board, catering quotes and the CRM keep working, and an order waiting for payment expires after 15 minutes by alarm (Q13 · Q-order-flow), as it would if the visitor walked away.
- The port keeps the domain free of Stripe's types, so `crates/domain` and `crates/app` test natively with the fake.

Bad:

- Receipts and invoices go to the sandbox Inbox screen, never to an email address. A visitor who expects an email gets a screen.
- One sandbox serves local work and CI, so they share test data; `e2e` asserts only on objects it created.
- The Stripe sandbox accumulates objects the API will not delete until the scheduled reset; a reset rotates keys, which is a deploy of new secrets ([operations.md](../operations.md)).
- The checkout page loads Stripe.js, which Stripe serves only from its own origin, and the Element's frames. Its bytes are measured in the payments pull request and reported beside the page's own budget ([stack.md](../stack.md), [ADR 0008](0008-astro-site-with-react-islands-on-an-assets-only-worker.md)).
- Stripe's script, frames and API need their origins in the checkout page's policy. [security.md](../security.md) owns the policy and lists them from Stripe's published guidance.
- A hand-written client follows Stripe's API versions by hand. The client pins one API version in a header, and a quarterly check reads Stripe's changelog ([operations.md](../operations.md)).

## Door

Two-way behind the port. Swapping PaymentIntents for Checkout Sessions, or Stripe for another provider, is a new adapter and a new checkout island; the domain and the ledger do not change, and every sandbox is wiped nightly, so no payment data needs migrating. Nothing in this decision is one-way: the webhook URL is configured in Stripe's dashboard and can be changed in minutes ([ADR 0009](0009-the-api-on-its-own-hostname.md) records that it must be remembered).

## Revisit if

- Stripe retires general sandboxes, starts charging for them, or changes or removes the Payment Element's `fields.billingDetails` option.
- A real payment is ever wanted, for a real product. That needs a new decision and a real privacy policy.
- The key guard fires in any environment: a non-sandbox key reached a Worker secret or a build.
- A webhook replay reaches the ledger twice: a test, a reconciliation or a visitor shows one Stripe event counted as two payments or two refunds.
- Spike S3 shows `fields.billingDetails: 'never'` cannot complete a payment, or a 3-D Secure test card, without a field Stripe collects from the visitor.

## Postscript 2026-11-09

As built, 2026-11-09: the Stripe adapter is `workers/api/src/stripe.rs`, and the request builders are in `crates/app/src/stripe/`, not `workers/api/src/stripe/`. Besides the Worker's key guard and CI's, the storefront's build refuses a publishable key that does not start `pk_test_` (`checkPublishableKey`, `apps/web/astro.config.mjs`).

## Patterns and further reading

- Idempotent receiver: Gregor Hohpe and Bobby Woolf, *Enterprise Integration Patterns* (2003), ["Idempotent Receiver"](https://www.enterpriseintegrationpatterns.com/patterns/messaging/IdempotentReceiver.html).
- Ports and adapters: Alistair Cockburn, ["Hexagonal architecture"](https://alistair.cockburn.us/hexagonal-architecture/) (2005).
- Idempotency keys on payment APIs: Stripe, [Idempotent requests](https://docs.stripe.com/api/idempotent_requests).
