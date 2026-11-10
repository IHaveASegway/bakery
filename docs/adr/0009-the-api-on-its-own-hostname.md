# ADR 0009: The API on its own hostname, api.bakery.ihaveasegway.com, behind CORS and a host-only cookie

Status: Accepted · 2026-11-09, by delegation; as amended by the postscript below · Proposed 2026-11-04 · Deciders: Joseph Peterson

## Context

The made-up bakery's pages are static files on the assets-only Worker `bakery-web` at `bakery.ihaveasegway.com` ([ADR 0008](0008-astro-site-with-react-islands-on-an-assets-only-worker.md)). Its API is the Rust Worker `bakery-api`, which holds every Durable Object (DO) class, the Queue consumer and the cron handler ([ADR 0002](0002-rust-for-every-backend.md), [ADR 0003](0003-durable-objects-as-the-system-of-record.md)). The browser calls the API from the app screens and the checkout, opens the kitchen board's WebSocket to it, and Stripe and Google talk to it directly ([ADR 0007](0007-stripe-sandbox-and-a-payment-element-that-collects-nothing.md), [ADR 0006](0006-sign-in-that-learns-nothing.md)). Joseph asked for the API under `api.bakery.ihaveasegway.com` (Q8 · Q-api-host).

The site chose the other shape for its lab: one Worker on the zone route `ihaveasegway.com/lab/api/*`, same origin, no CORS, `connect-src 'self'`. It listed a subdomain as the trade it declined, gaining origin isolation and a hostname-level kill switch for the cost of CORS, a second origin in the policy, another Turnstile hostname and another certificate ([the site's ADR 0009](https://github.com/IHaveASegway/website/blob/main/docs/adr/0009-lab-worker-same-origin.md)).

Facts, as of 2026-11-04:

- **Certificates.** A Workers Custom Domain generates its own certificate, multi-level subdomains included (the docs' example is `realms.app.example.com`), with no Advanced Certificate Manager subscription; Universal SSL alone covers only the apex and one level. The zone must be in the same account. A route Worker runs before a custom-domain Worker on the same hostname. ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/))
- **HSTS.** The zone's HSTS header carries `includeSubDomains` ([the site's ADR 0011](https://github.com/IHaveASegway/website/blob/main/docs/adr/0011-dnssec-and-hsts-ramp.md)), so every subdomain must serve HTTPS for the length of the max-age. A Custom Domain serves HTTPS with its own certificate, so both bakery hostnames satisfy it.
- **WebSockets.** Browsers apply no CORS to a WebSocket handshake and send the host's cookies with it, so the server must check `Origin` itself ([OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)).
- **Cookies and sites.** A cookie belongs to the host that set it, whatever page made the request. A host-only cookie set by `api.bakery.ihaveasegway.com` is therefore sent with credentialed requests the storefront's pages make to that host. `SameSite` compares sites, the registrable domain and scheme, and both hostnames are on `ihaveasegway.com`, so a `SameSite=Strict` cookie still travels on those calls. The `__Host-` prefix requires `Secure`, `Path=/` and no `Domain` attribute, so the cookie cannot be widened to the zone. ([RFC 6265bis](https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/), [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie))
- **The zone's WAF on the Free zone plan**: 5 custom rules and 1 rate-limiting rule ([WAF custom rules](https://developers.cloudflare.com/waf/custom-rules/)). Moving the account to Workers Paid does not change the zone's plan ([ADR 0010](0010-workers-paid-with-the-sites-guardrails.md)).
- **Turnstile** is free, and a widget is registered for the hostnames it renders on ([Turnstile plans](https://developers.cloudflare.com/turnstile/plans/)).

## Decision

1. **`bakery-api` on the Custom Domain `api.bakery.ihaveasegway.com`**, with `workers_dev: false` and no zone routes.
2. **CORS for exactly one origin.** `Access-Control-Allow-Origin: https://bakery.ihaveasegway.com` with `Access-Control-Allow-Credentials: true` and `Vary: Origin`; any other `Origin` gets no CORS headers. Allowed methods `GET, POST, PATCH, DELETE`; allowed request headers `Content-Type, Idempotency-Key, If-Match, If-None-Match`; exposed headers `ETag, Location, Retry-After`. Preflights are answered by the Worker without touching an object and cached with `Access-Control-Max-Age: 7200`, the ceiling Chromium applies (confirm when building).
3. **The session cookie** is `__Host-session; HttpOnly; Secure; SameSite=Strict; Path=/`, HMAC-signed, 24 hours, set only by the API host ([ADR 0006](0006-sign-in-that-learns-nothing.md), [security.md](../security.md)).
4. **An exact `Origin` check** on every state-changing request and every WebSocket upgrade: the header must equal `https://bakery.ihaveasegway.com`, byte for byte. Stripe's webhook path is the one exception and is authenticated by its signature instead; Google's redirect returns to the API with a `state` the API issued.
5. **The kill switch is the hostname.** A pre-built, disabled WAF custom rule matching `http.host eq "api.bakery.ihaveasegway.com"`, one of the zone's five, blocks the API without touching the site or the storefront. Detaching the Custom Domain is the level past it. The levels and the runbook are in [operations.md](../operations.md).
6. **Turnstile's widget is registered for `bakery.ihaveasegway.com`**, where it renders; the API verifies each token with Turnstile's server-side check before it creates a guest sandbox or a demo account (Q24 · Q-guest); a signed-in account needs no widget and is capped at 3 sandboxes a day instead ([architecture.md](../architecture.md)).
7. **The storefront's policy names `https://api.bakery.ihaveasegway.com` and `wss://api.bakery.ihaveasegway.com` in `connect-src`**, through the header its build writes ([ADR 0008](0008-astro-site-with-react-islands-on-an-assets-only-worker.md)). The API's own responses carry `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, since it serves no pages.
8. **The storefront holds the API's origin in one constant**, injected at build, so a preview build can point at a preview API when spike S4 allows one ([ADR 0011](0011-github-actions-owns-deploys-for-both-workers.md)).

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **A. The API on `api.bakery.ihaveasegway.com` (chosen)** | Operability: a hostname-level kill switch that cannot hit a page. Security: origin isolation between pages and API; a cookie the pages' scripts cannot read and no other host receives. Evolvability: the hostname can point at another Worker or provider later | Latency: a preflight on the first non-simple call per cached period. Operability: a second origin to configure, test and name in the policy; CORS code to get right | Chosen, as asked |
| B. Same-origin route `bakery.ihaveasegway.com/api/*` | Latency and simplicity: no CORS, no preflight, `connect-src 'self'`; the site's choice for its lab | Operability: a zone route in front of the assets Worker on the same hostname, so a wrong route pattern makes page views Worker invocations; a kill switch keyed on a path, where a mistake can match pages too | The runner-up |
| C. A path on the apex, `ihaveasegway.com/bakery/api/*` | One origin with the site | Evolvability and availability: ties the bakery to the site's hostname, its route table and its deploy history; the site's same-origin pages would share a cookie scope with a demo | Rejected |
| D. The API serving the pages too | One Worker and one deploy | Rejected in [ADR 0008](0008-astro-site-with-react-islands-on-an-assets-only-worker.md): no Version URLs for the pages, and every page deploy drops every socket | Rejected |
| E. A separate zone or account | A real quota and blast-radius bulkhead from the site | Feasibility: a Custom Domain needs the zone in the same account, so a subdomain of this zone cannot be served from another account without Cloudflare for SaaS (custom hostnames on someone else's zone) or an Enterprise subdomain setup (a subdomain delegated as its own zone). Cost: neither is on the plans in use; prices not sourced here | Rejected (Q29 · Q-account) |

## Consequences

Good:

- Switching off the API is one rule on one hostname. The storefront's public pages keep serving, and the site is untouched.
- The cookie is host-only on the API. No script on the storefront can read it, no other subdomain receives it, and the site's pages never carry it.
- The hostname is the API's address for third parties, independent of how the storefront is built; it can move to another Worker without a page changing.

Bad:

- A second origin to configure and test. CORS is code the API must get right, and e2e tests it from the storefront's origin and from a wrong one.
- A preflight costs one extra round trip the first time each non-simple request shape is sent, until the cache expires. JSON bodies and `Idempotency-Key` make most writes non-simple.
- CSRF is handled by `SameSite=Strict` together with the exact `Origin` check, with no CSRF tokens. `SameSite` alone is not enough here: any page on any `ihaveasegway.com` host is same-site, so the `Origin` check is what refuses a request from the site's own pages or a future subdomain.
- The zone's one rate-limiting rule must now cover two paths: the site's lab and this hostname. Its expression names both, at one threshold, until the zone's plan changes ([ADR 0010](0010-workers-paid-with-the-sites-guardrails.md)).
- One of the zone's five custom rules goes to the bakery's kill switch.

## Door

Two-way for the topology. Nothing public links the API: the storefront holds its origin in one constant, so moving to a same-origin route is a build change, a route and a policy edit, with no data to migrate because sandboxes are wiped nightly.

One-way-ish for the hostname once third parties hold it. Stripe's webhook endpoint and Google's authorized redirect URIs are configured with `api.bakery.ihaveasegway.com`. Changing them is cheap, minutes in two dashboards, but forgetting one breaks payments or sign-in silently; [operations.md](../operations.md) lists both beside the hostname.

## Revisit if

- Preflight latency shows on the page: the e2e or Lighthouse runs measure a first API call more than 100 ms slower than a repeat call, across runs.
- A demo needs a cookie shared with the site, or the site's lab and the bakery need one sign-in.
- The hostname has to move, for example to give the bakery its own domain once Q2 · Q-name is answered.
- The `Origin` check refuses a legitimate request from a browser that strips the header on same-site requests.

## Postscript 2026-11-09

As built, 2026-11-09: the kill switch's pre-built WAF rule is also turned on by the 15-minute breaker at `off`, through the Rulesets API (`workers/api/src/breaker.rs`). The breaker is not configured in production as of 2026-11-09 (`GET /v1/status` says `unconfigured`).

## Postscript 2026-11-10

Corrected on 2026-11-10 by the session, under the owner's delegation of 2026-11-09; revisable. Each line names a sentence above that the build or a later record contradicts, and gives what is true, with its source. The decision text above is not rewritten.

- Alternatives' verdict for option A, "Chosen, as asked", records the owner's direction (Q8 · Q-api-host). The engineering case is in the same row: a kill switch on a hostname that cannot hit a page, and origin isolation with a host-only cookie no other host receives. Its cost, a preflight on the first non-simple call, has not been measured: no first-call latency is recorded as of 2026-11-10 (Revisit if's first trigger).

## Patterns and further reading

- Cross-origin resource sharing: WHATWG, [Fetch Standard, CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol).
- Cross-site request forgery defences, `Origin` checks and SameSite: OWASP, [Cross-Site Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
