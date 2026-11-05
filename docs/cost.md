# Cost

What the system of the made-up bakery, Proof of Concept Bakery (Q2 · Q-name), costs to run, what breaks first on each Cloudflare plan under a launch, a bot or a bug, and the guardrails that keep both the bill and the breakage bounded. This doc owns the price sheet, the formulas, the per-sandbox meter, scenarios A–F, the guardrails, the launch checklist, the annual totals and denial of wallet. [ADR 0010](adr/0010-workers-paid-with-the-sites-guardrails.md) owns the plan decision ([ADR index](adr/README.md)); [architecture.md](architecture.md) owns how the objects and the Queue fit together; [operations.md](operations.md) owns the runbooks that act on these numbers.

Status: Updated in PR 4 · 2026-11-05

Prices and limits are as of 2026-11-04, with a source for every line.

## The core trade

Cloudflare's two Workers plans fail in opposite directions, as the site's [cost.md](https://github.com/IHaveASegway/website/blob/main/docs/cost.md#the-core-trade) sets out. **Free fails closed:** the bill stops at $0, each daily cap belongs to the whole account and resets at 00:00 UTC, and past it Worker routes return Error 1027 and Durable Object (DO) operations of the exhausted kind throw. **Paid fails open:** $5 a month buys included usage, then everything is metered with no spend cap, and budget alerts arrive the day after spend crosses a threshold.

The site lives on Free because a tripped cap darkens only its lab. The bakery is an application, with sign-in, a Stripe webhook endpoint, a nightly wipe and a live board in `bakery-api`, and a day of darkness on Free does three things the site never risks:

- **Stripe webhooks fail.** Stripe retries a failed delivery for up to 3 days ([Stripe webhooks](https://docs.stripe.com/webhooks)). The same page gives sandboxes a shorter schedule; until spike S3 reads it ([roadmap.md](roadmap.md)), plan for a retry window of hours and reconcile from Stripe's event list on recovery ([operations.md](operations.md)).
- **Visitors are turned away** from the one thing they came to try.
- **The nightly wipe can fail.** Deletes count as rows written; if the day's rows are spent before 10:00 UTC, the wipe cannot delete and the privacy page's promise breaks ([security.md](security.md#the-wipe)).

The storefront's pages stay static and unaffected on either plan. `bakery-web` is an assets-only Worker ([ADR 0008](adr/0008-astro-site-with-react-islands-on-an-assets-only-worker.md); the site's [ADR 0002](https://github.com/IHaveASegway/website/blob/main/docs/adr/0002-host-on-workers-static-assets.md)), and static assets are free, unlimited and never invoke a Worker ([static assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)). The public pages of Q6 · Q-public cost $0 at any traffic.

## The headline

Workers Paid for the account from launch day, the zone on its Free plan, and the site's guardrails applied in the launch pull request (PR 11), under an account ceiling of $100 a month ([ADR 0010](adr/0010-workers-paid-with-the-sites-guardrails.md); Q27 · Q-plan and Q28 · Q-budget, answered 2026-11-04). Until then nothing is deployed and the bill is $0 ([the plan decision](#the-plan-decision)). Usage stays inside the included amounts at every realistic scenario below.

| Recommended configuration | Value | Arithmetic |
|---|---|---|
| Monthly bill, scenario A (300 sandboxes, 10,000 page views) | **$5.00** | Plan minimum; usage $0 |
| Included allowances used | Worker requests 0.45%, CPU 0.9%, DO requests 4.65%, GB-s 0.21%, rows written 3.0%, Queue 4.5%, logs 0.3% | Scenario A's table |
| Year 1 | **$60.00** | 12 × $5.00 from launch day; the domain is already paid |
| The account's ceiling | $100 a month | Budget alerts at $10, $25, $50 and $100; the breaker's thresholds derive from it ([guardrails](#guardrails)) |
| First overage charge | $0.15, at about 6,450 sandboxes a month | DO requests pass 1M and round up to the next million |
| First overage dollar | At about 10,130 sandboxes a month, 34 times scenario A | Mostly rows written past 50M |
| The month at `Control`'s cap (300 a day, 9,000 a month) | $5.29 | $0.15 of DO requests + $0.14 of Queue operations; 5.3% of the ceiling |
| Scenario A with 30 minutes of simulated traffic in every sandbox | $5.00 | DO requests 11.9%, rows written 4.8%, Queue 20.9% of the included amounts ([scenario A](#a-a-quiet-month)) |

The included amounts belong to the account, and the site's lab draws on them too: about 0.3% of the rows in its quiet month ([site cost.md](https://github.com/IHaveASegway/website/blob/main/docs/cost.md), scenario A).

## Price sheet

As of 2026-11-04. The WAF row belongs to the zone plan, which stays Free either way.

| Item | Workers Free | Workers Paid ($5/month minimum per account) | Source |
|---|---|---|---|
| Worker requests | 100,000/day, reset 00:00 UTC; no overage | 10M/month, then $0.30/M | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Worker CPU | 10 ms per invocation | 30M CPU-ms/month, then $0.02/M; 30 s per invocation by default, up to 5 min; `limits.cpu_ms` per Worker | [pricing](https://developers.cloudflare.com/workers/platform/pricing/), [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Static assets | Free, unlimited, never invoke the Worker | Same; 100,000 files per version, 25 MiB each | [static assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) |
| DO requests | 100,000/day | 1M/month, then $0.15/M; an incoming WebSocket message counts 1/20; outgoing messages and pings free | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) (updated 2026-10-18) |
| DO duration | 13,000 GB-s/day | 400,000 GB-s/month, then $12.50 per million; 0.128 GB per active object | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| DO hibernation | An idle object eligible to hibernate is not billed for duration | Same | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| DO SQLite rows | 5M read, 100,000 written per day; deletes are writes; each `setAlarm()` is one row written | 25B read, then $0.001/M; 50M written, then $1.00/M | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| DO stored data | 5 GB in total, no reset; 1 GB per object (FAQ) | 5 GB-month, then $0.20/GB-month; 10 GB per object | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| Queues | 10,000 operations/day | 1M/month, then $0.40/M; one operation per 64 KB written, read or deleted (about 3 per message); a retry adds a read; batches up to 100 | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| Email Service | Sends only to verified addresses in the account, free | Beta: 3,000/month, then $0.35 per 1,000; verified-address sends free and uncounted | [Email pricing](https://developers.cloudflare.com/email-service/platform/pricing/) |
| Analytics Engine | 100,000 points and 10,000 queries/day | 10M points, then $0.25/M; 1M queries, then $1.00/M; "Currently, you will not be billed" | [AE pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) |
| Workers Logs, to 2026-11-30 | 200,000 events/day, 3-day retention | 20M events/month, then $0.60/M; 7-day retention | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Observability, from 2026-12-01 | 0.5 GB/day ingestion, 7 days | 50 GB ingestion and 10 GB-month per cycle, then $0.25/GB and $0.10/GB-month | [Observability pricing](https://developers.cloudflare.com/observability/pricing/) |
| Cron triggers | 5 per account, 15 min wall time | 250 per account | [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Turnstile | Free, unlimited | Same | [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/) |
| Rate Limiting binding | No published price; works on Free (the site's spike S4, 2026-10-23) | No published price | [site roadmap.md](https://github.com/IHaveASegway/website/blob/main/docs/roadmap.md#spikes) |
| Custom domains and certificates | 100 per zone; the certificate is issued automatically, multi-level subdomains included, without Advanced Certificate Manager; Universal SSL alone covers the apex and one level | Same | [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) |
| WAF, Free zone | 5 custom rules; 1 rate-limiting rule (IP only, 10 s period, 10 s block, as of 2026-10-22) | Same | [custom rules](https://developers.cloudflare.com/waf/custom-rules/), [rate limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/) |
| Budget alerts | The plan is the cap | Notify only, on usage (fee excluded), processed daily (as of 2026-10-22) | [budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) |
| Stripe sandbox | $0; not processed by card networks | — | [Stripe sandboxes](https://docs.stripe.com/sandboxes) |
| Google sign-in | $0 assumed: no published price; confirmed when the client is created | — | [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect) |
| GitHub sign-in | $0 assumed: OAuth apps carry no published price; confirmed when the app is created | — | [Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) |
| GitHub Actions | Free for public repositories | — | [GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |
| The domain | Paid through 2036-10-18 (the site's Q-renew) | Same | [site product.md](https://github.com/IHaveASegway/website/blob/main/docs/product.md) |

Notes:

- **Rounding.** DO requests and duration bill past the allowance in whole millions: the first request past 1M costs $0.15, the first GB-s past 400,000 costs $12.50. Per-1,000 figures below are averages.
- **Gaps, with the value to plan for** (spikes in [roadmap.md](roadmap.md)): `deleteAll()` billing, one row per row removed (S5); whether point-in-time recovery's 30 days count as storage, no (S5); whether `limits.cpu_ms` covers the Worker's DOs, yes (S1); a consumer batch counts as a Worker request (S1); Stripe's sandbox retry schedule (S3). The Rate Limiting binding counts approximately and per location, so it is never a budget.
- **Email sign-in, later** (Q43 · Q-email-signin): one send per sign-in link, inside the 3,000 a month included on Paid, then $0.35 per 1,000 (the Email Service row). Turnstile and the per-IP-hash and per-address limits bound the count ([security.md](security.md#email-sign-in-later)). Sending exists on Paid only, so it cannot ship before launch.
- Re-check on any pricing changelog entry, and yearly ([operations.md](operations.md)).

## Formulas

The site's formulas, extended with Queues, logs and the wipe. R is Worker requests (static assets excluded), c is CPU ms per request, M is 1,000,000.

```text
Workers Paid $   = 5 + max(0, R − 10M)/M × 0.30 + max(0, R × c − 30M)/M × 0.02
DO requests      = HTTP + upgrades + alarm runs + consumer deliveries + incoming frames ÷ 20
DO GB-s          = active seconds × 0.128
Rows written     = inserts + updates + deletes + setAlarm() calls + rows removed by deleteAll() (S5)
DO Paid $        = ceil(max(0, DO requests − 1M)/M) × 0.15 + ceil(max(0, GB-s − 400,000)/M) × 12.50
                 + max(0, rows written − 50M)/M × 1.00 + max(0, rows read − 25,000M)/M × 0.001
                 + max(0, GB-month − 5) × 0.20
Queue operations = messages × 3 + retries
Queues Paid $    = max(0, operations − 1M)/M × 0.40
Logs Paid $      = max(0, events − 20M)/M × 0.60                    (to 2026-11-30)
                 = max(0, GB − 50) × 0.25 + max(0, GB-month − 10) × 0.10   (from 2026-12-01)
Wipe, a sandbox  = DO requests: objects; rows written: rows held; GB-s: objects × 0.05 × 0.128
Free fails when, in one UTC day: R > 100,000, c > 10 ms, DO requests > 100,000, GB-s > 13,000,
                 rows written > 100,000, rows read > 5M, Queue operations > 10,000; or storage > 5 GB
```

**Why 0.128.** Cloudflare bills 128 MB per active object and its own example converts that as 0.128 GB; the site's [cost.md](https://github.com/IHaveASegway/website/blob/main/docs/cost.md#formulas) owns the correction.

**Assumptions:** 5 ms of CPU per stateless request; one password hash of 150 ms per sandbox ([security.md](security.md#sign-in-and-sessions)); 10 ms per DO handler run, 2 s to seed, 50 ms to wipe an object; 200 B per row; 12 KB per empty SQLite object; 500 B per log line; 30-day months.

## The per-sandbox meter

One sandbox session of about 20 minutes, then its share of the nightly wipe. As of 2026-11-04, from [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [DO](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [Queues](https://developers.cloudflare.com/queues/platform/pricing/) pricing.

| Meter, per sandbox | Session | Wipe | Total | Arithmetic |
|---|---|---|---|---|
| Worker requests | 150 | 0 | 150 | Island API calls, CORS preflights included (cached per URL) |
| Worker CPU-ms | 900 | 0 | 900 | 150 × 5 ms + 1 hash × 150 ms |
| DO requests | 120 | 35 | 155 | 35 to seed (one per object) + 60 commands and reads + 15 batched consumer deliveries + 5 alarms + 100 frames ÷ 20; wipe one per object |
| DO active seconds | 20 | 1.75 | 21.75 | 2 s seed and handler runs; wipe 35 × 0.05 s |
| DO GB-s | 2.56 | 0.22 | 2.78 | × 0.128 |
| Rows written | 2,500 | 2,500 | 5,000 | 2,000 at seed (alarms included) + 500 in use; wipe one per row removed (S5) |
| Rows read | 20,000 | 0 | 20,000 | Assumed: snapshots, menu, projections, one rebuild over 720 history events |
| Stored data, peak | ≈1 MB | to 0 | — | 35 × 12 KB + 2,500 × 200 B |
| Queue operations | 147 | 3 | 150 | 50 events × 3, `SandboxSeeded` and `SandboxWiped` included |
| Analytics Engine points | 9 | 1 | 10 | Start, seed, sign-in, admit or deny, payments, end, wipe (assumed) |
| Log events | 165 | 35 | 200 | One per Worker request and consumer batch; one per object wiped |

**Optional: with 30 minutes of simulated traffic** (Q40 · Q-traffic). Signed-in sandboxes only, at the top rate of 6 orders a minute: 180 orders, each about 8 rows, 3 Queue operations and 1 DO request (the order's event, outbox, state, lines, key and timer; one event on the Queue), the planning estimate until PR 4 measures one. Add these to the line above when a sandbox runs the full 30 minutes:

| Meter, per sandbox | Traffic | Wipe | Total | Arithmetic |
|---|---|---|---|---|
| Worker requests | 2 | 0 | 2 | Start and Stop; the ticks are alarms, not Worker requests |
| DO requests | 242 | 1 | 243 | 180 orders × 1 + 30 alarm runs + 30 Kitchen socket checks + 2 to `Control` (reserve, settle); wipe one object |
| DO GB-s | 0.31 | 0.01 | 0.32 | 242 × 10 ms = 2.42 s × 0.128 |
| Rows written | 1,500 | 1,500 | 3,000 | 180 × 8 = 1,440 + 30 `setAlarm()` rows + 30 minute-ledger rows; the wipe deletes as many |
| Queue operations | 546 | 0 | 546 | 180 events × 3 = 540, + 6 for `TrafficStarted` and `TrafficStopped` |

Rows written at seed, by object (approximate; [domain.md](domain.md) owns the seed, Q26 · Q-seed):

| Object | Instances | Rows each | Rows | Tables |
|---|---|---|---|---|
| `Sandbox` | 1 | 38 | 38 | Lifecycle, registry of 34, clock, alarm |
| `Catalog` | 1 | 106 | 106 | 5 categories, 24 items, 48 variants, 24 availability, version, events |
| `Schedule` | 7 | 46 | 322 | 32 slots, 6 windows, capacities, 5 plan lines |
| `Order` | 12 open | 10 | 120 | 3 events, state, 3 lines, key, alarm, outbox |
| `Kitchen` | 1 | 13 | 13 | Board, alarm |
| `CateringEvent` | 8 | 9 | 72 | 5 events, state, quote, 2 alarms |
| `Billing` | 1 | 107 | 107 | 90 daily totals, 16 deposits and balances |
| `Dispatch` | 1 | 13 | 13 | 10 stops, 2 plans |
| `Crm` | 1 | 942 | 942 | 720 history events (90 days × 8), 60 customers, 60 loyalty, segments, memberships, campaigns |
| `Inbox` | 1 | 241 | 241 | 240 messages |
| `Account`, `Control` | shared | — | 4 | Sandbox pointer; ledger |
| `Customer` | 0 | — | 0 | Created on first touch |
| **Total** | **34** | | **1,978** | About 2,000 |

History lives as events in `Crm`, so "rebuild projections" has a log to replay (Q21 · Q-crm-scope); 720 historic `Order` objects would add 720 DO requests and about 7,200 rows. In use, about 60 commands write about 8 rows each (event, outbox in and out, state, key, a subscriber's `seen` and projection): about 500 with alarms.

Which meter binds:

| Meter | Per sandbox | Free cap/day | Sandboxes/day at 100% | At 70% | Paid included/month | Sandboxes/month inside | Paid $ per 1,000 past it |
|---|---|---|---|---|---|---|---|
| Worker requests | 150 | 100,000 | 666 | 466 | 10M | 66,666 | 150,000 × $0.30/M = $0.045 |
| Worker CPU-ms | 900 | 10 ms each | argon2id does not fit | — | 30M | 33,333 | 900,000 × $0.02/M = $0.018 |
| DO requests | 155 | 100,000 | 645 | 451 | 1M | **6,451** | 155,000 × $0.15/M = $0.023 |
| DO GB-s | 2.78 | 13,000 | 4,669 | 3,268 | 400,000 | 143,678 | 2,784 × $12.50/M = $0.035 |
| Rows written | 5,000 | 100,000 | **20** | **14** | 50M | 10,000 | 5M × $1.00/M = **$5.00** |
| Rows read | 20,000 | 5M | 250 | 175 | 25B | 1.25M | 20M × $0.001/M = $0.020 |
| Queue operations | 150 | 10,000 | 66 | 46 | 1M | 6,666 | 150,000 × $0.40/M = $0.060 |
| Log events | 200 | 200,000 | 1,000 | 700 | 20M | 100,000 | 200,000 × $0.60/M = $0.120 |
| AE points | 10 | 100,000 | 10,000 | 7,000 | 10M | 1M | Not billed today |
| **Binding** | | | **Rows written** | | | **DO requests** | **$5.32; 94% of it rows written** |

From 2026-12-01 logs bill by volume: 200 × 500 B = 100 KB per sandbox, so Free's 0.5 GB a day holds 5,000 sandboxes and Paid's 50 GB a cycle 500,000; the Paid total per 1,000 falls to about $5.23.

- **On Free, rows written bind at 20 sandboxes a day,** half of them the previous night's wipe. Without the wipe it would be 40.
- **On Paid, DO requests run out first and cost least:** $0.15 at about 6,450 sandboxes a month, then Queues at 6,666, then rows written at 10,000.
- **Rows written are the meter to watch:** a seed twice as large halves Free's capacity and doubles Paid's marginal cost.

## Scenarios

Both plans, what fails first and what visitors see, from the [price sheet](#price-sheet) and the [meter](#the-per-sandbox-meter), as of 2026-11-04.

### A. A quiet month

300 sandboxes (10 a day) and 10,000 page views, which are static assets.

| | Free | Paid |
|---|---|---|
| Worker requests | 1,500/day: 1.5% of the cap | 45,000: 0.45% |
| DO requests | 1,550/day: 1.6% | 46,500: 4.65% |
| Rows written | 10 × 5,000 = 50,000/day: 50% | 1.5M: 3.0% |
| Queue operations | 1,500/day: 15% | 45,000: 4.5% |
| **Bill** | **$0.00** | **$5.00** |
| Fails first | Rows written on any day past 20 sandboxes; `Control` refuses the 15th | Nothing |
| Visitors see | Normal; on a 2× day the 15th is told today's sandboxes are used up until 00:00 UTC | Normal |

A quiet day on Free sits at 50% of the rows cap: the site's own upgrade trigger 2.

**If every sandbox runs the full 30 minutes of simulated traffic**, scenario A adds 300 × the [optional line](#the-per-sandbox-meter): DO requests 300 × 243 = 72,900 (7.3% of 1M, 11.9% with the base 46,500); rows written 300 × 3,000 = 900,000 (1.8% of 50M, 4.8% in total); Queue operations 300 × 546 = 163,800 (16.4% of 1M, 20.9% in total); DO GB-s 300 × 0.32 = 96 (0.02% of 400,000); Worker requests 600 (0.006% of 10M). The bill stays **$5.00**. If a simulated order costs five times the estimate, Queue operations reach 85.7% and DO requests 33.5% of the included amounts, still $5.00; Queue operations are the meter to watch.

### B. A launch day

2,000 sandboxes in 24 hours and 100,000 page views, on top of scenario A. At `Control`'s default cap of 300, 1,700 visitors (85%) are refused and the month is 600 sandboxes; the launch runbook raises the cap to 2,500 for the day ([operations.md](operations.md)), and the Paid column assumes it.

| | Free | Paid, cap raised |
|---|---|---|
| Worker requests that day | 300,000 wanted; the cap trips after about 666 sandboxes' worth | 300,000 |
| DO requests that day | 310,000 wanted | 310,000: 31% of the month's 1M |
| Rows written that day | 2,000 × 2,500 = 5M wanted, 50× the cap; the wipe's 5M lands on the next UTC day | 5M, then 5M at the wipe |
| Month | — | 2,300 sandboxes: DO requests 35.7%, rows 23%, Queue 34.5%, Worker 3.5%, CPU 6.9% |
| **Bill** | **$0.00** | **$5.00** |
| Fails first | `Control` at 14; without it, rows at 40, then every DO write on the account until 00:00 UTC | Nothing |
| Visitors see | 1,986 of 2,000 (99.3%) refused; pages unaffected | Normal |

Three launch days fit in a Paid month; the fourth costs $0.15. Stripe's sandbox rate limits ([Stripe](https://docs.stripe.com/rate-limits)) may bind first; spike S3 reads them.

### C. A bot creating sandboxes

One request a second for 24 hours: 86,400. Each bot sandbox is seeded, never used, then wiped: 1 Worker request, 70 DO requests (35 + 35), 4,000 rows (2,000 + 2,000), 0.48 GB-s (3.75 s × 0.128), 6 Queue operations, about 1 MB until the wipe. Scenario A runs alongside.

With no controls (every request seeds a sandbox):

| | Free | Paid, 1 day | Paid, 30 days unnoticed |
|---|---|---|---|
| DO requests | Capped | 6.09M, 5.09M past 1M, billed as 6M: $0.90 | 181.4M: $27.15 |
| Rows written | Cap reached after 50 bot sandboxes, 50 s | 347.1M − 50M = 297.1M: $297.10 | 10,369.5M − 50M: $10,319.50 |
| DO GB-s | Inside | 42,307: $0 | 1.24M, one step past 400,000: $12.50 |
| Queue operations | Capped at 10,000 | 563,400: $0 | 15.6M: $5.84 |
| Stored data | Writes fail first | 86 GB at peak, each held about half a day: 1.44 GB-month, $0 | About 43 GB all month: $7.60 |
| **Bill** | **$0.00** | **$303.00** | **About $10,380** |
| Visitors see | No sandbox all day, here and in the site's lab | Normal | Normal |

The damage rate is $14.44 an hour: 3,600 × 4,000 = 14.4M rows ($14.40) plus 252,000 DO requests. The $10, $25, $50 and $100 alerts all arrive on the second day, after about $347 of usage (24 × $14.44).

With the planned controls:

| Control | Free | Paid, 1 day | Paid, 30 days |
|---|---|---|---|
| Turnstile: no valid token, so the Worker refuses after siteverify in about 1 ms and no DO runs | 86,400 Worker requests, under the cap | $5.00 | 2.64M Worker requests: $5.00 |
| Plus the Rate Limiting binding per IP hash, for one address buying Turnstile solutions | Bounded per address | $5.00 | $5.00 |
| Plus `Control`'s cap, for a botnet that solves Turnstile | 14 bot sandboxes in 14 s; visitors refused for the day | 300: 1.2M rows, $5.00 | 9,000 a month, even with full sessions: **$5.29** |

The cap turns a denial of wallet back into a denial of service ([security.md](security.md#threat-model)).

### D. A loop with no outside traffic

An alarm that re-arms itself for now, or a consumer that re-enqueues its own events, runs for 2 hours before the 15-minute breaker trips (its interval, the analytics delay and a person reading the email). No visitor is involved; the WAF sees nothing.

| Loop, one object or consumer, Paid | Arithmetic per hour | $ per hour |
|---|---|---|
| Alarm at 600 runs a second (the [reported](https://aiidelist.com/blog/cloudflare-10811-bill-codex-durable-objects-alarm-loop) rate), alarm and state rows only | 2.16M DO requests ($0.32) + 4.32M rows ($4.32) + 460.8 GB-s ($0.006) | $4.65 |
| The same alarm appending an event each run | + 4.32M outbox rows ($4.32) + 6.48M Queue operations ($2.59) + 4.32M subscriber rows ($4.32) | $15.88 |
| Consumer re-enqueueing with new ids at an assumed 1,000 messages a second | 10.8M Queue operations ($4.32) + 7.2M subscriber rows ($7.20) + batched deliveries and batch invocations ($0.04) | $11.56 |
| The same with 12 unbatched writes per message, as in the [second report](https://ppc.land/developer-faces-36-000-cloudflare-bill-after-queue-loop-post-says/) | 43.2M rows ($43.20) + $4.32 + $0.04 | $47.56 |

Two hours of the worst row cost $95.12. A bug in a class every sandbox holds loops in every live sandbox at once: two hours at $15.88 cost $318 on a quiet day (10 live) and $63,520 on a launch day (2,000). On Free the same loop spends the day's rows in 1.4 minutes (100,000 ÷ 1,200 a second) and darkens every DO on the account, at $0.

What stops it: the loop guard bounds each object to 100 re-arms a day, about 400 rows; 2,000 sandboxes × 35 objects at that bound is 28M rows, inside the 50M. The consumer holds no producer for `bakery-events`, by type ([architecture.md](architecture.md)). For an internal loop the breaker sets `Control` to `off`; the consumer reads it (cached 60 s) and stops routing, so messages drain to `bakery-events-dlq` after 3 retries. Alarms need the guard or a deploy: no edge control reaches them ([operations.md](operations.md)).

### E. The nightly wipe

300 sandboxes a night, the cap every night (9,000 a month). Deletes are writes.

| Per night | Arithmetic | Free | Paid, 30 nights |
|---|---|---|---|
| DO requests | 300 × 35 = 10,500 | 10.5% of the cap | 315,000: 31.5% |
| Rows written | 300 × 2,500 = 750,000 | 7.5× the cap: the wipe cannot finish | 22.5M: 45% |
| DO GB-s | 300 × 1.75 s × 0.128 = 67.2 | 0.5% | 2,016: 0.5% |
| Queue operations | 300 × 3 = 900 | 9% | 27,000: 2.7% |
| **Bill** | | **$0.00, and the wipe fails** | **$0; past the included amounts, $2.50 per 1,000 sandboxes** |

On Free at 20 a day the wipe writes 50,000 rows at 10:00 UTC, half the new day's cap, so `Control` reserves them before admitting the day's first sandbox. If a bot or a bug spends the rows first, the wipe and the backstops fail: on Free the privacy promise depends on quota. The cron run has 15 minutes of wall time, so `Control` fans out by its own alarm in batches of 50, and each `Sandbox` wipes its children ([architecture.md](architecture.md)). If `deleteAll()` bills one row per object (S5), the wipe costs 35 rows per sandbox and Free holds 39 sandboxes a day.

### F. An idle month

0 sandboxes. The crons still run: 30 wipes that find nothing and 2,880 breaker runs, each one Worker request, one `Control` request and about one row: 2,910 Worker requests (0.03%), 2,910 DO requests (0.3%), about 2,940 rows. The morning object check runs in GitHub Actions, free for a public repository. **Free $0.00; Paid $5.00**, the floor, plus nothing.

## The plan decision

Workers Paid for the account, from launch day, with the guardrails below; the rationale, alternatives and Revisit if are in [ADR 0010](adr/0010-workers-paid-with-the-sites-guardrails.md) (Q27 · Q-plan). The account is the site's (Q29 · Q-account), so the move fires the Revisit if of the site's [ADR 0008](https://github.com/IHaveASegway/website/blob/main/docs/adr/0008-workers-free-with-guardrails.md), and the site records a superseding ADR in its own repository.

**Nothing is deployed until the launch pull request (PR 11)** (Q44 · Q-posture, speed first until launch). Until then the account stays on Free, as the site is today, and the bakery bills $0. Local development on `wrangler dev` runs the Worker, its DOs and its Queue locally ([local development](https://developers.cloudflare.com/workers/development-testing/), as of 2026-11-04) and has no Cloudflare cost. The upgrade, the $5 fee and every guardrail below that needs a deployed Worker or the zone arrive in that pull request.

Free stays the fallback if the decision is ever reversed. What it allows:

- **About 20 sandboxes a day, bound by rows written**, 14 inside `Control`'s 70%, half the rows reserved for the wipe.
- **Queues at 10,000 operations a day**: 66 sandboxes, not binding before rows.
- **No email sends** but to verified addresses; no change, since mail lands in the sandbox's inbox screen (Q22 · Q-email), but no email sign-in either.
- **10 ms of CPU in the stateless Worker**: demo passwords fall back to PBKDF2 through WebCrypto ([security.md](security.md#sign-in-and-sessions)).
- **Caps shared with the site's lab**, which a busy bakery day darkens too.

On Free the bakery serves 14 people a day; on Paid, 300, for $60 a year.

## Guardrails

Each control arrives with the work that needs it, in Q37 · Q-order-of-work's phases ([roadmap.md](roadmap.md)); a control that needs a deployed Worker or the zone arrives in the launch pull request (PR 11), since nothing runs in Cloudflare before it. Limits as of 2026-11-04.

| When | Control | Setting | Protects |
|---|---|---|---|
| Launch (PR 11) | Budget alerts | $10, $25, $50 and $100 of usage, the last the account's ceiling (Q28 · Q-budget); the fee is excluded, so any alert means a guardrail failed | Notice within a day |
| Foundation | `limits.cpu_ms` on `bakery-api` | 300 ms, twice an estimated 150 ms argon2id hash, raised only from a spike S1 measurement; `bakery-web` runs no code, so it has nothing to bound | CPU runaway |
| Launch (PR 11) | The zone's rate-limiting rule on `api.bakery.ihaveasegway.com` | IP, 10 s period, 10 s block; for example 50 per period | Dollars per flooding IP |
| Launch (PR 11) | A disabled WAF custom rule blocking the API hostname (kill switch L3) | 1 of 5 Free custom rules | Outside traffic, if WAF runs first (the site's spike S2, pending) |
| Launch (PR 11) | The 15-minute cron breaker in `bakery-api`: reads metered usage from analytics, sets `Control` to `read-only` or `off`, enables the WAF kill rule, emails Joseph's verified address; detaching the custom domain (L4) follows by hand ([operations.md](operations.md)) | Each meter at 4× its 15-minute share of `Control`'s budget, or usage priced past $100 ÷ 2,880 runs = $0.035 in one window, the rate that would spend the ceiling in a month | The alerts' day of lag; loops |
| Foundation | No KV: counters and flags in `Control`'s SQLite or memory | CI fails on a `kv_namespaces` binding | The costliest write on the sheet |
| Foundation | Batch writes: events and outbox in one transaction per command; the relay sends batches | — | The 12-writes-per-message multiplier |
| Auth, sandbox and wipe | `Control`'s daily caps and budgets, charged at the meter's ceiling on admission; if `Control` errors, no sandbox | Sandboxes 300, of which guests 100 (Q45 · Q-guest-scope); demo accounts 100; rows 1.6M; DO requests 50,000; Queue operations 50,000. On Free, 70% of each cap, the wipe's rows reserved first | $5.29 a month at most |
| Auth, sandbox and wipe | Turnstile before a sandbox or demo account | Single-use token, verified server-side | The costliest request |
| Auth, sandbox and wipe | Rate Limiting binding per session and per IP hash | Sandbox creation 1 per 60 s per IP hash; commands 60 per 60 s per session or per API token; upgrades 6 per 60 s | One sender's churn; never a budget |
| Auth, sandbox and wipe | The session cookie or the API token: no object is addressed without one | 24 h ([security.md](security.md#sign-in-and-sessions)) | Objects created by strangers |
| Auth, sandbox and wipe | An object its `Sandbox` has not initialized refuses every request and writes nothing | — | Objects summoned after the wipe or by a guessed name |
| Auth, sandbox and wipe | Cleanup: each object's 36 h backstop alarm, then `deleteAll()`; the 10:00 UTC wipe | Q25 · Q-ttl | Storage and the privacy promise |
| Auth, sandbox and wipe | Alarm loop guard: re-arm only for a later time, at most 100 times a day per object | Counted in the object's SQLite | Scenario D |
| Kitchen board | Hibernation API only (`State::accept_web_socket`), auto-response pings, no timers in objects | A lint fails a timer | Idle duration: 11,059 GB-s a day per non-hibernating socket |
| Kitchen board | The consumer holds no producer; DLQ after 3 retries | — | Queue loops |
| Kitchen board and simulated traffic (PR 4) | The `Simulator`'s caps: signed-in sandboxes only; runs only while the console's socket or heartbeat is live; reserved in `Control`'s ledger at its ceiling, designed to be charged to the daily budgets above. As built in PR 4 (2026-11-05), minutes are charged to `Control`'s new `traffic(day, sandbox, minutes)` ledger only; the DO-request and Queue budgets are not metered by `Control` yet, and PR 11's breaker reads the account's analytics instead | 6 orders a minute; 30 minutes a sandbox a UTC day; stopped by the wipe. On a day at the 300-sandbox cap the Queue budget leaves room for about 9 full runs (5,000 ÷ 546) | A load generator of our own making: about $0.0033 of meters per run at overage prices, 92% of it rows, and the designed worst month stays $5.29 |
| Payments | Stripe sandbox key guard in CI and the Worker | Any non-sandbox key refused; payment routes answer 503 ([security.md](security.md#payments-safety)) | Real money moving at all |

At `Control`'s caps the worst designed month is $5.29, 5.3% of the $100 ceiling, so a $10 alert means usage went around `Control`: a loop, a ledger bug, or a meter this doc counts wrong. That is why the breaker reads the account's real usage from analytics and not `Control`'s counters.

<a id="the-upgrade-day-checklist"></a>

## The launch checklist

The site's checklist, applied in the launch pull request (PR 11) on launch day, before `bakery-api` serves its first sandbox, in order:

1. The Launch gate passed: PRs 2 to 10 merged, spike S1 passed, Joseph's end-to-end read on `wrangler dev`, the name's registry check done. Q27 · Q-plan and Q28 · Q-budget were answered on 2026-11-04; [ADR 0010](adr/0010-workers-paid-with-the-sites-guardrails.md) Accepted; the site's superseding ADR merged.
2. Upgrade the account; record the date in [ADR 0010](adr/0010-workers-paid-with-the-sites-guardrails.md).
3. Budget alerts at $10, $25, $50 and $100.
4. Deploy `bakery-api` with `limits.cpu_ms`, and see it in the dashboard.
5. The rate-limiting rule on the API hostname and the disabled WAF kill rule, tested first on a throwaway path (the site's spike S2).
6. The cron breaker with its own token ([security.md](security.md#secrets-inventory)), its dollar threshold derived from the $100 ceiling; force one trip with zero thresholds, then restore them.
7. `Control`'s budgets to their Paid values; until now they keep the Free sizes.
8. The site's own Paid guardrails on its lab Worker, which its docs own.
9. Next day, the billable-usage dashboard shows only the $5 plan; any line that scenario A does not explain is a guardrail failure.

## Annual totals

Year 1 runs from launch day, the launch pull request (PR 11). Until then the account stays on Free and the bakery bills $0.

| Item | Paid path | Free path |
|---|---|---|
| Workers plan | $60.00 | $0 |
| Usage at scenarios A, B and F | $0 | $0, at about 14 sandboxes a day |
| The domain, paid through 2036-10-18 (the site's Q-renew) | $0 | $0 |
| Certificates (Custom Domains), GitHub Actions (public), Stripe sandbox, Google and GitHub sign-in (assumed), Turnstile, Analytics Engine | $0 | $0 |
| **Year 1** | **$60.00** | **$0.00** |

The $60 is the account's and covers the site too. The first overage dollar needs about 10,130 sandboxes in a month, which `Control`'s cap does not allow.

## Weaker designs

The site's list holds ([site cost.md](https://github.com/IHaveASegway/website/blob/main/docs/cost.md#weaker-designs)): Worker-rendered HTML, a rate limiter inside the Worker as the only defense, a KV kill flag, and KV counters at $5.00 per million writes (as of 2026-10-22, [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)). The bakery adds:

- **D1 as the central store.** Every sandbox queues behind one writer, every read is billed against a shared database, the wipe becomes `DELETE`s against live data, and storage costs $0.75 per GB-month against $0.20 (as of 2026-10-22, [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)). The workers-rs binding is alpha, and [ADR 0003](adr/0003-durable-objects-as-the-system-of-record.md)'s object per aggregate is lost.
- **KV sessions.** Each sign-in spends one of Free's 1,000 daily writes, and a sign-out can take 60 s or more to reach other locations ([how KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). A signed cookie needs no storage.
- **Workflows for the catering saga.** JavaScript and TypeScript only ([ADR 0002](adr/0002-rust-for-every-backend.md) is Rust); $0.80 per 100,000 steps past 500,000 ([Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)), where an alarm costs one row.
- **A container for the solver.** Paid-only; the site priced one at $5.23–$7.61 a month for 300 solves ([site cost.md](https://github.com/IHaveASegway/website/blob/main/docs/cost.md), scenario E). VROOM in the browser costs $0 and Clarke–Wright runs in milliseconds in `Dispatch` ([ADR 0012](adr/0012-delivery-dispatch.md)).
- **Polling the kitchen board.** A 5 s poll is 240 Worker and 240 DO requests a session, against 1 upgrade and 5 billed request-equivalents for the socket, whose outgoing updates are free. A forgotten polling tab makes 17,280 of each a day: 6 spend Free's Worker cap; one for a month uses 52% of Paid's DO requests.

## Denial of wallet

Denial of wallet is an attack on the bill rather than on availability. Kelly, Glavin and Barrett (2021) define it as "forced financial exhaustion" of a serverless account: the platform absorbs the load and sends the invoice. Cloudflare recommends capping CPU per invocation "to prevent accidental runaway bills or denial-of-wallet attacks" ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). On Free it turns back into a denial of service. On Paid there is no ceiling, only the guardrails, and an attacker aims at the meters that cost most per request: sandbox creation ($14.44 an hour unguarded, scenario C), sockets held open on the standard API (1,000 for 72 h cost $412.50, the site's scenario D3; here, hibernation only and 4 per sandbox), alarms ($15.88 an hour per looping object) and Queue re-enqueueing ($11.56–$47.56 an hour per consumer, scenario D).

The author's own code is the likelier culprit. In both five-figure Cloudflare bills reported in 2026, it was the cause or the multiplier:

- A DO alarm handler that re-armed itself for the current time ran about 600 times a second from 2026-09-23 to 2026-10-06: a $10,811.41 invoice, of which $10,701.41 was refunded after escalation. The loop needed no outside traffic ([report](https://aiidelist.com/blog/cloudflare-10811-bill-codex-durable-objects-alarm-loop)).
- Bot traffic, which a rate limiter written but never wired in should have stopped, met three multipliers: a queue consumer that re-enqueued its own writes (5 to 10 round trips each), 12 unbatched `storage.put()` calls per write, and a full KV key scan on about 95% of requests. One month produced 3.13 billion KV writes ($15,635, the largest line) in a bill reported at about $36,000 ([report](https://ppc.land/developer-faces-36-000-cloudflare-bill-after-queue-loop-post-says/)).

Both reports rest on the developers' own posts. The bakery holds both shapes, alarms in every aggregate and a Queue between them, and at 600 runs a second one object makes 51.8 million calls before a daily alert can arrive. The guard bounds each object, the missing producer removes the second loop, batching removes the multiplier, and the breaker bounds the rest.

## Patterns and further reading

- Bulkhead (pages and the API on separate meters): Microsoft Azure Architecture Center, ["Bulkhead pattern"](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead).
- Admission control and load shedding (Turnstile, the cookie, `Control`): Google, *Site Reliability Engineering*, chapter 21, "Handling Overload".
- Circuit breaker (the cron breaker, the WAF kill rule): Martin Fowler, ["CircuitBreaker"](https://martinfowler.com/bliki/CircuitBreaker.html).
- Lease and TTL (the wipe, the 36 h backstop): Gray and Cheriton, "Leases" (SOSP 1989).
- Fail-safe default (`Control` errors refuse a sandbox): Saltzer and Schroeder, ["The Protection of Information in Computer Systems"](https://web.mit.edu/Saltzer/www/publications/protection/Basic.html) (1975).
- Transactional outbox and idempotent consumer: Chris Richardson, [microservices.io](https://microservices.io/patterns/data/transactional-outbox.html).
- Fitness function (CI's checks on `limits.cpu_ms`, KV and timers): Ford, Parsons, Kua and Sadalage, *Building Evolutionary Architectures*, 2nd ed., chapter 2.
- Denial of wallet: Kelly, Glavin and Barrett, ["Denial of Wallet—Defining a Looming Threat to Serverless Computing"](https://arxiv.org/abs/2104.08031) (2021).
