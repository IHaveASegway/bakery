# ADR 0002: Rust for every backend, as WebAssembly on Workers, with the domain in native-testable crates

Status: Accepted · 2026-11-09, by delegation; as amended by the postscript below · Proposed 2026-11-04 · Deciders: Joseph Peterson

## Context

Joseph's rule for this repository: every backend is Rust. The made-up bakery's code that runs on a server, its API, each Durable Object (DO) class, its Queue consumer and its cron handler, is written in Rust, so that the site can later write about which language fits which tool with two working systems to compare. The browser is not a backend and is out of scope here.

The site decided the other way. [The site's ADR 0014](https://github.com/IHaveASegway/website/blob/main/docs/adr/0014-typescript-on-workers.md) (Proposed 2026-10-23) chose TypeScript for every Worker and DO class, and rejected workers-rs as 0.x, with two breaking releases in a year and no bindings for DO RPC or point-in-time recovery. Its reasons hold for the site and do not carry over, for four reasons:

1. **A different goal.** The site's lab shows principles at the lowest cost and effort. The bakery's goal includes the language: showing a Rust domain on DOs is part of what Q1 · Q-goal asks a visitor to come away with ([product.md](../product.md)).
2. **The domain does not run in the browser.** Each of the site's demo cores runs in three places: its DO, the browser (offline mode and replay) and the tests. A TypeScript core does that for 2.5 KB. The bakery's domain runs only on the server and in native tests. The browser renders what the API returns and gets the API's types generated from Rust, so nothing forces the core to be small JavaScript.
3. **A Paid plan with 30 s of CPU.** The site plans its stateless Worker against Free's 10 ms. The bakery's account moves to Workers Paid ([ADR 0010](0010-workers-paid-with-the-sites-guardrails.md); Q27 · Q-plan), where a slower start or a password hash fits inside the limit.
4. **A public repository whose point is the code.** A reviewer reads the bakery for its Rust. A TypeScript system with a note saying it could have been Rust shows less.

Platform facts, as of 2026-11-04:

- workers-rs ([repository](https://github.com/cloudflare/workers-rs), [docs](https://docs.rs/worker/latest/worker/); `worker` 0.8.7) has a `DurableObject` trait with `fetch`, `alarm`, `websocket_message`, `websocket_close` and `websocket_error`; `State::accept_web_socket` for the Hibernation API; a `Storage` with `sql()` (SQLite), `set_alarm`, `delete_alarm`, `delete_all` and `transaction`; an `Env` with Queue producers, `RateLimiter`, `AnalyticsEngineDataset`, `send_email`, KV, R2, D1 (alpha), Hyperdrive and Secrets Store; `#[event(fetch | scheduled | queue)]` entrypoints, with `queue` behind a beta feature; a `Router`; and a `crypto` module. It builds with `worker-build` (wasm-bindgen, wasm-opt). Not bound: Workflows, DO RPC, point-in-time recovery, `ctx.abort()`. Code targets `wasm32-unknown-unknown`, with no Tokio.
- Workers limits ([limits](https://developers.cloudflare.com/workers/platform/limits/)): 64 MiB uncompressed on both plans, with no compressed limit; startup must finish within 1 s, or the deploy fails with error 10021; 128 MB of memory per isolate, WebAssembly linear memory included; on Paid, 30 s of CPU per invocation by default, up to 5 minutes.
- Workflows ([pricing](https://developers.cloudflare.com/workflows/reference/pricing/)) are JavaScript and TypeScript only, so no Rust code can define one.
- Toolchain pins, with sources in [stack.md](../stack.md): Rust stable 1.97 in `rust-toolchain.toml` ([releases](https://github.com/rust-lang/rust/releases)); `worker` 0.8.7 and `worker-build` ([crates.io](https://crates.io/crates/worker)); `wasm-bindgen` at the version `worker` pins.

What nobody has measured for this code: the size of the WebAssembly once `serde`, `argon2`, an RS256 check and fourteen DO classes are linked in; the startup time that size costs; and the CPU time of a SQLite write through wasm-bindgen.

## Decision

1. **Every server-side component is Rust**, built with the `worker` crate for `wasm32-unknown-unknown` through `worker-build`, into one Worker, `bakery-api` ([ADR 0009](0009-the-api-on-its-own-hostname.md)). The layout is in [delivery.md](../delivery.md).
2. **The domain has no platform dependency.** `crates/domain` holds aggregates as `decide(command, state) -> events` and `evolve(state, event) -> state`, the events, value objects and state machines. `crates/app` holds use cases and ports as traits: `Clock`, `EventStore`, `Outbox`, `PaymentGateway`, `Mailbox`, `IdGen`. Neither crate depends on `worker`, `wasm-bindgen` or `web-sys`; CI fails the build if either does. Both are tested natively with `cargo test` and with `proptest` for state-machine properties (an order never reaches `Ready` unpaid; a slot never holds more than its capacity).
3. **The Worker is the adapter layer.** `workers/api` implements the ports over `Storage::sql()`, Queue producers, `set_alarm`, the Stripe API and the sandbox inbox, and maps HTTP to use cases with the `worker` crate's `Router`. Adapter code is kept thin enough to read in one sitting per object.
4. **Contracts come from Rust types.** `crates/contracts` defines the API's request and response types with `serde` and `schemars`; the build turns them into JSON Schema and then TypeScript types for the web app. TypeScript is written only for the browser, and the browser never re-implements a rule the domain owns.
5. **Exact pins.** `worker`, `worker-build` and the Rust toolchain are pinned to exact versions. Each release of `worker` is read before it is taken, in a pull request of its own.
6. **Spike S1 before PR 2** ([roadmap.md](../roadmap.md)). A throwaway Worker, deployed with the planned dependencies and two DO classes, measures the gzipped and uncompressed WebAssembly, the startup time Cloudflare reports at deploy, and the CPU time of a handler that writes one event and one outbox row in one transaction. The proposed budget, for S1 to confirm or replace: WebAssembly at most 2 MiB gzip, startup at most 400 ms, a single-write handler at most 5 ms of CPU at p50. If S1 misses the budget, the design changes before PR 2 (split classes across Workers, drop a dependency, or revisit this record).

Out of scope: build scripts and CI glue, which may be shell or TypeScript, and the dispatch solver, which is VROOM compiled to WebAssembly and run in the browser ([ADR 0012](0012-delivery-dispatch.md)).

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **Rust on workers-rs, domain in native crates (chosen)** | Evolvability: the language rule holds; the domain is a plain library that outlives the platform. Testability: `cargo test` and `proptest` run in seconds with no runtime | Operability: a 0.x SDK, no RPC, no Workflows, beta Queue support. Latency: a larger script to start. Testability: no first-party DO test harness | Chosen |
| TypeScript on Workers, the site's choice | Operability: first-class SDK, RPC, Workflows, `@cloudflare/vitest-plugin`. Latency: kilobytes to start | Fails the rule outright, and the site already shows this stack | Rejected by rule |
| Go through workers-go, or native Go in Containers | Evolvability: Joseph's own language | Operability: workers-go is untagged and lacks typed auto-response, attachments and RPC (the site's ADR 0014, 2026-10-23). Cost and latency: Containers are Paid-only with 1 to 3 s cold starts by their own FAQ. Fails the rule | Rejected |
| Python Workers | Evolvability: first-class since 2026-09-21 (the site's ADR 0014) | Testability: no DO test harness. Fails the rule | Rejected |
| TypeScript shell with a Rust core as WebAssembly | Operability: RPC, Workflows and the Vitest plugin in the shell; Rust where the rules live | Evolvability: two languages in every request path and a hand-written boundary. Security: the adapters, where most bugs live, are not Rust. It fails the rule for the part that touches the platform | Rejected |
| Rust in Containers, native and with Tokio | Evolvability: the full Rust ecosystem; axum, sqlx | Cost: Paid-only, billed while awake. Latency: cold starts in seconds. Consistency: state leaves the DOs, which is the point of [ADR 0003](0003-durable-objects-as-the-system-of-record.md) | Rejected |
| axum inside the Worker through the `worker` crate's `http` feature | Evolvability: a familiar router, extractors and tower middleware | Latency and cost: more code to start, unmeasured. Operability: a second abstraction over the platform's request type | Deferred until S1 measures its size |

## Consequences

Good:

- The domain is readable as ordinary Rust, tested without a runtime, and portable: the same crates would run behind a native server if the platform changed.
- Types cross the wire once. A renamed field fails the web app's type check in the same pull request.
- The site gains its second data point for the language comparison it intends to write.

Bad:

- **No DO RPC.** Objects call each other over HTTP through stubs, with JSON bodies and status codes instead of typed methods. A small internal client per class keeps that in one place.
- **No Workflows.** Durable multi-step processes are alarms plus Queues ([ADR 0004](0004-queues-between-objects-and-alarms-for-time.md)); the catering saga is written by hand as a state machine with timers.
- **A 0.x SDK.** Two breaking releases in a year, as the site recorded. Pinned exactly; each release is a pull request with its changelog read; the adapter layer is where the breakage lands, and the domain does not move.
- **A second toolchain in CI.** Rust stable, `wasm32-unknown-unknown`, `worker-build` and wasm-opt beside Node and pnpm, with their own cache ([ADR 0011](0011-github-actions-owns-deploys-for-both-workers.md)).
- **Cold-start sensitivity.** Startup grows with the script, and the 1 s limit fails a deploy. S1 sets the budget, and CI checks the size on every build.
- **Different test harnesses.** `@cloudflare/vitest-plugin` cannot drive Rust objects. Domain and app crates are tested natively; objects and HTTP are tested by integration tests against `wrangler dev`, which are slower and run in their own CI job.
- **No point-in-time recovery from code.** Restoring an object's storage is done outside the Worker, through Cloudflare's tooling, if it is ever needed ([ADR 0005](0005-a-private-sandbox-per-visitor-wiped-nightly.md) says why the bakery rarely would).

## Door

Two-way per crate, expensive as a whole. `crates/domain` and `crates/app` would survive a move to any Rust host unchanged; a move to TypeScript would rewrite them. The adapter layer is about a third of the code and is the part a different SDK would replace. Nothing about stored data depends on the language: SQLite schemas and event envelopes are language-neutral, and every sandbox is wiped nightly. What hardens is the volume of Rust written against `worker`'s API, which grows with every object.

## Revisit if

- Startup passes 400 ms at p50 on deploys, or the WebAssembly passes the budget S1 sets (proposed: 2 MiB gzip).
- workers-rs ships a breaking release that the adapter layer cannot absorb in a day.
- A DO handler's `cpuTime` p99 in production passes 100 ms, the trigger the site's ADR 0014 set for its own handlers, since a long handler stalls every request queued behind it in that object.
- Cloudflare ships Rust support for Workflows or for DO RPC. Then the alarm-and-Queue saga and the HTTP stubs are candidates for replacement, each in its own record.
- `wrangler dev` integration tests take more than 10 minutes in CI, or miss a bug a first-party harness would have caught.

## Postscript 2026-11-09

As built, 2026-11-09: the Worker routes with a table of its own (`workers/api/src/http/routes.rs`, matched by `match_route`), not the `worker` crate's `Router`. Two of the six ports have Worker adapters, `Clock` (`workers/api/src/clock.rs`) and `PaymentGateway` (`workers/api/src/stripe.rs`); `EventStore`, `Outbox`, `Mailbox` and `IdGen` are used by the native tests' fakes, and the objects write events and the outbox through `workers/api/src/objects/stream.rs` directly. What happens to those four was decided on 2026-11-09, below. The WebAssembly budget is uncompressed bytes, not gzip: PR 10's stripped module plus 25%, 5,317,776 B in `workers/api/budgets.json`, checked by `verify`. The `wrangler dev` smoke scripts run by hand; no CI job runs them yet (decided below), and CI's `e2e` job covers the browser paths on both Workers.

Decided on 2026-11-09 by the session, under Joseph's delegation of the same day; revisable: a port that nothing in production implements is removed rather than kept as ceremony, unless the app layer's own tested logic needs the seam; `Clock` and `PaymentGateway` stay. The audit of `EventStore`, `Outbox`, `Mailbox` and `IdGen`, then the removal or the wiring, is roadmap R68, and this postscript changes with it (R22). The smoke scripts are to run weekly in `scheduled.yml` and open one issue on a failure, not on every pull request, since a smoke check failed on `main` unnoticed until it was run by hand on 2026-11-09 (#86); Consequences' "run in their own CI job" means that weekly job, which is roadmap R70 (R28).

## Postscript 2026-11-10

Corrected on 2026-11-10 by the session, under the owner's delegation of 2026-11-09; revisable. Each line names a sentence above that the build or a later record contradicts, and gives what is true, with its source. The decision text above is not rewritten.

- Decision 6 and Revisit if's first trigger give a startup budget of 400 ms and a WebAssembly budget of 2 MiB gzip. The budgets in force are 500 ms for the local startup profile, half the platform's 1 s limit (`.github/workflows/ci.yml`, `budget=500`, as of 2026-11-10), and 5,317,776 B of uncompressed WebAssembly (`workers/api/budgets.json`), as the postscript of 2026-11-09 says.
- Context's reason 1 and the "Rejected by rule" verdicts in Alternatives are the owner's rule, not an engineering verdict. The engineering case for Rust here is the domain as a plain library tested natively in seconds (decision 2). The measured cost is the WebAssembly: 437,223 B after wasm-opt for one object class in spike S1 (2026-11-04, [roadmap.md](../roadmap.md#spikes)), and a budget of 5,317,776 B since PR 10. No TypeScript Worker with the same objects was measured beside it; [ADR 0016](0016-alternatives-weighed-after-the-build.md) records that, and roadmap R78 asks the owner whether to measure one.
- Consequences' "the same crates would run behind a native server if the platform changed" holds for `crates/domain`, which depends on no platform crate (a CI gate in `verify`). It does not hold as written for `crates/app`: four of its six ports, `EventStore`, `Outbox`, `Mailbox` and `IdGen`, have no production adapter, and the objects go round them through `workers/api/src/objects/stream.rs` (the postscript of 2026-11-09). Roadmap R68 removes or wires them. Until then the portable part is the domain, not the seam.
- The postscript of 2026-11-09 says no CI job runs the `wrangler dev` smoke scripts yet, and that they are to run weekly. Since 2026-11-09 the `smokes` job of `.github/workflows/scheduled.yml` runs every `scripts/smoke-*.sh` on Mondays and Thursdays (roadmap R70, done in #98).
