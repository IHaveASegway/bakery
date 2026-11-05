# bakery

Proof of Concept Bakery is a made-up bakery from the [Lab](https://ihaveasegway.com/lab/) on ihaveasegway.com, built as a running business system: online ordering, pickup and delivery scheduling, catering, billing through Stripe's sandbox, and a CRM with campaigns. Every backend is Rust on Cloudflare Workers, and state lives in SQLite-backed Durable Objects (DOs). Each visitor gets a private sandbox, seeded with synthetic history and wiped every night. It is a portfolio demo of architecture, modelled on [Joseph Peterson's site](https://github.com/IHaveASegway/website), and it is built in the open with its decisions written down.

**Status:** planning. PR 1 wrote the plan in `docs/` before any code, on 2026-11-04. Joseph answered the blocking questions the same day, and PR 2 is next, built local-first: nothing is deployed until the launch pull request (PR 11). The questions and their answers are in [docs/product.md](docs/product.md#open-decisions).

- [docs/README.md](docs/README.md) is the index and gives a reading order.
- [docs/product.md](docs/product.md) covers why the bakery exists, who it is for, and the open decisions.
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

Nothing is deployed until the launch pull request (PR 11), and until then both Workers, `bakery-web` and `bakery-api`, run on `wrangler dev` on your machine. The cargo tool versions below are the ones in `Cargo.toml`'s `[workspace.metadata.tools]`, which CI reads too; when they move, they move there.

1. **Rust**, through `rust-toolchain.toml` (rustup installs the pinned stable on first use), then the WebAssembly target and the two cargo tools, each `--locked` and pinned to the exact version, because without both `cargo install` resolves today's dependencies, not the audited ones ([delivery.md](docs/delivery.md#hardening-rules), rule 12):
   ```sh
   rustup target add wasm32-unknown-unknown
   cargo install worker-build --locked --version 0.8.7   # compiles a worker crate into a Worker module (stack.md)
   cargo install cargo-deny --locked --version 0.20.2    # licenses, advisories, bans, sources
   ```
2. **Node 26**, from `.nvmrc` (`nvm use`), and **pnpm, pinned by `packageManager`.** Any pnpm switches itself to the pinned version in this repository; with none installed, `npx pnpm@<version>` does the same. Then `pnpm install`.
3. **The hooks**, once per clone: `git config core.hooksPath .githooks`. `pnpm install` warns until they are on. The pre-commit hook runs the content firewall on staged changes and checks your commit identity; the pre-push hook refuses pushes to `main` and scans what you push.
4. **The private rules file** for the firewall, at the same path and with the same mode as the site's: `~/.config/ihaveasegway/firewall.toml`, mode 600, backed up in the password manager ([operations.md](docs/operations.md#9-local-hooks-and-the-private-firewall-file)). Without it both hooks refuse with exit 2. It is never committed, and its terms are never written anywhere else. A Claude Code cloud session has no such file and commits without the hooks, as [AGENTS.md](AGENTS.md) records.
5. **`.dev.vars`**, copied from `workers/api/.dev.vars.example` to `workers/api/.dev.vars` and filled with a Stripe sandbox key, a webhook secret and a cookie-signing secret. `.dev.vars` is git-ignored and never committed.
6. Optional: `pnpm --filter web exec astro telemetry disable`. CI disables Astro's telemetry, and the Wrangler configs turn off Wrangler's.

## Commands

All of these run locally; nothing here touches Cloudflare. CI runs the Rust checks, the build and the tests, and the firewall's self-test ([delivery.md](docs/delivery.md#before-launch)).

| Command                                                                            | What it does                                                                                                   |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `cargo test --workspace`                                                           | Unit and property tests for every crate, run natively                                                          |
| `cargo clippy --workspace --all-targets -- -D warnings`                            | Lints the whole workspace; a warning fails                                                                     |
| `cargo fmt --all --check`                                                          | Checks Rust formatting                                                                                         |
| `cargo deny check`                                                                 | Licenses, advisories, bans and sources for every crate ([stack.md](docs/stack.md))                             |
| `pnpm dev`                                                                         | Astro's dev server for the storefront at http://localhost:4321                                                 |
| `pnpm build`                                                                       | Builds the storefront into `apps/web/dist/`                                                                    |
| `pnpm test`                                                                        | The web app's unit tests (Vitest)                                                                              |
| `pnpm --filter web serve`                                                          | Serves the built storefront as the assets-only Worker on `wrangler dev`, at http://localhost:8787; build first |
| `cd workers/api && worker-build --release && npx wrangler dev --local --port 8788` | Builds the Rust API Worker and runs it locally with its Durable Objects, at http://localhost:8788              |
| `scripts/smoke-api.sh`                                                             | Smoke-tests the API running on `wrangler dev`: health, and CORS from the allowed origin and from another       |
| `pnpm firewall:test`                                                               | The content firewall's self-test, with throwaway rules                                                         |

## Deploy and roll back

**Deploy:** nothing is deployed until the launch pull request (PR 11). From then on, merge the pull request. CI builds once, runs the gates, and deploys the API Worker first and the storefront Worker second, so the page never calls an endpoint that does not exist yet. The pipeline, its previews and its gates are in [delivery.md](docs/delivery.md).

**Roll back:** per Worker, to a version the dashboard or the deploy summary names. Rolling back the storefront changes only static files. Rolling back the API has one limit: a rollback cannot cross a Durable Object migration (a class added, renamed or deleted), so a release that carries one rolls forward. The steps are in [delivery.md](docs/delivery.md) and [operations.md](docs/operations.md).

## Privacy

What a visitor should know: Proof of Concept is a sandbox. Every visitor gets a private copy of the made-up bakery, filled with synthetic customers and orders. It holds no personal data by construction: no email, no name, no real address. Sign-in with Google or GitHub learns only an opaque identifier, and the bakery never stores your name or email. Payments use Stripe's test cards and never move money. Everything in a sandbox is wiped every night at 10:00 UTC (03:00 Mountain standard time, 04:00 in summer). The full promise and its inventory are in [security.md](docs/security.md), and the privacy page, `/privacy/` on the bakery's site, will state it once it exists.

## License

The code and the docs are MIT-licensed ([LICENSE](LICENSE)), assumed until Q35 (Q-license) is answered.
