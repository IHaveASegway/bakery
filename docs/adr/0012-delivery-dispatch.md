# ADR 0012: Delivery dispatch: VROOM in the browser to plan, a savings heuristic in Rust to propose, the object to decide

Status: Proposed · 2026-11-04 · Deciders: Joseph Peterson

## Context

The made-up bakery, Proof of Concept Bakery, delivers in 2-hour windows per zone, with a daily capacity per window (Q10 · Q-slots). Each morning of business time the staff plan the day's deliveries: tens of stops and one to four vans leaving the bakery and coming back. Dispatch is a staff screen, `/app/dispatch/`, over one sandbox and one day. The `Dispatch` Durable Object (DO), one per sandbox and day, holds the day's stops and the route plan ([ADR 0003](0003-durable-objects-as-the-system-of-record.md)). It is where the Route Lab's principle runs in production code (Q33 · Q-principles), so a reader expects the Route Lab's solver here (Q9 · Q-dispatch). The bakery's city is Salt Lake City, Joseph's choice of 2026-11-04 (Q3 · Q-city), while the site's Route Lab stays on Seattle. So the bakery reuses the Route Lab's pipeline and solver files, and builds its own Salt Lake City data in PR 9; it does not reuse the Seattle data or places.

What the site already built, as of 2026-11-04:

- The site's Route Lab runs VROOM 1.15.0, the open-source vehicle routing solver in C++ (BSD-2-Clause), compiled to WebAssembly with Emscripten 6.0.13 and run in a module Web Worker in the visitor's browser, from static files. `vroom.wasm` is 919,927 B, 343,650 B gzip; in headless Chromium, 20 orders and 3 vans planned in about 60 ms, and 63 orders with 4 vans in about 320 ms (2026-10-25, 4 CPUs) ([the site's ADR 0016](https://github.com/IHaveASegway/website/blob/main/docs/adr/0016-route-lab-in-the-browser.md)).
- Its travel times were computed offline with OSRM's car profile over OpenStreetMap (© OpenStreetMap contributors, ODbL) for every pair of 64 public places in and around Seattle, 4,032 legs. The solver folder sits under `apps/web/public/lab/routes/solver/` and the data under `tools/route-data/out/`, both committed in the site's repository and pinned byte for byte by a lock file.
- The pipeline that built those data is `tools/route-data/pipeline/` in the site's repository: osmium-tool 1.16.0 and `@project-osrm/osrm` 26.6.5 with `d3-contour`, as pinned in [the site's stack.md](https://github.com/IHaveASegway/website/blob/main/docs/stack.md) as of 2026-11-04.
- *Amended 2026-11-05:* the bakery does not use that pipeline's engine. Its data build runs openrouteservice instead (decision 7); the site's pipeline stays reference only.
- A worker takes its Content Security Policy from its own response, so the solver's folder carries `'wasm-unsafe-eval'` and no page does (the site's ADR 0016).
- VROOM has no Rust port and no browser build upstream; the site's three patches are what make it compile.

Platform facts, as of 2026-11-04:

- Geofabrik publishes OpenStreetMap extracts by region, including Utah, under the ODbL ([Geofabrik downloads](https://download.geofabrik.de/), as of 2026-11-04). Whether the pipeline runs on the Utah extract is spike S7, bounded to one focused day.
- A DO handles one event at a time. A 2-second solve inside a handler would hold every other message to that object for 2 seconds, the kitchen board's included if it shared the object ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/): a soft 1,000 requests a second per object, CPU 30 s a request by default).
- Containers are Paid-only, start cold in 1 to 3 s, and under abuse the site priced one at about $185 per 72 hours ([the site's cost.md](https://github.com/IHaveASegway/website/blob/main/docs/cost.md), scenario E). The bakery does not use Containers.

The Clarke–Wright savings heuristic (Clarke and Wright, 1964) builds routes by merging the pair of stops whose shared trip saves the most travel, under each van's capacity. For n stops it computes n(n−1)/2 savings and sorts them: 1,770 for 60 stops, a few milliseconds of CPU in Rust, even compiled to WebAssembly.

## Decision

1. **The `Dispatch` object decides.** It holds the day's stops, the proposed plan and the published plan. Only a published plan reaches drivers, the kitchen board and the customer's order status, through a `RoutePublished` event ([domain.md](../domain.md)).
2. **The server proposes with Clarke–Wright savings in Rust**, in `crates/domain`, over the same travel-time matrix. It is a pure function from stops, vans, capacities and the matrix to a plan, tested natively with `proptest`, and it runs inside the object's handler in a few milliseconds for tens of stops.
3. **The staff screen can run VROOM in the browser** on the same data, in a module Web Worker, as the Route Lab does, and submit its plan as a command.
4. **The object validates every submitted plan** before it can be published: every stop appears exactly once; no van exceeds its capacity; each van's route starts and ends at the bakery; every stop belongs to this sandbox and day. The object recomputes each route's duration from the matrix itself, so a client's totals are never trusted.
5. **The page shows both plans' totals side by side**: total drive time, the time the last van is back, vans used, and the gap between them as a percentage, with a link to the Route Lab and to this record.
6. **The solver files are copied from the site's repository** with their lock, their licence file and their folder name, into `apps/web/public/app/dispatch/solver/vroom-<version>-<sha8>/`, and never fetched at run time from anywhere else. The dispatch page's policy adds `worker-src 'self'`, and the solver's folder gets the site's worker policy, the one place `'wasm-unsafe-eval'` appears ([security.md](../security.md)). The solver loads on the first solve, after the page ([ADR 0008](0008-astro-site-with-react-islands-on-an-assets-only-worker.md)).
7. **The travel-time matrix and the places are a committed fixture in `crates/seed`, built for Salt Lake City in PR 9.** The site's pipeline runs on Geofabrik's Utah extract, clipped to the city, with 64 curated public places: osmium, OSRM's car profile and d3-contour produce the matrix and the isochrones, kept with the ODbL attribution and also as static data for the dispatch screen. Delivery addresses are made up and map onto the curated places by index and label only; the screens show the made-up address, never the place as somebody's home (Q3 · Q-city). If spike S7 fails, PR 9 ships with a hand-built matrix and the gap is recorded.

   **Amended 2026-11-05.** Joseph's direction of that day replaces the routing engine in this decision. The travel times and the isochrones come from a **self-hosted openrouteservice** (openrouteservice v9.10.0, tag `v9.10.0`, commit `8ed869459de157032edb146a6fc247379c428e23`, read with `git ls-remote` on 2026-11-05), which the build itself runs, from Docker compose or from a jar built with Maven. They do not come from OSRM, and not from a hosted routing API (no API key, no quota, no third party at build time apart from the extract's mirror). The extract is Geofabrik's Utah file when it is reachable, with the [openstreetmap.fr US West file](https://download.openstreetmap.fr/extracts/north-america/us-west-latest.osm.pbf) (3,778,845,964 B, replication timestamp 2026-11-05T00:58:30Z) as the fallback; this build used the fallback, because Geofabrik answered every request with a reset connection from the build machine on 2026-11-05. osmium still clips the extract and picks the places. The site's pipeline, `tools/route-data/pipeline/` in its repository, is read-only reference and nothing of it is copied: the build is new, has no dependencies and so no lockfile, and writes the site's output shapes. The solver folder is not copied either, which changes decision 6's "copied" to "fetched at build" as the storefront stream built it on 2026-11-05: the web build fetches the folder from the site's repository at commit `34b4515260bdcca350a949f130a879b472ff90e0` and checks every file against `apps/web/solver.lock.json` (`vroom.wasm` is 919,927 B), so the module is never in git and the firewall's "no WebAssembly committed" line stays true. This part waits for Joseph's decision: committing the 919,927 B module, as the site does, is the alternative, and costs that line. Spike S7 passed on 2026-11-05 ([roadmap.md](../roadmap.md#spikes)). What the build found and where it is recorded: [tools/route-data/out/README.md](../../tools/route-data/out/README.md).

   What changes in the Consequences, by this amendment. Good: no API key and no quota anywhere, and a stranger can rebuild the data on their own machine. Bad: a second routing engine to pin (openrouteservice, GPL-3.0 with its engine under LGPL-3.0, a build tool whose output is data and of which nothing ships), next to osmium-tool; the build needs Node 22, osmium-tool 1.16.0 and either Docker or Java 21 with Maven, and downloads a 3.8 GB extract the first time; the Docker path is written and not yet run on any machine, because the build machine had no Docker daemon; and the graph build is not promised to give the same times on another machine or version, so the committed files are the record, not the rebuild. The Revisit trigger about a Utah extract now reads "the pipeline does not run on an extract the mirror or Geofabrik offers".

   **As built 2026-11-05.** The Worker stream settled three decisions more precisely than the text above, and Joseph has not yet read them (this record's status is unchanged). *Decision 1:* the object decides, and a plan stands once a van has left. The object cannot know that from its own log, so before a publish over a published plan it asks each of that plan's Orders for their status, and if one is out for delivery, delivered or closed it passes `departed` into `Publish`, which the aggregate refuses as `published`; completing stops still works. The alternative, routing `OrderOutForDelivery` back to the Dispatch, needs a new event and a catalog row. Its consequence is that an Order not yet ready refuses `MarkOutForDelivery`, so a plan published before its orders are ready leaves them unsent, and nothing sends them again when they become ready. *Decision 4:* the validator runs on a submitted plan and again at publish, since stops come and go between; its rules are `vans`, `route-ends`, `stop-unknown`, `stop-twice`, `over-capacity` and `stop-missing`, and the minutes are always recomputed from the matrix, so a total sent with a plan is refused 400 `body`. The refusal statuses are 422 for a proposal and a browser plan, 409 for every refusal of a publish (the plan's own rules re-checked included), and for a completion 409 `no-plan` and 422 `stop-unknown`. *Decision 5:* the time the last van is back counts 3 minutes at each door (the route data's `serviceSeconds` of 180), and the drive minutes the two plans are compared on do not. A command's key is its `Idempotency-Key` prefixed by its step (`publish:<key>`) in the object's `commands_seen`, so one key publishes once, and a key reused with another body is 422 `idempotency-key`. The seeded proposal and the object plan on the same committed matrix, and the default capacity is 250 units a van, because 20 cannot carry the busy Saturday ([domain.md](../domain.md#dispatch)).

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **A. VROOM in the browser to plan, savings in Rust to propose, the object to decide (chosen)** | Consistency: one validated record. Cost: both solvers run free, one in the browser and one in milliseconds of DO CPU. A stated comparison between a classic heuristic and a modern solver | Evolvability: two solvers and one validator to keep agreeing on the data. Latency: about 344 KB gzip of WebAssembly on the first browser solve | Chosen |
| B. Rust only | Least to ship; no WebAssembly on the page | A weaker plan with nothing to compare it against, and the Route Lab's solver missing from the place the lab links to | Rejected |
| C. Browser only | Least server code | Consistency: a plan nobody validated becomes the record, and any client can publish any plan | Rejected |
| D. A routing API per solve | A strong solver with no bytes on the page | Security and privacy: a third party, its quota, and visitors' choices leaving the site; a new origin in the policy | Rejected |
| E. VROOM in a Container | VROOM on the server | Cost: the site's scenario E; Containers are not used. Latency: a 1 to 3 s cold start | Rejected |
| G. Reuse the Route Lab's Seattle data | Cost: no data build in PR 9 | The bakery would sit in a city other than the one Joseph chose for it on 2026-11-04, and its fixture would depend on the site's data | Rejected |
| F. Port VROOM's algorithms to Rust | One solver, in the server's language | Evolvability: weeks of work, and a second implementation to keep right against upstream | Rejected |

## Consequences

Good:

- Every published plan obeys the invariants, whoever made it. The validator is the single writer's rule in code, and it is tested natively.
- The page states the gap between the two solvers on each seeded day instead of claiming either is good.
- The Route Lab's solver bytes and pipeline are reused as they are, pinned, with their licences, and the site's measurements apply.

Bad:

- Two plans, with a stated gap. The heuristic has limits, shown on the page rather than hidden: no time windows at first, capacity as a single number, one depot.
- The solver's 343,650 B gzip load only on the dispatch screen, on the first solve; a phone on a slow link waits for them.
- The matrix covers Salt Lake City only, 64 places, and is a new offline build in PR 9. Synthetic addresses map onto the curated places, so two customers can share a drop point, and a new city is another data build. The build is a one-day risk until spike S7 passes.
- Upkeep Dependabot cannot see: when the site moves to a new VROOM or Emscripten build, the bakery copies the new folder and its lock in a pull request of its own ([operations.md](../operations.md)).
- The browser floor is the Route Lab's: WebAssembly exception handling, bulk memory and module workers. Below it, the screen shows the server's proposal only and says why.

## Door

Two-way. The solvers, the page and the fixture are code and static files. Dispatch state lives one business day in one sandbox and is wiped nightly ([ADR 0005](0005-a-private-sandbox-per-visitor-wiped-nightly.md)), so changing the heuristic, dropping VROOM or adding a solver migrates no data. The `RoutePublished` event's shape is the one part other contexts read, and it changes as any event does, by version.

## Revisit if

- A browser solve takes more than 2 s on a phone, on the largest seeded day.
- The heuristic's gap to VROOM passes 25% of total drive time on the seeded days, measured by a test over the seed.
- Time windows become part of the story, so the savings heuristic would need its time-window variant or a different method.
- The site's Route Lab replaces VROOM or its pipeline, or Geofabrik's Utah extract changes licence or format.
- Spike S7 does not run the pipeline on the Utah extract within one focused day, or a curated place falls outside the clipped city.

## Patterns and further reading

- The savings heuristic: G. Clarke and J. W. Wright, ["Scheduling of Vehicles from a Central Depot to a Number of Delivery Points"](https://doi.org/10.1287/opre.12.4.568), *Operations Research* 12(4), 1964.
- VROOM: [VROOM project](https://github.com/VROOM-Project/vroom), BSD-2-Clause.
- Command validation by a single writer: Martin Fowler, ["CQRS"](https://martinfowler.com/bliki/CQRS.html) (2011).
