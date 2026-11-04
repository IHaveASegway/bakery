# ADR 0003: SQLite-backed Durable Objects as the system of record: one object per aggregate, an event log and a transactional outbox

Status: Proposed · 2026-11-04 · Deciders: Joseph Peterson

## Context

The made-up bakery's state has to live somewhere, and Joseph's rule is that as much of it as possible lives in Durable Object (DO) storage. A DO is a single-threaded object with its own SQLite database, addressed by name, that runs in one place at a time. That makes it a natural home for an aggregate in the domain-driven sense: one consistency boundary, one writer, and every command against it serialized without locks. The bakery's domain ([domain.md](../domain.md)) has orders, catering events, a ledger, schedules, a menu and customers, each with its own invariants, and projections (a CRM timeline, a kitchen board, a bake list) that read across them.

Platform facts, as of 2026-11-04:

- **Pricing** ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), page updated 2026-10-18). On Paid: 1M requests a month included, then $0.15 per million, with an incoming WebSocket message counted as 1/20 of a request and outgoing messages and pings free; 400,000 GB-s of duration a month included, then $12.50 per million GB-s, billed at 128 MB per active object, and an idle object eligible to hibernate is not billed. SQLite storage, billed since 2026-01-07: 25 billion rows read a month, then $0.001 per million; 50M rows written a month, then $1.00 per million; deletes count as writes, and each `setAlarm()` is one row written; 5 GB-month stored, then $0.20 per GB-month. On Free, rows written are capped at 100,000 a day.
- **Limits** ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). 10 GB per SQLite-backed object on Paid; 500 classes on Paid; a soft limit of 1,000 requests a second per object; 30 s of CPU per request by default; a row, string or blob up to 2 MB; 100 columns; 100 bound parameters; a WebSocket message up to 32 MiB; an alarm handler up to 15 minutes.
- **Recovery** ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)). Point-in-time recovery keeps 30 days of history, so deleted rows can be restored for a month. workers-rs does not bind it ([ADR 0002](0002-rust-for-every-backend.md)).
- **Alarms** ([alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), read 2026-11-04). Each object holds one alarm at a time; the handler runs at least once and is retried with exponential backoff from 2 s, up to 6 retries.

The site's lab wrote rules for its own DOs, and they apply here ([the site's lab.md](https://github.com/IHaveASegway/website/blob/main/docs/lab.md)): SQLite-backed classes only; the Hibernation API only for sockets, with pings answered by auto-response; no timers inside an object, alarms only; alarms idempotent, re-armed only for a later time and at most 100 times a day per object; names come from the server, never the URL; every object has a cleanup alarm and ends with `deleteAll()`; handlers short. The site's Outbox Lab simulates a transactional outbox inside one object; the bakery runs one for real across fourteen classes.

## Decision

1. **SQLite-backed DOs are the system of record.** No other database holds the bakery's state. Static content (the public menu, built from the seed) is a static asset, and the Cache API holds copies only.
2. **One object per aggregate**, fourteen classes, all in `bakery-api`:

| Context | Class | One per | Holds |
|---|---|---|---|
| Platform | `Control` | the account, named `control` | flags (`live`, `read-only`, `off`), the daily ledger of sandboxes, requests and rows, the kill switch, the daily IP salt |
| Platform | `Account` | identity (HMAC of the Google `sub` or the GitHub `id`, or the demo username) | the demo password hash, the current sandbox id, the day created |
| Platform | `Sandbox` | sandbox | lifecycle, seed, the registry of child object names, the clock offset, the nightly wipe and the 36 h backstop alarm |
| Storefront | `Catalog` | sandbox | menu items, categories, prices, availability, the menu version |
| Ordering | `Order` | order | its event log, state machine, idempotency keys, the expiry alarm |
| Ordering | `Kitchen` | sandbox | the live board: hibernating WebSocket connections, the current board, fan-out |
| Scheduling | `Schedule` | sandbox and day | slots, capacities, reservations, the production plan |
| Catering | `CateringEvent` | inquiry | its event log, state machine, quote, deposit and balance, reminder alarms |
| Billing | `Billing` | sandbox | the ledger: payment intents, invoices, refunds, Stripe ids, webhook events seen |
| Fulfillment | `Dispatch` | sandbox and day | stops, the proposed and the published route plan |
| CRM | `Customer` | customer persona | the synthetic profile, preferences, consent flags, loyalty balance |
| CRM | `Crm` | sandbox | projections: customer list, timelines, segments, campaign stats; the rebuild cursor |
| CRM | `Inbox` | sandbox | the simulated mailbox: messages, opens, clicks |
| Simulation | `Simulator` | sandbox, named `simulator:<sandbox>` | the traffic rate, the running flag, the minute ledger, its alarm; on each alarm it issues ordinary commands as synthetic customers (Q40 · Q-traffic) |

3. **Events and outbox in one transaction.** A command loads the aggregate, runs `decide`, and appends the resulting events to the object's `events` table and the same rows to its `outbox` table inside one `Storage::transaction`. State is derived from `events` by `evolve` and cached in ordinary tables in the same transaction. Either all of it commits or none does. Relaying the outbox is [ADR 0004](0004-queues-between-objects-and-alarms-for-time.md). The envelope and the event catalog are in [domain.md](../domain.md).
4. **Projections live in their own objects.** `Crm` and `Kitchen` hold read models built from other objects' events, never written by a command directly. A projection can be dropped and rebuilt by replaying the source logs; the "rebuild projections" control does that with a progress bar (Q21 · Q-crm-scope), which is the Backfill Lab's principle running for real.
5. **The Hibernation API for every socket** (`State::accept_web_socket`), with pings answered without waking the object (Q15 · Q-live-board). Whether workers-rs 0.8.7 binds the auto-response is checked in spike S1; if it does not, pings are answered in `websocket_message` and the duration cost is measured.
6. **Alarms only.** No `setTimeout`-style timers. Because an object holds one alarm, each keeps a `timers` table of due work and arms the alarm for the earliest row; the handler runs every due row idempotently, then re-arms for the next. The loop guard is in ADR 0004.
7. **Names come from the server.** An object is addressed by a name the Worker builds from verified data: `sandbox:<id>` from the session, `order:<sandbox>:<ulid>` from the `Order` id the server generated. A client can never name an object into existence.
8. **Every object ends with `delete_all()`.** The `Sandbox` registry records each child name as the child is created; the nightly wipe calls each child, which deletes its alarm and then its storage, and then deletes itself ([ADR 0005](0005-a-private-sandbox-per-visitor-wiped-nightly.md)).
9. **Classes are declared in the Wrangler config** with the declarative `exports` form the site's [ADR 0009](https://github.com/IHaveASegway/website/blob/main/docs/adr/0009-lab-worker-same-origin.md) uses, never the legacy `migrations` array; confirm the exact key against Wrangler ^4.152.0 when building.

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **One object per aggregate, events and outbox per object (chosen)** | Consistency: a single writer per aggregate, so invariants hold without locks. Latency: storage is local to the code. Evolvability: each aggregate's schema changes alone | Operability: fourteen classes, cross-object work through messages, a registry to wipe. Consistency: only eventual between aggregates | Chosen |
| D1 as one central database | Operability: one schema, SQL joins across the domain, familiar migrations | Cost: every read and write is a billed query over the network. Consistency: no single-writer guarantee per aggregate, so invariants need transactions and retries. Evolvability: D1 is alpha in workers-rs. The demo's point, aggregates as objects, is lost | Rejected |
| One object per sandbox holding everything | Cost and operability: one object to seed and wipe, one transaction for any command, no queue; a modular monolith in a box | Latency: every command and every socket in a sandbox serializes behind one thread. Evolvability: it shows none of the cross-object patterns (outbox, idempotent consumers, sagas, projections) the bakery exists to show | Rejected |
| Workers KV | Cost: cheap reads at the edge | Consistency: eventually consistent, no transactions, no single writer; unfit for an order's state machine | Rejected |
| Postgres through Hyperdrive | Evolvability: a mature database and tooling | Cost: a database to run and pay for outside Cloudflare. Operability: a second system to secure and wipe. It moves the state out of DOs | Rejected |
| An event store elsewhere, DOs as caches | Consistency: one ordered log for everything | Availability: every command depends on an external service. Operability and cost: as for Postgres | Rejected |

## Consequences

Good:

- Each aggregate's invariants (a slot's capacity, an order's state, a deposit paid once) are enforced in one place, by one writer, with no distributed lock.
- An object's history is its own `events` table. A visitor can open an order and read its log, and see the outbox row waiting until it is relayed.
- Objects hibernate when idle and cost nothing while they do. A sandbox nobody touches costs storage only, and only until the night's wipe.

Bad:

- **The wipe is per object.** Nothing in the Worker lists a namespace's objects, so the `Sandbox` registry must record every child before the child is first written. A child missing from the registry is a leak until its own 36 h backstop alarm fires; the morning object check is the third net ([operations.md](../operations.md)).
- **Rows written is the meter that binds.** About 2,500 rows per sandbox session, 2,000 of them at seed, and the wipe deletes about as many again, since deletes count as writes. On Free that binds at about 20 sandboxes a day; on Paid, 50M rows a month is about 10,000 sandboxes ([cost.md](../cost.md)). Every `setAlarm` is a row, so alarms are batched through the `timers` table.
- **A class name is near one-way.** Renaming or deleting a deployed class needs a tombstone in the config, and rollback is blocked across the change.
- **Projections lag.** `Crm` and `Kitchen` show events after the Queue delivers them. Each screen shows how far behind it is, and the rebuild control replays from the logs.
- **The single thread is a ceiling.** One object serves at most about 1,000 requests a second. No bakery aggregate comes near it; a shared `Control` object is the only one every request could touch, so the Worker caches its flags for a few seconds instead of asking on every request.

## Door

Two-way for the data: every sandbox is wiped nightly, so a change to a table, an aggregate's boundary or a class's granularity ships against empty objects by the next morning. `Control` and `Account` persist and change by migration inside the object. Near one-way for class names, which carry their storage and need tombstones to retire. What hardens over time is the number of cross-object flows that assume a boundary.

## Revisit if

- Rows written per sandbox session in production exceed 5,000 (twice the cost model's 2,500) for a week.
- An object's storage passes 1 GB, a tenth of the 10 GB limit, or any object's request rate passes 100 a second, a tenth of the soft limit. Neither should happen in a sandbox wiped nightly; either would mean an aggregate is too coarse (a per-sandbox object that should be per day) or a loop.
- A class is renamed more than once, which says the boundaries were drawn before the domain was understood.
- A command needs to change two aggregates atomically more than once in [domain.md](../domain.md). Then the boundary is wrong, or the flow should be a saga with a compensation, and the choice gets its own record.
