# bakery: product brief

Why the bakery demo exists, who it is for, what Joseph asked for on 2026-11-04, the principles it is built under, the content firewall it lives under, and the open decisions that block each pull request. The shape is in [architecture.md](architecture.md), the language and the events in [domain.md](domain.md), each hard-to-reverse decision in [adr/](adr/README.md), and the order of work in [roadmap.md](roadmap.md). This doc owns the goals, the questions and the answers; every other doc links here for them.

Status: Draft for review in PR 1 · 2026-11-04

Prices, limits and versions are as of 2026-11-04, with sources.

## In one line

The made-up bakery that ihaveasegway.com's lab simulates, built as a real business system: ordering, pickup and delivery scheduling, catering, billing through Stripe's sandbox, and a CRM with campaigns, every backend in Rust on Cloudflare Workers, its state in SQLite-backed Durable Objects (DOs), with a private sandbox for every visitor that is wiped every night, and every decision written down in public.

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

- A Rust Worker with 13 DO classes, an event log and a transactional outbox in each aggregate, Cloudflare Queues between them, and alarms for everything timed ([architecture.md](architecture.md)).
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
3. **No personal data, by construction.** The API never receives an email address or a name. Personas, venues, addresses and card details are synthetic. Two short free-text fields are pattern-checked on write and die with the sandbox. Every sandbox is wiped every night ([ADR 0005](adr/0005-a-private-sandbox-per-visitor-wiped-nightly.md), [security.md](security.md)).
4. **Static by default; code runs only where a visitor's input matters.** Public pages are prebuilt files on an assets-only Worker, so a page view costs nothing and never counts toward a cap. Code runs behind the API hostname, in its own Worker, so the demo cannot take the site down ([ADR 0008](adr/0008-astro-site-with-react-islands-on-an-assets-only-worker.md), [the site's ADR 0002](https://github.com/IHaveASegway/website/blob/main/docs/adr/0002-host-on-workers-static-assets.md)).
5. **Every number has a unit and a source.** Prices, limits and versions carry an "as of" date and a URL, in these docs and on the screens that show them. "Fast" is not a claim; "a SQL write in 0.4 ms of CPU, measured 2026-11-20" is.
6. **Fail closed, on cost and on content.** Admission control, daily budgets and a kill switch bound the bill on Workers Paid, where no cap exists; the firewall fails the build on a finding and when it cannot prove the tree clean ([cost.md](cost.md), [the site's ADR 0007](https://github.com/IHaveASegway/website/blob/main/docs/adr/0007-content-firewall.md)).
7. **The demo explains itself.** Every screen has a drawer that names the principle it runs, links the lab page that explains it and the ADR that decided it, and shows the events the last action produced. A visitor never has to guess what they are looking at (Q32, Q33).
8. **Two-way doors decided fast; one-way doors written down.** Layout, copy and limits change in a pull request. Hostnames once configured with Stripe and Google, DO class names, a promise on the privacy page and anything published get an ADR with a Door and a Revisit if ([ADR 0001](adr/0001-record-architecture-decisions.md)).
9. **One pipeline, one writer per environment.** GitHub Actions is the only thing that deploys either Worker ([ADR 0011](adr/0011-github-actions-owns-deploys-for-both-workers.md)).
10. **A sandbox is disposable; the promise is permanent.** Nothing a visitor does outlives the night. The sentence that says so on the privacy page is a one-way door, and the nightly object check proves it was kept ([security.md](security.md)).

## Content firewall

The site's policy applies unchanged ([the site's product.md](https://github.com/IHaveASegway/website/blob/main/docs/product.md#content-firewall)): nothing about Joseph's current employer or his private venture appears here, in the code, in fixtures, in commit metadata or in pull request text. This repository adds three rules of its own:

- **Public from the first push.** The site's repository went public after an audit; this one is public from its first commit. Content is published at `git push`, before CI runs, so the local hooks and the writer's read are the only prevention ([the site's ADR 0012](https://github.com/IHaveASegway/website/blob/main/docs/adr/0012-public-repository.md)). The same firewall scripts and the same secret-held rules are assumed for this repository until Q34 is answered.
- **Synthetic data only, everywhere.** Personas, venues, streets, menu items, campaign copy, test fixtures and the seed come from generators and word lists, never from a real person, business or address. Seattle is the made-up bakery's map city because the Route Lab's map is Seattle, cleared on 2026-11-03 ([the site's lab.md](https://github.com/IHaveASegway/website/blob/main/docs/lab.md#rules-for-every-demo)); nothing here says where Joseph lives.
- **Other repositories are not named.** Joseph mentioned a backend template of his own on 2026-11-04 and then asked that it be skipped for now (Q39). Its organization and name appear nowhere in this repository, and a port of its structure, if it comes, is described generically.

Every doc, commit message and pull request here is read against the site's firewall classes before it is pushed ([the site's content.md](https://github.com/IHaveASegway/website/blob/main/docs/content.md#firewall-classes-for-copy)). Answers that touch the firewall go in Joseph's private record, never in a review, comment or issue; this doc records only the option chosen.

## Milestones

| # | Milestone | Shows | Pull request |
|---|---|---|---|
| M0 | The plan | The questions answered, the ADRs argued | PR 1 (this) |
| M1 | Two hostnames answer | A Rust Worker with one DO on `api.bakery.ihaveasegway.com`; a placeholder Home on `bakery.ihaveasegway.com`; CI, the firewall, the deploy; the account on Workers Paid with its guardrails | PR 2 |
| M2 | A sandbox | Sign in with Google or a demo account, get a seeded bakery, watch it disappear at 10:00 UTC | PR 3 |
| M3 | An order on the board | The menu, a cart, an order, the kitchen board moving over a live socket, the outbox and the Queue visible in the drawer | PR 4 |
| M4 | A payment | A test card, a webhook, a paid order, a receipt in the inbox, a refund | PR 5 |
| M5 | A day planned | Slots, windows, the bake list, the clock advanced to tomorrow | PR 6 |
| M6 | A catering event | An inquiry to a paid balance, reminders fired by alarm | PR 7 |
| M7 | A campaign | Segments, a send to the inbox, opens and clicks, projections rebuilt from the log | PR 8 |
| M8 | A route | The server's plan beside VROOM's, published by the object | PR 9 |
| M9 | The two link | "Running in the bakery" on each lab page; "How this works" on each screen | PR 10, with pull requests in the site's repository |
| M10 | A status page | Live counters from the account's own metrics | PR 11 |

The order is [roadmap.md](roadmap.md)'s, and Q37 asks Joseph to confirm it.

## Open decisions

Recommendations that are not yet approved stay open. A blocking question stops its pull request. Eight questions block PR 2, the foundation; ten more block PR 3, the first pull request that stores anything; the rest are due before the pull request that needs them and proceed on the recommendation until Joseph answers. Anything the firewall touches defaults to the strictest option until he clears it in writing in the private record. "By" is the last point at which an answer costs no rework. The short names (Q-name and so on) are stable, and the other docs use them.

Joseph answers with the option letter, in the pull request review or in a message. An answer moves to [Decided](#decided) with the date, the option, what ships, its door and what would show it wrong. A one-way answer also gets an ADR.

### Blocking PR 2: the foundation

| # | Question | Options | Recommendation, and why | Door | Blocks · by |
|---|---|---|---|---|---|
| Q8 · Q-api-host | The API on `api.bakery.ihaveasegway.com`, as asked, or a same-origin route? | (a) `api.bakery.ihaveasegway.com`, a custom domain of the API Worker. (b) A route `bakery.ihaveasegway.com/api/*` in front of the assets Worker, the choice the site's lab made in [its ADR 0009](https://github.com/IHaveASegway/website/blob/main/docs/adr/0009-lab-worker-same-origin.md) | (a), as asked. A custom domain on a multi-level subdomain gets its certificate automatically, with no Advanced Certificate Manager subscription ([custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), as of 2026-11-04). It costs CORS on every API call and a second origin in the storefront's policy, and buys a hostname-level kill switch and a cleaner cookie. The session cookie is host-only on the API hostname and SameSite treats the two hosts as one site ([ADR 0009](adr/0009-the-api-on-its-own-hostname.md)) | Two-way for the topology; the hostname hardens once Stripe's webhook and Google's redirect URI carry it | PR 2's zone records and both Workers' config · before PR 2 |
| Q27 · Q-plan | Workers Paid or Free? | (a) Paid: $5 a month minimum per account, no caps, no spend cap, with the site's upgrade-day guardrails from day one. (b) Free: $0, with daily caps per account: 100,000 Worker requests, 100,000 DO rows written, 10,000 Queue operations, 10 ms of CPU per Worker invocation, no email sends | (a). On Free the bakery supports about 20 sandboxes a day before rows written run out, Stripe webhooks are dropped for the rest of the day when a cap trips, and an argon2 hash does not fit in 10 ms. The plan is per account, so this moves the site too, and fires the site's ADR 0008 revisit; a superseding ADR goes in the site's repository ([ADR 0010](adr/0010-workers-paid-with-the-sites-guardrails.md), [cost.md](cost.md); [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), as of 2026-11-04) | Two-way while only SQLite-backed objects exist | Everything in PR 2 · before PR 2's first deploy |
| Q28 · Q-budget | Does the $50 answer stand for the account? | (a) Yes: budget alerts at $10, $25 and $50, and the breaker's threshold set from the same figure. (b) A different figure for the account now that two things run on it | (a). The designed worst case stays under $1 of usage a month ([cost.md](cost.md)), so an alert at $10 already means a guardrail failed | Two-way | PR 2's upgrade-day checklist · before PR 2's first deploy |
| Q29 · Q-account | The site's Cloudflare account and zone? | (a) Yes: both Workers in the site's account, both hostnames in the `ihaveasegway.com` zone. (b) A second account | (a). A custom domain must be in a zone the account owns, and a second account cannot attach a hostname of this zone without Cloudflare for SaaS; the site's ADR 0009 rejected a second account for the same reason. The bulkhead between the site and the bakery is separate Workers and hostnames, and on Paid there are no shared caps, only the shared bill | Two-way | PR 2 · before PR 2 |
| Q30 · Q-previews | Previews per pull request? | (a) The web Worker gets a Worker Preview on the account's workers.dev subdomain like the site's, public and noindex; the API Worker gets none until spike S4 settles a `previews` block with its own DO namespaces and a cleanup job. (b) No previews | (a). The site's spikes S5 and S6 found that previews of a Worker with DOs need a `previews` block and count toward the class limit until deleted | Two-way | PR 2's pipeline · before PR 2 |
| Q34 · Q-firewall | Does this repository get the site's content firewall? | (a) Yes: the scripts copied, the private rules as this repository's secret, the identity allowlist, the hooks, the self-test. (b) An identity check and gitleaks' default rules only | (a). The site will link this repository, and its readiness checklist requires a clean scan over the tree and the history ([the site's content.md](https://github.com/IHaveASegway/website/blob/main/docs/content.md#repo-readiness-checklist)). (b) saves a day and leaves paraphrase and term matches to a person | Two-way | PR 2's CI, the hooks, `AGENTS.md` · before PR 2 |
| Q35 · Q-license | Which license? | (a) MIT for code and docs. (b) MIT for code, writing all rights reserved, as the site. (c) Apache-2.0 | (a). The repository exists to be read and reused; a reader who cannot reuse the docs gets less from it. A `LICENSE` file is in this pull request on that assumption | Loosening is two-way; tightening cannot recall copies | PR 1 · before merge |
| Q36 · Q-process | The site's working rules here too? | (a) Yes: one pull request in flight, relaxed for agent-built branches; an ADR for every decision over the threshold; open decisions due before the pull request they block; spikes before dependence; `TZ=UTC` commits as the noreply identity; cloud sessions commit without the hooks and say so. (b) Looser rules for a demo | (a). The rules are cheap and they are part of what the repository shows | Two-way | Every pull request · before PR 2 |

### Blocking PR 3: accounts, sandboxes and the wipe

| # | Question | Options | Recommendation, and why | Door | Blocks · by |
|---|---|---|---|---|---|
| Q2 · Q-name | What is the bakery called? The lab calls it "the made-up bakery" and names it nowhere | (a) Joseph supplies a made-up name. (b) Signal Box Bakery, after the site's own identity. (c) Ballast Bread, for a bakery on the water. (d) Low Tide Bakery | (a) if he has one; otherwise (b), which ties the bakery to the site's signal-box identity and is unlikely to collide with a real business. Whichever is chosen is checked against the Washington business registry and the USPTO trademark search before it is published, and it is a one-way door once it is on a consent screen, a Stripe sandbox and a hostname's pages | Two-way until published; one-way after | PR 3's consent screen and copy; PR 5's Stripe sandbox name · before PR 3 |
| Q3 · Q-city | Is the bakery in Seattle, on the Route Lab's map and places? | (a) Yes. (b) A synthetic grid with made-up place names. (c) Another city, with a new map extract | (a). The Route Lab's travel-time matrix, places and isochrones already exist, pinned byte for byte, and Joseph confirmed the map of Seattle for the lab on 2026-11-03. Nothing here says where Joseph lives; Seattle is the made-up bakery's city. One reading to confirm: the Route Lab's 64 places are real public parks and landmarks, so the bakery uses them only as map points for made-up addresses, by index and label, never as anyone's home or a street address ([ADR 0012](adr/0012-delivery-dispatch.md)). (b) costs the dispatch screen its map, and (c) costs a day of pipeline work | Two-way for the data; the mosaic rule applies to anything added beside it | PR 3's seed, PR 9's dispatch · before PR 3 |
| Q4 · Q-personas | Who does a visitor play? | (a) Both the customer, on the storefront, and the bakery's staff, in the console, switching with one control. (b) Staff only, with simulated customers. (c) Customers only | (a). The events are the story, and a visitor who places an order and then watches it land on the board sees both ends of one event | Two-way | PR 3's session model · before PR 3 |
| Q12 · Q-clock | Can a visitor move the bakery's clock? | (a) Yes: each sandbox has a business clock, wall time plus an offset the visitor can advance by hours or days; reminders, expiries and tomorrow's bake list follow it, and the platform's alarms are re-armed when it moves. (b) Wall time only | (a). Without it a visitor waits 15 minutes to see an order expire and a week to see a catering reminder. The clock is a port the domain reads, never `Date::now()` in an object, which is also what makes the domain testable ([domain.md](domain.md)) | Two-way | PR 3's clock port, PR 4's expiry, PR 6's time travel · before PR 3 |
| Q23 · Q-auth | How does a visitor sign in? | (a) Google OpenID Connect with the `openid` scope alone, so the API receives `sub` and never an email or a name, plus demo accounts: a generated username and a password the visitor sets, hashed, with no email anywhere. (b) (a) plus passkeys. (c) Google only | (a), which is what Joseph asked for, without the personal data a Google sign-in usually brings: `sub` is always present and `email` only when the `email` scope is requested ([Google](https://developers.google.com/identity/openid-connect/openid-connect), as of 2026-11-04). Passkeys come later. A demo account with a lost password is abandoned, since there is no email to reset it by ([ADR 0006](adr/0006-sign-in-that-learns-nothing.md)) | Two-way; the promise is one-way | PR 3 · before PR 3 |
| Q24 · Q-guest | Can a visitor try a sandbox without signing in? | (a) Yes: "Try it" creates a guest sandbox behind Turnstile, bound to a cookie, wiped with the rest at night; signing in keeps a sandbox across devices. (b) Sign-in required for any sandbox | (a). A recruiter will not sign in, and the storefront alone shows little. Sandbox creation is the abuse surface, so it sits behind Turnstile, the rate limit and the Control object's daily cap ([cost.md](cost.md)); the cost of a guest sandbox is the same as a signed-in one | Two-way | PR 3's admission path · before PR 3 |
| Q25 · Q-ttl | How long does a sandbox live? | (a) Until 10:00 UTC (02:00 Pacific standard time, 03:00 in summer) every night: a full wipe of every sandbox, with a 36-hour backstop alarm on every object. (b) 24 hours after the last activity, with hourly sweeps. (c) 7 days | (a). It is the simplest promise to state and to check: "everything you do here is deleted every night". (b) keeps a sandbox alive across days but makes the promise a formula; (c) holds data longer for no demo gain. Deleted rows stay recoverable for 30 days through point-in-time recovery, which the privacy page says ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), as of 2026-11-04) | Two-way for the lifetime; one-way for the promise | PR 3's wipe and the privacy page · before PR 3 |
| Q26 · Q-seed | What is a new sandbox born with? | (a) About 90 days of synthetic history: 24 menu items, 60 customers, orders with a weekly rhythm and a busy Saturday, 8 catering events across the lifecycle, 6 venues; deterministic from the sandbox's seed. (b) An empty bakery | (a). A CRM with no history has no segments to show and no projection to rebuild. The seed costs about 2,000 rows written per sandbox, priced in [cost.md](cost.md) | Two-way | PR 3's seed crate · before PR 3 |
| Q37 · Q-order-of-work | In what order? | (a) The plan, a spike, the foundation, then accounts and the wipe, then menu and orders and the kitchen board, then payments, then scheduling and the clock, then catering and billing, then CRM and campaigns, then dispatch, then the lab links, then the status page. (b) Storefront and payments first, the console after | (a). The wipe and the no-data rule come before anything a visitor can type; payments come once there is an order to pay for; the console screens follow the events that feed them. The cut order, if time runs short, is in [roadmap.md](roadmap.md) | Two-way at every pull request boundary | PR 3 onward · before PR 3 |
| Q38 · Q-time | How many hours a month, and is there a date? | A free answer: hours a month for this repository beside the site's own work, and any date that matters (a talk, an application, a launch post) | The plan assumes 20 hours a month and no date, which puts the last milestone about a year out ([roadmap.md](roadmap.md)); 40 hours halves it. A date moves Workers Paid's uptime guardrails earlier | Two-way | The calendar · before PR 3 |

### Due before later pull requests

These proceed on the recommendation until answered, in the order the pull requests need them.

| # | Question | Options | Recommendation, and why | Door | Blocks · by |
|---|---|---|---|---|---|
| Q1 · Q-goal | What should a visitor be able to say after ten minutes? | (a) "The principles the lab simulates run here for real, in Rust on Durable Objects, and I can read why each was built this way." (b) (a) and "I could run a bakery on this" | (a), with a storefront believable enough that (b) is plausible. Product polish competes with the next principle for the same hours, and the principles are the portfolio | Two-way | The storefront's scope · before PR 4 |
| Q5 · Q-menu | What is on the menu, and who can change it? | (a) About 24 items in 5 categories, with variants, allergens, lead times (a cake needs 48 hours), daily availability and seasonal items; staff edit prices and availability in their sandbox, and publishing bumps a version that invalidates the cached menu. (b) A fixed menu | (a). The menu is where the Cache Lab's principle runs: an edit, a publish, an invalidation, a cache miss, a hit | Two-way | PR 4 · before PR 4 |
| Q6 · Q-public | Which pages need no sign-in? | (a) Home, Menu, Catering (the inquiry needs a sandbox to submit), About the bakery, How it's built, Privacy, Status; a cart without sign-in until checkout. (b) (a) plus a read-only window onto a demo sandbox's kitchen board | (a). Every public page is a static asset, so it costs nothing and runs no code. (b) would put a page view on the meters | Two-way | PR 4 · before PR 4 |
| Q7 · Q-images | Photos of the food? | (a) None: items drawn in the site's technical-drawing style, with the site's tokens. (b) Generated photographs. (c) Stock photographs | (a). It matches the site, carries no license and no metadata, and a drawn croissant is clearly made up | Two-way | PR 4's menu page · before PR 4 |
| Q10 · Q-slots | How is pickup and delivery time chosen? | (a) Pickup slots of 15 minutes with a capacity each, and delivery windows of 2 hours per zone with a daily capacity; staff set capacities. (b) As soon as possible, no slots | (a). Slots make capacity a thing the kitchen board can show and the Schedule object can refuse, which is the reservation pattern | Two-way | PR 4's checkout, PR 6 · before PR 4 |
| Q13 · Q-order-flow | How much of an order's life is modelled? | (a) Cart, checkout with a slot and a note, payment, confirmed, in production, ready, picked up or delivered, closed; cancel and refund paths; an unpaid order expires after 15 minutes by alarm. (b) Placed, paid, done | (a). The states are where the events come from, and the expiry is the first alarm a visitor can watch fire | Two-way | PR 4 · before PR 4 |
| Q14 · Q-free-text | What may a visitor type? | (a) Two fields: an order note of up to 140 characters and a catering brief of up to 500, rejected on write when they match an email, phone, card-number or URL pattern, held only in the visitor's sandbox and gone with it. (b) None: every value is a choice from a list, as the site's lab does in its v1. (c) Unrestricted text | (a). A CRM with no notes reads as a mock-up; (c) is where personal data arrives. The two fields cannot hold a card number or an address that passes the checks, and the sandbox they live in is wiped every night. Joseph asked that it be impossible to store anyone's private data: (b) is the strict reading, and (a) is the believable one; this is his call | Two-way; the privacy page's wording is one-way once published | PR 4's order note, PR 7's catering brief, the privacy page · before PR 4 |
| Q15 · Q-live-board | A live kitchen board? | (a) Yes, over WebSockets on the Hibernation API, with a snapshot on join and the site's lab protocol shape. (b) Polling | (a). An idle socket costs nothing on the Hibernation API, and the board is where the Queue Lab's principle becomes visible | Two-way | PR 4 · before PR 4 |
| Q17 · Q-psp | Which payment provider? | (a) Stripe, in a sandbox. (b) Worldpay. (c) Both, behind one port | (a). Stripe's sandboxes are free, isolated, carry their own keys and webhooks, move no money and accept test cards ([sandboxes](https://docs.stripe.com/sandboxes), as of 2026-11-04). A second provider can implement the same `PaymentGateway` port later, which is how (c) would arrive ([ADR 0007](adr/0007-stripe-sandbox-and-a-payment-element-that-collects-nothing.md)) | Two-way behind the port | PR 5, and the Stripe sandbox's creation · before PR 5 |
| Q18 · Q-payment-ui | Which Stripe surface? | (a) The Payment Element embedded in the page, with `fields.billingDetails: 'never'` and the sandbox's synthetic billing details passed on confirm, so the visitor never types a name or an email into Stripe. (b) Stripe's hosted Checkout page | (a). (b) collects a name and an email into the Stripe sandbox, which breaks the no-personal-data rule ([Payment Element](https://docs.stripe.com/js/elements_object/create_payment_element), as of 2026-11-04) | Two-way | PR 5 · before PR 5 |
| Q19 · Q-billing-scope | What does billing cover? | (a) One-off payments, catering deposits, balance invoices through Stripe Invoicing, refunds full and partial, receipts to the sandbox inbox. (b) (a) plus a subscription, a weekly bread box, through Stripe Billing. (c) Payments only | (a) first; (b) as a later pull request. A subscription shows recurring billing and proration but adds a second lifecycle before the first is done | Two-way | PR 5, PR 7 · before PR 5 |
| Q20 · Q-stripe-account | Whose Stripe account? | (a) A general sandbox in Joseph's Stripe account, named for the bakery, with restricted keys as Worker secrets and a reset on a schedule; never a live key, and the Worker and CI refuse one. (b) An anonymous sandbox from the Stripe CLI | (a). An account's sandbox has a dashboard, webhooks and a lifetime Joseph controls. He creates it; the keys never enter the repository ([operations.md](operations.md)) | Two-way | PR 5 · before PR 5 |
| Q22 · Q-email | Does the bakery send email? | (a) Never to a visitor: the system holds no addresses, so every message lands in the sandbox's inbox screen. Real sends only to Joseph's own verified address, which Cloudflare's Email Service delivers free on any plan, for his own demonstrations. (b) Real email to visitors who opt in | (a). (b) needs an address to store, which the privacy rule forbids. Sends to a verified address are free and do not count toward the 3,000 a month on Paid ([Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/), as of 2026-11-04) | Two-way | PR 5's receipts, PR 8's inbox · before PR 5 |
| Q11 · Q-production | A bake list? | (a) A production plan per day, projected from confirmed orders and catering with the lead-time rules, on the kitchen board. (b) None | (a). It is the projection a visitor reads after advancing the clock, and the clearest reason the clock exists | Two-way | PR 6 · before PR 6 |
| Q16 · Q-catering | How much of catering is modelled? | (a) Inquiry with a date, a headcount, a package and a venue from a made-up list; a quote by staff; a 25% deposit; confirmed; production; delivered; a balance invoice; paid; closed; declined and cancelled paths; reminders by alarm; a calendar with 2 events a day and a 7-day lead time. (b) Inquiry and quote only | (a). Catering is the saga: steps days apart, each an alarm, each a chance to fail and retry | Two-way | PR 7 · before PR 7 |
| Q21 · Q-crm-scope | What does the CRM cover? | (a) Customers, a timeline per customer, segments, campaigns sent to the inbox with simulated opens and clicks, the catering lead pipeline, loyalty points, and a "rebuild projections" control that replays the event log. (b) Customers and timelines only | (a). The rebuild is where the Backfill Lab's principle runs, and campaigns are what makes the inbox worth having | Two-way | PR 8 · before PR 8 |
| Q9 · Q-dispatch | How are deliveries routed? | (a) VROOM in the browser for interactive planning, with the Route Lab's solver and data, and a Clarke–Wright savings heuristic in Rust in the Dispatch object for the server's proposed plan; the object validates and publishes, and the screen compares the two. (b) Rust only. (c) The browser only | (a). "Every backend is Rust" is kept, since the server's plan is Rust and the object decides; VROOM is the yardstick the heuristic is measured against, and a reader learns from the gap ([ADR 0012](adr/0012-delivery-dispatch.md)) | Two-way | PR 9 · before PR 9 |
| Q32 · Q-links | How do the lab and the bakery link? | (a) Both ways: each lab page gets a "Running in the bakery" section with one deep link into the screen where its principle runs, and each bakery screen has a "How this works" drawer that links the lab page and the ADR. (b) One "How it's built" page on the bakery only | (a). The links are the point of the exercise. The site's side is a pull request in the site's repository per lab page, after this repository passes the site's readiness checklist | Two-way for the drawers; the site's links are URLs, so one-way once shared | PR 10, and the site's pull requests · before PR 10 |
| Q33 · Q-principles | Which principles map where? | (a) Queue Lab → the outbox, the Queue, idempotent consumers and the dead-letter queue, on the kitchen board; Cache Lab → the menu cache and its invalidation by event; Backfill Lab → rebuilding the CRM's projections; Route Lab → dispatch; Raft Lab → an essay on why a single-writer object needs no consensus; new: idempotency keys, sagas by alarm, leases and TTLs, admission control, CQRS, a logical clock. (b) A shorter list | (a). The map is in [domain.md](domain.md); each row names the screen and the ADR | Two-way | PR 10 · before PR 10 |
| Q31 · Q-status | A public status page? | (a) Later: live counters from Analytics Engine (sandboxes today, orders, events relayed, the last wipe's time and count). (b) None | (a), after M9. It is the one page that puts a number on the meters in public, and it costs a query per view | Two-way | PR 11 · no date |
| Q39 · Q-template | Port the structure of Joseph's Go backend template? | (a) Skip it for now, as Joseph asked on 2026-11-04; the Rust layout in [delivery.md](delivery.md) stands on its own. (b) Port it once the repository is reachable from a session | (a) for now. The template's organization and name stay out of this repository either way | Two-way | Nothing · no date |

## Decided

Answers move here with the date, the option, what ships, the door and the evidence that would show the answer wrong. Detail the firewall touches stays in the private record.

| Question | Answer | What ships | Door | Wrong if |
|---|---|---|---|---|
| Q39 · Q-template | (a) Skip it for now: Joseph's message of 2026-11-04 | Nothing; the layout in [delivery.md](delivery.md) | Two-way | The template holds a convention the Rust layout lacks, found when building |

## Non-goals (v1)

- **Real commerce.** No live payments, no real customers, no real deliveries. The Stripe sandbox moves no money, and the Worker refuses a live key.
- **Email to visitors.** The system holds no addresses (Q22).
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
- **Upgrade day:** the day the account moves to Workers Paid and the site's guardrails are applied.
- **The site:** ihaveasegway.com and its repository, whose docs these are modelled on.

## Patterns and further reading

- Design docs with goals, non-goals and alternatives: Malte Ubl, ["Design Docs at Google"](https://www.industrialempathy.com/posts/design-docs-at-google/) (2020).
- One-way and two-way doors: Jeff Bezos, [2015 letter to Amazon shareholders](https://s2.q4cdn.com/299287126/files/doc_financials/annual/2015-Letter-to-Shareholders.PDF).
- The last responsible moment: Mary and Tom Poppendieck, *Lean Software Development* (2003).
- The mosaic effect: [OMB M-13-13](https://obamawhitehouse.archives.gov/sites/default/files/omb/memoranda/2013/m-13-13.pdf) (2013).
- Privacy by design: Ann Cavoukian, ["Privacy by Design: The 7 Foundational Principles"](https://www.ipc.on.ca/wp-content/uploads/resources/7foundationalprinciples.pdf) (2009).
- Every pattern named across these docs: each doc's own "Patterns and further reading", and the site's [reading-list.md](https://github.com/IHaveASegway/website/blob/main/docs/reading-list.md).
