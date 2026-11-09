# ADR 0001: Record architecture decisions

Status: Proposed · 2026-11-04 · Deciders: Joseph Peterson

## Context

The made-up bakery is a portfolio demo: a running ordering, scheduling, catering, billing and CRM system for a bakery that does not exist, with every backend in Rust on Cloudflare Workers and its state in a Durable Object (DO) per aggregate. One person builds and operates it, and much of the building is done by agents working from these docs. Its stated goal (Q1 · Q-goal in [product.md](../product.md)) is that a visitor can say, after ten minutes, that the principles the site's Lab simulates run here for real, in Rust on DOs, with the decisions readable. The decisions are therefore part of the product, and three readers need them written down:

- **Joseph, a year from now.** He will remember what was chosen and not why. Without the why, a decision is either reopened each time it is inconvenient or kept long after its reason has gone.
- **Visitors who read the code.** Engineers and hiring managers arrive from the site. They can read the Rust; they cannot see the options that lost. For architecture work the options that lost are the evidence, and a screen's "How this works" drawer links the record behind it (Q32 · Q-links).
- **The pull request reviewer,** who is also Joseph, and the agents that build from these docs. A decision written on its own page can be accepted or rejected on its merits. A decision buried in a diff is accepted with the diff, and an agent that cannot find the reason for a constraint tends to route around it.

The site already keeps its records this way: Nygard's format plus Door and Revisit if, an index, and a lifecycle from Proposed to Superseded ([the site's ADR 0001](https://github.com/IHaveASegway/website/blob/main/docs/adr/0001-record-architecture-decisions.md), accepted 2026-10-23). Several of the bakery's decisions are made against the site's: Rust where the site chose TypeScript ([the site's ADR 0014](https://github.com/IHaveASegway/website/blob/main/docs/adr/0014-typescript-on-workers.md)), Workers Paid where the site chose Free ([the site's ADR 0008](https://github.com/IHaveASegway/website/blob/main/docs/adr/0008-workers-free-with-guardrails.md)), a separate API hostname where the site chose the same origin ([the site's ADR 0009](https://github.com/IHaveASegway/website/blob/main/docs/adr/0009-lab-worker-same-origin.md)). Those contrasts read best when both sets use one format.

This repository is public from its first push (the site went public only after an audit, [the site's ADR 0012](https://github.com/IHaveASegway/website/blob/main/docs/adr/0012-public-repository.md)). There is no private period in which a careless sentence can be fixed before anyone reads it.

PR 1 proposes twelve records. Several are two-way doors. They are written because a reviewer would ask "why not X?", or because they move a boundary, not because they are irreversible. The threshold below says when that is worth an hour.

## Decision

- **Format.** The site's: Nygard's Context, Decision, Status and Consequences, plus **Alternatives considered** (each option's gain, its cost in quality attributes and a verdict), **Door** (one-way or two-way, and why, and what hardens) and **Revisit if** (evidence someone could observe). The quality attributes are named from one list: availability, cost, latency, operability, security, evolvability, testability, consistency. The template is in the [index](README.md).
- **When to write one.** An ADR is written when a decision meets any of these:
  1. Reversing it costs more than about a day, or breaks something outside the repository: a URL, a DO class name, stored data, a published protocol version, or a promise on the privacy page.
  2. It picks one technology, provider or plan over alternatives a reviewer would ask about.
  3. It moves a boundary: who owns a piece of data, what runs where, what a visitor can store, or who can deploy.

  Everything else is decided in the pull request and written into the doc that owns the topic. The repository layout is an example: [delivery.md](../delivery.md) owns it, and it has no ADR. Each topic has one owning doc; a record links that doc instead of copying it.
- **Files and numbers.** One decision per file, `docs/adr/NNNN-short-title.md`, numbered in order. A number is never reused. A reserved number (0013, for the API and socket contract v1) is held in the index until its record is written. A file is never renamed after it merges, because the site may link it (below).
- **Lifecycle.**
  - An ADR starts as **Proposed**, usually in the pull request that needs it. Merging a pull request does not accept the ADRs in it.
  - Joseph accepts an ADR in a pull request review by changing its status line to **Accepted** with the date. At the latest, that happens in the pull request that first builds on the decision. Until then a Proposed ADR can be edited or rewritten freely, including to record a different choice from the one first proposed.
  - An Accepted ADR is not rewritten. A changed decision gets a new ADR that supersedes it, and the old one's status becomes **Superseded by NNNN**. Besides that change, an Accepted ADR gets only typo fixes and postscripts.
  - When practice differs from an Accepted decision without changing it (a measured limit, a step done another way, a spike's result), a dated `## Postscript YYYY-MM-DD` goes after Revisit if. It says what differs, why, and whether any Revisit if condition was met.
  - The index in [README.md](README.md) changes in the same pull request as the ADR.
  - An open question in [product.md](../product.md) that a record depends on is named by number and short name ("assumed until Q25 · Q-ttl is answered"). Answering the question either accepts the record or rewrites it while it is still Proposed.
- **Public-safe by construction.** Records say "the current employer" or "a private venture" if they must say anything, never the thing itself. They name no real person, business, venue or address; every persona, venue and address in the bakery is synthetic, and Seattle appears only as the made-up bakery's city on the Route Lab's map (assumed until Q3 · Q-city is answered). The only email address a record may carry is hello@ihaveasegway.com. No account id, zone id, workers.dev subdomain, key or token appears, not even as a realistic placeholder. When a decision depends on a sensitive input, the input stays in a private file, as the content firewall's rules do (Q34 · Q-firewall), and the record refers to it generically. Records are scanned by the same firewall as every other file, locally by the hooks and in CI by the `firewall` job ([delivery.md](../delivery.md)).
- **Rendered by opt-in, from both repositories.** The site's colophon may later render selected records from this repository beside its own. Rendering stays opt-in per record, on the site's allowlist, so no record here reaches the site by accident. `docs/adr/` in this repository stays the system of record: the site reads it at build time and holds no copy that could drift. Adding the bakery's records to that allowlist is a pull request in the site's repository.

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **The site's format (chosen)** | Evolvability and operability: one format across both repositories, so a contrast with a site record reads side by side and the colophon renders both with one loader | Cost: an hour a record. The Door and Revisit if fields take thought, which is the point | Chosen |
| MADR 4.0 (4.0.0 released 2024-09-17, current as of 2026-11-04, [adr.github.io/madr](https://adr.github.io/madr/)) | Evolvability: YAML front matter that tools can read; decision-makers, consulted and informed fields that earn their place on a team | Operability: weight for one decider, whose consulted and informed fields stay empty. Consistency: its Confirmation section asks how compliance is checked, which is close to Revisit if but not the same question, and the bakery's records would read differently from the site's | Rejected |
| Design docs only, in the style of Malte Ubl's ["Design Docs at Google"](https://www.industrialempathy.com/posts/design-docs-at-google/) (2020) | Cost: one set of files. `docs/` already is that set, and it stays | Testability of the record itself: a design doc is edited as the design changes, so the reasoning at the time of a decision is overwritten and nothing says whether a choice was accepted | Rejected as the only record; both are kept |
| No records: decide in pull request descriptions and commit messages | Cost: zero overhead today | Evolvability: pull request text lives on GitHub, does not travel with a clone, cannot render on the site and cannot be read as a set. It fails Q1 · Q-goal outright, since the decisions are part of what the demo shows | Rejected |
| Amend in place: one file per topic, edited as the decision changes | Operability: one place to look | Consistency: what a reader takes away depends on how far down the page they read, and the index carries two statuses ("Accepted; amendment Proposed"). A screen's drawer that links a record could link a different decision next month | Rejected |

Prior art, and why nothing is built: [adr-tools](https://github.com/npryce/adr-tools) creates and supersedes Nygard-format files from the command line, and [Log4brains](https://github.com/thomvaill/log4brains) renders records as a static site. Twelve files need no generator, and the site already renders Markdown.

## Consequences

Good:

- A visitor who asks "why Rust" or "why not one database" finds a dated answer with its losing options, one click from the screen where the decision runs.
- Agents building from these docs find the reason for each constraint. A rule such as "no Workflows" or "no free text beyond two fields" carries its record, so it is less likely to be routed around.
- Superseded records stay in the folder with a link forward. The history is visible, and the index says which decision is current.
- The site and the bakery can be compared decision by decision, which is how the site will later write about which language fits which tool ([ADR 0002](0002-rust-for-every-backend.md)).

Bad:

- A pull request that makes a qualifying decision carries its record: about an hour each, an estimate taken from the site's.
- Wrong calls are public from the first push, with no private draft period. That is intended: a record that shows a decision changing, and why, is better evidence than one that is always right.
- Some context is written generically to pass the firewall. A reader occasionally gets "the current employer" where a name would be clearer.
- File names freeze at merge, because the site may link or render them.
- Ceremony is the main risk: twelve records before any code. The three-part threshold and the rule that other decisions are made in the pull request are the guard.

## Door

Two-way. The records are Markdown files in one folder, so changing the template costs a superseding record and an edit to the index. What hardens is a record's file name once the site links or renders it, and every promise a record makes that the privacy page repeats ([ADR 0005](0005-a-private-sandbox-per-visitor-wiped-nightly.md), [ADR 0006](0006-sign-in-that-learns-nothing.md)).

## Revisit if

- A decision that met the threshold merged without a record more than once in a quarter. Either the threshold or the habit is wrong.
- Proposed records older than 90 days outnumber Accepted ones. The acceptance step is not happening and needs a date in [roadmap.md](../roadmap.md).
- More than a quarter of Revisit if sections name no evidence anyone could observe. The format is being filled in rather than used.
- A second regular contributor joins. MADR's decision-makers, consulted and informed fields start to earn their place, and acceptance should not rest on one person.
- The site's format changes by a superseding record of its own. Follow it here, or record why not.
- After a year of rendered records, no visitor or reviewer has mentioned one. Keep writing them for maintenance, and stop treating them as portfolio pieces.

## Postscript 2026-11-09

As built, 2026-11-09: no record has been Accepted, though pull requests 2 to 18 built on all thirteen, so the rule that acceptance happens at the latest in the first pull request that builds on a decision was not kept. Each record that the build contradicts now carries a dated postscript like this one; accepting or revising them is Joseph's decision, listed in the roadmap's Remaining work. Q3 · Q-city was answered on 2026-11-04: the made-up bakery's city is Salt Lake City ([product.md](../product.md#decided)), and Seattle stays the Route Lab's map only.
