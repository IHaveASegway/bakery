# Architecture decision records

One file per decision that is hard to reverse, or that a reviewer would ask about. The made-up bakery, Proof of Concept Bakery, is a running ordering, scheduling, catering, billing and CRM system, with every backend in Rust on Cloudflare Workers and its state in a Durable Object (DO) per aggregate; these records say why it is built that way. Format after Michael Nygard, "Documenting Architecture Decisions" (2011), plus two fields: **Door** (one-way or two-way, and why) and **Revisit if** (the evidence that would show the decision was wrong). This repository is public from its first push, so every record is written to be public-safe, and sensitive inputs (such as the content firewall's terms) never appear in one.

Status: Draft for review in PR 1 · 2026-11-04

| # | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Proposed |
| [0002](0002-rust-for-every-backend.md) | Rust for every backend, as WebAssembly on Workers, with the domain in native-testable crates | Proposed |
| [0003](0003-durable-objects-as-the-system-of-record.md) | SQLite-backed Durable Objects as the system of record: one object per aggregate, an event log and a transactional outbox | Proposed |
| [0004](0004-queues-between-objects-and-alarms-for-time.md) | Cloudflare Queues between objects, idempotent consumers, and alarms for everything timed | Proposed |
| [0005](0005-a-private-sandbox-per-visitor-wiped-nightly.md) | A private, seeded sandbox per visitor, wiped every night, holding no personal data by construction | Proposed |
| [0006](0006-sign-in-that-learns-nothing.md) | Sign-in that learns nothing: Google with the openid scope alone, GitHub with its numeric id alone, and demo accounts without email | Proposed |
| [0007](0007-stripe-sandbox-and-a-payment-element-that-collects-nothing.md) | Stripe's sandbox for payments and billing, through a Payment Element that collects no billing details | Proposed |
| [0008](0008-astro-site-with-react-islands-on-an-assets-only-worker.md) | The storefront is an Astro site with React islands on an assets-only Worker at bakery.ihaveasegway.com | Proposed |
| [0009](0009-the-api-on-its-own-hostname.md) | The API on its own hostname, api.bakery.ihaveasegway.com, behind CORS and a host-only cookie | Proposed |
| [0010](0010-workers-paid-with-the-sites-guardrails.md) | Workers Paid for the account, with the site's guardrails from launch day | Proposed |
| [0011](0011-github-actions-owns-deploys-for-both-workers.md) | GitHub Actions owns build, gates and deploys, for both Workers | Proposed |
| [0012](0012-delivery-dispatch.md) | Delivery dispatch: VROOM in the browser to plan, a savings heuristic in Rust to propose, the object to decide | Proposed |

0013 is reserved for the API and socket contract v1, written in PR 10 (the tour and the visitor API). Until then the contract is described in [architecture.md](../architecture.md) and may change without a record.

Open decisions that have not reached an ADR yet are the numbered questions in [product.md](../product.md), cited across these records by number and short name (for example Q23 · Q-auth). Several records here state an assumption that holds until a question is answered, and say which.

## How a decision moves

How an ADR is proposed, accepted, superseded and amended is itself a decision: [ADR 0001](0001-record-architecture-decisions.md). In short:

- An ADR starts as **Proposed**, in the pull request that needs it. Merging that pull request does not accept it.
- Joseph accepts it in a pull request review by changing its status line to **Accepted** with the date, at the latest in the pull request that first builds on it.
- An Accepted ADR is not rewritten. A changed decision gets a new ADR, and the old one's status becomes **Superseded by NNNN**. A dated `## Postscript YYYY-MM-DD` records practice that differs without changing the decision.
- This index changes in the same pull request as the ADR.

## Same format as the site

The format is the one Joseph's site uses ([ADR 0001 of the site](https://github.com/IHaveASegway/website/blob/main/docs/adr/0001-record-architecture-decisions.md)), so a reader of one repository can read the other. The two sets are numbered separately. A record here that cites one of the site's records names it as "the site's ADR NNNN" and links its GitHub URL; a bare "ADR NNNN" always means this repository. Where the bakery decides differently from the site, the record says so and says why: [ADR 0002](0002-rust-for-every-backend.md) against the site's TypeScript choice, and [ADR 0009](0009-the-api-on-its-own-hostname.md) against the site's same-origin lab API.

## Template

```
# ADR NNNN: <decision>

Status: Proposed | Accepted | Superseded by NNNN · <date> · Deciders: <names>

## Context
## Decision
## Alternatives considered
## Consequences
## Door
## Revisit if
```

Context carries dated, sourced facts: every price, limit and version says "as of" a date and links its source. Alternatives considered names, for each option, what it gains, what it costs in quality attributes (availability, cost, latency, operability, security, evolvability, testability, consistency) and the verdict. Revisit if names evidence someone could observe.

## Patterns and further reading

- Architecture decision records: Michael Nygard, ["Documenting Architecture Decisions"](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) (2011).
- One-way and two-way doors: Jeff Bezos, [2015 letter to Amazon shareholders](https://s2.q4cdn.com/299287126/files/doc_financials/annual/2015-Letter-to-Shareholders.PDF) (Type 1 and Type 2 decisions).
- MADR, the main alternative format, and why it is not used here: [ADR 0001](0001-record-architecture-decisions.md).
- The site's records, which this set follows and sometimes departs from: [the site's ADR index](https://github.com/IHaveASegway/website/blob/main/docs/adr/README.md).
