# ADR 0013: The API and socket contract v1: one route table in Rust, an OpenAPI 3.1 document generated from it, and additive-only changes after acceptance

Status: Proposed · 2026-11-05 · Deciders: Joseph Peterson

## Context

The made-up bakery's console is a storefront of React islands that calls the API at `api.bakery.ihaveasegway.com` ([ADR 0009](0009-the-api-on-its-own-hostname.md)). PR 10 lets a visitor call the same API with `curl`, through a per-sandbox bearer token (Q42 · Q-api-access), and the guided tour (Q41 · Q-tour) shows, beside each console action, the request that does the same thing. Three readers therefore depend on one description of the API: the console, a visitor's own script and the tour's copyable requests. If they were written separately they would drift, so this record fixes what the description is, what every route must follow, and what "v1" promises.

Facts, as of 2026-11-05 (the route table is `crates/contracts/src/routes.rs`; the document is `apps/web/public/docs/api/openapi.json`; both in the PR 10 worktree, not yet merged):

- **72 routes** in the table (64 paths), by the pull request that added each: PR 2, 2; PR 3, 12; PR 4, 14; PR 5, 4; PR 6, 2; PR 7, 12; PR 8, 18; PR 9, 5; PR 10, 3. By method: 36 `POST`, 31 `GET`, 3 `PATCH`, 2 `DELETE`. The Worker serves the 46 routes through PR 7; the 26 from PR 8 to PR 10 are in the table ahead of the Worker streams that implement them ([workers/api/README.md](../../workers/api/README.md) says "through PR 7"), and the storefront's helpers already call exactly these.
- **Three transports.** JSON over HTTPS, with every error as `application/problem+json` ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457), as of 2026-11-05) whose `type` is `https://bakery.ihaveasegway.com/problems/<slug>`; the kitchen WebSocket, `GET /v1/sandboxes/{id}/kitchen/ws`, with protocol `v: 1` and nine frames (`snapshot`, `evt`, `presence`, `bye`, `cmd`, `ack`, `nack`, `ping`, `pong`); and Stripe's webhook, `POST /v1/stripe/webhook`, which only Stripe calls.
- **Two credentials.** The `__Host-session` cookie ([security.md](../security.md#the-session-cookie)) and the sandbox's API token in `Authorization: Bearer` ([security.md](../security.md#the-api-token)). By session rule, the table has 9 public routes, 2 for any session, 33 for the sandbox's own session, 26 for a signed-in one, 1 cookie-only (the socket) and 1 Stripe-signed (the webhook). 57 routes accept a bearer token.
- **One idempotency convention.** 35 of the 36 `POST`s require an `Idempotency-Key` holding a ULID; the 36th is the webhook, which dedupes on Stripe's event id ([domain.md](../domain.md#idempotency)). The envelope of every event is `v: 1` ([domain.md](../domain.md#the-envelope)).
- **One generation chain, each link checked for drift.** The `schemars` types and the route table in `crates/contracts` produce one JSON Schema per type (`cargo test` fails on a stale schema), the schemas produce the storefront's TypeScript (`pnpm --filter web test` fails on a stale copy), and the schemas with the table produce the OpenAPI 3.1.0 document served at `/docs/api/openapi.json` (`cargo test` and a CI step running the `openapi` binary with `--check` fail on a stale document). The tests also hold the table to the Worker's own table and to the Worker's README: method, pattern, scope and every status and slug ([crates/contracts/README.md](../../crates/contracts/README.md)).
- **The document's size:** 380,776 bytes pretty-printed, 30,381 bytes gzipped, with 64 paths, 72 operations and 112 component schemas (measured 2026-11-05 on the generated file, from the PR 10 platform-free stream's report).

## Decision

1. **The contract is the route table in `crates/contracts` and the schemas it names, and nothing else.** The OpenAPI document, the TypeScript, the tour's requests and the Worker's README are renderings of it or are held to it by tests; where one disagrees with the table, the table wins and the other is a bug. A route that is not in the table does not exist for a client.
2. **Every route follows these conventions.**
   - **Paths.** Resources live under `/v1/sandboxes/{id}`, the sandbox being the visitor's own. The exceptions are the health and status reads, sign-in (`/v1/auth/...`), the session (`/v1/session`) and the webhook (`/v1/stripe/webhook`). A client never names an object other than through these paths ([domain.md](../domain.md#identifiers)).
   - **Session rules,** one per route, in the table: public (no session needed), any (any valid session), sandbox (a session whose sandbox is `{id}`, a guest's included), signed-in (the same, and a guest gets 403 `guest-scope`), cookie-only (the socket) and Stripe-signed (the webhook).
   - **Bearer tokens** are accepted on sandbox and signed-in routes, 57 of the 72, and never on the account-level routes (`/v1/session`, sign-out), the socket, the webhook, or the two routes that mint a token (`issue-token` and `rotate-token`), so that a token never mints its successor. A request with a token and no cookie needs no `Origin`; a token in a query string, or a token and a cookie together, is 400 `token`.
   - **Idempotency.** Every `POST` but the webhook carries an `Idempotency-Key` that is a ULID (400 `idempotency-key` otherwise). A repeat with the same body gets the first answer with `Idempotent-Replayed: true`; a reused key with another body gets 422 `idempotency-key`. `PATCH` accepts the header and does not require it. The webhook is the one `POST` outside the rule.
   - **Errors** are `application/problem+json`. The `type` ends in the rule's slug, and where a refusal names a rule within a family (an order, a catering step, the clock, traffic) the `detail` names it as a whole word, in the sentence form `The rule is <slug>.`, and never echoes a value the visitor sent ([domain.md](../domain.md#free-text-and-personal-data)). The slugs each route can give are in the table and listed in the document's `x-problems`.
   - **Versions in the payloads.** The envelope is `v: 1` and every socket frame carries `v: 1`; the document's `info.version` is `"1"`.
3. **What a version means (a rule for the future, in force once this record is Accepted).** v1 is additive-only: new routes, new optional request fields, new response fields, new socket frames, new problem slugs and new values where a field is documented as open are allowed; a renamed or removed field, a changed type, a changed status, a changed slug, a changed meaning, or a field made required is not. Clients must ignore fields and frames they do not know (a tolerant reader, as the envelope already requires). A breaking change is `/v2/` beside `/v1/`, and a socket `v: 2` beside `v: 1`, with both served for at least 90 days after v2 is announced in the document. That period is this record's choice, not a measured need: sandboxes last one day, so a visitor's script is rewritten, not migrated, and the period can be shortened by a later record.
4. **What is explicitly not contract:** the Worker's internal object paths (`/_...`, such as `/_event` and `/_command`), log lines and their fields, the order of JSON keys, the seed's pinned values (ids, prices and quantities drawn from the seed), the size of the WebAssembly bundle, rate-limit thresholds, and the vendor fields `x-session`, `x-pr` and `x-problems` in the document. Rate limits are stated in [security.md](../security.md) and may change without a version, since a limit only refuses; a client must handle 429 `rate-limit` with its `Retry-After`.
5. **The document is a static file served with the storefront,** generated by `cargo run -p bakery-contracts --bin openapi`, committed so that CI can check it, and never hand-edited. It is served at `/docs/api/openapi.json` beside the storefront's page at `/docs/api/`, like every other asset ([ADR 0008](0008-astro-site-with-react-islands-on-an-assets-only-worker.md)).

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **A. A Rust route table and schemas as the source; the OpenAPI document generated (chosen)** | Evolvability and testability: one source, and a test can compare every neighbour (the Worker's table, its README, the TypeScript, the document) with it. Operability: the document is a static file at $0 | Operability: the table is kept by hand beside the Worker's own table, and the two must be edited together. Evolvability: the generator is ours, so OpenAPI features beyond the ones it emits cost code | Chosen |
| B. A hand-written OpenAPI document as the source | The ecosystem's usual starting point; any OpenAPI tool edits it | Consistency: the types in Rust and the document can disagree, and nothing but review notices. The tour's requests would be checked against prose. Teaches less: contract-first types are a point of this project | Rejected |
| C. A GraphQL schema | One endpoint; clients choose fields; introspection is built in | Operability and security: query cost limits, and per-field authorization, to build for a demo whose actions are commands with business rules; no `Idempotency-Key` or problem-type convention to reuse; `curl` examples get longer. Cacheability: queries are `POST`s by default | Rejected |
| D. gRPC or another binary RPC | Strong generated clients; streaming | Feasibility: a browser needs a translation layer, and a visitor's `curl` no longer works, which is the point of the visitor API | Rejected |
| E. Versioning by header or media type, with one path | Paths stay stable; one URL per resource | Operability and learnability: a visitor's `curl` and the tour's copyable requests must carry a header that is easy to forget and invisible in a log line; caches and the document need a second axis | Rejected; the path carries the version |
| F. No visitor API (Q42's option (c)) | No contract to keep stable; no token to secure; no rate limit per token | Learning: the console and a visitor's `curl` calling one contract is what PR 10 teaches; "learn to do it yourself" ends at the screen. The console's own client would still need a contract, only an unpublished one | Rejected (Q42 recommends (a)) |

## Consequences

Good:

- One source. The console, a visitor's `curl` and the document cannot disagree, because the TypeScript and the document are generated from the table and the schemas, and a stale copy fails CI.
- The tour's requests cannot drift: its steps are checked at build against `crates/contracts` ([architecture.md](../architecture.md#the-tour)).
- A visitor's `curl` is a first-class client: same routes, same errors, same idempotency, a token in one header.
- The additive-only rule gives later pull requests a short test for a change: if a field is renamed or a status changes, it is a new version.
- The Worker's routes and the table are held together by tests, so a route added in one place and not the other fails.

Bad:

- An additive-only promise constrains later pull requests. A mistake in a name or a status found in PR 11 or later is carried, not fixed, until a `/v2/`.
- The table must be maintained by hand beside the Worker's own, and 26 of its 72 routes are ahead of the Worker as of 2026-11-05; the Worker streams for PR 8 to PR 10 must land the matching `RouteId`s before the tests agree.
- 72 routes is a large surface to keep stable; it was written across nine pull requests, PR 2 to PR 10.
- The document is large for a static asset: 380,776 bytes pretty-printed, 30,381 gzipped (2026-11-05). The pretty copy is the one drift-checked, so it is not minified.
- Bearer tokens stop at the account-level routes and at token minting, which a visitor may find surprising; the document says why.

## Door

Two-way until this record is Accepted and the document is linked from the public pages (PR 12): nobody outside the project holds a script against it, the sandboxes are wiped nightly, and a renamed field is a build change.

One-way in effect once visitors have scripts against it. The cost of a rename then falls on people the project cannot reach, which is why the additive-only rule starts at acceptance and not before.

## Revisit if

- A renamed field or a changed slug is needed: the rule is working, and it is time to plan `/v2/`.
- The route table and the Worker's table disagree in CI more than once in a release: two tables kept by hand are one too many, and the Worker should read the shared one.
- The document passes 1 MB (it is 380,776 bytes as of 2026-11-05).
- A second client breaks on a release: the tour's requests, or a visitor's script reported in an issue.
- A bearer token's exclusion from the account-level routes proves wrong in use, for example visitors asking for a script that rotates its own token.

## Patterns and further reading

- Problem details for HTTP APIs: [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457), as of 2026-11-05.
- The OpenAPI Specification [3.1.0](https://spec.openapis.org/oas/v3.1.0).
- Tolerant reader: Martin Fowler, ["TolerantReader"](https://martinfowler.com/bliki/TolerantReader.html) (2011).
- Idempotent requests: Stripe, [Idempotent requests](https://docs.stripe.com/api/idempotent_requests), as of 2026-11-05.
- Contract-first and consumer-driven contracts: Ian Robinson, ["Consumer-Driven Contracts"](https://martinfowler.com/articles/consumerDrivenContracts.html) (2006).
