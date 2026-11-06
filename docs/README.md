# bakery docs

This folder is the plan and the decision record for Proof of Concept Bakery, a made-up bakery run as a real business system: ordering, pickup and delivery scheduling, catering, billing through Stripe's sandbox, and a CRM with campaigns. Every backend is Rust on Cloudflare Workers, and state lives in SQLite-backed Durable Objects (DOs). The docs say what the demo is for, how it is built, shipped, secured, paid for and run, and why each choice beat its alternatives. They are also a study guide: every decision names its pattern, the quality attributes it trades, whether it is a one-way or a two-way door, and a source to read next.

Status: Draft for review in PR 1 · 2026-11-04

PR 1 wrote these docs before any code, and Joseph answered the blocking questions on 2026-11-04; the docs below carry his answers. An Accepted ADR is a commitment and a Proposed one is still open to argument, and the [ADR index](adr/README.md) is the one place that says which is which. At the time of writing every ADR is Proposed. Everything else here changes by pull request, in the doc that owns the topic.

## Start here in 10 minutes

1. [product.md](product.md): read **Why** and **Open decisions** (5 minutes). The blocking questions were answered on 2026-11-04, and the rest proceed on their recommendations until Joseph moves them.
2. [architecture.md](architecture.md): the diagrams only (2 minutes).
3. [roadmap.md](roadmap.md): the phases, what each PR ships, and what blocks it (3 minutes).

Then change any answer in the PR review, with the question number and the option letter. Anything the firewall touches goes in the private record instead ([product.md](product.md#content-firewall)), because reviews and comments are public from the repository's first push. Every other doc can wait until the PR it serves comes up.

## Reading order

product → domain → architecture → stack → security → cost → delivery → operations → roadmap → adr/

Purpose first, then the language of the business, then the shape, then the parts, then what keeps it safe, what it costs, how it ships and how it is run alone, then the plan that schedules all of it. The ADRs come last because each one argues a single decision the docs have already put in context.

## Files

| # | File | What it answers |
|---|---|---|
| 1 | [product.md](product.md) | Why build it, for whom, and what is still undecided? Principles, the content firewall policy, open decisions Q1–Q45, what is decided, non-goals, how we will know it works |
| 2 | [domain.md](domain.md) | What does the business mean by its words? The ubiquitous language, aggregates, commands, the event catalog, state machines, invariants, the seed, and which lab principle runs where |
| 3 | [architecture.md](architecture.md) | What is the shape? Context and container diagrams, bounded contexts, DO topology, who owns each piece of data, request flows, bulkheads and failure modes, weaker designs |
| 4 | [stack.md](stack.md) | Which technologies, pinned how, and why? What each owns, what came second, what was rejected, the upgrade policy |
| 5 | [security.md](security.md) | What could go wrong, and what stops it? Threat model, headers, CSP and CORS, sign-in, privacy and the data inventory, the nightly wipe, secrets, Stripe safety, the content firewall, supply chain |
| 6 | [cost.md](cost.md) | What does it cost, and what keeps it there? Price sheet, formulas, the per-sandbox meter, scenarios, the plan decision, guardrails, denial of wallet |
| 7 | [delivery.md](delivery.md) | How does a change reach production? Repository layout, toolchain pins, the pipeline, environments, deploy and rollback for each Worker, quality gates, dependency policy |
| 8 | [operations.md](operations.md) | How is it run alone? Access setup, observability, alerting, runbooks (deploy, rollback, wipe, kill switch, secret rotation, leak response), the maintenance calendar |
| 9 | [roadmap.md](roadmap.md) | In what order? How we work, the definition of done, pull requests 1 to 16 with scope and estimates, spikes S1 to S7, decision gates, risks, what is explicitly later |
| 10 | [adr/README.md](adr/README.md) | Which decisions are hard to reverse? The ADR format, the template, and the index of every ADR with its status |

This table lists docs, not ADRs. The ADR index is the one owner of ADR titles and statuses. Copying it here would give the same facts two owners, the drift this plan avoids everywhere else.

## Status legend

| Status | Used on | Meaning | What may change |
|---|---|---|---|
| Draft for review | Docs (the line under each title) | Written for PR 1 and under review | Anything, in a PR |
| Updated in or after PR N | Docs | Revised since PR 1's review; the date is the latest revision | Anything, in a PR |
| Proposed | ADRs | Argued, not yet accepted. Every ADR starts here | The decision itself, in a PR |
| Accepted | ADRs | Joseph accepted it in review; the Status line carries the date | Typo fixes and dated postscripts only. A changed decision gets a new ADR |
| Superseded by NNNN | ADRs | Replaced by a later ADR, which links back | Nothing. It stays as the record of what was believed, and why |

## How to change a decision

The ADR lifecycle (proposing, accepting, superseding) is itself a decision, [ADR 0001](adr/0001-record-architecture-decisions.md). This is the short version.

- **A doc.** Edit it in a PR. Each topic has one owning doc (the table above), and other docs link to it rather than repeat it. Change the owner, not a copy.
- **A Proposed ADR.** Edit it in a PR. Nothing is built on it yet, so rewriting it is cheap.
- **An Accepted ADR.** Leave the decision as written. To change it, write a new ADR with the next number, explain in its Context what changed, and set the old one's status to `Superseded by NNNN`. When practice drifts without the decision changing, append a dated postscript instead. A later reader needs to see what was believed and why it changed, not only the current answer.
- **Door and Revisit if.** Every ADR carries both fields (the format is in [adr/README.md](adr/README.md), after Michael Nygard). **Door** says whether the decision is one-way, expensive or impossible to undo (a shared URL, a public repository, a Durable Object class name), or two-way, reversed by a PR. **Revisit if** names the evidence that would show the decision was wrong. When that evidence appears, the decision is reopened, never quietly edited.
- **An open question.** Joseph answers with the question number and the option letter, in the review or in an issue. The answer moves to Decided in product.md, which records the option, the date and what ships. A one-way answer also gets an ADR.
- **One PR in flight.** The roadmap's limit counts doc PRs too, so a decision change rides in the PR that needs it. It is relaxed for agent-built branches ([roadmap.md](roadmap.md#how-we-work), Q36 · Q-process).

## Conventions

- Every price, limit and version is labelled with the date it was checked, such as "as of 2026-11-04", and carries a source URL.
- Configuration in code fences is a sketch: confirm it against current docs when building.
- Diagrams are mermaid, which GitHub renders.
- Site URLs are written as code, such as `/menu/`, never as links. Links between docs are relative. Links to the site's own docs are GitHub URLs, such as `https://github.com/IHaveASegway/website/blob/main/docs/stack.md`.
- ISO dates, US English. "Durable Object (DO)" is spelled out on first use in each doc, then "DO".
- Each doc ends with "Patterns and further reading", one canonical source per pattern.
- The bakery is named Proof of Concept Bakery (Q2 · Q-name), chosen on 2026-11-04 by Claude at Joseph's request and checked against web search that day. The business-registry and trademark check runs before anything publishes. Docs say "the made-up bakery" on first mention, then "Proof of Concept" or "the bakery", and the Workers stay `bakery-web` and `bakery-api`.
- Write as if public, because it is. The repository is public from its first push, and the content firewall applies to docs, commit messages and PR text as much as to code. Its term list never appears here, and no doc names a real person, business or address.

## Relationship to the site's docs

The [site's docs](https://github.com/IHaveASegway/website/tree/main/docs) own the site and its Lab: the zone, the account, the design tokens, the Lab's five simulations and the rules they follow. These docs own the bakery. Where the bakery reuses a site decision, it links the site's ADR instead of copying it, and where it breaks with one, an ADR here says so and the site gets a superseding ADR in its own repository. The Lab pages will link here and the bakery's screens will link back to the Lab page that explains each principle (Q32 · Q-links).

## Patterns and further reading

- Architecture decision records: Michael Nygard, "Documenting Architecture Decisions" (2011).
- One-way and two-way doors: Jeff Bezos, 2015 letter to Amazon shareholders (Type 1 and Type 2 decisions).
- Goals, non-goals and alternatives considered: Malte Ubl, "Design Docs at Google" (2020).
- One owner per fact, applied to docs: Martin Kleppmann, *Designing Data-Intensive Applications*, Part III, "Systems of Record and Derived Data".
- Ubiquitous language and bounded contexts: Eric Evans, *Domain-Driven Design* (2003), Part IV, "Strategic Design".
- Docs next to code: Daniele Procida, ["Diátaxis"](https://diataxis.fr/), for why these docs separate explanation from reference.
