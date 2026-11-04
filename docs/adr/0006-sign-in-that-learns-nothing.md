# ADR 0006: Sign-in that learns nothing: Google OpenID Connect with the openid scope alone, and demo accounts without email

Status: Proposed · 2026-11-04 · Deciders: Joseph Peterson

## Context

Joseph asked for two ways to sign in to the made-up bakery: Google, and a username and password. Sign-in exists so a visitor can come back to the same sandbox from another device ([ADR 0005](0005-a-private-sandbox-per-visitor-wiped-nightly.md)); it does not exist to know who the visitor is. [ADR 0005](0005-a-private-sandbox-per-visitor-wiped-nightly.md) also promises that the bakery stores no one's personal data, and sign-in is the one place where a provider would hand it some. So the sign-in design starts from a question: what is the least the API can receive and still recognize a returning visitor? This record assumes the answer to Q23 · Q-auth in [product.md](../product.md) (Google `openid` only plus demo accounts, passkeys later), which is blocking.

Facts, as of 2026-11-04:

- **Google OpenID Connect** ([docs](https://developers.google.com/identity/openid-connect/openid-connect)). The ID token's `sub` is always present, "unique among all Google Accounts and never reused". `email` and `email_verified` appear only when the `email` scope is requested; `name` and `picture` come with `profile`. ID tokens are validated locally against the keys at the discovery document's `jwks_uri`; the `tokeninfo` endpoint is for debugging only. The same page says the scope "must begin with openid and then include profile, email, or both". Whether a request with `scope=openid` alone succeeds is therefore unknown and is spike S2 ([roadmap.md](../roadmap.md)).
- **Google's consent screen rules.** An app that uses only non-sensitive scopes does not have to complete app verification, but showing an app name and logo on the consent screen needs a lighter brand verification ([OAuth App Verification Help Center](https://support.google.com/cloud/answer/13463073), read 2026-11-04). The consent screen shows the app's name, logo, a user support email and links to the privacy policy, and the privacy policy must be hosted within the same domain as the app's home page ([brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification), read 2026-11-04). An app whose publishing status is Testing is limited to up to 100 test users ([Manage App Audience](https://support.google.com/cloud/answer/15549945), read 2026-11-04), so the app must be published to production before visitors can use it.
- **Authorization code flow hardening.** PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)) and the OAuth 2.0 Security Best Current Practice ([RFC 9700](https://datatracker.ietf.org/doc/html/rfc9700)), which recommends PKCE for every client.
- **Password hashing within Workers' limits.** On Paid, a stateless Worker invocation gets 30 s of CPU by default and 128 MB of memory, WebAssembly linear memory included ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). OWASP lists argon2id minimum configurations from m=47104 (46 MiB), t=1 down to m=19456 (19 MiB), t=2, p=1 and lower-memory equivalents ([Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), read 2026-11-04). The CPU time of argon2id compiled to wasm32 in workerd has not been measured.
- **The hostnames.** The API is on `api.bakery.ihaveasegway.com` and the storefront on `bakery.ihaveasegway.com` ([ADR 0009](0009-the-api-on-its-own-hostname.md)). They share a registrable domain, so a `SameSite=Strict` cookie on the API host is sent on the storefront's credentialed requests to it; it is not sent on a top-level navigation that arrives from another site, such as Google's redirect back.

## Decision

1. **Google sign-in is the authorization code flow, run by `bakery-api`,** with `state`, `nonce` and a PKCE `S256` challenge. The API sets a short-lived transaction cookie, `__Host-oauth; HttpOnly; Secure; SameSite=Lax; Path=/`, holding the signed `state`, `nonce` and verifier for 10 minutes; Lax because Google's redirect back is a cross-site navigation. The callback exchanges the code, verifies the ID token's RS256 signature against Google's JWKS (cached by its `Cache-Control`), and checks `iss`, `aud`, `exp` and `nonce`. The Rust crate for the RS256 check is chosen in [security.md](../security.md); `ring` has limited wasm32 support, which rules out libraries that require it.
2. **The scope is `openid` alone**, if spike S2 shows Google accepts it. If S2 fails, the fallback is `openid email` with the `email` and `email_verified` claims dropped in the callback before anything is stored or logged, which the docs record as the weaker design: the API would then receive an email address even though it keeps none.
3. **Only `sub` is used, and only as an HMAC.** The account id is `HMAC-SHA256(server secret, sub)`. The raw `sub` is never stored or logged, so the store holds no Google identifier either: someone holding the database could not look a visitor up at Google. The secret is a Worker secret, never in the repository.
4. **Demo accounts have a generated username and a password the visitor sets.** The username is generated (for example `baker-7f3k`) and shown once with a copy control; the visitor cannot choose it, because a chosen username is the one field where a visitor would type something of their own. The password is hashed with argon2id in the stateless Worker, outside any Durable Object (DO), with parameters from the OWASP list set in [security.md](../security.md) after spike S1 measures their CPU time; the hash is stored in the `Account` object. Creating one needs a Turnstile pass and counts against `Control`'s daily budget.
5. **The session is a host-only cookie on the API hostname**: `__Host-session; HttpOnly; Secure; SameSite=Strict; Path=/`, HMAC-signed, valid for 24 h, carrying the account id and the current sandbox id. No `Domain` attribute, so the storefront's host never receives it, and no token is ever readable by page script.
6. **No email anywhere**, so no password reset by email. A demo account that loses its password is abandoned; a new one costs nothing, and its sandbox would have been wiped that night anyway. An account unused for 30 days deletes itself by its own alarm ([architecture.md](../architecture.md)).
7. **The consent screen** names the bakery (assumed until Q2 · Q-name is answered), links `/privacy/` on `bakery.ihaveasegway.com`, and gives hello@ihaveasegway.com as the support email. The Google Cloud project is published to production before launch, and brand verification is requested so the name shows.
8. **Passkeys come later**, in their own record, as a third way to sign in to the same account.

```mermaid
sequenceDiagram
    participant B as Browser
    participant A as bakery-api
    participant G as Google
    B->>A: GET /v1/auth/google/start
    A-->>B: 302 to Google, Set-Cookie __Host-oauth (state, nonce, verifier)
    B->>G: consent (scope=openid)
    G-->>B: 302 to /v1/auth/google/callback?code&state
    B->>A: callback with __Host-oauth
    A->>G: code + verifier for tokens
    A->>A: verify ID token, keep HMAC(secret, sub), discard the rest
    A-->>B: Set-Cookie __Host-session; 303 to the console
```

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **Google `openid` plus generated demo accounts (chosen)** | Security: the store holds no email, no name and no provider identifier. Operability: no mail to send, no reset flow | Availability for the visitor: no password reset. Testability: depends on S2's answer about the scope | Chosen |
| Cloudflare Access in front of the console | Security: identity at the edge, no auth code in the Worker | It hides the console from visitors behind an identity wall, which defeats the demo. Fine for an operator-only view later | Rejected for visitors |
| Magic links by email | Operability: no passwords | Security: needs an email address, which the privacy rule forbids. Cost: sending mail to arbitrary visitors | Rejected |
| Passkeys only | Security: phishing-resistant, no password to hash | Availability: needs a recovery story, and a recruiter on a borrowed laptop may not have one set up. Evolvability: a later addition is cheap | Deferred |
| Guests only, no accounts | Security and cost: nothing persists but a cookie | Availability: no sandbox across devices, which Joseph asked for | Rejected |
| A social login with the `email` scope | Operability: the documented default; a reset path by email | Security: the API receives and must be trusted to discard an email for every sign-in, and the privacy page can no longer say it never receives one | Rejected; kept only as S2's fallback |

## Consequences

Good:

- The privacy page can say the bakery never receives a visitor's email or name from Google, if S2 passes, and never stores one either way.
- A Google account yields the same sandbox on any device, until the night's wipe, and the same account the next day.
- A database dump identifies no one: account ids are HMACs, demo usernames are generated, and passwords are argon2id hashes.

Bad:

- **No password reset.** A forgotten demo password loses the account. The sign-up screen says so before the visitor sets one.
- **Google's consent screen** shows the bakery's name and links the privacy page, so Q2 · Q-name blocks launch of Google sign-in, and brand verification takes Google's review time.
- **The HMAC secret is load-bearing.** Rotating it orphans every Google account's mapping. It is rotated only with a migration in `Account` that keeps the old key for lookups, and it is backed up outside Cloudflare.
- **argon2id costs CPU.** Each demo sign-in is a hash; the rate limit per IP hash and Turnstile bound how many an attacker can force ([ADR 0010](0010-workers-paid-with-the-sites-guardrails.md)).
- **Two cookies with different SameSite values.** The transaction cookie is Lax for one redirect and expires in 10 minutes; tests check that the session cookie never is.

## Door

Two-way for the mechanism: adding passkeys, changing hash parameters or moving the flow is code, and accounts hold nothing that a new mechanism could not map. One-way for the promise once `/privacy/` publishes it: adding the `email` scope later would need a new record and a dated privacy change. What hardens is the HMAC secret, since every Google account's id depends on it.

## Revisit if

- Spike S2 fails and the `openid email` fallback ships. Then the privacy page says the API receives an email it discards, and this record gets a postscript.
- More than 3% of sign-in attempts fail in a week for reasons other than a wrong password or a cancelled consent.
- Google changes the consent screen, scope or verification rules for non-sensitive scopes.
- A demo sign-in's argon2id hash takes more than 1 s of CPU at p95.
- A visitor's identifier (a raw `sub`, an email, a chosen name) is found in any store, log or analytics data point.
