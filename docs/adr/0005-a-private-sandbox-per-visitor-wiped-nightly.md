# ADR 0005: A private, seeded sandbox per visitor, wiped every night, holding no personal data by construction

Status: Accepted · 2026-11-09, by delegation; as amended by the postscript below · Proposed 2026-11-04 · Deciders: Joseph Peterson

## Context

Joseph asked for three things: a sandbox people can sign in to and use; a process that wipes the databases; and a design in which it is not possible to store anyone's private data. The made-up bakery, Proof of Concept Bakery, is a business system, and business systems are full of personal data: customers' names, emails, addresses, phone numbers, card details and free-text notes. The demo has to look like one without holding any of it.

The site's lab already lives by rules that point the same way ([the site's lab.md](https://github.com/IHaveASegway/website/blob/main/docs/lab.md), [the site's security.md](https://github.com/IHaveASegway/website/blob/main/docs/security.md)): no visitor free text in its first version, synthetic data only, IP addresses stored only as a keyed hash, no demo state that outlives its session, and every object ending with `deleteAll()`.

Platform facts, as of 2026-11-04:

- A SQLite-backed Durable Object (DO) is billed per row written, at $1.00 per million past the 50M a month Paid includes, and deletes count as writes; on Free, rows written are capped at 100,000 a day ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- Point-in-time recovery keeps 30 days of history, so rows deleted by `delete_all()` can be restored for a month ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)). workers-rs does not bind it ([ADR 0002](0002-rust-for-every-backend.md)).
- A cron trigger runs for up to 15 minutes of wall time, and a Paid invocation may make 10,000 subrequests ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
- The cost model's starting estimate for one 20-minute sandbox session ([cost.md](../cost.md)): about 2,500 rows written, 2,000 of them at seed, about 2 s of DO activity to seed, and a wipe that deletes about as many rows again.

The questions this record rests on, from [product.md](../product.md): Joseph answered Q24 · Q-guest (guests allowed behind Turnstile), Q25 · Q-ttl (a nightly full wipe plus a 36 h backstop) and Q26 · Q-seed (90 days of synthetic history) on 2026-11-04, and Q45 · Q-guest-scope (what a guest may do) proceeds on its recommendation. Q14 · Q-free-text (two capped, pattern-checked fields) proceeds on its recommendation too, and this record is rewritten while Proposed if an answer differs.

## Decision

1. **One sandbox per account or guest.** A sandbox is the whole bakery for one visitor: its own `Sandbox`, `Catalog`, `Kitchen`, `Billing`, `Crm`, `Inbox` and `Simulator` objects, a `Schedule` and a `Dispatch` per day, and an `Order`, `CateringEvent` or `Customer` object per aggregate ([ADR 0003](0003-durable-objects-as-the-system-of-record.md)). A signed-in account keeps one current sandbox across devices ([ADR 0006](0006-sign-in-that-learns-nothing.md)); a guest gets one behind Turnstile, tied to the session cookie (Q24 · Q-guest, answered yes on 2026-11-04).

   **What a guest can do (Q45 · Q-guest-scope).** A guest sandbox can browse, order and pay with a test card. Sign-in unlocks the console's writes (menu edits, campaigns, publishing a route), the API token, simulated traffic and a sandbox that follows the account across devices. Guest sandboxes are capped at 100 of the 300 sandboxes a day, a tighter cap in `Control`, because Joseph worried on 2026-11-04 that bots would create hundreds of accounts or sandboxes: they hit this wall before the paid-for meters ([ADR 0010](0010-workers-paid-with-the-sites-guardrails.md)).
2. **Seeded deterministically.** `crates/seed` builds about 90 days of orders, 60 customers and 8 catering events from the sandbox's seed, so two sandboxes with one seed are identical and a bug report can name its seed (assumed until Q26 · Q-seed is answered). Seeding writes in batches inside the `Sandbox` object's first alarm. Closed history (the 90 days of past orders) is written into the ledgers and projections that show it (`Billing`, `Crm`, `Customer`); an `Order` or `CateringEvent` object exists only for work that is open or placed in the sandbox, so a sandbox holds tens of objects.
3. **Wiped every night, all of it.** A cron trigger at 10:00 UTC (03:00 Mountain standard time, 04:00 in summer; the bakery's time zone is America/Denver) calls `Control`, which lists the day's sandboxes from its ledger and tells each `Sandbox` to wipe; a running `Simulator` stops with it. That is one subrequest a sandbox, and `Control`'s cap of 300 new sandboxes a day keeps it far under the 10,000 limit. Each `Sandbox` then works in its own alarm: it calls every child in its registry in batches, each child deletes its alarm and then its storage with `delete_all()`, and when the registry is empty the `Sandbox` deletes itself and reports to `Control`. A `Sandbox` that has not reported by 10:15 UTC is retried by the next cron run and shows in the morning check. A "Wipe now" control does the same for one sandbox. The wipe emits `SandboxWiped` to `Control`'s ledger and to nothing a visitor can read afterward.
4. **A 36 h backstop on every object.** Each object, when first written, adds a `timers` row due 36 h later that runs the same cleanup. A child the nightly wipe missed, or a wipe that failed, still ends within 36 h (assumed until Q25 · Q-ttl is answered).
5. **The registry lives in the `Sandbox` object.** A child's name is recorded in the registry before the child is first written, in the same request, so the wipe can never miss a child it created.
6. **Two free-text fields, and only two.** An order note (140 characters) and a catering brief (500 characters). Both are rejected on write, with a message that says why, when they match an email, phone, card-number or URL pattern; the patterns are in [security.md](../security.md) and tested with synthetic examples. Both are visible only inside the visitor's own sandbox and are deleted with it (assumed until Q14 · Q-free-text is answered).
7. **Everything else is chosen from lists.** Customers, venues, delivery addresses and billing details are synthetic, picked from `crates/seed`'s made-up sets, and Salt Lake City appears only as the made-up bakery's map city (Joseph's choice of 2026-11-04). Delivery addresses are made up and map onto the curated places by index and label only. A visitor cannot type a customer's name, an address or a phone number anywhere.
8. **Stripe sees synthetic data only**, and the `Sandbox` deletes the Stripe objects it created where Stripe's API allows deletion, during the wipe ([ADR 0007](0007-stripe-sandbox-and-a-payment-element-that-collects-nothing.md)). Records Stripe does not let an integration delete hold only synthetic details and an opaque sandbox reference.
9. **Logs hold no identifier.** Structured logs carry `HMAC(daily salt, IP)`, the country and the continent, never the city or coordinates, as on the site. `Control` makes the daily salt in memory, never writes it to storage, and replaces it each day ([security.md](../security.md)). Automatic invocation logs are off.
10. **The morning object check.** A GitHub Actions job after the wipe lists each DO namespace's objects through Cloudflare's API and opens an issue if any sandbox object still holds data, as the site does for its lab ([operations.md](../operations.md)).
11. **The privacy page's promise**, in one sentence at `/privacy/`: every sandbox is deleted every night at 10:00 UTC, and the bakery never asks for or stores your name, email, address or card. The page also says, in a second paragraph, that Cloudflare keeps deleted storage restorable for 30 days and that the bakery never restores a sandbox.

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **A private sandbox per visitor, wiped nightly (chosen)** | Security: one visitor's input is never shown to another. Operability: one promise, one clock time, easy to verify each morning | Availability for the visitor: work is lost each night. Cost: a seed per sandbox | Chosen |
| Guests get everything signed-in visitors get | Believability: nothing to unlock, no reason to sign in | Cost and security: a bot needs only a Turnstile pass to run simulated traffic and mint API tokens, and the paid-for meters bind first | Rejected; Q45 decides |
| One shared public bakery | Evolvability of the demo: multiplayer, orders appearing live from other visitors, a bakery that feels alive | Security: one visitor's junk is everyone's, which needs moderation, and any personal datum one person types is visible to the next. Consistency: visitors' actions collide | Rejected |
| A read-only demo with a recording | Cost and security: nothing stored, no seed, no wipe | Testability of the claim: the visitor cannot try the software, which is what Joseph asked for | Rejected |
| An idle TTL of 24 h with hourly sweeps | Availability: a sandbox survives across days while in use | Operability: 24 sweeps a day instead of one, and a promise that depends on each visitor's last action ("deleted 24 hours after you last used it") is harder to state and to check | Rejected for now |
| A 7-day life | Availability: a recruiter can come back later in the week | Security: seven times the exposure of anything a visitor typed. Cost: about seven times the stored rows | Rejected |
| No free text at all | Security: the strictest; nothing a visitor types is stored except a password hash | Evolvability of the demo: an order note and a catering brief are what make the screens look like a business; without them the CRM and catering flows read as forms | Rejected, narrowly; Q14 · Q-free-text decides |
| Unrestricted free text | Believability: every field a real system has | Security: names, addresses and anything else a visitor types, stored and shown to a member of staff (also the visitor, but the promise breaks) | Rejected |

## Consequences

Good:

- The privacy page can state its promise in one sentence, and the morning check verifies it every day.
- Nothing a visitor does reaches another visitor. There is nothing to moderate.
- A sandbox's history is deterministic from its seed, so a demo can be replayed, and tests use the same seeds.

Bad:

- **Visitors lose their sandbox each night.** A sandbox created at 09:55 UTC lasts five minutes. The console shows a countdown to the wipe and a "new sandbox" control, and a signed-in visitor gets a fresh seeded one on their next visit.
- **Seeding costs rows.** About 2,000 rows a sandbox, and the wipe about as many again: roughly $0.005 a sandbox past the included 50M a month, and the reason Free would bind at about 20 sandboxes a day ([cost.md](../cost.md)).
- **The account persists and holds nothing personal.** `Account` keeps an HMAC-derived id (Google, GitHub or the demo username), a password hash for demo accounts, the current sandbox id and the day it was created.
- **Guests are the abuse surface.** A guest sandbox needs only a Turnstile pass, so the guest cap of 100 a day, the rate limit per IP hash and `Control`'s budgets are what bound a bot, and the writes, the token and simulated traffic stay behind sign-in ([ADR 0010](0010-workers-paid-with-the-sites-guardrails.md)).
- **The pattern check is a filter.** A visitor can still type a name into a note. It stays in their own sandbox, which only their session can read, and it is gone by the next 10:00 UTC.
- **The wipe is not erasure from Cloudflare's backups.** Point-in-time recovery keeps deleted rows restorable for 30 days. The privacy page says so.

## Door

Two-way for the lifetime: the wipe time, the backstop and the seed are configuration, and changing them changes no stored data. One-way for the promise once `/privacy/` publishes it: the bakery can make it stricter, but loosening it (a longer life, more free text, a shared space) needs a new record, a dated change on the privacy page, and a rewrite of every screen that says "deleted tonight".

## Revisit if

- A wipe fails to delete something for two nights in a row, by the morning check.
- The pattern check rejects more than 5% of order notes or catering briefs written on ordinary traffic, which means it is catching ordinary text.
- Visitors ask for persistence: three or more requests in a quarter, through hello@ihaveasegway.com or an issue.
- A personal datum (a real email, phone number or card number) is found in any store, log or Stripe object. Then free text is turned off by flag the same day and this record is reopened.
- Rows written for seeding exceed 4,000 a sandbox, twice the estimate.

## Postscript 2026-11-09

As built, 2026-11-09: `Billing`, when the Sandbox wipes it, deletes the Stripe objects it created, not the `Sandbox` itself (`workers/api/src/objects/billing.rs`; [architecture.md](../architecture.md#the-nightly-wipe)). The privacy page names the 30 days of point-in-time recovery, and the console shows a countdown to the wipe, as decided.
