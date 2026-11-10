# ADR 0016: Alternatives weighed after the build: ten choices a reviewer would expect compared, and what was never measured

Status: Accepted · 2026-11-10, by delegation; revisable · Deciders: the owner, by delegation to the session of 2026-11-09

## Context

This is a record of reasoning, written on 2026-11-10, after the build, by the session under the owner's delegation of 2026-11-09. It is not a claim that these alternatives were compared before the choices were made. An audit of the records on 2026-11-10 listed alternatives that a senior reviewer would expect to see weighed and that no document mentioned. Each section below says what the alternative would have replaced, why it is not here, when it would be the right choice, and what was never measured.

How the facts were checked:

- Every claim about an outside tool cites its publisher's documentation by title and publisher, with the date it was read. Where a claim could not be checked, the text says "not checked".
- Claims about the bakery cite the record or file that holds them.
- Where one cheap measurement would settle a question, a roadmap item holds it: [R78 to R82](../roadmap.md#added-on-2026-11-10-from-the-records-audit). Where the honest answer is that nothing was compared, the section says so.

## Decision

The choices in the build stand. The ten sections below record why, and what is not known.

### 1. A TypeScript Worker for the API

- **Would have replaced:** the Rust Worker `bakery-api` and workers-rs ([ADR 0002](0002-rust-for-every-backend.md)).
- **Why it is not here:** the owner's rule that every backend is Rust (ADR 0002, Context). That is a rule, not an engineering verdict. The engineering case for Rust here is the domain as a plain library, tested natively with `cargo test` and `proptest` (ADR 0002, decision 2).
- **When it would be right:** when the Worker needs what workers-rs does not bind, which ADR 0002 lists as of 2026-11-04: Durable Object RPC, Workflows, point-in-time recovery and a first-party test harness for objects.
- **Never measured:** a TypeScript Worker with the same objects. Spike S1 measured only the Rust one (437,223 B of WebAssembly after wasm-opt for one class, 2026-11-04, [roadmap.md](../roadmap.md#spikes)). Roadmap R78 asks the owner whether to measure the baseline.

### 2. Server-Sent Events or polling for the kitchen board

- **Would have replaced:** the hibernating WebSocket on the `Kitchen` object ([ADR 0003](0003-durable-objects-as-the-system-of-record.md), decision 5).
- **Why it is not here:** the board is two-way. A press on the board sends a `cmd` frame and gets an `ack` or a `nack` on the same socket ([ADR 0013](0013-the-api-and-socket-contract-v1.md), Context). One-way push would need a second path for commands. And Cloudflare's Durable Objects guide "Use WebSockets" (Cloudflare documentation, read 2026-11-10) says "Hibernation is only supported when a Durable Object acts as a WebSocket server", so an open event stream would not hibernate the way an idle socket does.
- **When it would be right:** polling, where a screen can be seconds stale and the client cannot hold a connection; event streams, where updates flow one way only.
- **Never measured:** the duration cost or the code size of a polling board against the socket. No item: the socket's limits and costs are in the records, and a polling board is not planned.

### 3. Another island library

- **Would have replaced:** React through `@astrojs/react` ([ADR 0008](0008-astro-site-with-react-islands-on-an-assets-only-worker.md), decision 2).
- **Why it is not here:** one island library and not two. Stripe's React bindings need React, but only the two screens that take a payment use them, the checkout and a catering event's page (`apps/web/src/components/Checkout.tsx`, `PaymentPanel.tsx`). The cost is the React runtime on every island page: 65,840 B gzipped of the lightest page class's 93,993 B first load ([ADR 0014](0014-a-live-guide-in-place-of-the-tour.md), measured 2026-11-09).
- **When it would be right:** a site whose islands do not include those bindings. Preact's guide "Getting Started" (Preact documentation, read 2026-11-10) says that "Libraries and Components originally written for React work seamlessly with our compatibility layer", `preact/compat`. Whether Stripe's React bindings run under it: not checked. Svelte, Solid and Vue: not checked; each would mean Stripe's script without its React bindings.
- **Never measured:** a Preact build of any island page. Roadmap R81.

### 4. A hosted identity provider, an auth library, or a signed token as the session

- **Would have replaced:** the bakery's own code flows for Google and GitHub and its HMAC-signed `__Host-session` cookie ([ADR 0006](0006-sign-in-that-learns-nothing.md)).
- **Why it is not here:** the privacy promise is that the API receives no email or name and stores only an HMAC of the provider's id (ADR 0006, Consequences). A hosted provider would hold each visitor's identity on a third party's service, outside that promise. What any particular provider receives with the `openid` scope alone: not checked. A signed token such as a JWT would be another encoding of what the cookie already is, a signed claim set; revocation needs state on the server either way, and the records already prefer an epoch in `Account` to a second store ([architecture.md](../architecture.md#weaker-designs-and-why), the KV sessions row).
- **When it would be right:** a product with real users who need password reset, a second factor and account recovery, where holding an email is part of the service.
- **Never compared:** no provider or library was tried. No item: the promise, not a measurement, decides it.

### 5. Another solver or routing engine

- **Would have replaced:** VROOM in the browser and openrouteservice at build time ([ADR 0012](0012-delivery-dispatch.md)).
- **Why it is not here:** VROOM is the site's Route Lab solver, so the dispatch screen shows the lab's principle with the lab's tool (ADR 0012, Context). openrouteservice replaced OSRM by the owner's direction of 2026-11-05, with no engineering comparison (ADR 0012's postscript of 2026-11-10).
- **What the publishers say, read on 2026-11-10:** OSRM's table service "Computes the duration of the fastest route between all pairs of supplied coordinates" ("OSRM API Documentation", Project OSRM). openrouteservice's matrix endpoint "calculates profile specific distance and time matrices" ("Matrix Endpoint", openrouteservice backend documentation). Both run from an OpenStreetMap extract on the builder's own machine. OR-Tools is an "open source software suite for optimization" that covers vehicle routing, with models written in C++, Python, C# or Java ("OR-Tools", Google for Developers); that page names no browser or WebAssembly build, and its licence is not stated there (not checked). GraphHopper, Valhalla and jsprit: not checked.
- **When it would be right:** OR-Tools, for a server-side solver with constraints VROOM does not model. Another routing engine, if its matrix differs from openrouteservice's in a way the plans notice.
- **Never measured:** a matrix from OSRM beside the committed one (roadmap R79), and any solver but VROOM and the savings heuristic.

### 6. Tracing and error tracking

- **Would have replaced:** nothing directly. The bakery has Workers Logs, Analytics Engine points and, since ADR 0015, a per-sandbox flight recorder.
- **What the publisher says:** Cloudflare's "Traces" page (Workers documentation, read 2026-11-10) says Workers tracing "follows OpenTelemetry (OTel) standards", instruments fetch calls, binding calls and handler invocations without code changes, Durable Object calls included, and can export to an OpenTelemetry endpoint; traces are kept seven days, and from 2026-12-01 stored traces count toward Cloudflare's Observability pricing. Whether it instruments a Rust Worker built with workers-rs: the page does not say (not checked). A hosted error tracker: not checked.
- **Why it is not here:** it was not weighed before the build. The recorder answers a different question, a visitor's own event hops, scoped to their sandbox and readable by them ([ADR 0015](0015-a-lossy-flight-recorder-beside-the-event-path.md), When not to do this).
- **When it would be right:** for the operator, debugging one request across the Worker and its objects.
- **Never measured:** whether traces work on this Worker, and what they would cost. No item: turning them on is an account setting and a cost decision for the owner.

### 7. Infrastructure as code for the Cloudflare account

- **Would have replaced:** setup by hand. The two queues are created once in the dashboard ([ADR 0011](0011-github-actions-owns-deploys-for-both-workers.md), Context), and the WAF kill rule and the tokens are made by hand from [operations.md](../operations.md).
- **What the publisher says:** Cloudflare's "Terraform" page (Cloudflare documentation, read 2026-11-10) says "you can manage the Cloudflare global network using the same familiar tools". Which resources the provider covers (queues, WAF rules, Custom Domains, tokens): not checked.
- **Why it is not here:** the account objects are few and made once, and the Workers' own settings are already code in each `wrangler.jsonc`.
- **When it would be right:** a second environment, a second operator, or account settings that change often enough to drift.
- **Never measured:** whether anything has drifted from operations.md. No item.

### 8. Other secret scanners, and code scanning

- **Would have replaced:** gitleaks with private rules, the content firewall (ADR 0011, decision 3).
- **What the publisher says:** GitHub's "Secret scanning" page (GitHub Docs, read 2026-11-10) says secret scanning runs on public repositories automatically and for free. Whether custom patterns are available on a public repository without a paid licence: that page does not say (not checked). GitHub's "Code scanning with CodeQL" page (GitHub Docs, read 2026-11-10) lists Rust and JavaScript and TypeScript among the supported languages; its price for public repositories is not stated on that page (not checked).
- **Why gitleaks is here:** the firewall's terms are private and must never be written into the repository, and it runs before a push, in the hooks, as well as in CI over the built bundles. GitHub's scanning runs after a push, on its own patterns.
- **When the others would be right:** both alongside, not instead. Code scanning looks for flaws in code, which the firewall does not.
- **Never checked:** whether GitHub's secret scanning and push protection are on for this repository. Roadmap R82.

### 9. Stripe's mock server in place of the bakery's fake

- **Would have replaced:** `scripts/fake-stripe.mjs`, the fake the e2e suite and the smokes pay against.
- **What the publisher says:** the README of `stripe-mock` (Stripe, its GitHub repository, read 2026-11-10) says "stripe-mock is stateless", that data sent on a POST "will be validated, but it will be completely ignored beyond that", and that it is "locked to the latest version of Stripe's API". The README does not mention webhooks.
- **Why it is not here:** the bakery's payment flow needs state: an intent created, then confirmed, then a signed webhook that `Billing` deduplicates ([ADR 0007](0007-stripe-sandbox-and-a-payment-element-that-collects-nothing.md)). A stateless mock returns fixed answers.
- **When it would be right:** checking that each request's path and parameters match Stripe's API, which the fake does not check.
- **Never compared:** whether `stripe-mock` would refuse a request the fake accepts. Spike S3, against the real sandbox, has not run either ([roadmap.md](../roadmap.md#spikes), as of 2026-11-09).

### 10. Other test runners: cargo-nextest, Jest, Cypress

- **Would have replaced:** `cargo test`, Vitest and Playwright ([stack.md](../stack.md#the-stack)).
- **Why it is not here:** the web tools are the site's, so both repositories test the same way (stack.md, "Tests in the browser"), and `cargo test` is the Rust default.
- **When it would be right:** not checked for any of the three.
- **Never compared.** No item.

## Consequences

Good:

- A reader can see which choices were weighed, which were the owner's rule or direction, and which were never compared, in one place.
- Five measurements that would settle open questions have roadmap items, R78 to R82.

Bad:

- This record was written after the build. It explains choices; it does not show that they were compared when they were made.
- Its outside facts are as of 2026-11-10 and will age; each is dated so a reader knows how old it is.

## Door

Two-way. It records reasoning and changes no code. A section is corrected by a postscript when a roadmap item's measurement lands.

## Revisit if

- A measurement of R78, R79 or R81 lands: its section gets a postscript with the number, and if the number contradicts the choice, the choice's own record gets a new ADR.
- An outside fact cited here changes, or a "not checked" claim is checked.
- A reviewer names an alternative this record does not weigh.

## Postscript 2026-11-10

Section 3, measured locally on 2026-11-10 (roadmap R81). On a throwaway branch of `main` at 800ffd6, Astro's own Preact integration, `@astrojs/preact` ^6.1.2 with `compat: true` and `preact` ^11.2.0 (the ranges pnpm added that day), took the place of `@astrojs/react` in `apps/web/astro.config.mjs`. That was the only change: no component was edited, and the build ran on the first try. The bytes are the gzipped JavaScript a page loads, counted by the code in `apps/web/test/dist.test.ts`, on the largest page of each class; "guide on" adds the guide's deferred layer, as that test counts it.

| Page class (largest page) | React, first load | Preact, first load | Less | React, guide on | Preact, guide on |
|---|---|---|---|---|---|
| guide only (`/`) | 81,486 B | 22,525 B | 58,961 B | 107,017 B | 47,873 B |
| API reference (`/docs/api/`) | 81,739 B | 22,778 B | 58,961 B | 107,270 B | 48,126 B |
| status (`/status/`) | 84,259 B | 25,242 B | 59,017 B | 109,790 B | 50,590 B |
| storefront (`/menu/`) | 95,440 B | 36,229 B | 59,211 B | 120,427 B | 61,056 B |
| the order's page (`/order/`) | 105,121 B | 46,014 B | 59,107 B | 130,108 B | 70,841 B |
| console screens (`/app/`) | 112,750 B | 53,505 B | 59,245 B | 137,737 B | 78,332 B |
| checkout (`/checkout/`) | 113,646 B | 54,520 B | 59,126 B | 138,633 B | 79,347 B |

What passed on the Preact build: the unit suite (65 files, 1,871 tests, every budget in `dist.test.ts` among them) and the whole e2e suite (64 of 64). The unit tests that render a component still render it with React, because Vitest does not read the Astro config, so they say nothing about Preact. Nothing failed.

What was not checked: whether Stripe's React bindings run under `preact/compat`. The suite never mounts the Payment Element, because `js.stripe.com` is unreachable in it: under Preact, as under React, the checkout reached its payment step, showed that Stripe's form could not load, and the order was paid at the bakery's fake Stripe. No spec opens a catering event's payment panel. Stripe's real script was not loaded at all.

The saving is large, about 59,000 B gzipped on the first load of every island page, and everything the suites exercise passed. This record does not change the choice: React stays until the payment screens are shown to work under Preact, and the switch is the owner's to decide.

Section 1, measured locally on 2026-11-10 (roadmap R78): a TypeScript twin of spike S1's one-class Worker beside S1's own tree, on `wrangler dev`, is in [ADR 0002](0002-rust-for-every-backend.md#postscript-2026-11-10-s1s-worker-beside-a-typescript-twin)'s postscript of that day. Its upload is 8.14 KiB against 475.87 KiB, and nothing timed told the two apart; the choice is unchanged, being the owner's rule.
