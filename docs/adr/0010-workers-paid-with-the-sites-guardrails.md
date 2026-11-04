# ADR 0010: Workers Paid for the account, with the site's guardrails from launch day

Status: Proposed · 2026-11-04 · Deciders: Joseph Peterson

## Context

The made-up bakery, Proof of Concept Bakery, runs in Joseph's Cloudflare account and zone, the site's (Q29 · Q-account, answered yes on 2026-11-04): a Custom Domain needs its zone in the same account ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)). The plan is per account, so whatever the bakery needs, the site gets too: Joseph answered Q27 · Q-plan on 2026-11-04 with Workers Paid, and the site moves with it. His speed-first direction of the same day sets the timing: nobody uses the bakery yet, so until the launch pull request (PR 11) everything runs on `wrangler dev` at no Cloudflare cost, and the account stays on Free.

The site decided to stay on Workers Free, with guardrails built as if it were already on Paid and five upgrade triggers, any one of which moves it: a Container-backed demo; the first Error 1027 or any day above 50% of a Free daily cap; a route that needs more than 10 ms of CPU; a dated moment where demo uptime matters; email to arbitrary recipients or more than 10,000 Queues operations a day ([the site's ADR 0008](https://github.com/IHaveASegway/website/blob/main/docs/adr/0008-workers-free-with-guardrails.md), Accepted; [the site's cost.md](https://github.com/IHaveASegway/website/blob/main/docs/cost.md)). Its record also notes that budget alerts arrive the day after spend crosses them, because usage is processed once a day, that no hard spend cap exists on Paid, and that the way back to Free stays open only while every Durable Object (DO) namespace is SQLite-backed ([budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/), as of 2026-10-22).

What the bakery needs: an application with sign-in, Stripe webhooks and a nightly wipe by cron ([ADR 0005](0005-a-private-sandbox-per-visitor-wiped-nightly.md)); password hashing with `argon2` and RS256 checks of Google ID tokens in the stateless Worker ([ADR 0006](0006-sign-in-that-learns-nothing.md)); Queues for every event ([ADR 0004](0004-queues-between-objects-and-alarms-for-time.md)); a wipe that calls every child object of a sandbox. Email sends to Joseph's verified address are free on either plan (Q22 · Q-email).

Prices and limits, as of 2026-11-04 (the full sheet is in [cost.md](../cost.md)):

- **Workers Free**: $0; 100,000 requests a day; 10 ms of CPU per invocation; no overage. **Workers Paid**: $5 a month minimum per account; 10 million requests a month included, then $0.30 per million; 30 million CPU-ms included, then $0.02 per million; no spend cap; `limits.cpu_ms` per Worker ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
- **Limits**: CPU on Paid 30 s by default, up to 5 minutes; subrequests 50 per invocation on Free, 10,000 on Paid ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
- **DOs**: requests Free 100,000 a day, Paid 1 million a month then $0.15 per million; duration Free 13,000 GB-s a day, Paid 400,000 GB-s a month then $12.50 per million, billed at 0.128 GB per active object; rows written Free 100,000 a day, Paid 50 million a month then $1.00 per million, deletes counted as writes; overage rounds up to the next million for requests and GB-s ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), updated 2026-10-18).
- **Queues**: Free 10,000 operations a day; Paid 1 million a month then $0.40 per million; about 3 operations a message ([Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)).

One sandbox session of about 20 minutes, with its share of the nightly wipe, from [cost.md](../cost.md)'s meter: 150 Worker requests, 155 DO requests (35 of them the wipe's), 2,500 rows written plus about 2,500 deleted at the wipe (5,000 written in all), 21.75 DO-seconds (2.78 GB-s) and 150 Queue operations.

| Free daily cap | Per sandbox | Sandboxes a day before it binds |
|---|---|---|
| 100,000 rows written | 5,000 | **20** |
| 10,000 Queue operations | 150 | 66 |
| 100,000 Worker requests | 150 | 666 |
| 100,000 DO requests | 155 | 645 |
| 13,000 GB-s | 2.78 | 4,669 |

On Free, rows written bind first, at about 20 sandboxes a day. And `argon2` with the parameters [security.md](../security.md) sets is expected to need more than 10 ms of CPU (spike S1 measures it), which would fire the site's third trigger by itself; a bakery busy enough to pass 66 sandboxes in a day fires its fifth.

Two Cloudflare bills reported in 2026 reached five figures through the developers' own code: a DO alarm that re-armed itself for the current time, about 600 times a second for two weeks, a $10,811.41 invoice ([report](https://aiidelist.com/blog/cloudflare-10811-bill-codex-durable-objects-alarm-loop)); and a queue consumer that re-enqueued its own writes, behind a rate limiter written but never wired in, about $36,000 ([report](https://ppc.land/developer-faces-36-000-cloudflare-bill-after-queue-loop-post-says/)). Both rest on the developers' own accounts, as the site's cost.md says.

## Decision

1. **Move the account to Workers Paid in the launch pull request (PR 11)**, not before PR 2 or any earlier pull request (Q27 · Q-plan). PRs 2 to 10 deploy nothing. The Launch gate (PRs 2 to 10 merged, spike S1 passed, Joseph's end-to-end read on `wrangler dev`, the name's registry check done) comes first.
2. **Apply the site's upgrade-day checklist on launch day**, in its order:
   1. budget alerts at $10, $25, $50 and $100, under the account's ceiling of $100 a month, Joseph's answer of 2026-11-04 (Q28 · Q-budget; [budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/), as of 2026-11-04). The breaker's thresholds in item 2.4 derive from the $100 ceiling, and the designed worst case below stays $5.29, so any alert still means a guardrail failed;
   2. `limits.cpu_ms` on every Worker: on `bakery-api` a value set from spike S1's measurement of a sign-in, and on the site's lab Worker the site's own value;
   3. the zone's one rate-limiting rule, with an expression that covers both `api.bakery.ihaveasegway.com` and the site's `/lab/api/*` at one threshold, because the zone has one ([ADR 0009](0009-the-api-on-its-own-hostname.md));
   4. the 15-minute cron breaker: a scheduled handler reads usage every 15 minutes and enables the pre-built WAF kill rule on the API hostname above a threshold, with its own scoped token.
3. **A `Control` object with daily caps and budgets, as if Free's caps still applied**, sized to the bakery and charged at each meter's ceiling on admission: 300 sandboxes a day (guests capped at 100 of them, [ADR 0005](0005-a-private-sandbox-per-visitor-wiped-nightly.md)), 100 demo accounts a day, 30 minutes of simulated traffic a sandbox a day (Q40 · Q-traffic), 1.6 million rows written, 50,000 DO requests and 50,000 Queue operations a day ([cost.md](../cost.md), guardrails). Past a budget, `Control` refuses new sandboxes and serves existing ones read-only; past a second line, it sets the flag `off` ([architecture.md](../architecture.md)). The numbers live in config and change by pull request.
4. **SQLite-backed DO classes only**, so the way back to Free stays open.
5. **Record it in the site's repository.** A pull request there writes a new ADR that supersedes the site's ADR 0008 in part: the plan, and the triggers the bakery fired (the third and fifth). The site's guardrails and its bulkhead stand.

The designed worst case: every day of a 30-day month at `Control`'s cap of 300 sandboxes, 9,000 in the month, each with a full session and its wipe. Rows written reach 45 million, inside the 50 million included; DO requests 1.395 million, billed as 2 million, $0.15; Queue operations 1.35 million, $0.14; Worker requests, CPU and GB-s stay inside what is included. With the $5 fee, $5.29 a month. [cost.md](../cost.md) owns the figure, the meter behind it, and the bot and loop scenarios that the caps, the loop guard and the breaker bound.

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **A. Paid, with the site's guardrails and `Control`'s budgets (chosen)** | Availability: 300 sandboxes a day instead of 20. Latency and security: 30 s of CPU for real password hashing. A computed worst case of $5.29 a month | Cost: $5 a month, and an open tail the guardrails must bound. Operability: alerts and the breaker to build in the launch pull request, before the first visitor | Chosen |
| B. Stay on Free, with caps | Cost: a hard $0 ceiling, the only one Cloudflare offers | Availability: rows written darken every DO on the account at about 20 sandboxes a day, until 00:00 UTC; Queues at 66. Security: 10 ms of CPU forces weak hashing or WebCrypto PBKDF2. A wipe fan-out is bounded by 50 subrequests. The site's bulkhead holds, because its pages are static assets, but the site's lab darkens with the bakery | Rejected |
| C. Paid without `Control`'s budgets | Cost to build: least work | Cost: no ceiling but the breaker, which acts after the money is spent; both 2026 bills above are this shape | Rejected |
| D. A second Cloudflare account for the bakery | A quota and bill bulkhead | Feasibility: a Custom Domain on this zone needs the zone in the account, so the bakery would need another domain (Q29 · Q-account) | Rejected |
| F. A ceiling of $50 a month, as the site's own answer stood | Cost: alerts nearer the designed worst case | Operability: the thresholds trip on ordinary growth once simulated traffic and launch-day peaks arrive. Joseph set $100 on 2026-11-04 | Rejected |
| G. Paid from PR 2, with previews and deploys running while nobody visits | Testability: the pipeline is exercised early | Cost: $5 a month from the first pull request, and time spent on previews and tests for software nobody uses (Joseph, 2026-11-04) | Rejected |
| E. A usage-based platform outside Cloudflare | Some offer a spend cap | Feasibility: the bakery's state lives in Durable Objects ([ADR 0003](0003-durable-objects-as-the-system-of-record.md)), which exist only here | Rejected |

## Consequences

Good:

- $5 a month buys the bakery's ordinary month inside included usage: 300 sandboxes is 1.5 million rows written of the 50 million included.
- The site's lab gains Paid's headroom too, and its upgrade-day work is done once, for both.
- The designed worst case has a number, $5.29 a month at `Control`'s caps, rather than "no cap". A budget alert at $10 therefore means usage went around `Control`, and the $100 ceiling leaves room above the alerts for a real launch day.

Bad:

- The account fails open on cost. Alerts and the breaker must exist before the first visitor, so the launch pull request builds them and the Launch gate blocks on them, and the breaker is the only thing acting inside the day the alerts take.
- One rate-limiting rule serves two systems at one threshold.
- The site's ADR 0008 is superseded in part, and the site's pages now describe a Paid account; the site's own cost doc changes in the same pull request.
- `Control`'s budgets are estimates until real sessions are measured. Too tight refuses visitors; too loose moves the worst case.

## Door

Two-way while only SQLite-backed DOs exist, as the site's record says. Going back to Free takes minutes and needs no data migration, because sandboxes are wiped nightly; what it gives up is the 30 s CPU budget, so the hashing parameters would change with it. The money at stake either way is $5 a month and the tail the guardrails bound.

## Revisit if

- A month's usage passes $5 above the fee without traffic that explains it: a guardrail failed.
- Any budget alert fires, at $10, $25, $50 or $100.
- `Control` refuses sandboxes on a day that mattered, or its budgets trip on ordinary traffic.
- Cloudflare adds a hard spend cap to Paid, or changes the Free caps.

## Patterns and further reading

- Denial of wallet: Kelly, Glavin and Barrett, ["Denial of Wallet—Defining a Looming Threat to Serverless Computing"](https://arxiv.org/abs/2104.08031) (2021).
- Admission control and load shedding: Google, *Site Reliability Engineering*, ["Handling Overload"](https://sre.google/sre-book/handling-overload/) (2016).
