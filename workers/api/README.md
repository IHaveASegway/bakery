# bakery-api

The Rust Worker behind `api.bakery.ihaveasegway.com`: the router, every Durable Object class, the
Queue consumer and the cron handler ([architecture.md](../../docs/architecture.md)). Until the
launch pull request (PR 11) it runs only on `wrangler dev`.

Through PR 4 it answers:

| Route                                                    | Session     | Does                                                                                                                                                                  | Answers                                                                                                                                                                                                     |
| -------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                                         | none        | `{status, commit, version}`; touches no object                                                                                                                        | 200                                                                                                                                                                                                         |
| `GET /v1/status`                                         | none        | today's sandboxes, guests and demo accounts with their caps, and the flag, from one call to `Control`                                                                 | 200                                                                                                                                                                                                         |
| `GET /v1/auth/google/start?return=/app/`                 | none        | sets `__Host-oauth` (state, nonce, PKCE), redirects to Google with `scope=openid` alone                                                                               | 302                                                                                                                                                                                                         |
| `GET /v1/auth/google/callback`                           | the cookie  | checks `state`, exchanges the code, verifies the ID token (RS256), keeps `sub` only as an account id, sets `__Host-session`                                           | 303 to the storefront's path; 303 to `/signin/?error=state`, `exchange`, `token`, `provider` or `oauth`                                                                                                     |
| `GET /v1/auth/github/start?return=/app/`                 | none        | the same, with no `scope` parameter and no nonce                                                                                                                      | 302                                                                                                                                                                                                         |
| `GET /v1/auth/github/callback`                           | the cookie  | exchanges the code, one `GET /user` for the numeric id, drops the token                                                                                               | 303, as Google                                                                                                                                                                                              |
| `POST /v1/auth/demo`                                     | none        | Turnstile, `Control`'s daily cap, a `baker-xxxx` username, argon2id in the Worker, the `Account`                                                                      | 201 `{username}` and the cookie; 403 `turnstile`; 422 `password`; 503 `demo-cap`                                                                                                                            |
| `POST /v1/auth/demo/signin`                              | none        | the PHC string from the `Account`, verified in the Worker                                                                                                             | 200 and the cookie; 401 `credentials`; 429 `locked` with `Retry-After`                                                                                                                                      |
| `POST /v1/auth/signout`                                  | any         | clears the cookie; an account's session id is revoked                                                                                                                 | 204                                                                                                                                                                                                         |
| `GET /v1/session`                                        | any         | the cookie, decoded; no object call                                                                                                                                   | 200; 401 `session`                                                                                                                                                                                          |
| `POST /v1/sandboxes`                                     | optional    | Turnstile for a guest, the per-IP-hash limit, `Control`'s admission, a ULID and a seed, the `Sandbox`; re-issues the cookie with `sbx`                                | 201; 200 with the live one unless `replace`; 403 `turnstile`; 429 `rate-limit`, `account-sandbox-cap`; 503 `sandbox-cap`, `guest-cap`…                                                                      |
| `GET /v1/sandboxes/{id}`                                 | `sbx == id` | the `Sandbox`'s state                                                                                                                                                 | 200; 404 for any other id; 410 `wiped`                                                                                                                                                                      |
| `DELETE /v1/sandboxes/{id}`                              | `sbx == id` | "Wipe now", finished in the request; an account's cookie loses `sbx`, a guest's is cleared                                                                            | 200 `{id, state: wiped}`; 404; 410                                                                                                                                                                          |
| `POST /v1/sandboxes/{id}/faults`                         | signed in   | the `inbox` and `kitchen` switches; `kitchen` makes the Kitchen answer every delivery 503                                                                             | 200 `{faults}`; 403 `guest-scope` for a guest                                                                                                                                                               |
| `GET /v1/sandboxes/{id}/menu`                            | `sbx == id` | the Catalog's published menu, `ETag: "v<n>"`, `Cache-Control: private, no-cache`, `Bakery-Cache: hit` or `miss` from the Cache API entry keyed by sandbox and version | 200; 304 on a matching `If-None-Match`; 503 `seeding`                                                                                                                                                       |
| `PATCH /v1/sandboxes/{id}/menu/items/{slug}`             | signed in   | `{price_cents?, status?: paused or available}`: a price on every variant, a draft until publish; a pause or resume publishes that item                                | 200 `{version, pending}`; 404; 422 `menu`; 403 `guest-scope`                                                                                                                                                |
| `POST /v1/sandboxes/{id}/menu/publish`                   | signed in   | `MenuPublished`, the version plus one                                                                                                                                 | 200 `{version, pending}`; 422 `menu` with no drafts                                                                                                                                                         |
| `POST /v1/sandboxes/{id}/orders`                         | `sbx == id` | the key mapped to an order ULID by the Sandbox, the Catalog's menu, the Order's `decide`; the customer is the sandbox's persona; expires 15 business minutes later    | 201 `OrderResponse` and `Location`; 200 with `Idempotent-Replayed: true` for the same key; 422 `order` naming the rule (`note-<class>` for the note); 422 `idempotency-key` for a reused key; 503 `seeding` |
| `GET /v1/sandboxes/{id}/orders/{oid}`                    | `sbx == id` | the order, once the Sandbox's registry holds it                                                                                                                       | 200; 404                                                                                                                                                                                                    |
| `POST /v1/sandboxes/{id}/orders/{oid}/cancel`            | `sbx == id` | `CancelOrder` by the customer                                                                                                                                         | 200; 404; 422 `order`                                                                                                                                                                                       |
| `GET /v1/sandboxes/{id}/dead-letters`                    | `sbx == id` | the messages the Queue gave up on, oldest first                                                                                                                       | 200 `[DeadLetter]`                                                                                                                                                                                          |
| `POST /v1/sandboxes/{id}/dead-letters/{eventId}/redrive` | signed in   | the stored envelope sent again with its own id, the row removed                                                                                                       | 200 `DeadLetter`; 404                                                                                                                                                                                       |
| `POST /v1/sandboxes/{id}/clock`                          | signed in   | `{minutes}`: business time moves forward, at most 14 days in all; `ClockAdvanced`; every child's timers recomputed                                                    | 200 `ClockResponse`; 422 `clock`; 403 `guest-scope`                                                                                                                                                         |
| `OPTIONS` on any of these                                | none        | the CORS preflight                                                                                                                                                    | 204                                                                                                                                                                                                         |
| anything else                                            |             |                                                                                                                                                                       | 404 or 405 with `Allow`, `application/problem+json`                                                                                                                                                         |

Every `POST`, `PATCH` and `DELETE` needs `Origin` equal to `ALLOWED_ORIGIN` and no `Sec-Fetch-Site: cross-site`
(403 `origin`); every `POST` needs an `Idempotency-Key` holding a ULID (400 `idempotency-key`).
CORS allows exactly `ALLOWED_ORIGIN` with credentials ([security.md](../../docs/security.md#the-apis-cors)).
Each request writes one JSON log line: the route without its query, the status, the time, an IP
hash, country, continent, the sandbox and a reason code. Never a body, cookie, token, username or
provider id.

## Commands

From this directory, with the toolchain from `rust-toolchain.toml`:

```sh
cargo install worker-build --version 0.8.7 --locked   # once; the version is in the root Cargo.toml
worker-build --release                                # build/index_bg.wasm, build/index.js, build/worker/shim.mjs
pnpm exec wrangler dev --local --ip 127.0.0.1 --port 8788 --show-interactive-dev-session=false
```

`wrangler dev` runs the build command itself. Then:

```sh
curl -i http://127.0.0.1:8788/v1/health
curl "http://127.0.0.1:8788/cdn-cgi/local/scheduled?cron=0+10+*+*+*"      # the 10:00 UTC wipe, once
curl "http://127.0.0.1:8788/cdn-cgi/local/scheduled?cron=*/15+*+*+*+*"    # the 15-minute sweep, once
node ../../scripts/list-objects.mjs .wrangler/state                        # objects on disk; exit 1 if a sandbox holds data
../../scripts/smoke-api.sh                                                 # PR 2's checks
../../scripts/smoke-auth.sh                                                # PR 3's, against the fake provider
../../scripts/smoke-orders.sh                                              # PR 4's: menu, orders, expiry, DLQ, wipe
```

Wrangler 4.157.0 runs the scheduled handler at that URL without `--test-scheduled` (checked on
2026-11-05; [cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally)).

From the repository root: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo test --workspace` and `cargo deny check`.

## Local sign-in, with the fake provider

`scripts/fake-providers.mjs` stands in for Google, GitHub and Turnstile on 127.0.0.1:8790. Start
it before the Worker: it draws a new signing key each start. Then put these lines in `.dev.vars`
(the overrides are honored only for 127.0.0.1 and localhost; `.dev.vars.example` lists them):

```sh
SESSION_HMAC_KEY=<any 32 or more characters>
ACCOUNT_HMAC_KEY=<any text>
TURNSTILE_SECRET=1x0000000000000000000000000000000AA   # Turnstile's documented always-pass test secret
GOOGLE_CLIENT_ID=fake-google-client
GOOGLE_CLIENT_SECRET=fake-google-client-secret
GITHUB_CLIENT_ID=fake-github-client
GITHUB_CLIENT_SECRET=fake-github-client-secret
GOOGLE_ISSUER=http://127.0.0.1:8790/google
GITHUB_AUTHORIZE_URL=http://127.0.0.1:8790/github/login/oauth/authorize
GITHUB_TOKEN_URL=http://127.0.0.1:8790/github/login/oauth/access_token
GITHUB_USER_URL=http://127.0.0.1:8790/github/user
TURNSTILE_SITEVERIFY_URL=http://127.0.0.1:8790/turnstile/siteverify
ALLOWED_ORIGIN=http://127.0.0.1:8787
API_ORIGIN=http://127.0.0.1:8788
```

`scripts/smoke-auth.sh` writes exactly this file with random keys for its run and removes it after;
it refuses to start when a `.dev.vars` exists, unless `SMOKE_AUTH_OVERWRITE=1`, which moves yours
aside and puts it back. A route whose secret is missing answers 503 problem `config` naming it.

For the real providers, register `http://127.0.0.1:8788/v1/auth/google/callback` and
`http://127.0.0.1:8788/v1/auth/github/callback` as redirect URIs, set the real client ids and
secrets, keep `API_ORIGIN` and `ALLOWED_ORIGIN` as above, and leave the five overrides out.

## What a sign-in stores

Google's `sub` and GitHub's numeric id become `HMAC-SHA256(ACCOUNT_HMAC_KEY, "google:" + sub)` or
`"github:" + id` in the Worker and are dropped there: the `Account` object, named `account:<that hex>`,
holds the hex, the sign-in kind, the day it was created, the last sign-in, the current sandbox and
its wipe time, today's sandbox count, revoked session ids for 24 h, and one timer that deletes it
30 days after the last sign-in. A demo account also holds its `baker-xxxx` username, the argon2id
PHC string and its recent failed sign-in times; the password never leaves the Worker. Nothing
else a provider sends (email, name, picture, login, tokens) is read past its parser.

## Local state and secrets

`wrangler dev` keeps Durable Object state in `.wrangler/`, git-ignored; delete it to start over.
Wrangler 4.157.0 writes each object to `<state>/v3/do/bakery-api-<Class>/<id>.sqlite`, which is
what `scripts/list-objects.mjs` reads. Secrets go in `.dev.vars`, also git-ignored;
`.dev.vars.example` lists their names, never values. `BUILD_COMMIT` is set by CI at deploy and
reads `dev` when unset.

## Events, the Queue and the children

A new sandbox answers `seeding` until its first alarm has created its 14 children in two
batches: the `Catalog` (`catalog:<sandbox>`), the `Kitchen` (`kitchen:<sandbox>`) and the seed's
12 open orders (`order:<sandbox>:<ULID>`), each registered before its first write. Then it is
`live` and appends `SandboxSeeded`. The wipe calls `/_wipe` on every registered child by class.

Every object that writes events (Sandbox, Catalog, Order) commits them with their outbox rows and
the command's key in one transaction, sends the rows to `bakery-events` as JSON strings under
`wait_until`, and keeps an `outbox` timer 30 s out for whatever the send left. The consumer in
`src/queue.rs` delivers each envelope to the subscribers `bakery_app::routing` names (the Kitchen,
in PR 4) and acks when all answered 2xx; after 3 retries the message moves to `bakery-events-dlq`,
whose consumer writes it into the Sandbox's dead letters. Locally, `wrangler dev` runs both queues:
the log shows each failed delivery (`delivery_failed`), Wrangler's own line moving the message to
the DLQ, and `dlq` when the Sandbox keeps it.

## Notes

- `compatibility_date` is 2026-11-04. The date a config may carry is bounded by the workerd inside the Wrangler the lockfile resolves: 4.152.0's refused it (its newest was 2026-10-26) and 4.157.0's accepts it (docs/delivery.md, compatibility_date).
- `Control`, `Account`, `Sandbox`, `Catalog`, `Order` and `Kitchen` are declared SQLite-backed in the `exports` block; CI fails if a `#[durable_object]` class is missing there.
- The Cache API works on `wrangler dev` 4.157.0 (checked on 2026-11-05: the menu's second read answers `Bakery-Cache: hit`). An entry is stored with `max-age=86400`, since no sandbox outlives the next 10:00 UTC; the response to the browser says `private, no-cache`.
- The rate-limit bindings work on `wrangler dev` 4.157.0 (checked on 2026-11-05: a second creation from one IP hash inside the minute gets 429). If a runtime lacks them, the Worker logs `rate_limit_unavailable` once per isolate and lets the request through; `Control`'s caps still bound the day.
- `API_ORIGIN` is a var rather than the request's own origin because `wrangler dev` rewrites the request's host to the route's, `api.bakery.ihaveasegway.com`, and the OAuth redirect URI must match the registered one exactly.
