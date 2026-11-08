# bakery

Proof of Concept Bakery, the made-up bakery that [ihaveasegway.com's lab](https://ihaveasegway.com/lab/) simulates, built as a real business system: ordering, pickup and delivery scheduling, catering, billing through Stripe's sandbox, and a CRM with campaigns, every backend in Rust on Cloudflare Workers, its state in SQLite-backed Durable Objects (DOs), with a private sandbox for every visitor that is wiped every night, and every decision written down in public. It is a portfolio demo of architecture, modelled on [Joseph Peterson's site](https://github.com/IHaveASegway/website), and it is built in the open.

## What the demo shows

Each visitor gets a private sandbox, seeded with synthetic history (made-up customers, orders and catering events) and wiped every night. In it a visitor can:

- order from the menu, watch the kitchen board move over a live socket, and pay with one of Stripe's test cards (Stripe's sandbox, so no money moves);
- schedule pickups and deliveries against slots, read the bake list, and advance the business clock to tomorrow;
- take a catering event from inquiry to quote, deposit, delivery and paid balance;
- run a CRM with segments, campaigns and an inbox, whose projections can be rebuilt from the event log;
- plan deliveries in a dispatch screen, where VROOM runs in the browser beside the server's own proposal;
- be shown around by a guided tour on every screen, and make the same calls through the API with the sandbox's own bearer token (the API reference is at `/docs/api/`);
- read the status page (`/status/`), which shows live counters, and the How it's built page (`/how-its-built/`), which links each screen's principle to its decision record and to an essay on how the bakery does it for real.

## Status

As of 2026-11-06 ([roadmap.md](docs/roadmap.md#phases-and-pull-requests)), the plan has 17 pull requests and 16 are built and merged: PRs 1 to 16 (the plan, the foundation, accounts and the wipe, orders, payments, scheduling, catering, the CRM, dispatch, the tour and the API, the launch, the lab links and How it's built, the status page, and the essays for every principle). PR 17, the 15-minute cron breaker, is on its branch: the code, the fake and the smoke are written, and it has not run against Cloudflare ([roadmap.md](docs/roadmap.md#pr-17-the-cron-breaker)).

**Live since 2026-11-06:** the storefront at https://bakery.ihaveasegway.com and the API at https://api.bakery.ihaveasegway.com. Deploys happen on merge ([delivery.md](docs/delivery.md#before-launch)); the status page at `/status/` shows the counters and, from PR 17, the breaker's state. The questions Joseph has answered are in [docs/product.md](docs/product.md#decided).

- [docs/README.md](docs/README.md) is the index and gives a reading order.
- [docs/product.md](docs/product.md) covers why the bakery exists, who it is for, the milestones, and the open and decided questions.
- [docs/domain.md](docs/domain.md) covers the language, the aggregates, the event catalog and the state machines.
- [docs/architecture.md](docs/architecture.md) covers the shape, the DO topology, data ownership and failure modes.
- [docs/stack.md](docs/stack.md) lists every technology, its pin and what came second.
- [docs/security.md](docs/security.md) covers the threat model, sign-in, privacy and the nightly wipe.
- [docs/cost.md](docs/cost.md) prices a sandbox and the guardrails that keep the bill bounded.
- [docs/delivery.md](docs/delivery.md) covers the repository layout, the pipeline, deploys and rollbacks.
- [docs/operations.md](docs/operations.md) covers access setup, observability and the runbooks.
- [docs/roadmap.md](docs/roadmap.md) lists what gets built, in which pull request, and when it counts as done.
- [docs/adr/](docs/adr/README.md) holds the architecture decision records.

## Setup

Both Workers run on `wrangler dev` on your machine for local work (the launch, PR 11, deployed them on 2026-11-06). The tool versions below are as of 2026-11-06 and have one source each, which CI reads too; when they move, they move there.

1. **Rust**, through `rust-toolchain.toml` (stable 1.97; rustup installs it on first use), then the WebAssembly target and the two cargo tools, each `--locked` and pinned to the exact version in `Cargo.toml`'s `[workspace.metadata.tools]`, because without both `cargo install` resolves today's dependencies, not the audited ones ([delivery.md](docs/delivery.md#hardening-rules), rule 12):
   ```sh
   rustup target add wasm32-unknown-unknown
   cargo install worker-build --locked --version 0.8.7   # compiles a worker crate into a Worker module (stack.md)
   cargo install cargo-deny --locked --version 0.20.2    # licenses, advisories, bans, sources
   ```
2. **Node 26**, from `.nvmrc` (`nvm use`), and **pnpm, pinned by `packageManager`** (11.28.6). Any pnpm switches itself to the pinned version in this repository; with none installed, `npx pnpm@<version>` does the same. Then `pnpm install`. The scripts and fakes under `scripts/` need Node 22 or later and have no dependencies.
3. **The hooks**, once per clone: `git config core.hooksPath .githooks`. `pnpm install` warns until they are on. The pre-commit hook runs the content firewall on staged changes and checks your commit identity; the pre-push hook refuses pushes to `main` and scans what you push.
4. **The private rules file** for the firewall, at the same path and with the same mode as the site's: `~/.config/ihaveasegway/firewall.toml`, mode 600, backed up in the password manager ([operations.md](docs/operations.md#9-local-hooks-and-the-private-firewall-file)). Without it both hooks refuse with exit 2. It is never committed, and its terms are never written anywhere else. A Claude Code cloud session has no such file and commits without the hooks, as [AGENTS.md](AGENTS.md) records.
5. **`.dev.vars`**, copied from `workers/api/.dev.vars.example` to `workers/api/.dev.vars` and filled with sandbox or test values. The example holds names, never values, and `.dev.vars` is git-ignored and never committed. The groups it names:
   - the session and account HMAC keys (`SESSION_HMAC_KEY`, its optional rotation partner `SESSION_HMAC_KEY_PREV`, and `ACCOUNT_HMAC_KEY`);
   - Stripe's sandbox: a restricted key, the webhook secret, and an optional API base and version;
   - the Google and GitHub OAuth clients (id and secret each) and Turnstile's secret (its documented test secret works locally);
   - the status page's analytics pair, `ANALYTICS_API_TOKEN` and `ANALYTICS_ACCOUNT_ID`, optional for local runs: without them the counters read `unavailable`;
   - the breaker's token and ids (`BREAKER_API_TOKEN`, `BREAKER_ZONE_ID`, `BREAKER_RULE_ID`), optional for local runs: without them the breaker logs `breaker_unconfigured` and the status page says "not configured";
   - local-only overrides, commented out in the example: the origins, a fixed `SANDBOX_SEED`, and the base URLs that point the Worker at the fakes below. The Worker honors the overrides only for loopback hosts.
6. Optional: `pnpm --filter web exec astro telemetry disable`. CI disables Astro's telemetry, and the Wrangler configs turn off Wrangler's.

## Commands

All of these run locally; nothing here touches Cloudflare. CI runs the Rust checks, the build, the tests and the firewall's self-test before launch ([delivery.md](docs/delivery.md#before-launch)). The smoke scripts start their own Worker and fakes, write a throwaway `.dev.vars` and refuse to run when one exists, so move yours aside first (each script's header says how to override). Check counts are from a run of each script on 2026-11-06 (UTC), one after the other, on `wrangler dev` 4.157.0, all passing.

| Command                                                                       | What it does                                                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test --workspace --locked`                                             | Unit and property tests for every crate, run natively                                                                                             |
| `cargo clippy --workspace --all-targets -- -D warnings`                       | Lints the whole workspace; a warning fails                                                                                                        |
| `cargo fmt --all --check`                                                     | Checks Rust formatting                                                                                                                            |
| `cargo deny check`                                                            | Licenses, advisories, bans and sources for every crate ([stack.md](docs/stack.md))                                                                |
| `cargo run -q --locked -p bakery-contracts --bin openapi -- --check`          | Checks that the OpenAPI document in `apps/web/public/docs/api/` is the one the route table and schemas generate                                   |
| `pnpm dev`                                                                    | Astro's dev server for the storefront at http://localhost:4321                                                                                    |
| `pnpm build`                                                                  | Builds the storefront into `apps/web/dist/` (it first fetches and verifies the dispatch solver, `scripts/fetch-solver.mjs`)                       |
| `pnpm test`                                                                   | The web app's unit tests (Vitest)                                                                                                                 |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                            | Astro's type check, ESLint, and Prettier's check                                                                                                  |
| `pnpm --filter web contracts`                                                 | Regenerates the TypeScript types from the contracts crate's JSON Schemas (`cargo test -p bakery-contracts` writes the schemas)                    |
| `pnpm --filter web serve`                                                     | Serves the built storefront as the assets-only Worker on `wrangler dev`, at http://127.0.0.1:8787; build first                                    |
| `cd workers/api && pnpm exec wrangler dev --local --ip 127.0.0.1 --port 8788` | Builds the Rust API Worker (Wrangler runs `worker-build --release`) and runs it locally with its Durable Objects, at http://127.0.0.1:8788        |
| `node scripts/fake-providers.mjs`                                             | Stands in for Google's OpenID Connect, GitHub's OAuth endpoints and Turnstile's siteverify, so sign-in works with no account; port 8790           |
| `node scripts/fake-stripe.mjs`                                                | Stands in for the parts of Stripe's API the payments and invoices use, and sends the webhooks back; port 8791                                     |
| `node scripts/fake-analytics.mjs`                                             | Stands in for the Analytics Engine SQL API, so the status page's counters refresh locally; port 8792                                              |
| `node scripts/fake-cloudflare.mjs`                                            | Stands in for Cloudflare's GraphQL Analytics API and Rulesets API, so the cron breaker runs locally; port 8793                                    |
| `scripts/smoke-api.sh`                                                        | Health, and CORS from the allowed origin and from another; 56 checks                                                                              |
| `scripts/smoke-auth.sh`                                                       | Google and GitHub sign-in, demo accounts, guest and account sandboxes, the caps, the nightly wipe and "Wipe now"; 180 checks                      |
| `scripts/smoke-orders.sh`                                                     | The menu and its cache, orders and their idempotency, the event relay and dead letters, the kitchen socket, simulated traffic; 229 checks         |
| `scripts/smoke-payments.sh`                                                   | Payments through the fake Stripe: webhooks, refunds, the expiry's cleanup, the key guard, the seeded ledger; 117 checks on 2026-11-08             |
| `scripts/smoke-schedule.sh`                                                   | Slots and the race for the last one, the cake rule, the capacity editor and the business clock; 133 checks                                        |
| `scripts/smoke-catering.sh`                                                   | The catering saga from inquiry to paid balance, the calendar, reminders and cancellations; 251 checks                                             |
| `scripts/smoke-crm.sh`                                                        | The CRM: segments, campaigns, the inbox, consent, the activity feed and the rebuild; 179 checks on 2026-11-08                                     |
| `scripts/smoke-dispatch.sh`                                                   | Dispatch: stops, the proposal, the browser's plan and its refusals, windows, publishing, completing; 165 checks on 2026-11-08                     |
| `scripts/smoke-token.sh`                                                      | The visitor's API token: issue, use, refusals, rotation and the rate limit; 107 checks                                                            |
| `scripts/smoke-status.sh`                                                     | The status page's counters against the fake analytics: live, stale and unavailable; 65 checks                                                     |
| `scripts/smoke-breaker.sh`                                                    | The cron breaker against the fake Cloudflare: armed, read-only, off and the WAF rule, held, unread meters; 114 checks on 2026-11-06               |
| `node scripts/list-objects.mjs <persist-dir>`                                 | Lists the Durable Objects a `wrangler dev --persist-to` run left and exits 1 if a sandbox's still holds data: the local half of the morning check |
| `node scripts/check-links.mjs`                                                | Fetches every external link in the built storefront and exits 1 for any that does not answer 2xx; `--list` prints them instead                    |
| `pnpm --filter web e2e`                                                       | The browser suite on both Workers and the fakes ([delivery.md](docs/delivery.md#the-e2e-suite)); build both artifacts first                       |
| `pnpm firewall:test`                                                          | The content firewall's self-test, with throwaway rules                                                                                            |

## Deploy and roll back

**Deploy:** merge the pull request (the launch, PR 11, was deployed on 2026-11-06). CI builds once, runs the gates, and, while the repository variable `LAUNCHED` is `true`, deploys the API Worker first and the storefront Worker second, so the page never calls an endpoint that does not exist yet, and then runs `prod-smoke` against both hostnames. The pipeline, its previews and its gates are in [delivery.md](docs/delivery.md#pipeline); the launch-day steps are in [operations.md](docs/operations.md#launch).

**Roll back:** per Worker, with the `rollback` job: `gh workflow run ci.yml --ref main -f worker=<web|api> -f rollback_to=<version-id> -f reason="<why>"`, to a version id the `prod-verdict` issue or the last deploy summary names. Rolling back the storefront changes only static files. Rolling back the API has one limit: a rollback cannot cross a Durable Object migration (a class added, renamed or deleted), so a release that carries one rolls forward. The steps are in [operations.md](docs/operations.md#rollback) and [delivery.md](docs/delivery.md#deploy-verify-roll-back). None of this has run against the account yet.

## Privacy

What a visitor should know: Proof of Concept is a sandbox. Every visitor gets a private copy of the made-up bakery, filled with synthetic customers and orders. It holds no personal data by construction: no email, no name, no real address. Sign-in with Google or GitHub learns only an opaque identifier, and the bakery never stores your name or email. Payments use Stripe's test cards and never move money. Everything in a sandbox is wiped every night at 10:00 UTC (03:00 Mountain standard time, 04:00 in summer), with a 36-hour backstop on every object. The full promise and its inventory are in [security.md](docs/security.md#privacy-and-data-inventory); the privacy page, `/privacy/` on the bakery's site, is built and goes live in the launch pull request.

## How it's built

Every decision that is costly to reverse is written down in public before it is built on, as an [architecture decision record](docs/adr/README.md) with the options that lost. The storefront's How it's built page, `/how-its-built/`, links each principle to its record and to the lab page that explains it, and carries essays on the principles the bakery runs for real (idempotency, sagas, leases, admission control, the outbox, the cache, rebuilds, routing and single-writer objects). The page and the essays are served once the storefront is deployed; their sources are in `apps/web/src/pages/how-its-built/`, and the plan that scheduled them is [docs/roadmap.md](docs/roadmap.md).

## License

The code and the docs are MIT-licensed: [LICENSE](LICENSE) is the MIT License's text. Joseph chose MIT in the plan's first pull request, and [product.md](docs/product.md#decided) records it as decided under Q35 (Q-license).
