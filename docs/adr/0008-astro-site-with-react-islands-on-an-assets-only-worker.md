# ADR 0008: The storefront is an Astro site with React islands on an assets-only Worker at bakery.ihaveasegway.com

Status: Accepted · 2026-11-09, by delegation; as amended by the postscript below · Proposed 2026-11-04 · Deciders: Joseph Peterson

## Context

The made-up bakery, Proof of Concept Bakery, has two kinds of screen. The public pages (Home, Menu, Catering, About, How it's built, Privacy, Status, and the API docs at `/docs/api/`) need no sign-in, change only when the bakery deploys, and are what a shared link unfurls (Q6 · Q-public). The signed-in screens are an application: the cart and checkout, the staff console, the kitchen board on a WebSocket, the catering calendar, the CRM and dispatch, each with a guided tour (Q41 · Q-tour). They read and write a visitor's sandbox through the API ([ADR 0009](0009-the-api-on-its-own-hostname.md)), whose state lives in Durable Objects (DOs) ([ADR 0003](0003-durable-objects-as-the-system-of-record.md)). Joseph asked for React and Astro "if those are the right tools".

What the site already decided and measured:

- The site serves its pages from an assets-only Worker with no script, so a page view runs no code ([the site's ADR 0002](https://github.com/IHaveASegway/website/blob/main/docs/adr/0002-host-on-workers-static-assets.md)), and builds them with Astro, static-first, with no JavaScript by default ([the site's ADR 0003](https://github.com/IHaveASegway/website/blob/main/docs/adr/0003-astro-static-first.md)).
- A React 19 island costs about 69.5 KiB gzip on each page that has one, most of it the react-dom client; a framework does not change that cost, it decides which pages pay it ([the site's stack.md](https://github.com/IHaveASegway/website/blob/main/docs/stack.md)).
- The site's page policy is a header its build writes into `_headers`, hashing each page's inline code ([the site's ADR 0018](https://github.com/IHaveASegway/website/blob/main/docs/adr/0018-page-policy-as-a-header.md)); its design tokens are owned in one place and copied rather than imported ([the site's ADR 0010](https://github.com/IHaveASegway/website/blob/main/docs/adr/0010-quiet-console-design-tokens.md)).

Platform facts, as of 2026-11-04:

- Requests to static assets are free and unlimited and never invoke the Worker; a version may hold 100,000 files on Workers Paid, 25 MiB each ([static assets billing and limits](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)). The account moves to Paid ([ADR 0010](0010-workers-paid-with-the-sites-guardrails.md)).
- A Worker request on Paid costs $0.30 per million past the 10 million included each month ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
- Version URLs are not generated for a Worker that implements a DO, and deploying such a Worker restarts every object and drops every WebSocket ([Version URLs](https://developers.cloudflare.com/workers/configuration/previews/), [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).

Pins, as of 2026-11-04, with sources in [stack.md](../stack.md): Astro 7.4.2, React 19.3.1, `@astrojs/react` 7.x, Tailwind 4.3.3, Wrangler ^4.152.0, Node 26, pnpm 11.28.6.

## Decision

1. **Astro 7 with static output and no adapter** for every page under `apps/web/`. The public pages ship no JavaScript but the site's theme script and the Turnstile widget where a sandbox is created (Q24 · Q-guest).
2. **React 19 islands for the app screens under `/app/` and for the checkout**, loaded only on those pages. **The tour is one more island**: a client-side walkthrough on each app screen that says what the visitor is looking at, which events the last action produced, and how to do the same through the API with a copyable request. It uses no library and no third party, so it adds no script origin; the "How this works" drawer is one of its steps. Each screen is its own Astro page (`/app/orders/`, `/app/kitchen/`, `/app/catering/`, `/app/crm/`, `/app/dispatch/`), and a record's id travels in the query string, so every URL maps to a built file and no single-page fallback rule is needed. The islands render on the client and call the API with credentials.
3. **The public menu is built from the seed at build time.** A build step runs `crates/seed` natively and writes the default menu as JSON, which Astro renders into `/menu/`. A signed-in sandbox's own menu comes from the API with an `ETag` of its version ([architecture.md](../architecture.md)). The API types reach TypeScript through `crates/contracts` (serde and schemars to JSON Schema to generated types), so the islands and the Worker agree on one schema.
4. **The assets-only Worker `bakery-web`**: an `assets` directory and no `main`; `workers_dev: false`, `preview_urls: true`, `previews: {}`; `assets.not_found_handling: "404-page"` and `assets.html_handling: "auto-trailing-slash"`, both written out; the custom domain `bakery.ihaveasegway.com`. Workers Cache stays off, and CI fails if the key appears, as on the site.
5. **The page policy is a header the build writes**, as the site's ADR 0018 does. Every page names the API hostname in `connect-src`; the checkout adds Stripe's origins ([ADR 0007](0007-stripe-sandbox-and-a-payment-element-that-collects-nothing.md)); pages with the widget add Turnstile's; the dispatch screen adds the solver worker's rule ([ADR 0012](0012-delivery-dispatch.md)). [security.md](../security.md) owns the directives.
6. **Design tokens copied from the site's set** into `apps/web/src/styles/tokens.css`, with the site's contrast test copied beside them. The bakery owns its copy from then on.
7. **A Worker Preview per pull request on workers.dev**, like the site's, with `noindex` (Q30 · Q-previews). Previews arrive with the launch pull request (PR 11); until then Joseph reads each pull request on `wrangler dev`, because nobody uses the bakery yet ([ADR 0011](0011-github-actions-owns-deploys-for-both-workers.md)). The firewall passes before a preview exists.
8. **Byte budgets per page type**, gzip, held by a test in `verify`: a public page at most 5,000 B of JavaScript, the site's eager budget; an app screen at most 120,000 B of the bakery's own JavaScript, React included; the checkout the same, with Stripe.js measured and reported but not counted, because the bakery cannot shrink it; the dispatch screen's solver inside the site's Route Lab budgets (WebAssembly at most 360,000 B), loaded on first solve. The tour's code counts inside the app screen's budget.
9. **`/docs/api/` is a static page**, generated at build time from `crates/contracts` as an OpenAPI document (Q42 · Q-api-access, PR 10). It needs no island and no script beyond the theme script, and a change to a contract changes the page in the same pull request.

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **A. Static Astro, React islands, assets-only Worker (chosen)** | Cost: a page view is $0 at any volume. Latency: public pages are HTML from the edge. Evolvability: the site's pipeline shape and tests carry over | Latency: app screens render on the client, after the JavaScript and a first API call. Operability: a second Worker and a second deploy | Chosen |
| B. Server rendering with Astro's Cloudflare adapter | Per-request HTML for signed-in screens; one place to read a session | Cost: every page view is a Worker invocation, billed past 10 million a month. Availability: a page view now depends on running code. Consistency with [ADR 0002](0002-rust-for-every-backend.md): a JavaScript Worker would be a backend outside Rust. Needless for pages that change only per deploy | Rejected |
| C. A single-page app for everything | One React tree, one router, simplest client code | Cost and reach: the public pages lose their per-page HTML, so a shared link unfurls nothing specific, and every visitor pays React's 69.5 KiB to read the About page | Rejected |
| D. Serve the pages from the API Worker's assets | One Worker, one deploy, same origin for the API | Availability: the API holds DOs, so the pages lose Version URLs and their smoke test before promotion, and every page deploy restarts every object and drops every kitchen socket. Evolvability: a DO class change blocks rolling back a text fix | Rejected |
| E. Cloudflare Pages | The same static output on the same edge | Evolvability: Cloudflare ships new features on Workers first, and the site already left Pages for that reason (the site's ADR 0002) | Rejected |
| F. TanStack Start | A full-stack React framework with typed routing | Cost: every page pays React, text pages included (the site's stack.md). Operability: a server runtime to host, outside Rust | Rejected |

## Consequences

Good:

- The public pages cost $0 and keep working while the API is down, during an API deploy, and if the API's hostname is switched off ([ADR 0009](0009-the-api-on-its-own-hostname.md)).
- Two Workers, two deploys, and the site's pipeline shape reused: upload, smoke the Version URL, promote, for `bakery-web` ([ADR 0011](0011-github-actions-owns-deploys-for-both-workers.md)).
- React goes only where a screen needs state and interaction. A visitor who reads the menu and the How it's built page downloads none of it.
- Stripe's and Turnstile's scripts are the only third-party scripts, each on the pages that need it. The tour and the API docs add none.

Bad:

- The app screens are client-rendered and depend on the API for every view. A slow or failing API shows as a loading or error state on those screens; each screen has both, tested in e2e.
- 69.5 KiB of React on every app screen, cached across screens but paid on the first.
- The tour and `/docs/api/` are two more things to keep true as screens and contracts change; the OpenAPI page is generated, the tour's copy is not.
- Two builds in one repository: Astro reads the seed and the contract types the Rust crates produce, so a web build needs a Rust toolchain in CI ([ADR 0011](0011-github-actions-owns-deploys-for-both-workers.md)).
- Each Astro major release brings a migration, and the bakery inherits that upkeep beside the site's ([stack.md](../stack.md) owns the upgrade policy).
- A copied token set drifts from the site's unless someone copies again. The bakery accepts drift; its look may diverge on purpose.

## Door

Two-way. The output is files in `dist/`. Moving the app screens to server rendering, or the storefront to another host, is a build and deploy change measured in days, and no data lives in this Worker. The URLs of the public pages become near one-way once shared and linked from the site's lab pages (Q32 · Q-links); the app's URLs under `/app/` are not a public contract.

## Revisit if

- An app screen needs server-rendered HTML for a crawler or a link preview, for example a shared order status page.
- A page passes its JavaScript budget, and the cause is React or Astro rather than the bakery's own code.
- Astro's major-version cadence costs more than a day a quarter to keep up with, measured in the pull requests that do it.
- Client rendering shows in the numbers: a first app screen slower than 2.5 s to its largest paint on a mid-range phone in the Lighthouse job.

## Postscript 2026-11-09

As built, 2026-11-09: since the tour (PR 10), every screen with a tour step carries its island and the small script that turns Sign in into Console, including `/docs/api/`, which also has a copy script (`apps/web/src/layouts/Base.astro`, `apps/web/src/policy.ts`). Seventeen pages carry no script at all: About, How it's built, its fourteen essays and the 404. Byte budgets per page class are now checked by `apps/web/test/dist.test.ts` (2026-11-09): the 17 script-free pages must stay at 0 B, and every other page is held to a gzipped JavaScript budget set from its measured size plus a quarter, from 118,000 B for the pages that carry only the tour to 170,000 B for the console screens. Decision 8's own figures (5,000 B for a public page, 120,000 B for an app screen) are not met: the tour and React are on every island page, and the console measures 135,699 B. The status island's chunk and the API page's HTML keep their own budgets.

Decided on 2026-11-09 by the session, under Joseph's delegation of the same day; revisable: decision 8 is amended. Budgets are per page class, at each class's measured size plus 25%, as `apps/web/test/dist.test.ts` holds them, and a page with no script stays at 0 B. The 5,000 B and 120,000 B figures are retired, because every island page carries React and the guide (roadmap R61). The Stripe.js and solver rules of decision 8 are unchanged. PR 21 re-takes the measurements after the interface and the live guide land (roadmap PR 21).

As built on 2026-11-09, every page takes one of three shells, chosen from its path in `Base.astro`: prose for reading, shop for the storefront and app for the console, which keeps its pages static and adds no script of its own. The styles are a component layer, `components.css`, that every screen uses in place of its own buttons, over the semantic tokens in `tokens.css`; the change moved no JavaScript budget. Later that day the console became seven pages, one island each, so a page loads only its own workspace: the largest, the kitchen, measures 122,232 B, and the console's budget came down to 153,000 B.

As built on 2026-11-09, the live guide replaced the tour ([ADR 0014](0014-a-live-guide-in-place-of-the-tour.md)) and the budgets moved down to hold the first load only, measured with `apps/web/test/dist.test.ts`'s sum, gzipped. The first load is smaller than the tour's total, and with the guide on, the default, the page is larger, because the guide then loads a deferred layer of 22,603 B to 23,092 B, held by a budget of its own (29,000 B). Per class, first load / with the guide on / the tour's total: home and privacy 80,312 / 103,404 / 94,187 B; the API reference 80,565 / 103,657 / 94,440 B; status 83,086 / 106,178 / 96,960 B; the storefront 92,402 / 115,005 / 103,417 B; the checkout 108,672 / 131,275 / 119,472 B; the console 126,926 / 149,798 / 136,394 B. A visitor who turns the guide off loads only the first load on later pages.

Measured again on 2026-11-10, after the checkout's three steps, the order's page (#101) and the console's seven pages (#106) merged, and after the pages' own "How this works" paragraphs moved into the guide (the shop's and the checkout's first loads fell; the deferred layer, which now holds those words, grew): the deferred layer is 27,590 B to 28,357 B (budget 36,000 B). Per class, first load / with the guide on / the tour's total as last measured on main: home and privacy 81,822 / 110,179 / 94,187 B; the API reference 82,075 / 110,432 / 94,440 B; status 84,595 / 112,952 / 96,960 B; the storefront 93,680 / 121,490 / 103,417 B; the checkout 111,921 / 139,731 / 122,775 B; the console's largest page, the kitchen, 111,204 / 139,014 / 122,232 B. The order's page had no tour (97,911 B); it is 105,495 B first and 133,305 B with the guide on.

## Patterns and further reading

- Islands architecture: ["Islands Architecture"](https://jasonformat.com/islands-architecture/) (blog, 2020).
- Static-first delivery and its cost arithmetic: [the site's ADR 0002](https://github.com/IHaveASegway/website/blob/main/docs/adr/0002-host-on-workers-static-assets.md) and [the site's cost.md](https://github.com/IHaveASegway/website/blob/main/docs/cost.md).
