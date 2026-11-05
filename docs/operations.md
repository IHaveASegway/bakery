# Operations

How Proof of Concept Bakery, the made-up bakery, is set up, watched and repaired by one person: access setup, observability, alerting, runbooks and the maintenance calendar. It follows the site's [operations.md](https://github.com/IHaveASegway/website/blob/main/docs/operations.md), and the two share an account, a zone and a time budget. Each runbook is a short numbered list for use under stress. The pipeline these runbooks drive is in [delivery.md](delivery.md); the secrets inventory, the wipe's design and the privacy rules are in [security.md](security.md); prices and the kill switch's design are in [cost.md](cost.md).

Status: Updated in PR 3 · 2026-11-05

Prices, limits and versions are as of 2026-11-04, with sources. Steps that depend on a console's current labels say "confirm when building". A Durable Object (DO) is the unit that holds state; every DO class here is SQLite-backed.

## Access setup

Speed first until launch (Q44 · Q-posture) changes the order: steps that need the account, the deploy token, the zone or Workers Paid wait for the launch pull request, PR 11, and nothing is deployed before it. **PR 2, what local development needs:** step 9 (hooks and the private firewall file), step 3 (the Stripe sandboxes), step 4 (the Google OAuth client, in testing status), step 10 (the GitHub OAuth app), step 5 (Turnstile's test keys only), and the local half of step 6 (`.dev.vars`). **PR 11, launch day:** steps 1, 7 (secrets and the ruleset's `e2e` check), 8 and 2, then the production half of steps 3, 4, 5, 6 and 10, in the order of the [Launch runbook](#launch). **Later:** step 11, the Email Service sender (Q43). The bakery's name, Proof of Concept Bakery, is decided (Q2, 2026-11-04). Three rules apply, as on the site: never a Global API Key; no Cloudflare credential in a shell startup file; never `wrangler login`. The laptop gets short-lived tokens as in the site's [step 2](https://github.com/IHaveASegway/website/blob/main/docs/operations.md#2-short-lived-tokens-for-inspection-and-one-off-changes-as-needed).

### 1. The deploy token

Created on launch day, PR 11; nothing before it needs one. One account-owned token (prefix `cfat_`) for `preview`, `deploy`, `rollback` and `preview-cleanup`, both Workers ([ADR 0011](adr/0011-github-actions-owns-deploys-for-both-workers.md)). It is a new token, not the site's, so a leak in one repository does not reach the other.

1. Dashboard → Manage account → Account API tokens → Create Token → custom, named `github-actions-bakery-deploy`.
2. Permissions: the site's four (Account: Workers Scripts Edit and Account Settings Read; Zone `ihaveasegway.com`: Workers Routes Edit and Zone Read), plus two assumed ones, Account: Queues Edit (creating `bakery-events` and `bakery-events-dlq`) and Zone: DNS Edit (a second Custom Domain adds a record). PR 11's first deploy confirms them, as the site's spike S7 confirmed its four ([site roadmap](https://github.com/IHaveASegway/website/blob/main/docs/roadmap.md#spikes)). If a command fails, add only the permission the error names, record it here and in the [secrets inventory](security.md#secrets-inventory), and remove any the final run did not use.
3. Zone resources: Specific zone `ihaveasegway.com`. Leave Client IP Address Filtering empty: GitHub's runners share address ranges and GitHub advises against allowlisting them ([GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).
4. TTL: an end date 12 months out, read as 00:00 UTC ([token restrictions](https://developers.cloudflare.com/fundamentals/api/how-to/restrict-tokens/)). Put it in the [maintenance calendar](#maintenance-calendar) with a reminder 30 days ahead.
5. Store it from a prompt, not shell history ([gh](https://cli.github.com/manual/gh_secret_set)): `gh secret set CLOUDFLARE_API_TOKEN --repo IHaveASegway/bakery`, and the same for `CLOUDFLARE_ACCOUNT_ID`, which is an identifier but kept secret because this repository's logs are public. `wrangler.jsonc` carries no `account_id`.
6. Verify with PR 11's first deploy from `main`, not by exporting the token.

### 2. Workers Paid and the budget alerts

On launch day, before PR 11's first deploy (Q27 · Q-plan, [ADR 0010](adr/0010-workers-paid-with-the-sites-guardrails.md)). Workers Paid is $5 a month minimum per account with no spend cap ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), as of 2026-11-04). The plan is per account, so the site moves to Paid with the bakery. It fires the site's ADR 0008 "Revisit if", so the site's superseding ADR is merged first. The order is [cost.md](cost.md)'s upgrade-day order: guards first, then code.

1. Upgrade, and write the date in an issue.
2. $100 ceiling: alerts at $10, $25, $50 and $100 (Q28 · Q-budget, Joseph's answer of 2026-11-04, for the account, the site included). The breaker's thresholds derive from $100, and the designed worst case stays $5.29 at `Control`'s caps ([cost.md](cost.md)), so any alert means a guardrail failed. They are computed daily on cumulative spend and only notify, so expect a day's lag ([budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)).
3. `limits.cpu_ms` in both configs (PR 11). Confirm the argon2id hash's CPU in Workers Logs on the first sign-in: spike S1 timed it only locally.
4. The zone's rate-limiting rule on the API hostname. A Free zone has 1 such rule and 5 custom rules ([WAF custom rules](https://developers.cloudflare.com/waf/custom-rules/)), and the site's lab plan wants the same one for its path, so PR 11 writes a single rule whose expression matches both and each repository's docs name it.
5. The L3 rule, created and disabled ([kill switch](#kill-switch-l0-to-l4)).
6. The 15-minute cron breaker, whose Cloudflare token is the Worker secret `BREAKER_API_TOKEN`, scoped to reading analytics and editing that zone's rules (confirm the names when building), with the deploy token's end date.

### 3. The Stripe sandbox

Q17 · Q-psp, Q20 · Q-stripe-account, [ADR 0007](adr/0007-stripe-sandbox-and-a-payment-element-that-collects-nothing.md). No live key is ever created for this repository.

Created in PR 2, because local development needs the keys; the production webhook comes on launch day.

1. Use the test-mode sandbox Stripe gives the account: an isolated test environment with its own keys and webhooks, free, not processed by card networks ([Stripe](https://docs.stripe.com/sandboxes), as of 2026-11-04). Stripe refuses a second sandbox until the business is verified (seen in the dashboard on 2026-11-04), and a made-up bakery has nothing to verify, so this is the only one and it is never deleted.
2. A restricted key named `bakery-api-local`, with Write on payment intents, customers, invoices, and charges and refunds, and nothing else, becomes `STRIPE_SECRET_KEY` in `.dev.vars` (created 2026-11-04). At launch, a separate key with the same permissions becomes the Worker secret. The publishable key, public by design, is `STRIPE_PUBLISHABLE_KEY`.
3. Locally, the Stripe CLI forwards events to `wrangler dev` and prints a signing secret for `.dev.vars` ([Stripe CLI](https://docs.stripe.com/stripe-cli), as of 2026-11-04). At launch, a webhook endpoint at `https://api.bakery.ihaveasegway.com/v1/stripe/webhook`; its signing secret becomes `STRIPE_WEBHOOK_SECRET`. Signatures are HMAC-SHA256 over `t.payload` with a 5-minute tolerance ([Stripe](https://docs.stripe.com/webhooks#verify-manually)).
4. A second restricted key in the same sandbox, `bakery-ci-e2e`, with the same permissions: the GitHub secret `STRIPE_E2E_SECRET_KEY`, set on 2026-11-04 for the `e2e` job that arrives in PR 11. Stripe recommends a separate sandbox for automated tests, which the refusal above rules out, so CI and local work share test data, and `e2e` asserts only on objects it created. Test cards only ([Stripe testing](https://docs.stripe.com/testing)).

### 4. The Google OAuth client

[ADR 0006](adr/0006-sign-in-that-learns-nothing.md): the `openid` scope alone, so the API receives `sub` and no email. [S2](roadmap.md#spikes) passed on 2026-11-05: Google accepts it. Google's docs still describe `openid` alone as invalid, so the callback also drops `email`, `email_verified`, `name` and `picture` if they ever appear. A client in production status was not tested; check it on launch day.

Created in PR 2 in testing status, with Joseph as its test user, for local development; published on launch day.

1. A Google Cloud project named Proof of Concept Bakery. Console labels move; confirm when building.
2. Consent screen: External; the app name; privacy page `https://bakery.ihaveasegway.com/privacy/`; authorized domain `ihaveasegway.com`; `hello@ihaveasegway.com` as the developer contact. The user support email offers only the signed-in account's own address or a Google Group it manages (as of 2026-11-04), so in testing status it is that account's address, which only test users see. Before publishing, it moves to `hello@ihaveasegway.com`, because the screen then shows it to every visitor: a Google account on that address, verified through Email Routing, can select itself (Joseph's decision of 2026-11-04). A free Google Group would end in `@googlegroups.com` and would not match.
3. Scopes: `openid` only. No sensitive scope is requested, so no verification review is needed ([Google](https://developers.google.com/identity/openid-connect/openid-connect), as of 2026-11-04; confirm the current rule). Publish the screen to production at launch, once the privacy page is live, so any Google account can sign in.
4. An OAuth client of type Web application, redirect URIs `http://127.0.0.1:8788/v1/auth/google/callback` for local development and `https://api.bakery.ihaveasegway.com/v1/auth/google/callback`, both registered on 2026-11-04 (paths assumed until ADR 0013, written in PR 10). The client secret becomes `GOOGLE_CLIENT_SECRET`; the client id is public and goes in `vars`. The local URI is what PR 3's Worker sends when `API_ORIGIN` is `http://127.0.0.1:8788`.
5. Validate ID tokens locally against the `jwks_uri` keys; `tokeninfo` is for debugging only.

### 5. Turnstile

Free and unlimited ([Turnstile plans](https://developers.cloudflare.com/turnstile/plans/), as of 2026-11-04). Before launch, Turnstile's test keys only, in `.dev.vars` (confirm when building). At launch, a managed widget for `bakery.ihaveasegway.com`; the site key is public, the secret is `TURNSTILE_SECRET`; local runs and CI keep using the test keys. It gates guest sandbox and demo-account creation only; a signed-in account is capped at 3 sandboxes a day instead.

### 6. Worker secrets

Locally they live in `.dev.vars`, git-ignored, with names in `.dev.vars.example`. From launch day they are set with `wrangler secret put <NAME> --name bakery-api` from a short-lived token or the dashboard; never in the repository. [security.md](security.md#secrets-inventory) owns the inventory and wins if this list differs.

| Secret | Holds | Rotation |
|---|---|---|
| `SESSION_HMAC_KEY`, `SESSION_HMAC_KEY_PREV` | HMAC key for the 24 h session cookie and for the per-sandbox API tokens (Q42; same claims, `Authorization: Bearer`, so no new secret), and the old key during rotation | With overlap |
| `ACCOUNT_HMAC_KEY` | Key for `HMAC(secret, sub)` and `HMAC(secret, github id)`, the account id | On compromise only: it orphans Google and GitHub accounts |
| `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `TURNSTILE_SECRET` | The Google client secret; the GitHub OAuth app's client secret (its client id is public and goes in `vars`); Turnstile's server secret | Yearly or on exposure |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | The restricted sandbox key; the endpoint secret | Yearly, at a reset, or on exposure |
| `BREAKER_API_TOKEN` | The cron breaker's Cloudflare token | With the deploy token |

The local-only provider overrides (`GOOGLE_ISSUER`, `GITHUB_AUTHORIZE_URL`, `GITHUB_TOKEN_URL`, `GITHUB_USER_URL`, `TURNSTILE_SITEVERIFY_URL`) are not secrets and are never set as Worker secrets or in `wrangler.jsonc`; they live in `.dev.vars` for `wrangler dev` against the fake provider. Beside `ALLOWED_ORIGIN` (`http://127.0.0.1:8787` locally), `.dev.vars` also sets the public var `API_ORIGIN` (`http://127.0.0.1:8788` locally; `https://api.bakery.ihaveasegway.com` in `wrangler.jsonc`), the base of the OAuth redirect URIs. [security.md](security.md#secrets-inventory) owns the rule.

The daily IP salt is not a variable: `Control` generates it each day and discards it, so an IP hash cannot be linked across days.

### 7. GitHub repository settings

Before launch only `FIREWALL_RULES` is a secret, in both stores. Settings → Actions → General ([GitHub](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)): allow GitHub-created actions plus `pnpm/action-setup@*` and `lycheeverse/lychee-action@*`; tag pinning, so "require SHA" is off; read-only workflow permissions; no pull request approval by Actions. From launch day, secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STRIPE_E2E_SECRET_KEY`, `CLOUDFLARE_READ_TOKEN`, and `FIREWALL_RULES` in both the Actions and Dependabot stores. Security: dependency graph, Dependabot alerts and updates, secret scanning with push protection.

The repository is public from its first push, so a ruleset is available at once: require a pull request and the checks `verify`, `firewall` and `firewall-selftest` on `main`, and `e2e` once PR 11 has made it run; block force pushes and deletion; require approval before an outside contributor's workflow runs. This is the server half of "never push to `main`" ([roadmap.md](roadmap.md#how-we-work)).

### 8. The read token for the nightly object check

Launch day. `bakery-objects` needs read access every night, so it has its own token and a scheduled job never holds write access. A custom account token `github-actions-bakery-read` with Workers Scripts Read and Account Analytics Read (confirm the names), expiring with the deploy token, stored as `CLOUDFLARE_READ_TOKEN`.

### 9. Local hooks and the private firewall file

As the site's [step 5](https://github.com/IHaveASegway/website/blob/main/docs/operations.md#5-local-hooks-and-the-private-firewall-file-pr-2) (Q34 · Q-firewall). The rules file is the site's, never committed, never quoted: both repositories read the one file at `~/.config/ihaveasegway/firewall.toml`, readable only by its owner and backed up in the password manager, and `RULE_FLOOR` in `scripts/firewall/check.sh` matches the site's. Run `git config core.hooksPath .githooks`, then `scripts/firewall/test.sh` and `scripts/firewall/sync-secrets.sh` (it fills both `FIREWALL_RULES` secrets), and prove the hooks by watching `git push origin main` be refused. A cloud session has no rules file and commits without the hooks, by Joseph's decision, saying so in the pull request.

### 10. The GitHub OAuth app

Created in PR 2 for local development (Q23 · Q-auth, [ADR 0006](adr/0006-sign-in-that-learns-nothing.md)). GitHub sign-in uses the numeric user `id` only: the `user` scope is not requested (so no `user:email`), the token is used once for `GET /user` and discarded, and the id is HMAC'd like Google's `sub` ([GitHub, creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app), as of 2026-11-04).

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App, named Proof of Concept Bakery (local). Labels move; confirm when building.
2. Homepage `https://bakery.ihaveasegway.com/`; authorization callback `http://127.0.0.1:8788/v1/auth/github/callback` (path assumed until ADR 0013).
3. The client id is public and goes in `vars`; the client secret becomes `GITHUB_CLIENT_SECRET`, in `.dev.vars` locally. The local callback is what PR 3's Worker sends when `API_ORIGIN` is `http://127.0.0.1:8788`.
4. A second app named Proof of Concept Bakery, with the callback `https://api.bakery.ihaveasegway.com/v1/auth/github/callback`, created on 2026-11-04 with no secret yet. GitHub's form now takes up to 10 redirect URIs per app (as of 2026-11-04); two apps stay, so the production secret never sits on a laptop. At launch, generate its secret for the Worker. No scope is requested, and the Worker's test asserts it.

### 11. The Email Service sender (later)

Off until Q43 · Q-email-signin is moved, so nothing is set up before then. For magic links, sending needs a verified sender on the zone `ihaveasegway.com`; Email Service sending is Workers Paid only and in beta, with 3,000 emails a month included and then $0.35 per 1,000 ([Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/), as of 2026-11-04). Magic-link sends stay inside the 3,000 included, rate-limited per IP hash and behind Turnstile against email bombing. The sender address is chosen then; no address is created now. The transient-address rule ([security.md](security.md)) means the address a visitor types is used once and never stored or logged.

## Observability

A page view runs no Worker code, so the signals are about the API. As of 2026-11-04.

| Signal | Tool | Allowance and source |
|---|---|---|
| Request lines | Workers Logs, written by the Worker | Paid: 20M events a month, then $0.60 per million, 7-day retention ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)); from 2026-12-01, 50 GB of ingestion and 10 GB-month of storage a cycle, then $0.25/GB and $0.10/GB-month ([Observability pricing](https://developers.cloudflare.com/observability/pricing/)) |
| Business counters | Analytics Engine | Paid: 10M data points a month, then $0.25 per million; "Currently, you will not be billed" ([pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)) |
| Usage | Dashboard: Workers, DOs, Queues | Rows, duration and operations against [cost.md](cost.md)'s meter |

**Log lines.** One JSON object per request, queue batch, cron run, alarm and wipe: `type`, `route`, `status`, `ms`, `ip_hash`, `country`, `continent`, `sandbox`. `ip_hash` is `HMAC(daily salt, IP)`; never city or coordinates, as in the site's lab. Automatic invocation logs are off because they record location fields ([delivery.md](delivery.md#quality-gates-as-fitness-functions) enforces it). Never a body, cookie, token, note or brief.

**Data points.** One per event: `sandbox_created`, `order_placed`, `payment_succeeded`, `payment_failed`, `refund_issued`, `wipe` (sandboxes, objects, milliseconds) and `dlq`. Nothing identifies a visitor.

**Kept queries** (Analytics Engine SQL, saved as text): sandboxes a day against the cap of 300; orders and payments an hour; payment failures; the last wipe; `dlq` points in 24 hours.

**The nightly object check.** `bakery-objects` runs at 12:17 UTC, after the wipe and its retries. It lists every sandbox-scoped namespace (all classes but `Control` and `Account`), opens an issue for any object still holding data, and another for a `dlq` point under 24 hours old.

**The weekly reconciliation.** Compare `Control`'s ledger with the account's metered usage. Metered above the ledger means a per-sandbox ceiling is wrong; fix the ceiling, not the comparison.

## Alerting

Alerts go by email to Joseph's personal inbox, outside `ihaveasegway.com` on purpose: if DNS breaks, mail to `hello@` breaks with it.

| Signal | Source | Runbook |
|---|---|---|
| Budget alert at $10, $25, $50 or $100 | Cloudflare | [Kill switch](#kill-switch-l0-to-l4) |
| Breaker token rejected (401 or 403) | The cron handler's log, read in the weekly reconciliation | [Rotate secrets](#rotate-secrets) |
| Nightly wipe failed or short | `wipe` data point; the morning issue | [The nightly wipe](#the-nightly-wipe) |
| Objects surviving the wipe | `bakery-objects` issue | [The nightly wipe](#the-nightly-wipe) |
| Dead-letter queue not empty | `dlq` point; `bakery-objects` issue | Read the message in the queue's dashboard, fix the consumer, replay |
| `prod-smoke` failed | `prod-verdict` issue | [Rollback](#rollback) |
| Stripe webhook failures | Stripe's email for the endpoint | Read the delivery attempts; [reset](#stripe-sandbox-reset) if the secret changed |
| Either hostname down, from launch | An uptime monitor on `https://bakery.ihaveasegway.com/` and `https://api.bakery.ihaveasegway.com/v1/health` | [Incident](#incident-the-bakery-down) |
| Firewall exit 1 or 2; a vulnerable dependency | `firewall`; Dependabot | [Leak response](#leak-response); [Dependency update](#dependency-update) |

The monitor is the site's choice, Better Stack's free tier ([pricing](https://betterstack.com/pricing), as of 2026-11-04; the free interval is not stated there). `/v1/health` runs no DO, so a check every 3 minutes (an assumption) is about 480 Worker requests a day, 0.14% of the 10M a month Paid includes.

## Runbooks

### Launch

PR 11's day. Everything before it ran locally, so this is the first time anything touches the account, the zone or a public URL. Set the day aside, start in the morning, and do the steps in order: guards first, then code ([cost.md](cost.md)).

1. Check the Launch gate ([roadmap.md](roadmap.md#decision-gates)): PRs 2 to 10 merged; spike S1 passed; Joseph's end-to-end read on `wrangler dev`; the name's business-registry and trademark check done; the privacy page's text reviewed.
2. Merge the site's superseding ADR in the site's repository, then upgrade the account to Workers Paid and write the date in an issue ([step 2](#2-workers-paid-and-the-budget-alerts)).
3. Set the budget alerts at $10, $25, $50 and $100 the same hour, so there is no uncovered spend.
4. Create the deploy token and the read token ([step 1](#1-the-deploy-token), [step 8](#8-the-read-token-for-the-nightly-object-check)), store them as GitHub secrets, and finish the settings in [step 7](#7-github-repository-settings).
5. In the zone: the rate-limiting rule on the API hostname and the L3 rule, created and disabled; then `BREAKER_API_TOKEN` and the 15-minute cron breaker.
6. Production secrets ([step 6](#6-worker-secrets)): the Stripe sandbox's webhook endpoint and a production restricted key, Turnstile's production widget, the production GitHub app's client secret, the Google client secret, and the consent screen's support email moved to `hello@ihaveasegway.com`.
7. Publish the privacy page, then publish the Google consent screen and the GitHub app.
8. Merge PR 11. The first `deploy` runs `wrangler deploy` for the API, then the web Worker, attaching both custom domains.
9. Watch the first `prod-smoke`. If it fails, `prod-verdict` opens the issue: [Rollback](#rollback).
10. Sign in with each provider on the production hostnames; read the first sign-in's CPU in Workers Logs against `limits.cpu_ms`; rehearse a rollback of each Worker.
11. After the next 10:00 UTC wipe, watch the first run of the morning object check (`bakery-objects`, 12:17 UTC): green means the launch is complete. Record the date and start spike S4.

### Deploy

From PR 11, deploys happen on merge ([delivery.md](delivery.md#deploy-verify-roll-back)); there is no manual path.

1. Merge. `ci.yml` runs `verify`, `firewall`, `firewall-selftest`, `deploy`, `prod-smoke`. Before PR 11 only the first three exist.
2. Read the `deploy` summary: which Worker deployed, the version live before, the new id. The API deploys first, and only when its paths changed.
3. Green `prod-smoke` means done. A failed web Version URL smoke changed nothing; a failed API deploy leaves the web Worker on its old version; fix forward.
4. If `prod-smoke` failed, `prod-verdict` opened an issue with the command: [Rollback](#rollback).
5. A DO class change is merged alone and deployed alone.

### Rollback

1. Find the target in the `prod-verdict` issue or the last `deploy` summary. Always pass an explicit version id.
2. From `main`: `gh workflow run ci.yml -f worker=<web|api> -f rollback_to=<version-id>`, plus `-f reason=<why>`. The `rollback` job runs `wrangler rollback <id> --message "rollback: <reason>" --yes`, and `prod-smoke` follows.
3. If GitHub is down: dashboard → the Worker → Deployments → Rollback. Never from the laptop.
4. **The DO caveat:** Cloudflare refuses a rollback across a DO class change ([Cloudflare](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)). If refused, set the API to `read-only` or `off` with L1 and fix forward. Class changes ship alone, so the refused target is the version before one.
5. A rollback undoes code, not data, and sandbox data is gone by morning anyway.
6. Fix or revert on `main` first, since the next merge deploys `main` again. Close the issue with the cause and the check that would have caught it.

### The nightly wipe

The wipe is the privacy promise ([ADR 0005](adr/0005-a-private-sandbox-per-visitor-wiped-nightly.md)): every sandbox, all of it, at 10:00 UTC (03:00 Mountain standard time, 04:00 in summer; the bakery's time zone is America/Denver).

**What runs.** Cron `0 10 * * *` asks `Control` for the day's sandboxes (no `wiped_at`). `Control` calls each `Sandbox`, which calls `deleteAll()` on every child in its registry, deletes the Stripe sandbox objects it created where the API allows, then wipes itself. `Control` stamps `wiped_at`. The 15-minute cron retries what is left. Each object's own alarm at 36 hours is the backstop (Q25 · Q-ttl).

**How to see it ran.** A `wipe` data point; the `wipe_summary` log line (filter `type=wipe`); no row lacking `wiped_at` in `Control`'s `sandboxes` table in Data Studio; a green `bakery-objects` at 12:17 UTC.

**When it fails halfway.** The wipe is idempotent and the registry keeps children until the end, so a retry resumes. Wait two 15-minute sweeps, read the sandbox's `wipe_error` in the log, fix the cause, then request it by hand. If a class cannot delete, set `read-only` with L1 so no new data arrives, and fix forward.

**Before launch** there is no cron. On `wrangler dev` the scheduled handler runs when asked, with no `--test-scheduled` flag (Wrangler 4.157.0, checked on 2026-11-05; [cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally)): `curl "http://127.0.0.1:8788/cdn-cgi/local/scheduled?cron=0+10+*+*+*"` runs the wipe, and `cron=*/15+*+*+*+*` the sweep. The morning check does not exist until PR 11; its local half is `node scripts/list-objects.mjs <persist-dir>`, which exits 1 if a sandbox-scoped object holds data, and `scripts/smoke-auth.sh` runs both.

**By hand.** Set `wipe_due` in `Control`'s `flags` table in Data Studio; the next sweep runs the full wipe. (The table and column names are an assumption for [architecture.md](architecture.md) to confirm.)

Deleted rows count as writes ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), as of 2026-11-04; spike S5 measures it). SQLite-backed objects keep 30 days of point-in-time recovery ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)), so Cloudflare can restore wiped rows for a month; [security.md](security.md) owns how the privacy page words that.

### Wipe now

A visitor's "Wipe now" calls `DELETE /v1/sandboxes/{id}` with their session and takes seconds. An operator wiping one sandbox sets `wipe_requested` on its row in `Control`'s `sandboxes` table and waits up to 15 minutes for the sweep, then confirms `wiped_at` is set.

### Kill switch L0 to L4

Five levels, cheapest first; [cost.md](cost.md) owns the design. Use the lowest that stops the problem.

| Level | Use when | Action | Takes effect | Undo |
|---|---|---|---|---|
| L0 `Control`'s budgets | Automatic: a daily budget (sandboxes, requests, rows, simulated traffic) is spent. The `Simulator`'s caps (Q40): at most 6 orders a minute and 30 minutes of traffic a sandbox a day, counted in the ledger, running only while the visitor's console is open and stopped by the wipe. Guests have 100 of the 300 sandboxes a day (Q45) | None; `Control` answers `read-only` or `off`, and the `Simulator` stops at its cap | Next admission | Resets at 00:00 UTC |
| L1 flags | A feature misbehaves or cost must stop | Set `live`, `read-only` or `off` in `Control`'s `flags` table in Data Studio; there is no admin endpoint | New requests at once; sockets end at their next message | Set `live` |
| L2 redeploy | Running sessions must end | `gh workflow run ci.yml -f redeploy_api=true`: every object restarts, every socket drops | Seconds once it runs | None; admission applies L0 and L1 on reconnect |
| L3 WAF rule | A flood must stop before the Worker | Enable the pre-built, disabled custom rule that blocks the API hostname ([WAF](https://developers.cloudflare.com/waf/custom-rules/)) | Seconds. Whether a blocked request counts as an invocation is the site's spike S2; read its result there | Disable the rule |
| L4 detach the domain | The API should not exist for a while | Workers & Pages → `bakery-api` → Settings → Domains & Routes → remove `api.bakery.ihaveasegway.com` | Minutes | Redeploy, which re-attaches it (confirm) |

After L3 or L4, public pages still work (static assets, $0) and signed-in screens show their offline state; a WAF block answers 403. Write any change that outlasts the day back into the code.

### Rotate secrets

Yearly, before the deploy token's end date; verify each new secret before deleting the old.

1. **Cloudflare tokens** (deploy, read, breaker): recreate as in steps 1, 8 and 2.6 with a new end date; `gh secret set` the first two, `wrangler secret put BREAKER_API_TOKEN --name bakery-api` the third; re-run a `preview`; confirm the next 15-minute run raises no 401; delete the old; update the calendar.
2. **`SESSION_HMAC_KEY`, with overlap.** Sessions and API tokens last 24 hours. Put the current key in `SESSION_HMAC_KEY_PREV`, put the new one in `SESSION_HMAC_KEY` (the Worker signs with one and verifies with both, so no one is signed out), and delete `SESSION_HMAC_KEY_PREV` after 24 hours. Setting a secret creates a new version; confirm when building.
3. **`ACCOUNT_HMAC_KEY`:** on compromise only. Every Google and GitHub account id changes, so each such visitor gets a new sandbox; sandboxes are wiped nightly anyway.
4. **Stripe:** roll the restricted keys and the webhook secret (an endpoint secret may allow a short overlap; confirm), update the three secrets, send a signed test event from the dashboard.
5. **Google and GitHub:** add a second client secret, set it, test sign-in, delete the old (confirm two can coexist on each). **Turnstile:** rotate in the widget, set `TURNSTILE_SECRET`, test sandbox creation.

On suspected exposure, do it at once in this order: delete the exposed credential, create the replacement, then read the audit logs from its creation for changes nobody made.

### Stripe sandbox reset

Quarterly, or when the sandbox is cluttered or its keys leaked. It holds only synthetic data. Never delete the sandbox: Stripe refuses a new one until the business is verified (as of 2026-11-04).

1. Clear the sandbox's test data, if the dashboard offers it (confirm the control when building).
2. Roll the Worker's key, CI's key and the webhook secret as in [step 3](#3-the-stripe-sandbox); set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_E2E_SECRET_KEY`.
3. Redeploy the API (L2's dispatch works), run `e2e`, send a signed test event.
4. Do it just after 10:00 UTC: `Billing` entries then reference Stripe ids that no longer exist for under a day.

### Leak response

A term or a secret was pushed. The order matters; the site's [leak response](https://github.com/IHaveASegway/website/blob/main/docs/operations.md#leak-response) applies, with these additions.

1. **A secret: rotate it first.** Cloudflare tokens as in [Rotate secrets](#rotate-secrets). **Stripe:** roll the key or webhook secret and read the sandbox's event log for activity nobody made. **Google and GitHub:** delete the client secret, issue a new one, review the project's or app's credentials.
2. **Stop serving it:** a WAF rule on the path, then a fix or rollback; delete any preview that carries it (`wrangler preview delete --name pr-<n> --skip-confirmation`).
3. **The repository is public, so assume it was copied.** Rewrite with `git filter-repo --sensitive-data-removal` and force-push the mirror ([GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)); ask GitHub Support to drop cached views and pull request references; ask fork owners; ask archives and search engines. A name cannot be rotated, and a clone persists.
4. **Make it not recur:** tighten the rule, run the full-history scan, write a note of which control should have caught it, never repeating the term.

### compatibility_date bump

Quarterly per Worker. Read the flags dated since the current date ([compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)); change only `compatibility_date` in that Worker's config; CI, `e2e` and (for the API) the native tests and startup budget must pass; merge and watch `prod-smoke`. A rollback undoes it.

### Dependency update

Every other Monday, beside the site's sitting; security updates as they arrive.

1. Dependabot opens grouped pull requests for cargo and npm, one for actions, and one per major after 14 days.
2. Skim the changelogs of what is in the deploy path: Wrangler, Astro, pnpm, the actions, and cargo crates that ship in the wasm. Merge on green; read the size and startup deltas in the `verify` summary.
3. `worker`, `worker-build` and `wasm-bindgen` are never in a group: bump them together, by hand, after the release notes ([delivery.md](delivery.md#dependency-policy)).
4. pnpm failing on release age (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`): re-run after 24 to 48 hours, or add the exact version to `minimumReleaseAgeExclude` with a dated comment and a removal date within 7 days.
5. `cargo audit` or `cargo deny` red: update the crate, or pin it and document why; same day for a reachable vulnerability. Never hand-edit a lockfile.

### Incident: the bakery down

Nothing on `ihaveasegway.com` changes: the site is separate Workers and static assets, and its links to the bakery are plain links. Link targets show the bakery's own state.

1. Confirm from outside: `curl -sS -o /dev/null -w '%{http_code}\n'` on `https://bakery.ihaveasegway.com/` and `https://api.bakery.ihaveasegway.com/v1/health`, then both on a phone off Wi-Fi.
2. Web down and API up points at the last web deploy or the zone. API down and web up: public pages work and signed-in screens show their offline state.
3. Check [Cloudflare's status](https://www.cloudflarestatus.com/); an incident on Workers or DOs means wait.
4. `curl -sI` the failing host: a 404 everywhere points at the last web deploy; a 5xx at the last API deploy or a spent budget (`Control` answering `off` is L0 working); a TLS error at the certificate.
5. `gh run list --workflow ci.yml --branch main --limit 3`; if it started with a deploy, [roll back](#rollback). Check the budget alerts and `Control`'s flags before assuming a bug.
6. Afterwards, a blameless note in an issue, scrubbed first.

## Maintenance calendar

Nothing in this calendar recurs before launch: until PR 11 there is no production to watch, no token to rotate and no wipe to check, and Dependabot's pull requests (from PR 2) are merged between feature pull requests. The minutes below start with PR 11. Minutes a month for the bakery alone, with quarterly and yearly work spread over its months. The site's calendar is separate. Incidents and framework majors are excluded.

| When | Task | How | Minutes a month |
|---|---|---|---|
| Daily | Nightly wipe and the morning `bakery-objects` check | Automatic; an issue on a finding | 0 while green |
| Weekly | Reconciliation of `Control`'s ledger against metered usage | Dashboard, 5 minutes | 22 |
| On each issue | Read, fix the cause, close | [The nightly wipe](#the-nightly-wipe) | 5 |
| Monday | Zone audit and `cargo audit` | Automatic (`scheduled.yml`) | 0 while green |
| Every other Monday | Grouped Dependabot pull requests, about 10 minutes beyond the site's sitting | [Dependency update](#dependency-update) | 22 |
| Monthly | Stripe sandbox review: delivery failures, key list, changelog, one signed test event | Stripe dashboard | 10 |
| Monthly | Usage against [cost.md](cost.md)'s meter; budget alert history; the DLQ is empty | Dashboard | 10 |
| Quarterly | Stripe sandbox reset | [Runbook](#stripe-sandbox-reset) | 5 |
| Quarterly | `compatibility_date` for both Workers, 20 minutes each | [Runbook](#compatibility_date-bump) | 13 |
| Quarterly | What Dependabot does not watch: workers-rs and the Rust toolchain, Stripe's API version, Google console changes | Release pages | 5 |
| Quarterly | Firewall rules review with a full-history scan | [security.md](security.md) | 3 |
| Quarterly | ADR "Revisit if" triggers | [ADR index](adr/README.md) | 7 |
| Yearly, 30 days before the end date | Rotate the deploy, read and breaker tokens, Stripe keys, Google, GitHub and Turnstile secrets | [Rotate secrets](#rotate-secrets) | 3 |
| **Total** | | | **105 min, 1 h 45 min** |

The site's calendar totals about 117 minutes a month before its lab ([site operations.md](https://github.com/IHaveASegway/website/blob/main/docs/operations.md#maintenance-calendar), as of 2026-11-04). Together that is about 222 minutes, 3 h 42 min, against a target of 2 hours including the site's. **The target does not hold,** by about 1 h 42 min. Three cuts exist and none is taken yet, because three months of the time log should decide: automate the reconciliation in `scheduled.yml` (saves 22 minutes, but puts an analytics-reading token in a scheduled job, which the site declined for its zone export); merge the two Dependabot sittings (about 10); make the monthly sittings quarterly once launch settles (about 12). All three leave about 2 h 58 min, so reaching 2 hours means dropping a duty. Q38 · Q-time asks for Joseph's hours; if they are near 20 a month, the honest move is to raise the target to about 3 hours in [roadmap.md](roadmap.md#time-budget), not to skip the wipe check.

## Patterns and further reading

- Runbooks for use under stress, and blameless notes: Betsy Beyer et al., *Site Reliability Engineering* (2016), chapters 12 and 15.
- Alerts that need an action: Rob Ewaschuk, "My Philosophy on Alerting" (2013). Black-box monitoring from a separate failure domain: *Site Reliability Engineering*, chapter 6.
- Breakers, bulkheads and a last-resort kill switch: Michael Nygard, *Release It* (2018).
- Resumable, idempotent batch work: Pat Helland, "Idempotence Is Not a Medical Condition" (2012).
