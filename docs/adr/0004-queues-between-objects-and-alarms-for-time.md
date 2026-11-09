# ADR 0004: Cloudflare Queues between objects, idempotent consumers, and alarms for everything timed

Status: Proposed · 2026-11-04 · Deciders: Joseph Peterson

## Context

[ADR 0003](0003-durable-objects-as-the-system-of-record.md) makes each aggregate of the made-up bakery a Durable Object (DO) that appends its events and an outbox row in one transaction. Something has to carry those events to the objects that react to them: an `OrderPaid` reserves production in `Schedule`, earns points in `Customer`, puts a receipt in `Inbox` and a line on the `Kitchen` board, and lands on the customer's timeline in `Crm`. Something also has to fire at a time: an unpaid order expires after 15 minutes (Q13 · Q-order-flow), a catering inquiry gets reminders and a balance invoice (Q16 · Q-catering), every object has a cleanup backstop ([ADR 0005](0005-a-private-sandbox-per-visitor-wiped-nightly.md)).

Platform facts, as of 2026-11-04:

- **Queues pricing** ([Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)): Free 10,000 operations a day; Paid 1M operations a month included, then $0.40 per million. One operation per 64 KB written, read or deleted, so a small message costs about 3; each retry adds a read. Retention is 4 days by default, up to 14 days on Paid. A batch holds up to 100 messages.
- **Delivery** ([delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)): at least once by default, so a message is "in rare occasions" delivered more than once. A consumer acknowledges or retries each message ([batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)), and messages that exhaust their retries can go to a dead-letter queue ([dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)). Ordering across a queue is not part of the guarantee.
- **Alarms** ([alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)): one alarm per object at a time; at-least-once execution, retried with exponential backoff from 2 s, up to 6 retries. Each `setAlarm()` is one row written ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- **Workflows** ([Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)): JavaScript and TypeScript only, so the Rust rule ([ADR 0002](0002-rust-for-every-backend.md)) excludes them.
- **workers-rs** 0.8.7 ([repository](https://github.com/cloudflare/workers-rs)): Queue producers in `Env`, and a `#[event(queue)]` consumer behind the `queue` feature, which is beta.
- **What a loop costs.** The site's [cost.md](https://github.com/IHaveASegway/website/blob/main/docs/cost.md) cites a 2026 bill reported at about $36,000, in which a queue consumer that re-enqueued its own writes was one of three multipliers on bot traffic ([report](https://ppc.land/developer-faces-36-000-cloudflare-bill-after-queue-loop-post-says/)), and a $10,811.41 invoice from a DO alarm that re-armed itself for the current time about 600 times a second ([report](https://aiidelist.com/blog/cloudflare-10811-bill-codex-durable-objects-alarm-loop)). Both reports rest on the developers' own posts.

## Decision

1. **One queue, `bakery-events`, and a dead-letter queue, `bakery-events-dlq`.** Every event any object relays goes through it, with the envelope in [domain.md](../domain.md): `v`, `id` (a ULID), `sandbox`, `stream`, `seq`, `type`, `at` (business time), `recorded_at` (wall time), `data`, `cause` (the command id).
2. **The consumer runs in `bakery-api`**, the same Worker as the objects. It routes each message by `type` to the subscriber objects a static table names, and acknowledges each message only when every subscriber has answered 2xx.
3. **Every subscriber is an idempotent consumer.** It keeps a `seen` table keyed by event id and applies an event and records its id in one transaction. A duplicate is acknowledged and changes nothing. A projection also keeps the last `seq` per stream: a lower or equal `seq` is a duplicate, and a gap is retried with a delay until the missing event arrives.
4. **Three retries, then the DLQ.** A message that fails three times goes to `bakery-events-dlq`, which keeps it 14 days. Nothing consumes the DLQ automatically. A daily job counts it, and a staff screen in the operator view shows its messages, with a "redeliver" control that is itself idempotent because subscribers are ([operations.md](../operations.md)).
5. **The relay is in the producing object.** After a commit, the object sends its unrelayed outbox rows in one batch inside `wait_until`, each envelope as a JSON string (spike S6, 2026-11-04: a `serde_json::Value` map sent through `worker` 0.8.7's `Queue::send` arrives as `{}`), and marks them relayed when the send returns. It also adds a `timers` row due 30 s later; the alarm sends whatever is still unrelayed. A crash between commit and send loses nothing, and the visitor can watch an outbox row wait. Whether workers-rs binds `wait_until` on a DO's state is checked in spike S1; if it does not, the object sends before it answers and pays the latency.
6. **Alarms for everything timed.** Order expiry, catering reminders and each step of the catering saga, outbox retries, the nightly wipe and the 36 h backstop are rows in the object's `timers` table; the one platform alarm is armed for the earliest. Business time is a per-sandbox clock the visitor can advance (Q12 · Q-clock); alarms stay on wall time, and moving the clock re-arms every object's alarm for its next due row.
7. **The loop guard.** An alarm re-arms only for a time later than now. An object re-arms at most 100 times a wall-clock day; past that, it stops arming, records the fault and flags the sandbox `read-only` through `Control`. `Control`'s daily ledger also counts relayed events per sandbox, with a cap set in [cost.md](../cost.md).
8. **A consumer never enqueues an event it consumed.** The consumer path holds no reference to the producer binding. When a subscriber reacts with an event of its own, that event is a new event with a new id, appended to the subscriber's own log and outbox in the transaction that records the consumed id as seen, and relayed by that object like any other.

```mermaid
sequenceDiagram
    participant C as Order (DO)
    participant Q as bakery-events
    participant W as consumer (bakery-api)
    participant S as Schedule, Customer, Inbox, Crm, Kitchen
    C->>C: transaction: events + outbox
    C-->>Q: send batch (wait_until)
    Note over C: alarm retries unrelayed rows after 30 s
    Q->>W: batch of up to 100
    W->>S: deliver by type
    S->>S: transaction: apply + insert into seen
    S-->>W: 2xx (or 2xx for a duplicate)
    W-->>Q: ack, or retry; after 3, to bakery-events-dlq
```

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **Queues with idempotent subscribers; alarms for time (chosen)** | Availability: a slow or failing subscriber never blocks the aggregate that produced the event. Evolvability: a new subscriber is a line in the routing table | Consistency: eventual between objects; ordering per stream only, rebuilt by `seq`. Cost: about 3 operations an event. Operability: a beta binding, a DLQ to watch | Chosen |
| Direct object-to-object HTTP calls from the producer | Latency: no queue hop. Cost: no Queue operations | Availability: a slow subscriber stalls the aggregate's single thread. Evolvability: the producer knows every subscriber, and fan-out and retries live in the producer | Rejected |
| Workflows for the catering saga and fan-out | Operability: durable steps, retries and sleeps built in | JavaScript and TypeScript only | Rejected by rule |
| An in-object broker, as the site's Outbox Lab simulates | Testability: every delivery in one object, deterministic | Evolvability: fine for one object; across fourteen classes it becomes a central object every event passes through, which is a bottleneck and a single writer for the whole sandbox | Rejected |
| Projections poll the source objects | Operability: no queue | Cost: requests and duration on every poll, across every object. Latency: as stale as the interval | Rejected |
| A third-party broker | Evolvability: ordering, replay and consumer groups | Security and operability: another account, credentials in the Worker, traffic leaving Cloudflare. Cost: a bill outside the guardrails | Rejected |

## Consequences

Good:

- The Queue Lab's principles run in production code a visitor can watch: an outbox row waiting, a message delivered twice and ignored, a poison message in the DLQ (Q33 · Q-principles).
- A sandbox session's 50 events cost about 150 operations; 300 sandboxes a month are about 45,000, inside the 1M included on Paid ([cost.md](../cost.md)).
- Time is one mechanism everywhere, and the business clock can jump forward without waiting for a platform timer.

Bad:

- **Eventual consistency between aggregates and projections.** The kitchen board and the CRM timeline lag the order by the queue's delay. The page shows the lag as part of the design; it is a feature of the demo, and each projection says how far behind it is.
- **Ordering per stream only.** Two orders' events can arrive in any order. Nothing in the domain may depend on ordering across streams.
- **A shared resource.** Every sandbox's events share one queue. A bot or a loop in one sandbox delays all the others, which is why `Control` caps events per sandbox and why the loop guard exists.
- **A poison message path.** A message that always fails reaches the DLQ after three retries and stays for 14 days. A DLQ message is a bug report.
- **A beta consumer binding.** The `queue` feature may change between `worker` releases; it is pinned with the rest ([ADR 0002](0002-rust-for-every-backend.md)).

## Door

Two-way. The application sees the Queue only through the `Outbox` port in `crates/app`, so replacing it (with direct calls, or with Workflows if Rust gains them) changes one adapter and the consumer entrypoint. Events and their `seen` tables are wiped nightly, so no history has to migrate. What hardens is the envelope's shape once the event catalog is published in [domain.md](../domain.md) and ADR 0013.

## Revisit if

- The DLQ receives a message a week on ordinary traffic, outside fault-injection controls the visitor triggers on purpose.
- Consumer lag, from `recorded_at` to a subscriber's apply, passes 5 s at p95 for a day.
- Any object hits the 100 re-arms a day guard in production.
- Queue operations per sandbox session exceed twice the cost model's 150.
- Cloudflare ships Rust support for Workflows. Then the catering saga is a candidate for a superseding record.

## Postscript 2026-11-09

As built, 2026-11-09: the consumer drains the dead-letter queue into the owning Sandbox's `dead_letters` and acks each message (`workers/api/src/queue.rs`), kept until a redrive or the wipe, so the queue holds nothing for 14 days; a `dlq` point is counted, and the 12:17 `bakery-objects` run opens an issue from `GET /v1/status`. The loop guard only stops arming and logs `alarm_guard` (`workers/api/src/objects/stream.rs`): nothing flags a sandbox `read-only`, and `Control` keeps no per-sandbox event count. A consumer batch is up to 10 messages (`max_batch_size` in `workers/api/wrangler.jsonc`), not 100; the relay sends up to 100 rows. The objects reach the Queue through `objects/stream.rs`, not through the `Outbox` port, which the native tests use. With the flag at `off` every message is retried, so events in flight reach the dead-letter queue after three tries; what `off` should do with them is a decision pending, listed in the roadmap's Remaining work. No screen shows its lag as a number.
