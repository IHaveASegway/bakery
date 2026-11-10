# ADR 0014: A live guide in place of the tour: notes beside what the visitor just did, hotspots for the rest, and a recorder, from one set of entries

Status: Accepted · 2026-11-10, by delegation · Proposed 2026-11-09 · Deciders: Joseph Peterson

## Context

PR 10 built a guided tour on every screen (Q41 · Q-tour; [architecture.md](../architecture.md#the-guide)): a button opened a drawer over the lower half of the window, and Back and Next walked the screen's steps, 31 of them on the console. Each step said what the element is, which events its action produces, which principle it teaches and the same request as `curl`. The content was checked against the OpenAPI document at build; the form was a slideshow the visitor had to take.

On 2026-11-09 Joseph wrote, of the tour: "the tour is basically a crappy drawer. It should be alive as basically a pop up around things being done, not always something that you take, rather a guide to what is being implemented under the hood." And of the product: "an elegant example of these various tools and principles working together to show interviewers everything we can bring to the table and the understanding of why use a tool and when not to."

Facts, as of 2026-11-09 (measured in this change's worktree):

- **The page already holds the evidence.** Every write the storefront makes goes through one function, `send` in `apps/web/src/lib/api.ts`, which gives each `POST` an `Idempotency-Key`. The console holds the kitchen socket, whose `evt` frames carry the envelope's `id`, `stream`, `seq`, `type` and `cause`; a board command's id is its idempotency key, and the event it causes names that id as its `cause` ([domain.md](../domain.md#the-envelope)). The simulator's events carry `cause: sim:<ulid>`.
- **The tour's words were long.** 65 steps on 11 screens; several steps (the clock's, the bake list's, the campaigns') ran past five sentences, because they were the screens' "How this works" paragraphs.
- **The tour cost every first load.** Its island and its 65 steps were in each island page's first JavaScript: the lightest class, the start page and privacy, loaded 93,993 B gzipped, of which the React runtime was 65,840 B (`apps/web/test/dist.test.ts`, measured 2026-11-09).
- **The page policy** is `style-src 'self'` plus hashes and `img-src 'self'` (`apps/web/src/policy.ts`): no `style` attribute in server-rendered markup, so a position computed at run time is set through the CSS object model.

## Decision

1. **One content model, the entry,** replaces the tour's step: `{ id, screen, target, title, what, why, whenNot, events, principle, api, triggers }` in `apps/web/src/guide/`. Every step carried over (65 entries on 2026-11-09; 68 on 12 screens on 2026-11-10, with the order's page; 71 later that day, with the landing page's path and the menu's start and categories; 72 with the menu the checkout reads); `what` is at most three short sentences, and `why` and `whenNot` one sentence each, written from the principle's essay. `triggers` names the route ids and event types that make the entry a live note. `apps/web/test/guide.test.ts` holds each entry against the OpenAPI document, the event catalog and those lengths, as the tour's test did.
2. **Three forms, one island, "Under the hood":**
   - **Live notes.** A click on a button, followed within 2 s by a write, opens a dark note beside the card or control pressed: the request (method, path, status, milliseconds, its key) or the socket frame and its answer; the object that decided it; each expected event, observed with its sequence number, seen in the activity feed, or still expected; then why this tool, when not, and the essay. A note never covers what it explains: it sits on whichever side has room, else docks in a corner clear of it, with a ring on the anchor. It is not a dialog, takes no focus, is announced politely as one sentence, closes itself after 8 s unless pinned or in use, and on a phone is a sheet over the lower third.
   - **Hotspots.** A small button beside each element an entry targets opens the entry's standing note: what it is, its events, why and when not, the principle's links and the same call as `curl`.
   - **The recorder.** A panel from the guide's bar lists the visitor's last actions, each opening into its hops, and every entry of the screen. It is the keyboard's and the screen reader's path to everything a note shows.
   - A short path, "Show me around", strings at most five entries a screen and waits at each for the visitor to do the thing. It is never required.
3. **A trace store in the page,** `apps/web/src/lib/trace.ts`, takes evidence from sources behind one interface: the page's own writes (a hook in `send`: route, method, path, status, time and key, never a body), the socket's commands, answers and envelopes, and the activity feed's new entries. An event belongs to the visitor's action when its `cause` is the action's key or the id of an event that does; a simulated event never does, so simulated traffic opens no note. A third source, the server's flight recorder, is typed and not built; it plugs in without changing the notes.
4. **The switch** is on by default and remembered for the browser tab in `sessionStorage` (`bakery-guide` = `off` while off); the privacy page says so.
5. **The How it's built page gains a decision table** from the same entries: one row a principle, with the tool, why here, when it is the wrong tool and the essay. It loads no script.
6. **The layer loads after the island mounts, and only while it is needed.** The bar and the trace store are in the first load. The notes, hotspots, panel and entries are a deferred load of 30,192 B to 30,958 B gzipped (measured 2026-11-10, held under 39,000 B) that a dynamic import brings while the guide is on or the recorder is open; a visitor who turns the guide off does not load it on later pages.

## Alternatives considered

| Option | Gains | Costs | Verdict |
|---|---|---|---|
| **A. Live notes, hotspots and a recorder from one set of entries (chosen)** | Learnability: the explanation arrives where and when the thing happens, with the visitor's own ids and timings. Cost: the first load is smaller than the tour's, by 9,795 B to 13,774 B a page class (2026-11-10). Consistency: the notes, the hotspots and the How it's built table say the same words | Cost: with the guide on, the default, a page loads 10,804 B to 14,563 B more than it did with the tour, the deferred layer (2026-11-10). Complexity: a trace store, correlation by `cause`, and placement code. Testability: a note's behaviour needs a browser to prove, so an end-to-end spec carries it | Chosen |
| B. Keep the tour, restyle the drawer | Least work; the content stays | Learnability: still a slideshow taken apart from the action, which is what Joseph rejected | Rejected |
| C. A tour library (Shepherd.js, Intro.js, driver.js) | Ready-made popovers and steps | Security and cost: a script and often inline styles the policy refuses; it walks steps, it does not watch what the visitor did | Rejected, as the tour's own row in [stack.md](../stack.md) rejected it |
| D. Notes only from the server, through a flight recorder | Every hop, consumers and retries included, with real lag | Feasibility: not built yet. Availability: a demo whose explanation depends on a second socket. The page's own evidence is already there | Deferred: the recorder is typed as a source and joins later |
| E. Tooltips on hover alone, no live notes | Small; no store | Learnability: says what a thing is, never what just happened; nothing for a keyboard or a phone | Rejected |

## Consequences

Good:

- The signature minute explains itself: a press on the board shows the frame sent, the event that came back with its sequence number, and the judgment behind the tool, beside the card.
- The first load is lighter than the tour's, because the entries and the notes come after the page is usable, and a visitor who turns the guide off never loads them. Per class (2026-11-10, gzipped, after the console's seven pages merged), first load / with the guide on / the tour's total as last measured on main: home and privacy 82,071 / 113,029 / 94,187 B; the API reference 82,324 / 113,282 / 94,440 B; status 84,845 / 115,803 / 96,960 B; the storefront 93,930 / 124,342 / 103,417 B; the checkout 112,169 / 142,581 / 122,775 B; the console's largest page, the kitchen, 111,447 / 141,859 / 122,232 B; the order's page, which had no tour (97,911 B), 105,748 / 136,160 B. The tour's totals predate the shop's and the console's later changes, so part of each gap is theirs.
- The decision table and the notes cannot disagree, being one source, and both are tested.
- Simulated traffic never interrupts: it carries a `sim:` cause, and nothing the visitor did not press opens a note.

Bad:

- With the guide on, which is the default, every island page loads more JavaScript than it did with the tour, by 18,842 B to 20,925 B gzipped (2026-11-10): the deferred layer of 30,192 B to 30,958 B, held under 39,000 B by `apps/web/test/dist.test.ts`.
- The guide sees only what the page sees. On a page with no socket (the checkout) the events are shown as expected, not observed, until the activity feed or, later, the recorder says otherwise.
- A note is placed by script after mount, so it can lag a frame behind a page that moves under it; and with no room on any side it docks in a corner, further from its anchor.
- The guide's layer is dark in both schemes, so its colours (the `guide-*` roles in `apps/web/src/styles/tokens.css`) are the same in every theme block, and a hotspot needs a disc and a ring so that one of the two shows on a light page and the other on a dark one; `apps/web/test/tokens.test.ts` holds both.
- The click that marks an action as the visitor's is a heuristic: a write that starts more than 2 s after the click is treated as the page's own.

## When not to do this

A guide that watches the page earns its code when the point of the product is to explain itself, as this demo's is. A product whose users came to get a job done needs help that stays out of the way, not a note on every press; there a help page, or a hint on first use, costs less and interrupts less. And where the evidence lives only on the server, notes built from what the page can see would mislead: build the recorder first.

## Door

Two-way. The entries are data and the island is one mount in `Base.astro`; removing the guide is removing that mount, its sheet and its tests. The trace hook in `send` is a few lines.

## Revisit if

- Visitors turn the guide off on most visits (the switch is stored per tab only, so this needs a count the bakery does not keep yet).
- A note is found covering what it explains, at a width the specs do not test.
- The server's flight recorder ships: then the expected hops of pages with no socket should become observed, and this record gets a postscript.
- The first-load budgets of `dist.test.ts` grow back past the tour's, which would mean the layer is no longer lazy.

## Patterns and further reading

- Correlation by cause in an event-driven system: the bakery's envelope ([domain.md](../domain.md#the-envelope)) and the outbox essay, `/how-its-built/outbox/`.
- The record this one replaces in part: the tour's design in PR 10 ([roadmap.md](../roadmap.md#pr-10-the-tour-and-the-visitor-api)) and [ADR 0013](0013-the-api-and-socket-contract-v1.md), whose copyable requests the guide keeps.

## Postscript 2026-11-10

The pages stopped explaining. Every screen's "How this works" paragraph (the menu's and the checkout's cache line, the shop's catering page, the inbox, and in the console the bake list, the clock, the campaigns, the rebuild and the dispatch comparison) left its page once an entry carried every fact in it; the unit tests that used to read those words on the page now read them in the entries. Two fields joined the entry: `happened`, what a live note says its action set off (a hold placed and released by alarm, the clock's timers re-armed in every object, a send that waits while a rebuild runs), and `facts`, the standing words, shown under `what` in the standing note. The dispatch page keeps one sentence, the windows rule and the gap's formula, because its table cannot be read without them. `HowItWorks.tsx`, `HowThisWorks.tsx` and `apps/web/src/guide/how.ts` are gone.

Reads joined the evidence where a page's story needs one. `STORY_READS` in `apps/web/src/lib/trace.ts` names them (on 2026-11-10 the menu's alone); `send` in `apps/web/src/lib/api.ts` traces such a read with its status, `Bakery-Cache`, `ETag` and the `If-None-Match` it sent, and every other read stays untraced, so polling never floods the recorder. A story read opens its note when it happens, with no click: on the menu and the checkout the note says whether the cache answered or the Catalog object answered and filled it, and its Ask again repeats the read through a repeat the menu's island registers, showing the 304. No API change was needed: both headers were already exposed to the browser. 72 entries on 12 screens (2026-11-10). Bytes, measured the same day with `apps/web/test/dist.test.ts`'s sum: the deferred layer is 30,192 B to 30,958 B under a 39,000 B budget; the storefront's first load fell to 93,930 B and the checkout's to 112,169 B.

On a phone (390 px, the same day, after production showed a mark on a button, one on a word and a dock over the column of Add buttons): a hotspot sits in the gutter only where there is room and a clear margin, else in its heading's own line after the text, and only where no control or line of text is under it; the dock becomes one 48 px button showing on or off that opens the whole control, at the left end of the menu's cart bar where the page has one and in the masthead's first row where it has none. Bottom-left was the first choice for a page with no bottom bar, and was dropped: a fixed corner passes over the checkout's left-aligned controls at some scroll position. `apps/web/e2e/guide.spec.ts` scrolls each page through and checks both.

A note the page causes by itself, such as the menu's read on load, opens as one line (its title and its answer in a chip) and in full only when the visitor taps it; a press elsewhere in the page folds it back unless it is pinned. On a narrow screen the line sits in the masthead's flow, on a wide one just above the dock, so at load it covers no control: beside the menu's lead at 1280 px the only room was over the cart card. A note that runs past its edge fades at its foot until scrolled, and no hotspot is drawn under an open note.

The flight recorder became the guide's third source of evidence on 2026-11-10 ([ADR 0015](0015-a-lossy-flight-recorder-beside-the-event-path.md)). A hop's `cause` is the command's `Idempotency-Key`, or the causing event's id for a reaction, so the trace store ties hops to the visitor's action by the key it already holds, and their reactions after them, up to 12 events a trace. A note for a write answered 2xx reads `GET /v1/sandboxes/{id}/trace?after=<cursor>` at most three times, about 0.4 s, 1.2 s and 3 s after the answer, and stops at the first read that holds every event the note expects; each read may follow `more` for at most two pages, and none is made while the tab is hidden. The route spends no rate limit (`Limit::None` in `workers/api/src/http/routes.rs`): a read is one Worker request and one Recorder request, a page of at most 50 batches. The recorder panel, while open and shown, holds the recorder's socket, which spends the session's upgrade limit shared with the kitchen socket (6 a minute, `UPGRADE_LIMIT` in `workers/api/wrangler.jsonc`) and is one of at most 4 a Recorder; where the upgrade is refused, as a preview's Origin is, the panel reads every 5 seconds and says so. What the recorder cannot promise, a note says: an event no hop showed by the last read is "not seen yet: the recorder may have missed it", never "did not happen"; `missed` says older hops left the ring of 200 batches; a 410 `wiped` stops the reads. A retry and a dead letter are said in plain words, "delivered on attempt N" and "dead-lettered for Kitchen after attempt N", with the attempt the Recorder's own count, a lower bound. With the console's `kitchen` fault on, every delivery to the Kitchen fails, so a dead letter is deterministic locally, and `apps/web/e2e/guide.spec.ts` proves one.
