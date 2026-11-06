# Operations

How Proof of Concept Bakery, the made-up bakery, is set up, watched and repaired by one person: access setup, observability, alerting, runbooks and the maintenance calendar. It follows the site's [operations.md](https://github.com/IHaveASegway/website/blob/main/docs/operations.md), and the two share an account, a zone and a time budget. Each runbook is a short numbered list for use under stress. The pipeline these runbooks drive is in [delivery.md](delivery.md); the secrets inventory, the wipe's design and the privacy rules are in [security.md](security.md); prices and the kill switch's design are in [cost.md](cost.md).

Status: Updated in PR 11, launch preparation (draft) · 2026-11-06

Prices, limits and versions are as of 2026-11-04, with sources. The runbooks that drive the pipeline (Launch, Deploy, Rollback, the kill switch and the nightly wipe) were checked on 2026-11-06 against `.github/workflows/ci.yml` and `scheduled.yml` as written on the launch branch at d778ff7, and against `scripts/bakery-objects.mjs`; none of those jobs has run against the account yet. Steps that depend on a console's current labels say "confirm when building". A Durable Object (DO) is the unit that holds state; every DO class here is SQLite-backed.

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
6. The 15-minute cron breaker (planned for PR 11; not built on 2026-11-06, when `workers/api/src/cron.rs` runs only the retry sweep and the status refresh), whose Cloudflare token will be the Worker secret `BREAKER_API_TOKEN`, scoped to reading analytics and editing that zone's rules (confirm the names when building), with the deploy token's end date.

### 3. The Stripe sandbox

Q17 · Q-psp, Q20 · Q-stripe-account, [ADR 0007](adr/0007-stripe-sandbox-and-a-payment-element-that-collects-nothing.md). No live key is ever created for this repository.

Created in PR 2, because local development needs the keys; the production webhook comes on launch day.

1. Use the test-mode sandbox Stripe gives the account: an isolated test environment with its own keys and webhooks, free, not processed by card networks ([Stripe](https://docs.stripe.com/sandboxes), as of 2026-11-04). Stripe refuses a second sandbox until the business is verified (seen in the dashboard on 2026-11-04), and a made-up bakery has nothing to verify, so this is the only one and it is never deleted.
2. A restricted key named `bakery-api-local`, with Write on payment intents, customers, invoices, and charges and refunds, and nothing else, becomes `STRIPE_SECRET_KEY` in `.dev.vars` (created 2026-11-04). At launch, a separate key with the same permissions becomes the Worker secret. The publishable key, public by design, is `STRIPE_PUBLISHABLE_KEY` for the Worker, which hands it to the browser in the payment answer only when it starts `pk_test_`, and `PUBLIC_STRIPE_PUBLISHABLE_KEY` for the storefront's build, which fails unless it is empty or starts `pk_test_`. A restricted key is preferred to a secret key: the Worker accepts either, `rk_test_` or `sk_test_`, and refuses anything else with 503 `stripe-key` ([security.md](security.md#payments-safety)). PR 5 called payment intents (create, retrieve, confirm, cancel) and refunds (create). PR 7 adds customers (create, delete) and invoices and their items (create the draft, add the item, finalize, void, pay on the test path, read), and nothing else. Whether invoice items need a permission of their own on a restricted key is for the dashboard to say (confirm when building, S3).
3. Locally, the Stripe CLI forwards events to `wrangler dev` and prints a signing secret for `.dev.vars` ([Stripe CLI](https://docs.stripe.com/stripe-cli), as of 2026-11-04). `STRIPE_WEBHOOK_SECRET` must start `whsec_`, or the webhook route answers 503 `config`. At launch, a webhook endpoint at `https://api.bakery.ihaveasegway.com/v1/stripe/webhook`; its signing secret becomes `STRIPE_WEBHOOK_SECRET`. Select these events and no others: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `refund.created`, `refund.updated`, and since PR 7 `invoice.paid` and `invoice.voided`. The Worker acknowledges `charge.refunded` and drops it, and answers 200 to any event type it has no use for (`invoice.payment_failed` and `invoice.finalized` included), so selecting more only costs deliveries. Signatures are HMAC-SHA256 over `t.payload` with a 5-minute tolerance ([Stripe](https://docs.stripe.com/webhooks#verify-manually)).
4. A second restricted key in the same sandbox, `bakery-ci-e2e`, with the same permissions: the GitHub secret `STRIPE_E2E_SECRET_KEY`, set on 2026-11-04 for the `e2e` job that arrives in PR 11. Stripe recommends a separate sandbox for automated tests, which the refusal above rules out, so CI and local work share test data, and `e2e` asserts only on objects it created. Test cards only ([Stripe testing](https://docs.stripe.com/testing)).

#### Working on payments without a Stripe account, from PR 5

`scripts/fake-stripe.mjs` is a dependency-free Node (22 or later) stand-in for the part of Stripe's API the Worker uses and for the signed webhooks Stripe sends back. It is a fixture and never a Stripe, and everything in PR 5 and PR 7 was proven against it and not against Stripe (checked 2026-11-05 by `scripts/smoke-payments.sh`, [roadmap.md](roadmap.md#pr-5-payments), and `scripts/smoke-catering.sh`, [roadmap.md](roadmap.md#pr-7-catering-and-billing)). Since PR 7 it also models customers, invoice items and invoices (draft, finalize, pay on the test path, void, read) and the `invoice.paid`, `invoice.payment_failed` and `invoice.voided` webhooks, with the same signing, faults and request log; its header lists seven known differences from Stripe, and `node --test scripts/fake-stripe.test.mjs` runs its own 5 tests. To use it by hand:

1. Put these three lines in `workers/api/.dev.vars` (git-ignored; the values are test-shaped fakes and not secrets, and `STRIPE_API_BASE` is honored only for `127.0.0.1` and `localhost`):

   ```sh
   STRIPE_API_BASE=http://127.0.0.1:8791
   STRIPE_SECRET_KEY=rk_test_not_a_key
   STRIPE_WEBHOOK_SECRET=whsec_not_a_secret
   ```

2. Start the fake: `node scripts/fake-stripe.mjs` (port 8791; `--port` changes it). It posts its webhooks to `http://127.0.0.1:8788/v1/stripe/webhook`, which is `wrangler dev`'s default, and signs them with the `whsec_` value above.
3. Start the Worker as in `workers/api/README.md`. For the storefront's payment step to mount, `PUBLIC_STRIPE_PUBLISHABLE_KEY` or the Worker's `STRIPE_PUBLISHABLE_KEY` must hold a `pk_test_` key; the fake has no Payment Element behind it, so that step is for the real sandbox. Server-side, the Simulator and the smoke test pay with `pm_card_visa`.
4. The fake's controls (`POST /_config`, `GET /_events`, `GET /_requests`, `POST /_reset`, `GET /_health`, header of the script) replay a webhook, break its signature or its timestamp, flip a byte of the body, or send it as live mode, to watch the Worker refuse it. `scripts/smoke-payments.sh` runs all of that.

#### What spike S3 must still do

[S3](roadmap.md#spikes) runs on Joseph's machine with a real sandbox key, and PR 5's code waits on it for these:

- Confirm that the Payment Element with `fields.billingDetails: 'never'` and the persona's synthetic details confirms a payment with the test card 4242 4242 4242 4242 ([Stripe testing](https://docs.stripe.com/testing)), shows no name, email or address field, and raises no CSP violation with the `payment` page class's three origins.
- Put the real key in `.dev.vars` with the fake's lines removed, run the Stripe CLI against the Worker (`stripe listen --forward-to http://127.0.0.1:8788/v1/stripe/webhook`, which prints the `whsec_` value for `STRIPE_WEBHOOK_SECRET`; not run here) and confirm that a real `payment_intent.succeeded` verifies and marks the order paid, that a body altered by one byte is refused, and that `refund.created` and `payment_intent.canceled` arrive carrying what the fake's do.
- **Confirm `automatic_payment_methods[allow_redirects]=never` against a real sandbox.** The adapter sends it with `automatic_payment_methods[enabled]=true` when it creates an intent, so a server-side confirm with a test payment method needs no `return_url`. Without it Stripe asks for one on such a confirm; the fake does not model that, so only a real sandbox can say whether the parameter is accepted and enough.
- **Confirm that `send_invoice` to a customer with no email sends nothing.** The adapter makes the customer with the synthetic persona id in its metadata and no email, and the invoice with `collection_method=send_invoice`, `days_until_due` and `auto_advance=false`. The fake sends no email by construction, so it shows nothing; at Stripe, check the invoice's email settings and that no message goes anywhere.
- **Confirm that the invoice's own payment intent carries none of our metadata.** The code assumes it: `invoice.paid` carries the invoice's metadata (`sandbox`, `invoice`, `purpose`, `ref`) and its `amount_paid`, and the `payment_intent.succeeded` Stripe sends for the invoice names no sandbox, so the webhook route drops it (`crates/app/src/stripe/webhook.rs`, `billing_kind`). If that intent did carry the bakery's metadata, the route would see a second success for one balance, and what `Billing` does with it has not been run.
- **Decide how a visitor pays the balance at real Stripe.** Built and proven against the fake only: `pay-balance` pays the invoice with the test payment method `pm_card_visa` (the fake has no Payment Element behind an invoice). At Stripe that call may need the card attached to the customer, and the visitor's own card step is not built. The options are the Payment Element on the invoice's payment, with whatever client secret Stripe's current API exposes for an invoice (confirm the field when building), the same server-side `pm_card_visa` payment, or Stripe's hosted invoice page, which sends the visitor off the site and outside the CSP. Joseph decides; S3 shows which of them work.
- **Confirm the wipe's void-and-delete at Stripe.** `Billing` voids each open invoice and then deletes the customer. The fake allows both in any order; check that real Stripe lets a customer with a void invoice be deleted, and what it does with a draft invoice left by a crash between the draft and its finalization (nothing in the bakery knows of one).
- Read the dashboard's API version and set it as the `STRIPE_API_VERSION` var in `wrangler.jsonc`. Until then no `Stripe-Version` is sent and the account's default applies ([stack.md](stack.md)).
- Confirm the restricted key `bakery-api-local` works with the permissions PR 5 uses, including the read the webhook route makes of a payment intent to find a refund's sandbox.
- The storefront recovers a payment step's client secret on a remount by the idempotent re-create and not by a retrieve. At real Stripe that holds while the idempotency key lives, 24 hours ([Stripe](https://docs.stripe.com/api/idempotent_requests), as of 2026-11-05), and a sandbox lives under 36 h ([architecture.md](architecture.md#placing-and-paying-an-order)). Check what a remount past 24 hours does, since the code has not been run that way.

### 4. The Google OAuth client

[ADR 0006](adr/0006-sign-in-that-learns-nothing.md): the `openid` scope alone, so the API receives `sub` and no email. [S2](roadmap.md#spikes) passed on 2026-11-05: Google accepts it. Google's docs still describe `openid` alone as invalid, so the callback also drops `email`, `email_verified`, `name` and `picture` if they ever appear. A client in production status was not tested; check it on launch day.

Created in PR 2 in testing status, with Joseph as its test user, for local development; published on launch day.

1. A Google Cloud project named Proof of Concept Bakery. Console labels move; confirm when building.
2. Consent screen: External; the app name; privacy page `https://bakery.ihaveasegway.com/privacy/`; authorized domain `ihaveasegway.com`; `hello@ihaveasegway.com` as the developer contact. The user support email offers only the signed-in account's own address or a Google Group it manages (as of 2026-11-04), so in testing status it is that account's address, which only test users see. Before publishing, it moves to `hello@ihaveasegway.com`, because the screen then shows it to every visitor: a Google account on that address, verified through Email Routing, can select itself (Joseph's decision of 2026-11-04). A free Google Group would end in `@googlegroups.com` and would not match.
3. Scopes: `openid` only. No sensitive scope is requested, so no verification review is needed ([Google](https://developers.google.com/identity/openid-connect/openid-connect), as of 2026-11-04; confirm the current rule). Publish the screen to production at launch, once the privacy page is live, so any Google account can sign in.
4. An OAuth client of type Web application, redirect URIs `http://127.0.0.1:8788/v1/auth/google/callback` for local development and `https://api.bakery.ihaveasegway.com/v1/auth/google/callback`, both registered on 2026-11-04 (paths assumed until ADR 0013, written in PR 10). The client secret becomes `GOOGLE_CLIENT_SECRET`; the client id is public and goes in `vars`. The local URI is what PR 3's Worker sends when `API_ORIGIN` is `http://127.0.0.1:8788`.
5. Validate ID tokens locally against the `jwks_uri` keys; `tokeninfo` is for debugging only.

### 5. Turnstile

Free and unlimited ([Turnstile plans](https://developers.cloudflare.com/turnstile/plans/), as of 2026-11-04). Before launch, Turnstile's test keys only, in `.dev.vars` (confirm when building). At launch, a managed widget for `bakery.ihaveasegway.com`; the site key is public and becomes the repository variable `TURNSTILE_SITE_KEY`, which `verify`'s web build reads as `PUBLIC_TURNSTILE_SITE_KEY` so the bundle carries it (`ci.yml`, 2026-11-06), the secret is `TURNSTILE_SECRET`; local runs and CI keep using the test keys. It gates guest sandbox and demo-account creation only; a signed-in account is capped at 3 sandboxes a day instead.

### 6. Worker secrets

Locally they live in `.dev.vars`, git-ignored, with names in `.dev.vars.example`. From launch day they are set with `wrangler secret put <NAME> --name bakery-api` from a short-lived token or the dashboard; never in the repository. On launch day, 2026-11-06, the eight were set before the first deploy: Wrangler 4.157.0 creates a Worker that does not exist yet as a draft holding the secret, without a prompt, so `bakery-api` existed as a draft before `deploy` ran, and the first deploy found every secret in place (the draft's version is the `api_before` the first `prod-verdict` issue named, #41, which is why a rollback to it is never a target). [security.md](security.md#secrets-inventory) owns the inventory and wins if this list differs.

| Secret | Holds | Rotation |
|---|---|---|
| `SESSION_HMAC_KEY`, `SESSION_HMAC_KEY_PREV` | HMAC key for the 24 h session cookie and for the per-sandbox API tokens (Q42; same claims, `Authorization: Bearer`, so no new secret), and the old key during rotation | With overlap |
| `ACCOUNT_HMAC_KEY` | Key for `HMAC(secret, sub)` and `HMAC(secret, github id)`, the account id | On compromise only: it orphans Google and GitHub accounts |
| `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `TURNSTILE_SECRET` | The Google client secret; the GitHub OAuth app's client secret (its client id is public and goes in `vars`); Turnstile's server secret | Yearly or on exposure |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | The restricted sandbox key (`rk_test_`, preferred to a secret key, which is `sk_test_`; the Worker refuses any other prefix); the endpoint's `whsec_` signing secret, which the Worker refuses otherwise. Each lives in `.dev.vars` locally and is a Worker secret from launch; neither is ever a var | Yearly, at a reset, or on exposure |
| `ANALYTICS_API_TOKEN` | The status page's read token (PR 13): a custom account token `bakery-api-analytics-read` with one permission, Account: Account Analytics Read (confirm the name), expiring with the deploy token ([step 8](#8-the-read-token-for-the-nightly-object-check)). The 15-minute cron sends it as a bearer token to the Analytics Engine SQL API | With the deploy token |
| `ANALYTICS_ACCOUNT_ID` | The Cloudflare account id the SQL API's path carries. A secret only because this repository's logs are public, as `CLOUDFLARE_ACCOUNT_ID` is; letters and digits only, or the refresh is skipped | Never, unless the account changes |
| `BREAKER_API_TOKEN` | The cron breaker's Cloudflare token. Planned (PR 11's design): no code reads it on 2026-11-06 | With the deploy token |

`STRIPE_PUBLISHABLE_KEY` is not a secret and not in the table: an optional public var (`pk_test_` only) in `.dev.vars` locally and `wrangler.jsonc` from launch. **Public vars must be in `workers/api/wrangler.jsonc` at launch, not in the dashboard.** `deploy` runs `wrangler deploy --no-bundle` without `--keep-vars` (`ci.yml` at d778ff7, checked 2026-11-06), and a deploy without that flag deletes variables set only in the dashboard ([Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/#deploy), confirm the flag's current wording when building). So `GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_ID` and `STRIPE_PUBLISHABLE_KEY`, with `API_ORIGIN`, are `vars` in the file PR 11 merges; secrets are unaffected, since `wrangler secret put` keeps them. `STRIPE_API_BASE` and `STRIPE_API_VERSION` are public too (and so is `ANALYTICS_API_BASE`, below): the first is a local-only override, honored for `127.0.0.1` and `localhost` and never set in `wrangler.jsonc`; the second, once S3 reads it, is pinned there ([security.md](security.md#secrets-inventory)).

The local-only provider overrides (`GOOGLE_ISSUER`, `GITHUB_AUTHORIZE_URL`, `GITHUB_TOKEN_URL`, `GITHUB_USER_URL`, `TURNSTILE_SITEVERIFY_URL`, and since PR 13 `ANALYTICS_API_BASE`, the SQL API's origin, for the fake in `scripts/fake-analytics.mjs`) are not secrets and are never set as Worker secrets or in `wrangler.jsonc`; they live in `.dev.vars` for `wrangler dev` against the fake provider. Beside `ALLOWED_ORIGIN` (`http://127.0.0.1:8787` locally), `.dev.vars` also sets the public var `API_ORIGIN` (`http://127.0.0.1:8788` locally; `https://api.bakery.ihaveasegway.com` in `wrangler.jsonc`), the base of the OAuth redirect URIs. [security.md](security.md#secrets-inventory) owns the rule.

The daily IP salt is not a variable: `Control` generates it each day and discards it, so an IP hash cannot be linked across days.

### 7. GitHub repository settings

Before launch only `FIREWALL_RULES` is a secret, in both stores. Settings → Actions → General ([GitHub](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)): allow GitHub-created actions plus `pnpm/action-setup@*` and `lycheeverse/lychee-action@*`; tag pinning, so "require SHA" is off; read-only workflow permissions; no pull request approval by Actions. From launch day, secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STRIPE_E2E_SECRET_KEY`, `CLOUDFLARE_READ_TOKEN`, and `FIREWALL_RULES` in both the Actions and Dependabot stores. `STRIPE_E2E_SECRET_KEY` is named in a comment in `ci.yml` and read by no step: until S3 the `e2e` payment step pays at the fake Stripe, so storing it is harmless and not yet needed. **The variable `LAUNCHED`** (Settings → Secrets and variables → Actions → Variables) is set to `true` in [Launch](#launch) step 4. It is a variable, not a secret, and it gates every launch job: see [delivery.md](delivery.md#the-jobs-as-written). **Labels:** create one label, `incident`, once (Issues → Labels). `prod-verdict` adds it to its `Incident:` issues only if it exists, so the pipeline works without it. The "Objects survived the wipe" and "Weekly audit" issues carry no label: the jobs find their own open issue again by exact title, and open a new one if the last was closed, so close them only when the cause is fixed. Security: dependency graph, Dependabot alerts and updates, secret scanning with push protection.

The repository is public from its first push, so a ruleset is available at once: require a pull request and the checks `verify`, `firewall` and `firewall-selftest` on `main`, and `e2e` once PR 11 has made it run; block force pushes and deletion; require approval before an outside contributor's workflow runs. This is the server half of "never push to `main`" ([roadmap.md](roadmap.md#how-we-work)).

### 8. The read token for the nightly object check

Launch day. `bakery-objects` needs read access every night, so it has its own token and a scheduled job never holds write access. A custom account token `github-actions-bakery-read` with one permission, Account: Workers Scripts Read (confirm the name), expiring with the deploy token, stored as `CLOUDFLARE_READ_TOKEN`. Durable Object namespaces and their objects are listed under Workers Scripts Read: on 2026-11-06 the token listed the namespaces (checked from the laptop before the first deploy). Whether the objects endpoint reports `hasStoredData` is still for the first run to confirm (`scheduled.yml`, 2026-11-06). Account Analytics Read, which this step named before, is not on this token, by design: the dead-letter step reads the public `GET /v1/status` (see [the dead-letter check](#observability)), the Worker's own token below reads analytics, and nothing in Actions does, so the Actions token does not get it. `bakery-objects` also reads `CLOUDFLARE_ACCOUNT_ID`, the same secret as the deploy token's (step 1.5): the account API's paths carry it, and `wrangler.jsonc` has none. The job maps the read token to `CLOUDFLARE_API_TOKEN` in one step's `env:` only, so it never holds the deploy token.

**The Worker's analytics token (PR 13).** The status page's counters come from the Analytics Engine SQL API, which the `*/15` cron queries from inside `bakery-api`. A second custom account token, `bakery-api-analytics-read`, with one permission, Account: Account Analytics Read (confirm the name), expiring with the deploy token. It is set with `wrangler secret put ANALYTICS_API_TOKEN --name bakery-api`, and the account id with `wrangler secret put ANALYTICS_ACCOUNT_ID --name bakery-api`; neither goes to GitHub, and the Actions read token does not get this permission. It can read this account's analytics and nothing else. Locally both live in `.dev.vars` (names in `.dev.vars.example`), with `ANALYTICS_API_BASE=http://127.0.0.1:8792` pointing at the fake.

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
| Business counters | Analytics Engine | Paid: 10M data points a month, then $0.25 per million; "Currently, you will not be billed" ([pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)). Read by the status page's 15-minute refresh: 192 queries a day ([cost.md](cost.md)) |
| Usage | Dashboard: Workers, DOs, Queues | Rows, duration and operations against [cost.md](cost.md)'s meter |

**Log lines.** One JSON object per request, queue batch, cron run, alarm and wipe: `type`, `route`, `status`, `ms`, `ip_hash`, `country`, `continent`, `sandbox`. `ip_hash` is `HMAC(daily salt, IP)`; never city or coordinates, as in the site's lab. Automatic invocation logs are off because they record location fields ([delivery.md](delivery.md#quality-gates-as-fitness-functions) enforces it). Never a body, cookie, token, note or brief. Since PR 4 (2026-11-05) the kitchen socket writes `kitchen_wake`, `kitchen_socket_open`, `kitchen_socket_closed`, `kitchen_socket_refused`, `kitchen_sockets_closed` and `kitchen_cmd`, the Simulator writes `sim_started`, `sim_tick`, `sim_rate`, `sim_refused`, `sim_cap` and `sim_stopped`, and a failed settlement writes `settle_error`. Since PR 6 (2026-11-05) the loop guard writes `alarm_guard` with `reason: rearm-cap` and the object's class (an object that reaches its 101st alarm-driven re-arm in a UTC day stops arming until the wipe; none was logged in any smoke run), the Schedule writes `seed_schedule_refused` (a seeded command its rules refused, skipped) and `schedule_event_refused` (a consumed event it could not apply, with the rule), the consumer writes `schedule_no_day` (an order whose Schedule day was never born, counted as delivered), the Sandbox writes `clock_children_missed` (children that did not take a clock advance and are left for its alarm's retry) and the Simulator writes `sim_slot_full` (an order the day refused, with the rule). Since PR 7 (2026-11-05) the catering saga writes: `catering_timer` when an alarm runs a timer row (the row's id and the catering id), `catering_timer_refused` when the aggregate refuses that row's command (a rule slug), `timers_cleared` when a commit leaves a catering event with no timer row (the catering id and its state), `catering_event_refused` when the aggregate refuses a delivered event (the envelope's id and type, and the rule), `catering_hold_refused` when the day's `Schedule` refuses a hold at acceptance (the rule, such as `slot-full`), `seed_catering_refused` when a replayed seed step is refused, and `deposit_late` when a deposit landed on an expired quote and was sent for a full refund (the payment, the refund id and the status of the ask). `Billing` writes `invoice_issued` (the invoice's id and Stripe's), `invoice_refused` (the rule, when an invoice for the job already exists or there is nothing to invoice), `invoice_pay_test` (the amount paid, on the test path), `refund_skipped` with the rule `no-deposit` when a cancelled event has no deposit to refund, `stripe_error` with an `op` (`void`, `delete-customer`, `cancel` and the rest) and a reason code when a call to Stripe failed, and, at the wipe, `stripe_wipe` with the counts of intents, invoices voided, customers deleted and failures. None of them holds a brief, a key, an email or a card.

**Log lines added in PR 8 (2026-11-05).** All carry ids, counts and rule slugs, never a body, a subject, a note or a brief. Crm writes `crm_seeded` (`logged`, `refused`), `crm_ingest_skipped` (`skipped`), `crm_event_refused` (event id, type, `rule`), `campaign_sent` (`campaign`, `recipients`), `campaign_send_skipped` (`reason: not-scheduled`, the second firing of a timer), `campaign_send_refused` (`rule`), `sends_deferred` (`sends`, while a rebuild runs), and the rebuild's `rebuild_started` (`total`), `rebuild_step` (`applied`, `total`), `rebuild_finished` (`events`, `ms`, `identical`) and `rebuild_error` (`rule`, `position`). The Inbox writes `inbox_seeded` (`messages`, `timers`), `messages_delivered` (`cause`, `messages`, `kinds`), `engagement` (`opened`, `clicked`) and `inbox_event_refused`; the Customer writes `customer_event_refused`. The consumer writes `subscriber_unborn` when Crm or the Inbox answers 410, and the Sandbox writes `fault_push_error` when it cannot push the `inbox` switch to the Inbox and `seed_override_refused` when `SANDBOX_SEED` is set on a non-loopback API. The line to look for in a rebuild is `rebuild_finished` with `"identical":false`.

**Data points** (as built, 2026-11-06; `METRICS` is bound to the dataset `bakery_events` in `wrangler.jsonc`). Seven, written only by the Worker and its objects. Each has `blobs: [name]`, `indexes: [name]` and a double `1`, except `wipe`, whose doubles are `[sandboxes, objects, ms]`. Nothing identifies a visitor, a sandbox, an account or an IP.

| Point | Written by |
|---|---|
| `sandbox_created` | `Control::admit`, after its commit, only when admitted and not a replay |
| `order_placed` | the Order's `place`, after its commit (a replay returns earlier) |
| `payment_succeeded`, `payment_failed`, `refund_issued` | Billing's `commit`, after the transaction, one per matching event |
| `dlq` | `workers/api/src/queue.rs`: the dead-letter writer when the Sandbox keeps the message, and the consumer's poison path when its dead letter is written |
| `wipe` | `Control::finish_wipe_run`: the 10:00 cron opens a row in `wipe_runs`, the fan-out run that ends the wipe closes it with the sandboxes stamped since and now wiped, their objects and the milliseconds from the cron (the `Clock` port); one point per wipe, not per sandbox. A sweep retry with no open row writes none |

A write is fire-and-forget (`workers/api/src/metrics.rs`) and never fails a request: a missing binding logs `metrics_unbound` once per isolate, and a refused write logs `metrics_error`. **Seeded orders and payments write no point** (seeding bypasses the commit paths); the Simulator's do. So a fresh sandbox's counters at zero are not a bug.

**Kept queries** (Analytics Engine SQL; code since PR 13, as built 2026-11-06). Two constants in `crates/app/src/analytics.rs`, listed in `KEPT`, with their reader and unit tests beside them:

- `COUNTS_24H` (`counts_24h`): one grouped query over `bakery_events` for the six counted events (`sandbox_created`, `order_placed`, `payment_succeeded`, `payment_failed`, `refund_issued`, `dlq`) since `NOW() - INTERVAL '1' DAY`, summing `_sample_interval`. A missing name reads as 0 and a row naming any other event is ignored.
- `LAST_WIPE` (`last_wipe`): the newest `wipe` point's timestamp, sandboxes, objects and milliseconds.

The counters are **rolling 24-hour totals** across every sandbox, so the older wording ("orders and payments an hour", "sandboxes a day") is replaced: orders, payments, payment failures, refunds, sandboxes and dead letters **in the last 24 hours**. The day's cap of 300 is not read from analytics: the status page draws `sandboxes_today` from `Control`'s ledger. The answer shapes in the unit tests come from Cloudflare's documented `FORMAT JSON` (fetched 2026-11-06), not a recorded real answer: [Launch](#launch) step 12 confirms one.

**The refresh** (`workers/api/src/analytics.rs`, called from the `*/15` cron after the retry sweep; never inside an object). It sends `POST {base}/accounts/{ANALYTICS_ACCOUNT_ID}/analytics_engine/sql` with `Authorization: Bearer ANALYTICS_API_TOKEN` and the query as the body, 5 s per query, `{base}` being `https://api.cloudflare.com/client/v4` unless `ANALYTICS_API_BASE` names a loopback host. Two queries a refresh, 96 refreshes a day, **at most 192 queries a day whatever the traffic.** On success `Control` stores `(as_of, json)` in `status_snapshot` and the cron logs `analytics_refreshed`. On a missing secret it logs `analytics_unconfigured` with the variable's name (or the reason `shape` for an account id that is not letters and digits) and runs no query. On a failure it stops at the first failing query, stores nothing from the partial answer, logs `analytics_failed` with the query's name, a reason code among `status`, `timeout`, `unreachable`, `body` and `shape`, and the status, and tells `Control` (`failed_at`). `GET /v1/status` then reports `counters_state`: `live`; `stale` at once after a failure that follows a good refresh, or when the snapshot is older than 20 minutes (the cron runs every 15 minutes, so a run that is missed or fails leaves the snapshot stale by the next one); `unavailable` with no snapshot. Always HTTP 200, `Cache-Control: no-store`; the page polls every 60 s and a view never runs a query.

**Log lines added in PR 13 (2026-11-06).** `analytics_unconfigured` (the variable's name), `analytics_failed` (query, reason, status), `analytics_refreshed` (`queries`, milliseconds), `analytics_base_refused` (the variable's name), `metrics_unbound`, `metrics_error` and `wipe_point` (sandboxes, objects, milliseconds). No line holds the token, the account id or any SQL.

**The nightly object check.** `bakery-objects` (in `scheduled.yml`, dormant until `LAUNCHED`; as built, 2026-11-06) runs twice a day, at 09:47 and 12:17 UTC. It lists every sandbox-scoped namespace of `bakery-api` through the account API with the read token (all classes but `Control` and `Account`). The API says whether an object holds data and never how old it is, so the 09:47 run keeps its listing and the 12:17 run, after the wipe and its retries, compares: an object that held data at both times survived the wipe. It opens (or comments on) one issue, "Objects survived the wipe", and fails the job. Listings hold only SHA-256 hashes, classes and counts, because logs, artifacts and issues are public here; the objects' ids are in the dashboard.

**The dead-letter check** (the 12:17 UTC run's last step; as built, 2026-11-06; dormant with the job). Since PR 13 the Worker's own refresh counts `dlq` points over the last 24 hours, and `GET /v1/status` carries the number as `counters.dlq_24h` with `counters_state` and `counters_as_of`. The step fetches `https://api.bakery.ihaveasegway.com/v1/status` with `curl` (20 s, two retries; the route is public, so it takes no token and no new secret) and reads those fields with `jq`. It runs after the survivors step even when that one failed, so neither finding hides the other. The 09:47 run skips it: the count covers 24 hours, so once a day is enough. By state:

| State | Count | The step |
|---|---|---|
| `live` or `stale` | 0 | One line in the job summary; green |
| `live` or `stale` | above 0 | Opens, or comments on, one issue titled "Messages dead-lettered" with the count, the state, `counters_as_of` and the runbook link, then fails the job. A `stale` count says so in the issue |
| `unavailable` | none | One line in the job summary; opens nothing and stays green (the status page says so itself: [the status incident](#incident-the-status-page-says-stale-or-unavailable)) |
| The fetch fails, or the answer has no valid state or count | none | Fails the step with a summary line. The API being down is `prod-smoke`'s finding ([Incident: the bakery down](#incident-the-bakery-down)); the line only says the count is unknown |

The issue carries a count and two times, never a message, an object id or a sandbox id (logs and issues are public here). The count is a rolling window, not an event, so a letter stays counted for 24 hours: the next day's run comments on the same open issue again until the window clears or the issue is closed. **The Actions read token still does not get Account Analytics Read, and no longer needs it:** the check reads the public route, and the only analytics credential is the Worker's own `ANALYTICS_API_TOKEN` ([step 8](#8-the-read-token-for-the-nightly-object-check)). The step has not run against the real route: the first run after launch is the proof, and [Launch](#launch) step 11 already has that run watched.

**The weekly reconciliation.** Compare `Control`'s ledger with the account's metered usage. Metered above the ledger means a per-sandbox ceiling is wrong; fix the ceiling, not the comparison.

## Alerting

Alerts go by email to Joseph's personal inbox, outside `ihaveasegway.com` on purpose: if DNS breaks, mail to `hello@` breaks with it.

| Signal | Source | Runbook |
|---|---|---|
| Budget alert at $10, $25, $50 or $100 | Cloudflare | [Kill switch](#kill-switch-l0-to-l4) |
| Breaker token rejected (401 or 403) | The cron handler's log, read in the weekly reconciliation | [Rotate secrets](#rotate-secrets) |
| Nightly wipe failed or short | `wipe` data point; the morning issue | [The nightly wipe](#the-nightly-wipe) |
| Objects surviving the wipe | `bakery-objects` issue, "Objects survived the wipe" | [The nightly wipe](#the-nightly-wipe) |
| Status page says stale or unavailable | The page itself; `analytics_unconfigured` or `analytics_failed` in the cron's log | [Incident: the status page](#incident-the-status-page-says-stale-or-unavailable) |
| Dead-letter queue not empty | `bakery-objects` issue, "Messages dead-lettered", from the 12:17 UTC run; the status page's dead-letter count (last 24 hours, every 15 minutes) and the Queues screen | [A dead-lettered message](#a-dead-lettered-message) |
| Weekly audit finding, a broken external link included | `audit` issue, "Weekly audit" | [Dependency update](#dependency-update); for a link, the maintenance calendar's Monday row |
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
4. Create the deploy token and the read token ([step 1](#1-the-deploy-token), [step 8](#8-the-read-token-for-the-nightly-object-check)), store them as GitHub secrets, and finish the settings in [step 7](#7-github-repository-settings). Then set the repository variable `LAUNCHED` to `true`, **before PR 11 merges**.
   - **What it gates.** In `ci.yml`: `preview`, `e2e`, `lighthouse`, `preview-cleanup`, `deploy`, `rollback`, `prod-smoke` and `prod-verdict`. In `scheduled.yml`: the scheduled runs of `bakery-objects` and `audit`. `verify`, `firewall` and `firewall-selftest` do not depend on it. With it unset, or set to anything but `true`, all of those are skipped and nothing holds a credential; unsetting it is the pipeline's off switch (`ci.yml` and `scheduled.yml` headers, 2026-11-06).
   - **Why before the merge.** `deploy` needs it on the merge's own run, and a merge with it unset deploys nothing and leaves nothing to say so but a skipped job. With it set, PR 11's own pushes start `e2e` and `lighthouse`; `preview` skips with a notice because `bakery-web` has no production yet.
   - **The dry run.** `scheduled.yml` has a `workflow_dispatch` that runs the chosen job whatever `LAUNCHED` says: `gh workflow run scheduled.yml --ref <branch> -f job=bakery-objects` (or `-f job=audit`). `bakery-objects` needs the two secrets and stops with an error without them. On an account where the API was never deployed it prints "nothing listed holds data", which a wiped account prints too: the dry run proves the token, the account id and the listing, not the wipe. `audit` needs no secret, and its first run is expected to open a "Weekly audit" issue, because main carried one moderate pnpm advisory (minimatch, through eslint) on 2026-11-05. GitHub offers a workflow for dispatch from the branches where its file exists, and whether it lists one that is not yet on the default branch is for launch day to confirm; if it does not, run the dry run right after the merge instead.
5. In the zone: the rate-limiting rule on the API hostname and the L3 rule, created and disabled; then `BREAKER_API_TOKEN` and the 15-minute cron breaker.
6. Production secrets ([step 6](#6-worker-secrets)): the Stripe sandbox's webhook endpoint and a production restricted key, Turnstile's production widget, the production GitHub app's client secret, the Google client secret, and the consent screen's support email moved to `hello@ihaveasegway.com`. Check that `workers/api/wrangler.jsonc` carries `GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_ID` and `STRIPE_PUBLISHABLE_KEY` as `vars`: the first deploy deletes any that exist only in the dashboard (step 6). Also the two status-page secrets, `ANALYTICS_API_TOKEN` and `ANALYTICS_ACCOUNT_ID` (step 8): without them the counters stay `unavailable`.
7. Publish the privacy page, then publish the Google consent screen and the GitHub app.
8. Merge PR 11. The first `deploy` runs `wrangler deploy` for the API, then the web Worker, attaching both custom domains.
   - **As it went on 2026-11-06 (run 116, PR 22's merge).** The merge's push run was cancelled by the pull request's own `closed` run (the shared concurrency group, fixed in #46) and re-run by hand. The API deployed and attached its Custom Domain, but the stage's health check failed: a new hostname spends longer than the check's two minutes on its DNS record and certificate (no resolution, then a refused connection, then a TLS handshake failure for the rest of the window), and the web stage never ran. The hostname answered three minutes after the deploy, with the commit and exact CORS. "Re-run failed jobs" finished the launch: `deploy` found the API live at the commit, skipped stage 1 and gave `bakery-web` its first deploy, whose hostname answered within a minute. So a first deploy of a hostname can fail its own health check and needs a re-run; every later deploy creates no hostname, and two minutes is right for it.
9. Watch the first `prod-smoke`. If it fails, `prod-verdict` opens the issue: [Rollback](#rollback).
   - **As it went on 2026-11-06.** The first smoke ran on the re-run and failed one check of 36: the start page got two policies in a browser, because production applies a `_headers` rule for `/` alone beside `/*` rather than in its place ([security.md](security.md#the-storefronts-policy); #42, fixed forward in #47). No rollback: the API had not changed and the web Worker had no earlier version. #47's merge (run 126) uploaded, smoked and promoted the fixed storefront, and the smoke passed all 36 checks at 17:59 UTC: the launch's first green `prod-smoke`.
10. Sign in with each provider on the production hostnames; read the first sign-in's CPU in Workers Logs against `limits.cpu_ms`; rehearse a rollback of each Worker.
11. After the next 10:00 UTC wipe, watch the first run of the morning object check (`bakery-objects`, 12:17 UTC): green means the launch is complete. It compares with the 09:47 listing of the same day, so the day's 09:47 run has to have happened too; if it was missed, a red 12:17 may only mean new sandboxes ([The nightly wipe](#the-nightly-wipe)). Record the date and start spike S4.
12. The status page's first real answer (PR 13). Within 15 minutes of the deploy, `analytics_refreshed` appears in Workers Logs and `https://api.bakery.ihaveasegway.com/v1/status` says `counters_state: "live"`. The query shapes were written from Cloudflare's documented `FORMAT JSON`, not from a recorded real answer, so confirm the first real answer against the unit tests' shape and that `IN`, `NOW()` and `INTERVAL '1' DAY` behave as documented; an `analytics_failed` line with the reason `shape` or `status` on the first run is the likeliest finding. Remember the counters read 0 until a visitor places an order: seeded orders write no point.

### Deploy

From PR 11, deploys happen on merge ([delivery.md](delivery.md#deploy-verify-roll-back)); there is no manual path.

1. Merge. `ci.yml` runs `verify`, `firewall`, `firewall-selftest`, `deploy`, `prod-smoke`. The last two run only while `LAUNCHED` is `true` ([Launch](#launch) step 4); until PR 11 merges only the first three exist.
2. Read the `deploy` summary: which Worker deployed, the version live before, the new id. The API deploys first, and only when its paths changed.
3. Green `prod-smoke` means done. A failed web Version URL smoke changed nothing; a failed API deploy leaves the web Worker on its old version; fix forward. A deploy that creates a hostname (the first deploy of a Worker with a Custom Domain, which has happened once, on 2026-11-06) can fail the API stage's two-minute health check while the hostname's certificate is issued: re-run the failed jobs once the hostname answers ([Launch](#launch) step 8).
4. If `prod-smoke` failed, `prod-verdict` opened an issue with the command: [Rollback](#rollback).
5. A DO class change is merged alone and deployed alone.

### Rollback

1. Find the target in the `prod-verdict` issue or the last `deploy` summary. Always pass an explicit version id.
2. From `main`: `gh workflow run ci.yml --ref main -f worker=<web|api> -f rollback_to=<version-id> -f reason="<why>"`. The job acts only on a dispatch from `main`, so `--ref main` is not optional. All three inputs are required: `worker` is `web` or `api`; `rollback_to` is a version id, a UUID, and the job refuses anything else (a tag or a commit will not do); `reason` is one line of at most 200 printable characters and becomes the deployment's message. The `rollback` job runs `wrangler rollback <id> --name bakery-<worker> --message "rollback: <reason>" --yes`, and `prod-smoke` follows. The `prod-verdict` issue gives this command ready to paste (`ci.yml`, 2026-11-06). The job needs `LAUNCHED` and the deploy token like `deploy`, and shares its group, so it waits for a running deploy and never races it.
3. If GitHub is down: dashboard → the Worker → Deployments → Rollback. Never from the laptop.
4. **The DO caveat:** Cloudflare refuses a rollback across a DO class change ([Cloudflare](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)). If refused, set the API to `read-only` or `off` with L1 and fix forward. Class changes ship alone, so the refused target is the version before one.
5. A rollback undoes code, not data, and sandbox data is gone by morning anyway.
6. Fix or revert on `main` first, since the next merge deploys `main` again. Close the issue with the cause and the check that would have caught it.

### The nightly wipe

The wipe is the privacy promise ([ADR 0005](adr/0005-a-private-sandbox-per-visitor-wiped-nightly.md)): every sandbox, all of it, at 10:00 UTC (03:00 Mountain standard time, 04:00 in summer; the bakery's time zone is America/Denver).

**What runs.** Cron `0 10 * * *` asks `Control` for the day's sandboxes (no `wiped_at`). `Control` calls each `Sandbox`, which calls `deleteAll()` on every child in its registry, deletes the Stripe sandbox objects it created where the API allows, then wipes itself. `Control` stamps `wiped_at`. The 15-minute cron retries what is left. Each object's own alarm at 36 hours is the backstop (Q25 · Q-ttl).

**How to see it ran.** A `wipe` data point; the `wipe_summary` log line (filter `type=wipe`); no row lacking `wiped_at` in `Control`'s `sandboxes` table in Data Studio; a green `bakery-objects` at 12:17 UTC.

**When it fails halfway.** The wipe is idempotent and the registry keeps children until the end, so a retry resumes. Wait two 15-minute sweeps, read the sandbox's `wipe_error` in the log, fix the cause, then request it by hand. If a class cannot delete, set `read-only` with L1 so no new data arrives, and fix forward.

**Before launch** there is no cron. On `wrangler dev` the scheduled handler runs when asked, with no `--test-scheduled` flag (Wrangler 4.157.0, checked on 2026-11-05; [cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally)): `curl "http://127.0.0.1:8788/cdn-cgi/local/scheduled?cron=0+10+*+*+*"` runs the wipe, and `cron=*/15+*+*+*+*` the sweep. The morning check is written (`scheduled.yml`, `scripts/bakery-objects.mjs`) and dormant until `LAUNCHED` is `true`; a dispatch runs it earlier ([Launch](#launch) step 4). Its local half is `node scripts/list-objects.mjs <persist-dir>`, which exits 1 if a sandbox-scoped object holds data, and `scripts/smoke-auth.sh` runs both.

**When the morning check is red.** The issue, "Objects survived the wipe", names the classes and counts, not the objects; open the dashboard (Workers & Pages → `bakery-api` → Durable Objects) for the ids, then follow "When it fails halfway". The job exits 2 and fails without an issue when the listing itself failed (a bad token, an API error): that is never read as a clean wipe, so look at the run. If it finds nothing holding data it says "nothing listed holds data", which a wiped account and an account the API was never deployed to both answer.

**When the 09:47 run was missed.** GitHub can delay or drop a scheduled run. Without that day's 09:47 listing, the 12:17 check cannot tell an object that survived the wipe from a sandbox a visitor made after it, so it counts every object holding data, opens the issue anyway, and says so in the issue and in a run warning ("No 09:47 listing ..."). Read that as a prompt to look, not a finding: dispatch `scheduled.yml` with `-f job=bakery-objects` before the next 10:00 wipe to make a baseline, or check `wiped_at` in `Control`'s `sandboxes` table. Close the issue if the objects are the day's new sandboxes.

**By hand.** Set `wipe_due` in `Control`'s `flags` table in Data Studio; the next sweep runs the full wipe. (The table and column names are an assumption for [architecture.md](architecture.md) to confirm.)

Deleted rows count as writes ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), as of 2026-11-04; spike S5 measures it). SQLite-backed objects keep 30 days of point-in-time recovery ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)), so Cloudflare can restore wiped rows for a month; [security.md](security.md) owns how the privacy page words that.

### A dead-lettered message

A message that failed its three retries is in `bakery-events-dlq`, and the dead-letter writer kept it, with its last error, in the owning Sandbox's `dead_letters` ([architecture.md](architecture.md), "Dead letters"). The issue "Messages dead-lettered" arrives at 12:17 UTC with a count for the last 24 hours and no message in it. The Queues screen (Workers & Pages, Queues, `bakery-events-dlq`) and the Sandbox's dead letters show which message and why; the issue does not. Then: read the last error, fix the consumer (or the data) and ship the fix, redrive the letter, and close the issue. The count is a rolling 24 hours, so the issue is commented on again the next day if the window still holds the letter; close it once the cause is fixed. A letter in a sandbox is gone at the next 10:00 UTC wipe, which is the cleanup for a poisoned message in a demo.

### Rebuild Crm's projections

A signed-in session (a guest gets 403) starts it from the console's "Rebuild projections" button or with `POST /v1/sandboxes/{id}/rebuild` (202; a second start while one runs is 409 `rebuild`). It is safe to run at any time: the log is never touched, and a delivery that arrives meanwhile is appended to the log and replayed too. Watch `GET /v1/sandboxes/{id}/rebuild`: `state` is `rebuilding` with `applied` climbing to `total` at 200 log entries per alarm, then `finished` with `ms` (and `idle` before the first run in a sandbox). Reads in the meantime answer the partial projection with `Projection-State: rebuilding`, and a campaign that falls due waits (`sends_deferred`). When it ends, `rebuild_finished` is logged with `identical`. `true` means the replay gave back, byte for byte, the projection it replaced. `false` means the stored projection had drifted from its log, which is a defect to report; the replayed projection is the one kept, because the log is the truth. On 2026-11-05 `scripts/smoke-crm.sh` ran this on a log of 1,033 entries and read `identical: true`. Nothing here rebuilds the Inbox or the Customers, which hold their own state and have no log to replay from.

**Real sends (Q22) are off and unbuilt.** No `Mailbox` adapter exists, so nothing in the Worker can send mail; every campaign message is a row in the Inbox. When the adapter is built for Joseph's own verified address it will be off by default, and its switch and its sender setup will be written here then ([security.md](security.md#privacy-and-data-inventory) says why the port can name no one else).

### Wipe now

A visitor's "Wipe now" calls `DELETE /v1/sandboxes/{id}` with their session and takes seconds. An operator wiping one sandbox sets `wipe_requested` on its row in `Control`'s `sandboxes` table and waits up to 15 minutes for the sweep, then confirms `wiped_at` is set.

### Kill switch L0 to L4

Five levels, cheapest first; [cost.md](cost.md) owns the design. Use the lowest that stops the problem.

| Level | Use when | Action | Takes effect | Undo |
|---|---|---|---|---|
| L0 `Control`'s budgets | Automatic: a daily budget (sandboxes, requests, rows, simulated traffic) is spent. The `Simulator`'s caps (Q40): at most 6 orders a minute and 30 minutes of traffic a sandbox a day, counted in the ledger, running only while the visitor's console is open and stopped by the wipe. Guests have 100 of the 300 sandboxes a day (Q45) | None; `Control` answers `read-only` or `off`, and the `Simulator` stops at its cap | Next admission | Resets at 00:00 UTC |
| L1 flags | A feature misbehaves or cost must stop | Set `live`, `read-only` or `off` in `Control`'s `flags` table in Data Studio; there is no admin endpoint | New requests at once; sockets end at their next message | Set `live` |
| L2 redeploy | Running sessions must end | **Not built as a dispatch** (see below). Use L1 `off`, or ship a change under `workers/api/` through the pipeline: every deploy restarts every object and drops every socket | L1: new requests at once, sockets at their next message. A deploy: minutes | None; admission applies L0 and L1 on reconnect |
| L3 WAF rule | A flood must stop before the Worker | Enable the pre-built, disabled custom rule that blocks the API hostname ([WAF](https://developers.cloudflare.com/waf/custom-rules/)) | Seconds. Whether a blocked request counts as an invocation is the site's spike S2; read its result there | Disable the rule |
| L4 detach the domain | The API should not exist for a while | Workers & Pages → `bakery-api` → Settings → Domains & Routes → remove `api.bakery.ihaveasegway.com` | Minutes | Redeploy, which re-attaches it (confirm) |

**Why L2 has no `redeploy_api` dispatch (`ci.yml` at d778ff7, 2026-11-06).** The dispatch trigger carries only the rollback's three inputs. A redeploy from a button would publish the scanned API bundle without a fresh `verify` and `firewall` run, and the rule is that nothing is published unless both passed on the bytes being published; `scripts/firewall/check.sh` cannot scope a dispatch run to a commit. A rollback is the only dispatch because it re-publishes a version that already passed. So when sessions must end: set `read-only` or `off` in `Control`'s `flags` (L1), which ends sockets at their next message and needs no deploy; if every object must restart, merge a change under `workers/api/` and let `deploy` publish it (a change to `docs/` alone does not redeploy the API, which deploys only when its own paths changed). In an emergency that cannot wait for CI, L3 and L4 act at the edge in seconds and minutes.

After L3 or L4, public pages still work (static assets, $0) and signed-in screens show their offline state; a WAF block answers 403. Write any change that outlasts the day back into the code.

### Rotate secrets

Yearly, before the deploy token's end date; verify each new secret before deleting the old.

1. **Cloudflare tokens** (deploy, read, analytics, breaker): recreate as in steps 1, 8 and 2.6 with a new end date; `gh secret set` the first two, `wrangler secret put ANALYTICS_API_TOKEN --name bakery-api` the third (and `BREAKER_API_TOKEN` the fourth, once it exists); re-run a `preview`; confirm the next 15-minute run raises no 401 and logs `analytics_refreshed` and not `analytics_failed` with `status` 401 or 403; delete the old; update the calendar.
2. **`SESSION_HMAC_KEY`, with overlap.** Sessions and API tokens last 24 hours. Put the current key in `SESSION_HMAC_KEY_PREV`, put the new one in `SESSION_HMAC_KEY` (the Worker signs with one and verifies with both, so no one is signed out), and delete `SESSION_HMAC_KEY_PREV` after 24 hours. Setting a secret creates a new version; confirm when building.
3. **`ACCOUNT_HMAC_KEY`:** on compromise only. Every Google and GitHub account id changes, so each such visitor gets a new sandbox; sandboxes are wiped nightly anyway.
4. **Stripe:** roll the restricted keys and the webhook secret (an endpoint secret may allow a short overlap; confirm), update the three secrets, send a signed test event from the dashboard.
5. **Google and GitHub:** add a second client secret, set it, test sign-in, delete the old (confirm two can coexist on each). **Turnstile:** rotate in the widget, set `TURNSTILE_SECRET`, test sandbox creation.

On suspected exposure, do it at once in this order: delete the exposed credential, create the replacement, then read the audit logs from its creation for changes nobody made.

### Stripe sandbox reset

Quarterly, or when the sandbox is cluttered or its keys leaked. It holds only synthetic data: payment intents, charges, refunds and the finalized invoices the wipe voided, which Stripe keeps. Never delete the sandbox: Stripe refuses a new one until the business is verified (as of 2026-11-04).

1. Clear the sandbox's test data, if the dashboard offers it (confirm the control when building).
2. Roll the Worker's key, CI's key and the webhook secret as in [step 3](#3-the-stripe-sandbox); set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_E2E_SECRET_KEY`.
3. Redeploy the API (there is no L2 dispatch: merge a small change under `workers/api/`, or use [L2's alternatives](#kill-switch-l0-to-l4)), run `e2e`, send a signed test event.
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

### Rebuild the Salt Lake City data

Not a recurring task and not in CI: run it only to change the places, the city or the routing engine, and expect the files to change. The steps, the outputs' checksums and the open questions are in [tools/route-data/out/README.md](../tools/route-data/out/README.md); the first build (2026-11-05) ran as follows.

1. Needs Node 22, osmium-tool 1.16.0, about 4 GB of disk under `tools/route-data/work/` (git-ignored; delete it to reclaim the space) and either Docker, or Java 21 and Maven.
2. Without Docker, `sh ors/build-jar.sh` from `tools/route-data/` builds the ORS v9.10.0 jar (4 to 5 minutes on 2026-11-05). Then `npm run build` downloads the extract (Geofabrik's Utah file, else the openstreetmap.fr US West file, 3.78 GB, about 3 minutes), checks its MD5, builds the graph (about 20 s) and writes `out/`, `crates/seed/data/salt-lake-city/` and `apps/web/public/app/dispatch/data/`. With Docker, `npm run build` starts `ors/compose.yml` itself; that path is untested.
3. `npm test` runs the 20 tests (they skip the end-to-end ones when osmium is missing); `npm run check-box` makes one Nominatim request to re-check the city's box.
4. Read `out/places.md` against the firewall's classes (Joseph does), then commit the output in a pull request of its own. A different extract gives a different file, so say which extract and its timestamp in the pull request.
5. Moving to a new VROOM build is a different change: edit `apps/web/solver.lock.json` (commit, files, SHA-256s) in a pull request of its own and run `pnpm --filter web build`; `scripts/fetch-solver.mjs --check` verifies a fetched folder without fetching.

### Incident: the status page says stale or unavailable

As built in PR 13 (2026-11-06). Nothing else changes: orders, sign-in and the wipe do not read the snapshot, and only the page's counters are affected. `stale` means the last refresh failed or the snapshot is older than 20 minutes; `unavailable` means no snapshot has been stored yet.

1. Read the cron's lines in Workers Logs for the last hour: `analytics_unconfigured` names the missing variable; `analytics_failed` names the query (`counts_24h` or `last_wipe`), a reason (`status`, `timeout`, `unreachable`, `body`, `shape`) and the status; `analytics_refreshed` means it works.
2. `analytics_unconfigured`: set the secret it names ([step 8](#8-the-read-token-for-the-nightly-object-check)); `wrangler secret list --name bakery-api` shows names, never values. The next `*/15` run picks it up.
3. `analytics_failed` with status 401 or 403: the token expired or lost its permission. Recreate it as in step 8 and [rotate](#rotate-secrets). 429 or 5xx, `timeout` or `unreachable`: Cloudflare's SQL API ([status](https://www.cloudflarestatus.com/)); wait, the page recovers at the next good run. `shape` or `body` on a changed API: compare with `crates/app/src/analytics.rs`'s reader and fix forward.
4. `GET /v1/status` should still answer 200; if it does not, this is the [bakery down](#incident-the-bakery-down) runbook, not this one.
5. A page that says "Unreachable." is the browser failing to reach the API, not the snapshot.

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
| Daily | Nightly wipe and the morning `bakery-objects` check, which at 12:17 UTC also reads the dead-letter count | Automatic; an issue on a finding ("Objects survived the wipe", "Messages dead-lettered") | 0 while green |
| Weekly | Reconciliation of `Control`'s ledger against metered usage | Dashboard, 5 minutes | 22 |
| On each issue | Read, fix the cause, close | [The nightly wipe](#the-nightly-wipe) | 5 |
| Monday | `audit` in `scheduled.yml`: `cargo audit`, `cargo deny check advisories`, `pnpm audit`, Dependabot's old pull requests and alerts, `compatibility_date` age. A zone audit is not built | Automatic; an issue, "Weekly audit", on a finding | 0 while green |
| Monday | The external-link check, the last step of `audit` (`scripts/check-links.mjs`, from PR 12): every link that leaves the storefront (the site's lab pages, the ADRs, the essay's sources), 22 on 2026-11-06 | Automatic; a line "external link: <url>" in the same "Weekly audit" issue. A moved page: fix the link in `apps/web/src/lib/` or the page; a link that fails once from GitHub's rate limit clears the next Monday | 0 while green; 5 on a finding |
| Every other Monday | Grouped Dependabot pull requests, about 10 minutes beyond the site's sitting | [Dependency update](#dependency-update) | 22 |
| Monthly | Stripe sandbox review: delivery failures, key list, changelog, one signed test event | Stripe dashboard | 10 |
| Monthly | Usage against [cost.md](cost.md)'s meter; budget alert history; the DLQ is empty (the Queues screen; the daily check already opens an issue for a letter) | Dashboard | 10 |
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
