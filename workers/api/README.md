# bakery-api

The Rust Worker behind `api.bakery.ihaveasegway.com`: the router, every Durable Object class, the
Queue consumer and the cron handler ([architecture.md](../../docs/architecture.md)). Until the
launch pull request (PR 11) it runs only on `wrangler dev`.

In PR 2 it answers:

| Route               | Does                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `GET /v1/health`    | 200 with `{status, commit, version}`; touches no object                                  |
| `GET /v1/status`    | 200 with today's `{day, sandboxes_today, sandbox_cap, flag}`, from one call to `Control` |
| `OPTIONS` on either | the CORS preflight, 204                                                                  |
| anything else       | 404 or 405, `application/problem+json`                                                   |

CORS allows exactly `ALLOWED_ORIGIN` with credentials; any other origin gets no CORS header
([security.md](../../docs/security.md#the-apis-cors)).

## Commands

From this directory, with the toolchain from `rust-toolchain.toml`:

```sh
cargo install worker-build --version 0.8.7 --locked   # once; the version is in the root Cargo.toml
worker-build --release                                # build/index_bg.wasm, build/index.js, build/worker/shim.mjs
npx --yes wrangler@4.152.0 dev --local --ip 127.0.0.1 --port 8788 --show-interactive-dev-session=false
```

`wrangler dev` runs the build command itself. Then:

```sh
curl -i http://127.0.0.1:8788/v1/health
curl -i -H 'Origin: https://bakery.ihaveasegway.com' http://127.0.0.1:8788/v1/status
curl "http://127.0.0.1:8788/cdn-cgi/local/scheduled?cron=0+10+*+*+*"   # run the 10:00 UTC cron once
../../scripts/smoke-api.sh                                              # every check above, scripted
```

From the repository root: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo test --workspace` and `cargo deny check`.

## Local state and secrets

`wrangler dev` keeps Durable Object state in `.wrangler/`, git-ignored; delete it to start over.
Secrets go in `.dev.vars`, also git-ignored; `.dev.vars.example` lists their names, never values.
`BUILD_COMMIT` is set by CI at deploy and reads `dev` when unset.

## Notes

- `compatibility_date` is 2026-11-04. The date a config may carry is bounded by the workerd inside the Wrangler the lockfile resolves: 4.152.0's refused it (its newest was 2026-10-26) and 4.157.0's accepts it (docs/delivery.md, compatibility_date).
- `Control` is declared SQLite-backed with the `exports` block, which Wrangler 4.152.0 accepts with
  a worker-build bundle.
- The cron handlers are placeholders: the 10:00 UTC one asks `Control` to prune its ledger, the
  15-minute one logs and returns.
