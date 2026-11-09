# ADR 0015: A lossy flight recorder beside the event path: one Recorder object per sandbox, fed by the Queue's consumer after the fact

Status: Proposed · 2026-11-09 · Deciders: Joseph Peterson

## Context

The storefront is getting a guide, "Under the hood", that shows a visitor what their own action did inside the system: the request, the events written, who consumed them and how long each hop took. The page can already see its own requests (each write carries an `Idempotency-Key`) and the kitchen socket's envelopes (`id, stream, seq, type, at, recorded_at, cause`). It cannot see the fan-out: which subscribers the Queue's consumer delivered each envelope to, on which attempt, and how long after the event was written. Only the consumer knows that, and only at the moment it decides a message.

Facts, as of 2026-11-09:

- **One consumer.** Every event leaves its object through the outbox and the relay onto `bakery-events`, and one handler, `workers/api/src/queue.rs`, routes each envelope to its subscriber objects by the static table in `crates/app/src/routing.rs`. It stops at a message's first failed delivery and retries the message; after 3 retries the platform moves it to `bakery-events-dlq` (`workers/api/wrangler.jsonc`, `max_retries: 3`).
- **No attempt count in the binding.** `worker` 0.8.7, the version in `Cargo.lock`, gives a queue message `id`, `timestamp`, `body`, `ack` and `retry`, and no `attempts` ([architecture.md](../architecture.md#events-and-the-outbox), "Dead letters").
- **Batches.** The consumer takes up to 10 messages a batch and does not wait for a batch to fill (`max_batch_timeout: 0`), so at a visitor's pace most batches hold one message.
- **Prices.** A Durable Object request is 1M a month included on Workers Paid, then $0.15 per million; an outgoing WebSocket message is free and an incoming one counts 1/20 of a request; each SQLite row written is 50M a month included, then $1.00 per million ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), as of 2026-11-04, the page updated 2026-10-18). Per-sandbox figures are in [cost.md](../cost.md#the-flight-recorder).

## Decision

1. **A new class, `Recorder`, one per sandbox,** named `recorder:<sandbox>`, SQLite-backed, seeded by the Sandbox with its other children (after the Inbox, before every child that writes events), registered in its child registry, wiped with it and ended by its 36 h backstop like every child. It is not part of the Kitchen: observability is not the kitchen's job, and one object should not become the hub for everything. It ships expand first, then wire, because a class lifecycle change ships alone ([ADR 0011](0011-github-actions-owns-deploys-for-both-workers.md), decision 9): first the contract types and the consumer's refactor, with the class set unchanged; then the class alone, bound and exported in `wrangler.jsonc` with nothing calling it, no seeding, no hook and no route; then the routes, the seeding, the consumer's hook and the docs that describe them.
2. **Fed by the consumer, after the fact, best effort.** Once a message's deliveries are decided, the consumer builds its hop: the envelope's `id`, `type`, `stream`, `seq`, `cause`, `at` and `recorded_at`, each routed class with its outcome (`delivered`, `retried`, `dead_lettered`), and the time the deliveries were decided. At the end of the batch it sends each sandbox's Recorder one `POST /_record` with that sandbox's hops, through the context's `wait_until`, so the handler has returned and every ack and retry stands before the request goes. A failure is one `trace_drop` log line with the sandbox and the count, and changes nothing else. Nothing in a command's path calls the Recorder.
3. **No payloads.** A hop is identifiers, type names, sequence numbers and times, never `data` (`bakery_contracts::TraceHop`, `deny_unknown_fields`; tested in crates/contracts, in `objects/recorder.rs` and in `scripts/smoke-orders.sh`).
4. **A small ring.** One row per batch, the hops as JSON, the oldest deleted in the same transaction once more than 200 are kept. Lag is `delivered_at - recorded_at` in milliseconds, clamped at 0.
5. **The Recorder counts attempts.** Since the binding has no attempt count, the Recorder keeps a row for each event whose last hop was not delivered everywhere; the next hop for that event is the next attempt, and a hop that fails on the fourth attempt, the Queue's last, is marked `dead_lettered`. The count is as lossy as the recorder.
6. **Read two ways, both in the route table with `pr: 21`:** `GET /v1/sandboxes/{id}/trace?after=<cursor>`, the hops of up to 50 batches after the cursor, newest last, with the next cursor, `more` and `missed`; and `GET /v1/sandboxes/{id}/trace/ws`, a hibernating WebSocket that sends a `snapshot` of the last 50 batches and then a `hops` frame for each batch as it is recorded. Both take the session scope of the kitchen socket, a guest's own sandbox included; the read accepts the API token as `GET /v1/sandboxes/{id}` does, and the socket takes the cookie only, with the kitchen socket's checks, its `ping` auto-response, its `bye` and close codes and its limits (4 sockets a sandbox).
7. **The kill switch.** With the flag `off` the consumer delivers nothing, so nothing is recorded. The Recorder counts toward no new limit.

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **A. A Recorder per sandbox, fed after the batch, lossy (chosen)** | Latency and availability: nothing in a command's or a delivery's path waits for it; a broken Recorder loses hops, not events. Evolvability: its own class, its own schema, removable alone. Cost: one DO request a sandbox a batch | Cost: about a third more DO requests per sandbox at the visitor's pace ([cost.md](../cost.md#the-flight-recorder)). Consistency: lossy by design; the attempt count is the Recorder's own | Chosen |
| B. Record inside the Kitchen, which already holds a socket per console | No new class or socket | Evolvability: the Kitchen becomes the hub for every event, the bottleneck ADR 0004's alternatives table rejects. Security: the board's socket would carry what every subscriber did | Rejected |
| C. Record synchronously, before the ack | A hop for every delivery, never lost | Availability and latency: a slow or broken Recorder would delay or fail every delivery, and observability would sit in the event path | Rejected |
| D. Workers Logs or Analytics Engine as the store, read back by the page | No new object | Latency and security: logs are minutes behind and account-wide, not a visitor's own; Analytics Engine has no per-sandbox read path the router could scope, and costs a query per read | Rejected |
| E. Each subscriber records its own receipt | Exact, per object | Cost and evolvability: a write in every subscriber for every event, in nine classes, and still no view of what was retried | Rejected |
| F. Record only while a socket is open | Fewer DO requests when nobody watches | Learnability: `GET .../trace` would be empty for `curl` and after a reconnect, which is the fallback the guide needs | Rejected |

## Consequences

Good:

- The guide can show the fan-out live: who consumed an event, on which attempt, how long after it was written.
- A Recorder that fails, or a sandbox that never seeded one, costs a log line; orders, deliveries and acks are unchanged.
- No event data leaves its subscribers: the hop's type has no field for it, and a hop that carries one is refused.
- Storage is bounded by 200 rows a sandbox, so the wipe has little to delete.

Bad:

- Lossy by design: a batch whose `/_record` fails is gone, the socket has no replay, and the attempt count misses attempts it was never told of. A retry made with the flag `off` is not seen at all.
- One more class: 15 classes, and 37 children per seeded sandbox. It is a class lifecycle change, which ships alone ([ADR 0011](0011-github-actions-owns-deploys-for-both-workers.md), decision 9).
- One DO request per sandbox per consumer batch, about 50 per sandbox session, which brings forward the first DO-request overage on Paid ([cost.md](../cost.md#the-flight-recorder)).

## When not to do this

- When the system has a tracing backend that accepts spans per request and can be scoped to a tenant: emit spans and read them there.
- When the recorder must be complete, as an audit log must: that is a durable write in the event path, with its cost and its failure modes, not this.
- When there is more than one consumer: each would need to report, and the ring's order would be the order of arrival, not of delivery.

## Door

Two-way. The Recorder holds nothing another object reads, so the class, its two routes and the consumer's hook can be removed together; removing the class is a lifecycle change and ships alone, and the two routes would leave v1 only with the version rule of [ADR 0013](0013-the-api-and-socket-contract-v1.md).

## Revisit if

- `trace_drop` lines appear for more than a few batches a day outside a deploy or a wipe.
- DO requests pass 80% of the included 1M in a month, with the Recorder's share named in the breaker's meters.
- `workers-rs` exposes a message's attempt count: the consumer should send it and the Recorder should stop counting.
- The guide needs hops the consumer cannot see, such as the relay's own sends.

## Patterns and further reading

- Wire Tap and Message History: Gregor Hohpe and Bobby Woolf, [Enterprise Integration Patterns](https://www.enterpriseintegrationpatterns.com/patterns/messaging/WireTap.html) (2003). The consumer is the tap; the Recorder keeps a short history beside the channel.
- Distributed tracing, of which a hop is a small part: Chris Richardson, [Pattern: Distributed tracing](https://microservices.io/patterns/observability/distributed-tracing.html), read on 2026-11-09.
- Durable Object WebSockets and hibernation: [Cloudflare's guide](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), read on 2026-11-09.
