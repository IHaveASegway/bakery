# ADR 0011: GitHub Actions owns build, gates and deploys, for both Workers

Status: Accepted · 2026-11-09, by delegation; as amended by the postscript below · Proposed 2026-11-04 · Deciders: Joseph Peterson

## Context

The made-up bakery, Proof of Concept Bakery, ships two Workers from one repository: `bakery-web`, an assets-only Worker for the storefront ([ADR 0008](0008-astro-site-with-react-islands-on-an-assets-only-worker.md)), and `bakery-api`, a Rust Worker that holds every Durable Object (DO) class, the Queue consumer and the cron handler ([ADR 0002](0002-rust-for-every-backend.md), [ADR 0009](0009-the-api-on-its-own-hostname.md)).

The site settled who deploys: GitHub Actions owns build, gates, previews and deploys; Workers Builds stays disconnected; the gate is the job graph, so the firewall passes before anything is published, previews included; one scoped, account-owned token with four permissions (Account: Workers Scripts Edit and Account Settings Read; Zone: Workers Routes Edit and Zone Read) and a 12-month expiry; rollbacks through the pipeline; never two writers ([the site's ADR 0006](https://github.com/IHaveASegway/website/blob/main/docs/adr/0006-github-actions-owns-deploys.md)). Its pipeline is `verify`, `firewall`, `firewall-selftest`, `preview`, `e2e` and `lighthouse`, `deploy` (upload, smoke the Version URL, promote), `prod-smoke`, `prod-verdict`, `rollback`, `preview-cleanup`, `pr-text` and scheduled jobs, under eleven hardening rules: `permissions: {}` at the top, secrets only in the steps that use them, untrusted text through `env:`, only GitHub-created actions plus `pnpm/action-setup` in jobs that hold a secret, no `pull_request_target`, `persist-credentials: false`, a deploy group that never cancels, timeouts on every job, no shared cache next to the token ([the site's delivery.md](https://github.com/IHaveASegway/website/blob/main/docs/delivery.md)). Whether that token could attach a custom domain was the site's spike S7, run as its first deploy.

What differs here, as of 2026-11-04:

- **A Rust toolchain.** Rust stable 1.97 from `rust-toolchain.toml`, the `wasm32-unknown-unknown` target, and `worker-build` ([stack.md](../stack.md)). The storefront's build also reads the seed and the contract types the Rust crates produce.
- **A Worker with DOs.** Version URLs are not generated for it, so there is no smoke on the edge before traffic ([Version URLs](https://developers.cloudflare.com/workers/configuration/previews/)). `wrangler deploy` restarts every object and drops every WebSocket ([DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)). Rollback is blocked across a DO class lifecycle change, and when the target binds a queue that no longer exists ([rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)).
- **Previews of a Worker with DOs** need a `previews` block with its DO bindings, and each preview's namespaces count toward the account's class limit while it exists: the site's spikes S5 and S6, 2026-10-23. The limit is 500 classes on Paid ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). With 14 bakery classes and the site's lab classes beside them, about 34 API previews could exist at once. Whether a preview's Queue binding is its own or production's is not documented; spike S4 checks it.
- **Queues and cron triggers** are attached by `wrangler deploy`; the queues `bakery-events` and `bakery-events-dlq` are created once, by hand, in [operations.md](../operations.md)'s setup.
- **Stripe webhooks keep arriving** during a deploy. Stripe retries a delivery that fails, and the `Billing` object deduplicates by event id ([ADR 0007](0007-stripe-sandbox-and-a-payment-element-that-collects-nothing.md)).
- **GitHub Actions is free for standard runners on a public repository** ([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)). This repository is public from its first push.

## Decision

1. **One workflow, `ci.yml`, with the site's job graph** and its eleven hardening rules, copied. Workers Builds stays disconnected for both Workers. The graph grows in two steps, item 12: before the launch pull request (PR 11) it is three jobs, and items 4 to 6, 8 and 10 to 11 below describe what arrives with PR 11.
2. **`verify` builds everything once, with no secrets**: `cargo fmt --check`; `cargo clippy --all-targets -- -D warnings`; `cargo test` natively for `crates/domain`, `crates/app`, `crates/seed` and `crates/contracts`; `cargo deny check` for licences and advisories; the wasm build through `worker-build`; `wrangler deploy --dry-run --outdir` for `bakery-api`, so the bytes that ship are on disk; then the Astro build and its Vitest tests. It uploads both outputs as one artifact. Rust comes from the runner's `rustup` and `rust-toolchain.toml`; the cargo registry and `target/` are cached with `actions/cache`, in `verify` only.
3. **`firewall` scans everything** in that artifact, the API's JavaScript shim and WebAssembly included, with the site's scanner copied and its private rules as this repository's secret (Q34 · Q-firewall). `firewall-selftest` runs beside `verify`, as on the site.
4. **From PR 11, previews for `bakery-web` only**, on workers.dev with `noindex`, pointing at the production API, until spike S4 settles API previews (Q30 · Q-previews). When S4 passes, an API preview gets its own `previews` block, its own queue, and a checked `preview-cleanup`.
5. **From PR 11, `deploy`, on a push to `main`, API first.** `bakery-api` deploys with `wrangler deploy --no-bundle` from the scanned output, then `prod-smoke` runs against `api.bakery.ihaveasegway.com`. Then `bakery-web` deploys through the site's upload, smoke the Version URL, promote. API changes are backward-compatible with the storefront that is live, so the order never leaves a page calling an endpoint that does not exist yet. Confirm the exact Wrangler flags for a Rust bundle when building.
6. **From PR 11, `prod-smoke` through both hostnames**, and `prod-verdict` opens an issue with the exact rollback command if it fails.
7. **Rollback per Worker**, as a `workflow_dispatch` job with a version id. For `bakery-api` it is refused across a DO class lifecycle change, so a broken API version after such a change is fixed forward.
8. **This repository's own deploy token**, account-owned, never the site's: the site's four permissions plus what Queues and the second Custom Domain need. The launch pull request's first deploy is the test, as the site's spike S7 was, and the narrowest permission that fixes a failure is added and recorded in [operations.md](../operations.md).
9. **A DO class lifecycle change ships alone**, at 100%, in its own pull request, with the affected screens flagged `off` until healthy: expand, migrate, contract.
10. **The API deploys only when `workers/api/` or `crates/` changed** since the commit the live API runs, read from the live deployment's message. A storefront-only merge never drops a socket.
11. **From PR 11, scheduled jobs**, each with a read-only credential: the morning object check after the nightly wipe, which lists each namespace's objects and opens an issue if a sandbox object still holds data ([ADR 0005](0005-a-private-sandbox-per-visitor-wiped-nightly.md)); and a weekly reconciliation of the `Billing` ledgers against the Stripe sandbox.

12. **Speed first until launch.** Until the launch pull request (PR 11) the workflow runs `verify`, `firewall` and `firewall-selftest` only. There are no previews, no `e2e`, no Lighthouse, no deploy jobs and no scheduled jobs; they arrive in PR 11 (previews, a small `e2e` suite, `deploy`, `prod-smoke`, the morning object check), and Lighthouse follows once previews exist. The reason is Joseph's direction of 2026-11-04: nobody uses the bakery yet, so no time goes to tests and previews until there is something to show. Joseph reads each pull request on `wrangler dev`. The firewall stays on from the first pull request, because the repository is public from its first push.

The pipeline in full, its timeouts and its permissions per job are in [delivery.md](../delivery.md).

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **A. Actions owns both Workers (chosen)** | Security: the firewall passes before a preview exists. Consistency: one writer per Worker, build once. Operability: the site's pipeline, already debugged | Operability: two toolchains in one workflow. Security: a long-lived Cloudflare token in GitHub, bounded by scope and expiry | Chosen |
| B. Workers Builds for both | No Cloudflare secret in GitHub; managed caching and check runs | Security: its docs describe no way to make a preview wait for GitHub checks, so a public preview can exist before the firewall passes. Operability: Rust build settings in a dashboard, a second place to read | Rejected for now |
| C. Manual `wrangler deploy` from a laptop | Nothing to build | Security: an edit credential at rest on a laptop. Testability and consistency: no gate, no record, bytes no firewall scanned | Rejected |
| D. A separate workflow per Worker | Simpler files; independent runs | Consistency: two deploy groups can race, so the storefront can promote before the API it needs; two copies of the hardening rules to keep equal | Rejected |
| F. The full pipeline from PR 2 | Testability: previews and `e2e` exercise every pull request, and the deploy path is rehearsed early | Cost and speed: the account would be on Paid from PR 2, and time goes to previews and tests for software nobody uses | Rejected for now (Joseph, 2026-11-04) |
| E. Deploy the API from the web Worker's deploy step | One job | Availability: every storefront change would redeploy the API and drop every kitchen socket. Operability: a failure in one Worker blocks the other | Rejected |

## Consequences

Good:

- Build once holds for both Workers: the bytes the firewall scanned are the bytes that ship.
- The site's job graph, rules and runbooks carry over, so a reader of one pipeline can read the other.
- Actions minutes cost nothing while the repository is public.

Bad:

- Two toolchains in CI. A cold Rust build is the slowest step of `verify`; the cache keeps it to a warm build on most runs.
- Every API deploy restarts every object and drops every live kitchen socket. Clients reconnect with backoff and take a fresh snapshot (Q15 · Q-live-board), and Stripe's retries cover a webhook that lands mid-deploy.
- Until PR 11 no change is tested in a browser by CI or previewed on the edge: a regression that only `e2e` or a preview would catch reaches `main`, and Joseph's read on `wrangler dev` is the net. The first run of `deploy` is launch day, which the Launch gate and spike S1 exist to make safe.
- The API gets no edge smoke before traffic. Native tests, `wrangler dev` tests and `prod-smoke` carry that load until previews exist.
- The morning object check and the weekly reconciliation are scheduled jobs someone reads; an unread issue is a missed wipe.
- A token in GitHub that can deploy two Workers on the site's account. Its blast radius includes the site, so its scope stays as narrow as PR 2 proves it can be.

## Door

Two-way. Moving either Worker to Workers Builds is a dashboard connection and a pull request that deletes the jobs that write to it; versions stay in Cloudflare's history; revoking the token cuts GitHub off in seconds. The rule that matters, one writer per Worker, holds through any such move.

## Revisit if

- An API deploy drops sessions on a day that matters more than once.
- `verify` passes 10 minutes on a warm cache, across a week of runs.
- Workers Builds can make a preview wait for GitHub checks, the repository's ruleset requires those checks, and keeping a deploy token in GitHub has become the larger risk.
- Spike S4 shows API previews cannot isolate their queue, which keeps the API without previews for good.
- Two regressions reach `main` before PR 11 that `e2e` or a preview would have caught, or Joseph starts sharing the bakery with others before launch. Then the missing jobs move earlier.

## Postscript 2026-11-09

As built, 2026-11-09: stage 1's own check is health and CORS, and `prod-smoke` runs once after both stages (`.github/workflows/ci.yml`). Before either stage `deploy` refuses a storefront bundle with Turnstile's test site key, so every merge since #73 has stopped there until the repository variable is set ([delivery.md](../delivery.md#the-jobs-as-written)). No rollback of either Worker has been rehearsed, and no ruleset protects `main` (read through the GitHub API on 2026-11-09).

## Patterns and further reading

- Deployment pipeline and build once: *Continuous Delivery* (book, 2010), [continuousdelivery.com](https://continuousdelivery.com/).
- Expand and contract for schema changes: ["Parallel Change"](https://martinfowler.com/bliki/ParallelChange.html) (bliki, 2014).
