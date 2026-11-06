# bakery-contracts

The API's published language, written once in Rust and copied out by tools, never by hand
([architecture.md](../../docs/architecture.md), "The published language").

| What                                                                                                | Where                                   | Written by                                           |
| --------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| The wire types, with `serde` and `schemars`                                                         | `src/lib.rs`                            | people                                               |
| The route table: method, path, session rule, `Idempotency-Key`, request and response types, answers | `src/routes.rs` (`ROUTES`)              | people                                               |
| One JSON Schema per type (2020-12)                                                                  | `schemas/`                              | `cargo run -p bakery-contracts --bin export-schemas` |
| The web app's TypeScript                                                                            | `apps/web/src/contracts/`               | `pnpm --filter web contracts`                        |
| The OpenAPI 3.1 document, served at `/docs/api/`                                                    | `apps/web/public/docs/api/openapi.json` | `cargo run -p bakery-contracts --bin openapi`        |

One source, so the console, a visitor's `curl` and the docs cannot disagree: the TypeScript is
generated from the schemas, and the OpenAPI document from the table and the schemas, the schemas'
`$defs` becoming its components and the `Problem` type every error's body.

After changing a type or a route:

```sh
cargo run -p bakery-contracts --bin export-schemas
pnpm --filter web contracts
cargo run -p bakery-contracts --bin openapi
cargo test -p bakery-contracts
```

Each generated copy is checked for drift: `cargo test` fails on a stale schema or document,
`pnpm --filter web test` on stale TypeScript, and CI also runs
`cargo run -p bakery-contracts --bin openapi -- --check`.

The tests also hold the table to its neighbours, in both directions: every Worker route in
`workers/api/src/http/routes.rs` is in it with the same method, pattern, scope and bearer rule, and
every route up to the pull request the Worker's README names in its lead line ("Through PR N") is
served by the Worker (here, and again natively in `workers/api`'s own test); every route and answer
in [workers/api/README.md](../../workers/api/README.md)'s table is in it with its session and Token
cells, and every route up to that pull request is in the README; every route a type's doc comment
names is in it and reaches that type; and every type a route names is rendered. A later pull
request's routes may be in the table, the Worker and the README before the lead line moves; none
is held to a fixed number.
A route's own answers are in the table, and the ones a kind of route shares (401 `session`, 403
`guest-scope` and `origin`, 400 and 422 `idempotency-key`, 410 `wiped`, 429 `rate-limit`, and on
every route that needs a session the token's 400 and 401, `cookie-only` where it takes the cookie
only) are added by `routes::answers`.
