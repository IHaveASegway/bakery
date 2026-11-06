# bakery: product brief

Why the bakery demo exists, who it is for, what Joseph asked for on 2026-11-04, the principles it is built under, the content firewall it lives under, and the open decisions that block each pull request. The shape is in [architecture.md](architecture.md), the language and the events in [domain.md](domain.md), each hard-to-reverse decision in [adr/](adr/README.md), and the order of work in [roadmap.md](roadmap.md). This doc owns the goals, the questions and the answers; every other doc links here for them.

Status: Updated in PR 16 · 2026-11-06

Prices, limits and versions are as of 2026-11-04, with sources.

## In one line

Proof of Concept Bakery, the made-up bakery that ihaveasegway.com's lab simulates, built as a real business system: ordering, pickup and delivery scheduling, catering, billing through Stripe's sandbox, and a CRM with campaigns, every backend in Rust on Cloudflare Workers, its state in SQLite-backed Durable Objects (DOs), with a private sandbox for every visitor that is wiped every night, and every decision written down in public.

## Why

The site's lab shows five principles in the visitor's browser: queues, caches, backfills, consensus and vehicle routing, each as a deterministic simulation about a made-up bakery ([the site's lab.md](https://github.com/IHaveASegway/website/blob/main/docs/lab.md)). A simulation shows what its rules say and no more. It proves that Joseph understands a principle well enough to model it; it does not prove that he can build and run the system the principle belongs in. The bakery is that proof: the same principles, in production code he operates, on infrastructure he pays for, behind a sign-in a visitor can use.

Three things a reader can do with the bakery that no simulation offers:

- **Use it.** Place an order, watch the kitchen board update over a live socket, pay with a test card, see the receipt land in a mailbox, advance the clock to tomorrow and read the bake list.
- **Read it.** Every screen links the lab page that explains its principle and the decision record that chose its design. The repository is public from its first push.
- **Check it.** The code, the tests, the pipeline and the bill are all in the open. The cost model in [cost.md](cost.md) says what a month costs, and the monthly figure is checked against the account.

A second purpose, Joseph's: every server-side line here is Rust, so the site can later write about which language fits which tool, with this repository and the site's own TypeScript lab as the evidence.

## Who it serves

| Reader | Arrives from | Wants | Gets |
|---|---|---|---|
| An engineer or a hiring manager | A lab page's "Running in the bakery" link, or the repository | Proof that the principle runs for real; code to read; decisions with the options that lost | A sandbox in one click, a drawer on every screen that names the principle and its ADR, a repository whose docs read like this one |
| A recruiter | The site's Home or About | Something to click that works in a minute, and a sentence to repeat | The storefront without sign-in; an order and a payment with a test card in under two minutes; one line on the storefront's "How it's built" page |
| Joseph | His own calendar | A system he can run alone, inside a budget, that never holds anyone's data | The guardrails in cost.md, the wipe in security.md, the runbooks in operations.md |

## The ask and the need

Joseph's ask on 2026-11-04, paraphrased: a subdomain and a new site that shows the lab's principles in action, as an event-driven CRM and marketing site for the made-up bakery; a sandbox people can sign in to with Google or a username and password; pages that need no sign-in; a process that wipes the databases and makes it impossible to store anyone's private data; the API under `api.bakery.ihaveasegway.com`; React and Astro if they are the right tools; as much as possible in Durable Objects; a monthly cost estimate for building it properly and completely; every backend in Rust; the code open-sourced in this repository and deployed; and the lab and the bakery linking to each other where a principle is used. He asked for questions first, so the goals are understood from the menu to routing, scheduling, order submission, catering, billing and payment processing, and for the plan and the ADRs to be drafted so building can start quickly and correctly.

The need under the ask:

| Need | What serves it |
|---|---|
| Evidence of building and architecting, not only explaining | A real system with real failure modes, and the docs that say what was traded ([architecture.md](architecture.md), [adr/](adr/README.md)) |
| A demo a stranger can use without risk to them or to Joseph | The sandbox, the wipe and the no-personal-data rule ([ADR 0005](adr/0005-a-private-sandbox-per-visitor-wiped-nightly.md), [security.md](security.md)) |
| A bounded bill | Workers Paid at $5 a month with the site's guardrails, and a computed worst case ([ADR 0010](adr/0010-workers-paid-with-the-sites-guardrails.md), [cost.md](cost.md)) |
| Rust on the server, as a rule | [ADR 0002](adr/0002-rust-for-every-backend.md), and the site's ADR 0014 as the counterpart that chose TypeScript for its lab |
| The lab and the bakery as one body of work | The principle map in [domain.md](domain.md), the links both ways (Q32) |

## What exists, and what is new

**Exists**, in the site's repository, and is reused rather than rebuilt:

- The five labs and their write-ups, the made-up bakery's story, and the Route Lab's Seattle map, travel-time matrix and places, pinned byte for byte ([the site's ADR 0016](https://github.com/IHaveASegway/website/blob/main/docs/adr/0016-route-lab-in-the-browser.md)).
- A pipeline shape: build once, gates, a Worker Preview per pull request, upload-smoke-promote, rollback, a weekly audit ([the site's delivery.md](https://github.com/IHaveASegway/website/blob/main/docs/delivery.md)).
- A content firewall with secret-held rules, an identity allowlist and a self-test ([the site's ADR 0007](https://github.com/IHaveASegway/website/blob/main/docs/adr/0007-content-firewall.md)).
- A cost model, a price sheet and the guardrails for the day the account moves to Workers Paid ([the site's cost.md](https://github.com/IHaveASegway/website/blob/main/docs/cost.md)).
- A set of rules for Durable Objects: SQLite only, the Hibernation API only, alarms not timers, names from the server, every object ends with `deleteAll()` ([the site's lab.md](https://github.com/IHaveASegway/website/blob/main/docs/lab.md#durable-object-rules)).
- The design tokens, the typefaces and the technical-drawing style, copied rather than imported ([the site's ADR 0010](https://github.com/IHaveASegway/website/blob/main/docs/adr/0010-quiet-console-design-tokens.md)).

**New**, and the reason this repository exists:

- A Rust Worker with 14 DO classes, an event log and a transactional outbox in each aggregate, Cloudflare Queues between them, and alarms for everything timed ([architecture.md](architecture.md)).
- Sign-in that learns nothing about the visitor, and a seeded private sandbox per visitor that is wiped every night ([ADR 0005](adr/0005-a-private-sandbox-per-visitor-wiped-nightly.md), [ADR 0006](adr/0006-sign-in-that-learns-nothing.md)).
- Payments and billing against Stripe's sandbox with test cards, through a Payment Element that collects no billing details ([ADR 0007](adr/0007-stripe-sandbox-and-a-payment-element-that-collects-nothing.md)).
- A business clock per sandbox that a visitor can advance, so alarms, reminders and tomorrow's bake list can be seen without waiting (Q12).
- A storefront and a staff console on `bakery.ihaveasegway.com`, and an API on `api.bakery.ihaveasegway.com` ([ADR 0008](adr/0008-astro-site-with-react-islands-on-an-assets-only-worker.md), [ADR 0009](adr/0009-the-api-on-its-own-hostname.md)).
- The account's move to Workers Paid, which the site's ADR 0008 said would be a dated, deliberate change with a checklist ([ADR 0010](adr/0010-workers-paid-with-the-sites-guardrails.md)).

## Prior art

| Prior art | What it is | What the bakery takes from it, and where it differs |
|---|---|---|
| [Cloudflare's Durable Objects examples](https://developers.cloudflare.com/durable-objects/examples/) and [workers-chat-demo](https://github.com/cloudflare/workers-chat-demo) | Reference code for rooms, rate limits and hibernation | The limits and the hibernation habits. The templates take free text with no auth and no cleanup; the bakery takes almost none and wipes everything |
| [tldraw sync](https://tldraw.dev/docs/sync) | One DO per room with SQLite storage, in production on tldraw.com | One object per aggregate holds up in production |
| [Stripe's sample integrations](https://github.com/stripe-samples) | Working checkout flows against test mode | The Payment Element flow and the webhook handling, with billing details never collected |
| The site's lab ([lab.md](https://github.com/IHaveASegway/website/blob/main/docs/lab.md)) | Deterministic simulations of the same principles, in the browser | The story, the bakery, the rules and the write-up shape. The lab explains; the bakery runs |
| Reference applications such as Microsoft's [eShop](https://github.com/dotnet/eShop) and the [RealWorld](https://github.com/gothinkster/realworld) apps | Public, complete sample systems meant to be read | The idea of a whole system built in the open as evidence. They are frameworks' showcases; this one is a person's |

## Principles

1. **Everything that runs on a server is Rust.** The Worker, every DO class, the Queue consumer and the cron handler. The browser runs TypeScript. Another language enters only as prebuilt WebAssembly behind an interface, as VROOM does on the dispatch screen ([ADR 0002](adr/0002-rust-for-every-backend.md), [ADR 0012](adr/0012-delivery-dispatch.md)).
2. **State lives in Durable Objects, one writer per aggregate.** An order, a catering event, a customer, a day's schedule: each is one object with its own SQLite database, its own event log and its own outbox. Projections live in their own objects and are rebuilt from the logs ([ADR 0003](adr/0003-durable-objects-as-the-system-of-record.md), [ADR 0004](adr/0004-queues-between-objects-and-alarms-for-time.md)).
3. **No personal data, by construction.** The API never stores an email address or a name, and receives none from Google or GitHub. Personas, venues, addresses and card details are synthetic. Two short free-text fields are pattern-checked on write and die with the sandbox. Every sandbox is wiped every night ([ADR 0005](adr/0005-a-private-sandbox-per-visitor-wiped-nightly.md), [security.md](security.md)).
4. **Static by default; code runs only where a visitor's input matters.** Public pages are prebuilt files on an assets-only Worker, so a page view costs nothing and never counts toward a cap. Code runs behind the API hostname, in its own Worker, so the demo cannot take the site down ([ADR 0008](adr/0008-astro-site-with-react-islands-on-an-assets-only-worker.md), [the site's ADR 0002](https://github.com/IHaveASegway/website/blob/main/docs/adr/0002-host-on-workers-static-assets.md)).
5. **Every number has a unit and a source.** Prices, limits and versions carry an "as of" date and a URL, in these docs and on the screens that show them. "Fast" is not a claim; "a SQL write in 0.4 ms of CPU, measured 2026-11-20" is.
6. **Fail closed, on cost and on content.** Admission control, daily budgets and a kill switch bound the bill on Workers Paid, where no cap exists; the firewall fails the build on a finding and when it cannot prove the tree clean ([cost.md](cost.md), [the site's ADR 0007](https://github.com/IHaveASegway/website/blob/main/docs/adr/0007-content-firewall.md)).
7. **The demo explains itself.** Every screen has a drawer that names the principle it runs, links the lab page that explains it and the ADR that decided it, and shows the events the last action produced. A visitor never has to guess what they are looking at (Q32, Q33). As built in PR 12 (2026-11-06): the "How this works" drawer is the tour's step, and its card names the principle and links the lab page and the ADR as real links ("Read how it works: Queue Lab · ADR 0004"); a principle with no lab page links its section of the How it's built page and its ADR instead, and the Raft step adds the essay. As built in PR 14 (2026-11-06) each of the five lab principles has its own essay and its tour step links it by title; as built in PR 15 (2026-11-06) four principles with no lab page, idempotency keys (and payment keys on the same page), sagas, leases and admission control, have essays too, nine in all, and a tour step has an essay exactly when its id is in `ESSAYS`; as built in PR 16 (2026-11-06) the last four pages, time travel, the lag (CQRS and load you can watch, one page), the private sandbox (with no personal data) and the API, mean every one of the 16 principles has an essay, thirteen pages in all. All 16 principles are used by at least one of the 63 steps, and a test fails if one is not.
8. **Two-way doors decided fast; one-way doors written down.** Layout, copy and limits change in a pull request. Hostnames once configured with Stripe and Google, DO class names, a promise on the privacy page and anything published get an ADR with a Door and a Revisit if ([ADR 0001](adr/0001-record-architecture-decisions.md)).
9. **One pipeline, one writer per environment.** GitHub Actions is the only thing that deploys either Worker ([ADR 0011](adr/0011-github-actions-owns-deploys-for-both-workers.md)).
10. **A sandbox is disposable; the promise is permanent.** Nothing a visitor does outlives the night. The sentence that says so on the privacy page is a one-way door, and the nightly object check proves it was kept ([security.md](security.md)).

## Content firewall

The site's policy applies unchanged ([the site's product.md](https://github.com/IHaveASegway/website/blob/main/docs/product.md#content-firewall)): nothing about Joseph's current employer or his private venture appears here, in the code, in fixtures, in commit metadata or in pull request text. This repository adds three rules of its own:

- **Public from the first push.** The site's repository went public after an audit; this one is public from its first commit. Content is published at `git push`, before CI runs, so the local hooks and the writer's read are the only prevention ([the site's ADR 0012](https://github.com/IHaveASegway/website/blob/main/docs/adr/0012-public-repository.md)). The same firewall scripts and the same secret-held rules are assumed for this repository until Q34 is answered.
- **Synthetic data only, everywhere.** Personas, venues, streets, menu items, campaign copy, test fixtures and the seed come from generators and word lists, never from a real person, business or address. Salt Lake City is the made-up bakery's city, Joseph's choice of 2026-11-04; the Route Lab's map stays Seattle ([the site's lab.md](https://github.com/IHaveASegway/website/blob/main/docs/lab.md#rules-for-every-demo)). The firewall's rule about Joseph's own city is his to apply, and nothing here says where he lives.
- **Other repositories are not named.** Joseph mentioned a backend template of his own on 2026-11-04 and then asked that it be skipped for now (Q39). Its organization and name appear nowhere in this repository, and a port of its structure, if it comes, is described generically.

Every doc, commit message and pull request here is read against the site's firewall classes before it is pushed ([the site's content.md](https://github.com/IHaveASegway/website/blob/main/docs/content.md#firewall-classes-for-copy)). Answers that touch the firewall go in Joseph's private record, never in a review, comment or issue; this doc records only the option chosen.

## Milestones

| # | Milestone | Shows | Pull request |
|---|---|---|---|
| M0 | The plan | The questions answered, the ADRs argued | PR 1 (this) |
| M1 | Two Workers run locally | A Rust Worker with one DO and a placeholder Home on `wrangler dev`; CI runs the firewall and the native tests; nothing is deployed | PR 2 |
| M2 | A sandbox | Sign in with Google, GitHub or a demo account, or try one as a guest; get a seeded bakery; watch it disappear at 10:00 UTC | PR 3 |
| M3 | An order on the board | The menu, a cart, an order, the kitchen board moving over a live socket, simulated customers placing orders, the outbox and the Queue visible in the drawer | PR 4 |
| M4 | A payment | A test card, a webhook, a paid order, a receipt in the inbox, a refund | PR 5 |
| M5 | A day planned | Slots, windows, the bake list, the clock advanced to tomorrow | PR 6 |
| M6 | A catering event | An inquiry to a paid balance, reminders fired by alarm | PR 7 |
| M7 | A campaign | Segments, a send to the inbox, opens and clicks, projections rebuilt from the log | PR 8 |
| M8 | A route | The server's plan beside VROOM's on the Salt Lake City map, published by the object | PR 9 |
| M9 | The tour and the API | A walkthrough on every screen, and the same actions through the API with the visitor's own token | PR 10 |
| M10 | Launch | Both hostnames answer; the account on Workers Paid with its guardrails; the privacy page live | PR 11 |
| M11 | The two link | "Running in the bakery" on each lab page; "How this works" on each screen | PR 12, with pull requests in the site's repository. Half done on 2026-11-06: the bakery's half is built (the tour's links, the How it's built page, the essay, a weekly link check; PR 14 then added the other four essays and each tour step for a lab principle now links its essay by title); the site's half, the pull requests adding "Running in the bakery", is gated by the linking gate and not started ([roadmap.md](roadmap.md#pr-12-the-lab-links-and-how-its-built)) |
| M12 | A status page | Live counters from the account's own metrics | PR 13 (unchanged) |
| M13 | The essays | One essay for each of the five lab principles: outbox, cache, rebuild, routes and single-writer, each saying what the lab shows in the small and what the bakery does for real | PR 14 ([roadmap.md](roadmap.md#pr-14-the-how-its-built-essays)) |
| M14 | The essays without a lab page | Four more essays, for the principles the lab has no page on yet: idempotency keys (one page for commands and payments), sagas, leases and admission control, each saying what a simpler design would do and what the bakery does for real | PR 15 ([roadmap.md](roadmap.md#pr-15-the-essays-for-the-principles-without-a-lab-page)); built 2026-11-06 |
| M15 | The last essays | Four more essays, so every principle on the How it's built page has one, thirteen pages in all: time travel, the lag between writes and projections (CQRS and load you can watch, one page), the private sandbox (with no personal data) and the API as a first-class client, each saying what a simpler design would do and what the bakery does for real | PR 16 ([roadmap.md](roadmap.md#pr-16-the-last-essays)); built 2026-11-06 |

The order is [roadmap.md](roadmap.md)'s, confirmed by Joseph on 2026-11-04 (Q37): build it locally, pull request by pull request, and deploy when it is good.

## Open decisions

Recommendations that are not yet approved stay open. Joseph answered the eighteen blocking questions on 2026-11-04 ([Decided](#decided)). What remains proceeds on the recommendation until he answers, due before the pull request that needs it; four of the rows are new on 2026-11-04 and came out of his answers. Anything the firewall touches defaults to the strictest option until he clears it in writing in the private record. "By" is the last point at which an answer costs no rework. The short names (Q-name and so on) are stable, and the other docs use them.

Joseph answers with the option letter, in the pull request review or in a message. An answer moves to [Decided](#decided) with the date, the option, what ships, its door and what would show it wrong. A one-way answer also gets an ADR.

### Blocking PR 2 and PR 3

None left: Joseph answered all eighteen on 2026-11-04 ([Decided](#decided)).

### Due before later pull requests

These proceed on the recommendation until answered, in the order the pull requests need them.

| # | Question | Options | Recommendation, and why | Door | Blocks · by |
|---|---|---|---|---|---|
| Q1 · Q-goal | What should a visitor be able to say after ten minutes? | (a) "The principles the lab simulates run here for real, in Rust on Durable Objects, and I can read why each was built this way." (b) (a) and "I could run a bakery on this" | (a), with a storefront believable enough that (b) is plausible. Product polish competes with the next principle for the same hours, and the principles are the portfolio | Two-way | The storefront's scope · before PR 4 |
| Q5 · Q-menu | What is on the menu, and who can change it? | (a) About 24 items in 5 categories, with variants, allergens, lead times (a cake needs 48 hours), daily availability and seasonal items; staff edit prices and availability in their sandbox, and publishing bumps a version that invalidates the cached menu. (b) A fixed menu | (a). The menu is where the Cache Lab's principle runs: an edit, a publish, an invalidation, a cache miss, a hit | Two-way | PR 4 · before PR 4 |
| Q6 · Q-public | Which pages need no sign-in? | (a) Home, Menu, Catering (the inquiry needs a sandbox to submit), About the bakery, How it's built, Privacy, Status; a cart without sign-in until checkout. (b) (a) plus a read-only window onto a demo sandbox's kitchen board | (a). Every public page is a static asset, so it costs nothing and runs no code. (b) would put a page view on the meters. As built on 2026-11-06 (PR 12), Home, Menu, Catering, About the bakery, How it's built and Privacy exist, with the essay under How it's built; Status waits for PR 13 | Two-way | PR 4 · before PR 4 |
| Q7 · Q-images | Photos of the food? | (a) None: items drawn in the site's technical-drawing style, with the site's tokens. (b) Generated photographs. (c) Stock photographs | (a). It matches the site, carries no license and no metadata, and a drawn croissant is clearly made up | Two-way | PR 4's menu page · before PR 4 |
| Q10 · Q-slots | How is pickup and delivery time chosen? | (a) Pickup slots of 15 minutes with a capacity each, and delivery windows of 2 hours per zone with a daily capacity; staff set capacities. (b) As soon as possible, no slots | (a). Slots make capacity a thing the kitchen board can show and the Schedule object can refuse, which is the reservation pattern | Two-way | PR 4's checkout, PR 6 · before PR 4 |
| Q13 · Q-order-flow | How much of an order's life is modelled? | (a) Cart, checkout with a slot and a note, payment, confirmed, in production, ready, picked up or delivered, closed; cancel and refund paths; an unpaid order expires after 15 minutes by alarm. (b) Placed, paid, done | (a). The states are where the events come from, and the expiry is the first alarm a visitor can watch fire | Two-way | PR 4 · before PR 4 |
| Q14 · Q-free-text | What may a visitor type? | (a) Two fields: an order note of up to 140 characters and a catering brief of up to 500, rejected on write when they match an email, phone, card-number or URL pattern, held only in the visitor's sandbox and gone with it. (b) None: every value is a choice from a list, as the site's lab does in its v1. (c) Unrestricted text | (a). A CRM with no notes reads as a mock-up; (c) is where personal data arrives. The two fields cannot hold a card number or an address that passes the checks, and the sandbox they live in is wiped every night. Joseph asked that it be impossible to store anyone's private data: (b) is the strict reading, and (a) is the believable one; this is his call | Two-way; the privacy page's wording is one-way once published | PR 4's order note, PR 7's catering brief, the privacy page · before PR 4 |
| Q15 · Q-live-board | A live kitchen board? | (a) Yes, over WebSockets on the Hibernation API, with a snapshot on join and the site's lab protocol shape. (b) Polling | (a). An idle socket costs nothing on the Hibernation API, and the board is where the Queue Lab's principle becomes visible | Two-way | PR 4 · before PR 4 |
| Q45 · Q-guest-scope | What can a guest do without signing in? | (a) Browse, order and pay with a test card; sign-in unlocks the console's writes (menu edits, campaigns, publishing a route), the API token, simulated traffic and a sandbox that follows the account across devices; guests get 100 of the 300 sandboxes a day. (b) Everything a signed-in visitor can. (c) Nothing without sign-in | (a). It answers Joseph's worry of 2026-11-04 about bots creating hundreds of accounts or sandboxes without turning away a recruiter who will not sign in; the paid-for meters sit behind the smaller cap | Two-way | PR 3's admission path · before PR 3 |
| Q40 · Q-traffic | Simulated traffic, so the bakery moves while a visitor watches? | (a) A `Simulator` object per sandbox, started from the console at a chosen rate, that issues ordinary commands as synthetic customers while the console is open, capped at 6 orders a minute and 30 minutes a day. (b) A scripted replay of a recorded day. (c) None: the visitor makes every order | (a), Joseph's direction of 2026-11-04. The board, the timelines and the projections move on real events, and the caps keep it inside the cost model ([cost.md](cost.md)) | Two-way | PR 4 · before PR 4 |
| Q17 · Q-psp | Which payment provider? | (a) Stripe, in a sandbox. (b) Worldpay. (c) Both, behind one port | (a). Stripe's sandboxes are free, isolated, carry their own keys and webhooks, move no money and accept test cards ([sandboxes](https://docs.stripe.com/sandboxes), as of 2026-11-04). A second provider can implement the same `PaymentGateway` port later, which is how (c) would arrive ([ADR 0007](adr/0007-stripe-sandbox-and-a-payment-element-that-collects-nothing.md)) | Two-way behind the port | PR 5, and the Stripe sandbox's creation · before PR 5 |
| Q18 · Q-payment-ui | Which Stripe surface? | (a) The Payment Element embedded in the page, with `fields.billingDetails: 'never'` and the sandbox's synthetic billing details passed on confirm, so the visitor never types a name or an email into Stripe. (b) Stripe's hosted Checkout page | (a). (b) collects a name and an email into the Stripe sandbox, which breaks the no-personal-data rule ([Payment Element](https://docs.stripe.com/js/elements_object/create_payment_element), as of 2026-11-04) | Two-way | PR 5 · before PR 5 |
| Q19 · Q-billing-scope | What does billing cover? | (a) One-off payments, catering deposits, balance invoices through Stripe Invoicing, refunds full and partial, receipts to the sandbox inbox. (b) (a) plus a subscription, a weekly bread box, through Stripe Billing. (c) Payments only | (a) first; (b) as a later pull request. A subscription shows recurring billing and proration but adds a second lifecycle before the first is done | Two-way | PR 5, PR 7 · before PR 5 |
| Q20 · Q-stripe-account | Whose Stripe account? | (a) The test-mode sandbox of Joseph's Stripe account, with restricted keys as Worker secrets and a reset on a schedule; never a live key, and the Worker and CI refuse one. (b) An anonymous sandbox from the Stripe CLI | (a). An account's sandbox has a dashboard, webhooks and a lifetime Joseph controls. Set up on 2026-11-04 with two restricted keys. Stripe refuses a second sandbox until the business is verified, so local work and CI share this one; the keys never enter the repository ([operations.md](operations.md#3-the-stripe-sandbox)) | Two-way | PR 5 · before PR 5 |
| Q22 · Q-email | Does the bakery send email? | (a) Never to a visitor: the system holds no addresses, so every message lands in the sandbox's inbox screen. Real sends only to Joseph's own verified address, which Cloudflare's Email Service delivers free on any plan, for his own demonstrations. (b) Real email to visitors who opt in | (a). (b) needs an address to store, which the privacy rule forbids. Sends to a verified address are free and do not count toward the 3,000 a month on Paid ([Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/), as of 2026-11-04) | Two-way | PR 5's receipts, PR 8's inbox · before PR 5 |
| Q11 · Q-production | A bake list? | (a) A production plan per day, projected from confirmed orders and catering with the lead-time rules, on the kitchen board. (b) None | (a). It is the projection a visitor reads after advancing the clock, and the clearest reason the clock exists | Two-way | PR 6 · before PR 6 |
| Q16 · Q-catering | How much of catering is modelled? | (a) Inquiry with a date, a headcount, a package and a venue from a made-up list; a quote by staff; a 25% deposit; confirmed; production; delivered; a balance invoice; paid; closed; declined and cancelled paths; reminders by alarm; a calendar with 2 events a day and a 7-day lead time. (b) Inquiry and quote only | (a). Catering is the saga: steps days apart, each an alarm, each a chance to fail and retry | Two-way | PR 7 · before PR 7 |
| Q21 · Q-crm-scope | What does the CRM cover? | (a) Customers, a timeline per customer, segments, campaigns sent to the inbox with simulated opens and clicks, the catering lead pipeline, loyalty points, and a "rebuild projections" control that replays the event log. (b) Customers and timelines only | (a). The rebuild is where the Backfill Lab's principle runs, and campaigns are what makes the inbox worth having | Two-way | PR 8 · before PR 8 |
| Q9 · Q-dispatch | How are deliveries routed? | (a) VROOM in the browser for interactive planning, with the Route Lab's solver and data, and a Clarke–Wright savings heuristic in Rust in the Dispatch object for the server's proposed plan; the object validates and publishes, and the screen compares the two. (b) Rust only. (c) The browser only | (a). "Every backend is Rust" is kept, since the server's plan is Rust and the object decides; VROOM is the yardstick the heuristic is measured against, and a reader learns from the gap ([ADR 0012](adr/0012-delivery-dispatch.md)) | Two-way | PR 9 · before PR 9 |
| Q41 · Q-tour | A guided tour? | (a) A walkthrough on every screen, in a client-side island with no third party: what you are looking at, the events the last action produced, the principle with its lab page and ADR, and the API request that does the same thing. (b) One "How it's built" page | (a), Joseph's direction of 2026-11-04: a visitor wants to be shown around and to learn to do things themselves, in the screens or through the API | Two-way | PR 10 · before PR 10 |
| Q42 · Q-api-access | Can a visitor use the API directly? | (a) A per-sandbox bearer token shown in the console, signed like the session cookie and dying with the sandbox; an OpenAPI document generated from the contracts at `/docs/api/`; every console action has an API equivalent and the tour shows it. (b) A read-only API. (c) No visitor API | (a). It is the second half of "learn to do it yourself", and the contract gets its ADR 0013 in the same pull request ([security.md](security.md) owns the token) | Two-way; the contract hardens once ADR 0013 is Accepted | PR 10 · before PR 10 |
| Q32 · Q-links | How do the lab and the bakery link? | (a) Both ways: each lab page gets a "Running in the bakery" section with one deep link into the screen where its principle runs, and each bakery screen has a "How this works" drawer that links the lab page and the ADR. (b) One "How it's built" page on the bakery only | (a). The links are the point of the exercise. The site's side is a pull request in the site's repository per lab page, after this repository passes the site's readiness checklist | Two-way for the drawers; the site's links are URLs, so one-way once shared | PR 12, and the site's pull requests · before PR 12 |
| Q33 · Q-principles | Which principles map where? | (a) Queue Lab → the outbox, the Queue, idempotent consumers and the dead-letter queue, on the kitchen board; Cache Lab → the menu cache and its invalidation by event; Backfill Lab → rebuilding the CRM's projections; Route Lab → dispatch; Raft Lab → an essay on why a single-writer object needs no consensus (and, as built in PR 14 on 2026-11-06, an essay for each of the other four; as built in PR 15 on 2026-11-06, an essay also for idempotency keys, sagas, leases and admission control, the principles with no lab page; as built in PR 16 on 2026-11-06, an essay for each of the rest, so every principle has one, thirteen pages in all); new: idempotency keys, sagas by alarm, leases and TTLs, admission control, CQRS, a logical clock. (b) A shorter list | (a). The map is in [domain.md](domain.md); each row names the screen and the ADR | Two-way | PR 12 · before PR 12 |
| Q31 · Q-status | A public status page? | (a) Later: live counters from Analytics Engine (sandboxes today, orders, events relayed, the last wipe's time and count). (b) None | (a), after M9. It is the one page that puts a number on the meters in public, and it costs a query per view. **Answered as built, 2026-11-06 (PR 13):** (a), at `/status/`, with one change: not a query per view but a snapshot that the 15-minute cron refreshes, so the cost is 192 queries a day whatever the traffic ([cost.md](cost.md)). The page shows six 24-hour counters (sandboxes, orders, payments, payment failures, refunds, dead-lettered messages), the last wipe's time, sandboxes, objects and milliseconds, and today's sandboxes against the cap of 300. Events relayed are not counted. Three states, each said in words: live (refreshed within 20 minutes), stale (the last refresh failed; old numbers with their time) and unavailable (no snapshot yet), and a fourth in the browser when the API is unreachable, which shows its last answer with the time | Two-way | PR 13 · built 2026-11-06 |
| Q43 · Q-email-signin | Sign in with an email address? | (a) Later, as magic links under a transient-address rule: the address is used once to send the link through Cloudflare's Email Service and never stored, logged or counted; the account id is an HMAC of the normalized address, so a returning visitor types it again; behind Turnstile and a per-IP-hash limit. (b) Never. (c) Now, in PR 3 | (a). Joseph asked for it on 2026-11-04 with the condition that an address can never leak; the rule keeps the system address-free, the sends stay inside the 3,000 a month included on Paid, and Cloudflare's own delivery logs are the residual risk the privacy page names ([security.md](security.md)) | Two-way; the privacy page's wording is one-way | Explicitly later · no date |
| Q39 · Q-template | Port the structure of Joseph's Go backend template? | (a) Skip it for now, as Joseph asked on 2026-11-04; the Rust layout in [delivery.md](delivery.md) stands on its own. (b) Port it once the repository is reachable from a session | (a) for now. The template's organization and name stay out of this repository either way | Two-way | Nothing · no date |

## Decided

Answers move here with the date, the option, what ships, the door and the evidence that would show the answer wrong. Detail the firewall touches stays in the private record. Joseph answered the eighteen blocking questions in chat on 2026-11-04; where he did not pick a letter, he took the recommendation, as the row says.

| Question | Answer | What ships | Door | Wrong if |
|---|---|---|---|---|
| Q2 · Q-name | Proof of Concept Bakery, named by Claude at Joseph's request on 2026-11-04 (his brief: almost techy, believable, clearly fictitious). A web search that day found no bakery of that name; a "Proof Bakery" exists in Los Angeles and another in Coventry, which is why the full phrase is used. The business-registry and trademark check runs before anything publishes | The name on every page, the consent screens and the Stripe sandbox, from PR 3 | Two-way until published; one-way after | A business of that name turns up in the registry or trademark search, or a reader takes it for a real bakery |
| Q3 · Q-city | Salt Lake City, Joseph's choice of 2026-11-04. The Route Lab stays Seattle; the bakery builds its own map, places and travel times with the site's pipeline on Geofabrik's Utah extract (PR 9, spike S7). The firewall's rule about Joseph's own city is his to apply, and nothing here says where he lives | PR 3's seed addresses, as map labels only; PR 9's dispatch data | Two-way for the data | The data build takes more than two focused days, or the mosaic rule bites |
| Q4 · Q-personas | (a) Both, switchable with one control: "that is correct" | PR 3 | Two-way | Visitors lose track of which persona they are |
| Q8 · Q-api-host | (a) `api.bakery.ihaveasegway.com` | PR 2's config on `wrangler dev`; PR 11's custom domain | Two-way; the hostname hardens once Stripe and Google hold it | Preflight latency shows on the page |
| Q12 · Q-clock | (a) The clock, and beside it simulated traffic (Q40), a guided tour (Q41) and API access (Q42): Joseph's point that a visitor wants to be shown around, told what they are seeing, and taught to do it themselves in the screens or through the API | PR 6 the clock; PR 4 the traffic; PR 10 the tour and the API | Two-way | Visitors advance the clock and cannot tell what moved |
| Q23 · Q-auth | Google with the `openid` scope only, GitHub with its numeric id only, and demo accounts; email sign-in later as magic links under a transient-address rule (Q43), so no address is ever stored and none can leak | PR 3; email later | Two-way; the promise is one-way | An address or a provider id is found in any store or log |
| Q24 · Q-guest | (a) Guests, behind Turnstile, with the scope Q45 recommends | PR 3 | Two-way | Bots create sandboxes past the guest cap |
| Q25 · Q-ttl | (a) Every sandbox wiped every night at 10:00 UTC, with the 36 h backstop | PR 3 | Two-way for the lifetime; one-way for the promise | A wipe misses something two nights running |
| Q26 · Q-seed | (a) 90 days of synthetic history per sandbox | PR 3 | Two-way | Seed rows pass 4,000 a sandbox |
| Q27 · Q-plan | (a) Workers Paid, the site included, since the plan is per account: "yes on workers for site" | PR 11, launch day; the site's superseding ADR in its own repository | Two-way while only SQLite-backed objects exist | A month's usage passes the fee without traffic to explain it |
| Q28 · Q-budget | $100 a month is the account's ceiling: budget alerts at $10, $25, $50 and $100; the breaker's thresholds derive from it. The designed worst case stays $5.29 ([cost.md](cost.md)) | PR 11 | Two-way | Any alert fires |
| Q29 · Q-account | (a) The site's account and zone | PR 11 | Two-way | A second zone is ever needed |
| Q30 · Q-previews | (a), deferred to launch under Q44 | PR 11 | Two-way | A bug a preview would have caught reaches launch |
| Q34 · Q-firewall | (a) The site's content firewall, copied, with the private rules as this repository's secret | PR 2 | Two-way | A finding reaches a public commit |
| Q35 · Q-license | (a) MIT. Joseph asked for whatever removes his liability and gives the code away; MIT disclaims warranty and liability and permits any use with attribution | `LICENSE`, in PR 1 | Loosening is two-way; tightening cannot recall copies | A reuse request MIT does not cover |
| Q36 · Q-process | (a) The site's rules, with the speed-first posture of Q44 | Every pull request | Two-way | A pull request sits blocked a week |
| Q37 · Q-order-of-work | (a), renumbered on 2026-11-04 so that nothing deploys before a launch pull request: the plan, a local-first foundation, accounts and the wipe, menu and orders and traffic, payments, scheduling and the clock, catering, CRM, dispatch, the tour and the API, launch, the lab links, the status page ([roadmap.md](roadmap.md)) | Every pull request | Two-way at every boundary | A pull request waits on a later one's code |
| Q38 · Q-time | As soon as possible, with no hour limit: "build the right thing one step at a time and work quickly" | The calendar has no date; the roadmap's estimates stand until the outside view corrects them | Two-way | A pull request runs past 150% of its estimate |
| Q44 · Q-posture | Speed first until launch, Joseph's direction of 2026-11-04: no time on tests and previews while nobody uses the bakery. CI runs `verify`, `firewall` and `firewall-selftest`; the domain's native tests stay because they cost nothing; previews, `e2e`, Lighthouse and the deploy jobs arrive in the launch pull request; Joseph reads each pull request on `wrangler dev`. Sign-in gates the things bots would abuse (Q45) | PR 2 onward ([roadmap.md](roadmap.md), [delivery.md](delivery.md)) | Two-way | A regression that a preview or an e2e test would have caught costs more than a day |
| Q39 · Q-template | (a) Skip it for now: Joseph's message of 2026-11-04 | Nothing; the layout in [delivery.md](delivery.md) | Two-way | The template holds a convention the Rust layout lacks, found when building |

## Non-goals (v1)

- **Real commerce.** No live payments, no real customers, no real deliveries. The Stripe sandbox moves no money, and the Worker refuses a live key.
- **Email to visitors.** The system stores no addresses (Q22). The one exception is a sign-in link sent to an address the system uses once and never stores (Q43, later).
- **Persistence.** A sandbox lives until the next 10:00 UTC (Q25). Nothing a visitor does is kept.
- **Multi-location, multi-currency, internationalization.** One made-up bakery, USD, English, ISO dates in the docs and US English dates on the screens.
- **Native apps.** The storefront and the console are web pages.
- **A workflow engine.** Workflows is JavaScript and TypeScript only, so sagas run on alarms and the Queue ([ADR 0004](adr/0004-queues-between-objects-and-alarms-for-time.md)).
- **Containers.** Paid-only, with cold starts; nothing here needs a native process ([the site's cost.md](https://github.com/IHaveASegway/website/blob/main/docs/cost.md), scenario E).
- **Employer vocabulary.** No data shape, named tool or number carried over from employer work; neutral nouns only, cleared as a set against the résumé before the first screen ships, as the lab's rules require.
- **A port of the Go template** (Q39), for now.

## How we will know it works

- **A stranger places an order in two minutes.** Five people who have not seen the bakery, on a phone, from the storefront's Home: at least four reach a paid order with the test card without help. Measured on the preview before PR 5 merges.
- **A reader finds the principle.** Shown an order landing on the kitchen board, five engineers name the pattern (the outbox or the queue) within a minute, using the drawer. Measured before PR 10 merges.
- **The bill is $5.00.** Every month until a milestone's traffic says otherwise, the account's bill is the plan fee and nothing else; a budget alert that fires is an incident ([cost.md](cost.md)).
- **The wipe is kept.** Every morning's object check finds no sandbox object holding data from the day before; a find opens an issue and is an incident ([operations.md](operations.md)).
- **No personal datum, ever.** No store, log, metric or Stripe object holds a name, an email, a phone number, a card number or an address that is not synthetic. Checked by the pattern tests on every write and read again by a person at every pull request that touches a schema.
- **It is manageable alone.** The bakery's maintenance is estimated at about 1 h 45 min a month on top of the site's 1 h 57 min ([operations.md](operations.md)'s calendar), which breaks the site's 2-hour target by about 1 h 42 min. Three months of a time log decide whether the target moves to about 3 hours or a duty is dropped (Q38 · Q-time); scope is cut before automation is added.
- **The two link.** Within a month of PR 10, each lab page's "Running in the bakery" link records visits on the bakery's side, and the bakery's drawers send readers back.
- **The firewall holds.** Zero findings reach a public commit. A finding caught by the hooks is the system working; one that gets past them is an incident.

## Glossary

[domain.md](domain.md) owns the bakery's language. These are the words the docs use about the project itself.

- **Sandbox:** one visitor's private copy of the bakery, seeded at creation and wiped every night.
- **Account:** what a sign-in produces: an opaque id derived from Google's `sub` by HMAC, or a demo username. It holds no personal data.
- **Business time:** the sandbox's clock, which a visitor can advance. **Wall time** is the platform's.
- **Aggregate:** one thing with its own rules and its own object: an order, a customer, a day's schedule.
- **Projection:** a read model built from events, rebuildable from the logs: the CRM's customer list, a timeline.
- **The outbox:** the table each aggregate writes beside its events, in the same transaction, and relays to the Queue.
- **The wipe:** the nightly deletion of every sandbox, and the morning check that proves it.
- **Simulated traffic:** synthetic customers a sandbox's `Simulator` object plays while the visitor watches, at a rate they choose.
- **The tour:** the walkthrough on every screen that says what the visitor sees and how to do it themselves, in the screen or through the API.
- **Launch:** the pull request that deploys both Workers for the first time, moves the account to Workers Paid and turns the guardrails on.
- **Launch day:** the day the account moves to Workers Paid and the site's guardrails are applied, in PR 11.
- **The site:** ihaveasegway.com and its repository, whose docs these are modelled on.

## Patterns and further reading

- Design docs with goals, non-goals and alternatives: Malte Ubl, ["Design Docs at Google"](https://www.industrialempathy.com/posts/design-docs-at-google/) (2020).
- One-way and two-way doors: Jeff Bezos, [2015 letter to Amazon shareholders](https://s2.q4cdn.com/299287126/files/doc_financials/annual/2015-Letter-to-Shareholders.PDF).
- The last responsible moment: Mary and Tom Poppendieck, *Lean Software Development* (2003).
- The mosaic effect: [OMB M-13-13](https://obamawhitehouse.archives.gov/sites/default/files/omb/memoranda/2013/m-13-13.pdf) (2013).
- Privacy by design: Ann Cavoukian, ["Privacy by Design: The 7 Foundational Principles"](https://www.ipc.on.ca/wp-content/uploads/resources/7foundationalprinciples.pdf) (2009).
- Every pattern named across these docs: each doc's own "Patterns and further reading", and the site's [reading-list.md](https://github.com/IHaveASegway/website/blob/main/docs/reading-list.md).
