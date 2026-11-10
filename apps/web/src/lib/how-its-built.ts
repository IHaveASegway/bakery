// The How it's built page as data (docs/product.md, principle 7, "The demo explains itself";
// docs/domain.md, "The principle map"; Q32 · Q-links, Q33 · Q-principles). One section per
// principle, in the order the page reads: the problem the bakery has, the technique chosen, how
// it works here with the nuance that matters, where it runs, what a visitor can do to see it, and
// the links. The guide's principles (src/guide/principles.ts) are read from here, so an entry and
// the page can never name a principle differently or link it somewhere else.
import type { Principle } from './guide';
import { adrUrl, essayOf, howUrl, labUrl, type LabOrNone } from './links';

/**
 * The bakery in one line (docs/product.md, "In one line"), as the How it's built page and the home
 * page both say it.
 */
export const ONE_LINE =
  'Proof of Concept Bakery is the made-up bakery that ihaveasegway.com’s lab simulates, built as a real business system: ordering, pickup and delivery scheduling, catering, billing through Stripe’s sandbox, and a CRM with campaigns. Every backend is Rust on Cloudflare Workers, its state is in SQLite-backed Durable Objects, every visitor gets a private sandbox that is wiped every night, and every decision is written down in public.';

/**
 * The sentence a recruiter can repeat (docs/product.md, "Who it serves"). A draft: product.md asks
 * for one and does not write it.
 */
export const RECRUITER_LINE =
  'A working bakery you can order from in a minute, built to show the principles of the lab running for real: Rust on Cloudflare, a private copy for every visitor, and nothing in it real.';

/** Which part of the page a section sits in. */
export type Group = 'lab' | 'new' | 'demo';

/** Who a principle is: what the guide reads. */
export interface Identity {
  /** The section's anchor, such as "queue": `/how-its-built/#queue`. */
  id: string;
  group: Group;
  /** The principle's name, as the guide's notes say it. */
  name: string;
  lab: LabOrNone;
  /** The ADR that decided it, by number. */
  adr: string;
}

/** What the page says about it. */
export interface Prose {
  /** The problem the bakery has. */
  problem: string;
  /** The technique chosen for it. */
  technique: string;
  /** How it works here, in two or three plain sentences, with what breaks without it or what it costs. */
  how: string;
  /** Where it runs: the object, the table, the event. */
  where: string;
  /** What a visitor can do to see it (docs/domain.md, "The principle map"). */
  see: string;
  /** The screen to do it on. */
  screen: { href: string; label: string };
}

export type Section = Identity & Prose;

export const GROUPS: Record<Group, { title: string; intro: string }> = {
  lab: {
    title: 'The five lab principles',
    intro:
      'Each of these has a lab page on ihaveasegway.com, where a simulation in your browser shows the principle on its own. Here it runs for real.',
  },
  new: {
    title: 'Principles with no lab page yet',
    intro:
      'The bakery needed these too. Each is explained here and decided in an ADR, and each is explained in place, under the hood, on the screen it runs on.',
  },
  demo: {
    title: 'How the demo itself is run',
    intro:
      'What makes it safe to hand a stranger a working bakery: their own copy, nothing personal in it, and an API they can call from a terminal.',
  },
};

/**
 * Each principle, as the guide needs it: its id, its name, its lab page and its ADR, in the page's
 * order. Kept apart from the prose below so the guide's bundle carries this table and not the page.
 */
export const PRINCIPLE_TABLE = [
  {
    id: 'queue',
    group: 'lab',
    name: 'Transactional outbox, idempotent consumer and the dead-letter queue',
    lab: 'Queue Lab',
    adr: '0004',
  },
  {
    id: 'cache',
    group: 'lab',
    name: 'Cache invalidation by version',
    lab: 'Cache Lab',
    adr: '0003',
  },
  {
    id: 'backfill',
    group: 'lab',
    name: 'Rebuilding derived data from a log',
    lab: 'Backfill Lab',
    adr: '0003',
  },
  {
    id: 'routes',
    group: 'lab',
    name: 'Vehicle routing, and computing where it is free',
    lab: 'Route Lab',
    adr: '0012',
  },
  {
    id: 'raft',
    group: 'lab',
    name: 'Consensus, and when a single writer needs none',
    lab: 'Raft Lab',
    adr: '0003',
  },
  {
    id: 'idempotency-keys',
    group: 'new',
    name: 'Idempotency keys',
    lab: 'none yet',
    adr: '0004',
  },
  {
    id: 'payment-keys',
    group: 'new',
    name: 'Idempotency keys on payments and webhooks',
    lab: 'none yet',
    adr: '0007',
  },
  {
    id: 'sagas',
    group: 'new',
    name: 'Sagas by alarm',
    lab: 'none yet',
    adr: '0004',
  },
  {
    id: 'leases',
    group: 'new',
    name: 'Leases and TTLs',
    lab: 'none yet',
    adr: '0005',
  },
  {
    id: 'admission',
    group: 'new',
    name: 'Admission control',
    lab: 'none yet',
    adr: '0005',
  },
  {
    id: 'cqrs',
    group: 'new',
    name: 'CQRS: aggregates write, the CRM reads',
    lab: 'none yet',
    adr: '0003',
  },
  {
    id: 'load',
    group: 'new',
    name: 'Load you can watch: lag between writes and projections',
    lab: 'none yet',
    adr: '0004',
  },
  {
    id: 'time-travel',
    group: 'new',
    name: 'Time travel with a logical clock',
    lab: 'none yet',
    adr: '0004',
  },
  {
    id: 'sandbox',
    group: 'demo',
    name: 'A private sandbox per visitor, wiped nightly',
    lab: 'none yet',
    adr: '0005',
  },
  {
    id: 'no-personal-data',
    group: 'demo',
    name: 'No personal data, by construction',
    lab: 'none yet',
    adr: '0005',
  },
  {
    id: 'api',
    group: 'demo',
    name: 'An API as a first-class client, from one contract',
    lab: 'none yet',
    adr: '0013',
  },
  {
    id: 'breaker',
    group: 'demo',
    name: 'A breaker that reads the platform’s meter',
    lab: 'none yet',
    adr: '0010',
  },
] as const satisfies readonly Identity[];

export type PrincipleId = (typeof PRINCIPLE_TABLE)[number]['id'];

/** What the page says about each principle, in the page's order: problem, technique, nuance, where, see. */
const PROSE: Record<PrincipleId, Prose> = {
  queue: {
    problem:
      'A paid order has to reach the kitchen board, the CRM and the inbox, which are other objects. A write and a message sent after it can come apart: the write commits and the message is lost, or the message goes and the write is undone.',
    technique:
      'A transactional outbox, a queue that delivers at least once, consumers that skip what they have already applied, and a dead-letter queue for what keeps failing.',
    how: 'Each object writes its events, and a copy of them in its outbox, in the same transaction as its state, then sends the outbox to the Queue: a row may go twice, but once committed it is never lost. Each subscriber records the ids of the events it has applied in the same transaction as the change it makes, so a second delivery changes nothing; without that, every retry would put a second card on the board. A delivery still failing after three retries is parked as a dead letter, not dropped, until someone fixes the cause and redrives it.',
    where:
      'The outbox table of every aggregate object; the bakery-events Queue; each subscriber’s record of applied events; the dead-letter queue and the Sandbox’s dead letters.',
    see: 'Turn on the kitchen fault in the console, place an order, and watch the retries, the dead letter and a redrive that puts the card on the board once.',
    screen: { href: '/app/', label: 'The console' },
  },
  cache: {
    problem:
      'Nearly every page view asks for the same menu, and most of the time it has not changed. Fetching the whole menu from the Catalog object each time costs a request and its body, and a cache that expires on a timer serves an old price until it does.',
    technique: 'Cache keys that carry the menu’s version, and an ETag for the browser.',
    how: 'Publishing the menu bumps its version and emits MenuPublished. The cache is keyed by sandbox and version, so the first read of a new version misses once and fills it, and an old version is never served again because nothing asks for its key: nothing has to be found and deleted. A client that sends the ETag back gets a 304 and no body. The cost is a version check on every read, one miss per publish in each data centre that serves the sandbox, and a new price nobody sees until it is published.',
    where:
      'The Catalog object’s menu version and ETag; the Cache API, keyed by sandbox and version; the MenuPublished event.',
    see: 'Change a price in the console, publish it, and watch the version, the ETag and the Bakery-Cache header change on the menu.',
    screen: { href: '/menu/', label: 'The menu' },
  },
  backfill: {
    problem:
      'The CRM’s customer list, timelines, segments and campaign stats are derived from events. A bug in how they are derived, or a new view of them, means computing them again from history while orders keep arriving.',
    technique: 'Projections rebuilt from an append-only log, in batches, behind a cursor.',
    how: 'The CRM object keeps every event that changed its projections in a log. A rebuild empties the projections, sets a cursor at the start of the log and replays 200 events at a time, one alarm a batch, while commands keep working; the result is the same bytes it was before. That only holds because applying an event is idempotent and ordered per stream: a late event with a lower sequence number is dropped, and a projection that appended on every replay would write each order’s timeline line twice.',
    where: 'The Crm object: its log, its projections and its rebuild cursor.',
    see: 'Press Rebuild projections in the console, watch the cursor move, and compare the stats before and after.',
    screen: { href: '/app/', label: 'The console' },
  },
  routes: {
    problem:
      'On a Saturday the bakery has 63 deliveries and four vans. Dealing the stops out as they come drives hours more than it needs to, and a good plan takes real computation, which on a server is CPU the bakery pays for.',
    technique:
      'Two planners and one record: a savings heuristic on the server, VROOM in the visitor’s browser, and the Dispatch object as the judge.',
    how: 'The server plans with the Clarke–Wright savings heuristic, fast and good but not exact. VROOM, compiled to WebAssembly, plans the same stops in your browser and looks harder for a shorter plan, at no cost to the server. Neither is trusted: the Dispatch object works out any plan’s minutes from its own travel-time matrix, refuses one that misses a stop, and publishes one as the record. The times are free-flow, with no traffic.',
    where:
      'VROOM in a Web Worker on the dispatch screen; Clarke–Wright and the publish check in the Dispatch object, one per sandbox and day; RoutePublished.',
    see: 'Plan Saturday’s stops both ways on the dispatch screen, compare the two, and publish one.',
    screen: { href: '/app/dispatch/', label: 'Dispatch' },
  },
  raft: {
    problem:
      'Two tabs race for the last place in a pickup slot. If the slot’s count lived in several copies, the copies would have to agree on who got it, and making copies agree is what consensus protocols such as Raft are for.',
    technique:
      'A single writer: one Durable Object owns each day’s places, so there is only one copy to agree with.',
    how: 'The Schedule object for a sandbox and a day takes every hold for that day one at a time, and its storage commits with the code that decided, so the second of two racing holds sees the first and is refused, naming the next free slot. The bakery replicates nothing itself, so it elects no leader and counts no quorum. What that gives up, and where the bakery pays for it, is the essay linked below.',
    where:
      'The Schedule object, one per sandbox and business day; the SlotHeld event and the slot-full refusal.',
    see: 'Set a pickup slot’s capacity to one in the console, then check out that slot from two tabs: one order is held and the other is refused.',
    screen: { href: '/menu/', label: 'The menu' },
  },
  'idempotency-keys': {
    problem:
      'A phone loses its connection just after Place order. The visitor presses it again, and the first request may have arrived after all. Without care, that is two orders.',
    technique: 'An Idempotency-Key on every POST, remembered by the object that runs it.',
    how: 'Each attempt carries a new key, and its retries the same one. The object records the key and its answer in the same transaction as the command’s events, so a repeat gets the first answer back with Idempotent-Replayed: true, and the same key with a different body is refused. The key has to be stored with the write: checked in one place and written in another, a crash between the two would let the repeat through.',
    where:
      'The commands_seen table in every aggregate object; the Idempotency-Key header on every POST.',
    see: 'Copy the checkout’s Under the hood curl for placing an order and run it twice: the second answer is the first, replayed.',
    screen: { href: '/checkout/', label: 'The checkout' },
  },
  'payment-keys': {
    problem:
      'Stripe is a second system with its own state. A request to it can time out after it succeeded, and its webhooks arrive at least once, sometimes late and out of order.',
    technique:
      'A key built from the sandbox and the order’s id as the idempotency key at Stripe, and each webhook event’s id as the record that it was applied.',
    how: 'The Billing object asks Stripe for a payment with a key built from the sandbox and the order’s id, so asking twice gets the same one. The order is paid only when Stripe’s signed webhook says so, and Billing keeps the id of every webhook event it has applied, so a redelivered one changes nothing. Everything runs in Stripe’s test mode: no money moves.',
    where:
      'The Billing object, one per sandbox: payments, refunds and the webhook events it applied; PaymentSucceeded and OrderPaid.',
    see: 'Pay for an order with the test card 4242 4242 4242 4242, then find the payment once in the console’s ledger.',
    screen: { href: '/checkout/', label: 'The checkout' },
  },
  sagas: {
    problem:
      'A catering job runs for weeks: an inquiry, a quote, an acceptance, a deposit, the kitchen, the delivery and the balance. No transaction can last that long, or span the objects and Stripe it touches.',
    technique:
      'A saga: each step is one object’s transaction, and the next is started by an event or a timer.',
    how: 'The CateringEvent object moves through its states one transaction at a time, and keeps its reminders, the quote’s expiry and the deposit’s lapse as rows in a timers table behind one alarm. A step that cannot go on is undone by a step of its own, such as releasing the day’s place or refunding the deposit, never by a rollback. The saga only moves forward, so a command out of order is refused with 409.',
    where:
      'The CateringEvent object, one per inquiry, and its timers; the Schedule’s catering places; Billing’s deposit and balance invoice.',
    see: 'Run a catering job end to end, and advance the clock in the console to see each reminder fire.',
    screen: { href: '/catering/', label: 'Catering' },
  },
  leases: {
    problem:
      'An order placed and never paid would hold its place in a slot for good, and a sandbox nobody comes back to would keep its data for good.',
    technique: 'Leases: every hold and every sandbox has an end, written down when it starts.',
    how: 'Placing an order holds its places for 15 minutes of bakery time, and if it is not paid, the hold’s timer releases them. Every sandbox is deleted at 10:00 UTC, and every object in it arms a 36-hour backstop on its first write, so one the wipe misses deletes itself. The cost is the payment that lands after its hold lapsed: the Schedule takes it back even past capacity, because the money already moved.',
    where: 'The Schedule’s hold timers; the Sandbox’s wipe alarm; every object’s 36-hour backstop.',
    see: 'Let a checkout lapse, or advance the clock past it, and watch the place come back; the console says when your sandbox will be wiped.',
    screen: { href: '/checkout/', label: 'The checkout' },
  },
  admission: {
    problem:
      'Every sandbox costs requests and storage, and the bakery pays for each one. A script could make thousands of them.',
    technique:
      'Admission control: a check that you are a person, rate limits, and daily budgets that refuse work before it costs anything.',
    how: 'Making a sandbox or an account needs a Turnstile pass. The Control object counts the day’s sandboxes and refuses past its caps, giving guests a smaller share, while commands and API tokens have rate limits of their own and simulated traffic its own minutes a day. A refusal is cheap and says when to come back; the cost is that on a busy day a visitor can be turned away.',
    where: 'Turnstile on sign-in; the Control object’s daily ledger; the API Worker’s rate limits.',
    see: 'Ask GET /v1/status: it shows today’s sandboxes, guests and demo accounts against their caps.',
    screen: { href: '/signin/', label: 'Sign in' },
  },
  cqrs: {
    problem:
      'Staff want a customer’s whole history, the segments and the campaign stats, which cut across hundreds of orders. Each order is its own object, and asking every one of them would be slow and expensive.',
    technique:
      'Command and query responsibility segregation: the aggregates take the writes, and the CRM keeps read models built from their events.',
    how: 'An order, a customer or a catering event decides its own changes and publishes them as events; the CRM object consumes them and keeps the views the console reads. The two are joined only by the Queue, so a read trails a write by a moment, and the screens say so rather than hide it. A change of consent is a command to the Customer object, never an edit to the list.',
    where:
      'The Order, Customer and CateringEvent objects write; the Crm object reads them through the Queue.',
    see: 'Place an order, then open its customer in the console and watch the order appear on their timeline a moment later.',
    screen: { href: '/app/', label: 'The console' },
  },
  load: {
    problem:
      'A quiet demo hides how the system behaves under load: the board filling up, the customer list and the activity feed trailing the orders, the retries and dead letters in the console.',
    technique:
      'Simulated traffic: made-up customers who order through the same checks as a visitor.',
    how: 'The Simulator object places orders on its own alarm, through the same API and objects as yours, so the Queue, the board and the CRM carry real load. It runs only while the console is open, at a capped rate and for capped minutes a day, and stops by itself once the console has been closed for 90 seconds. What you watch is lag: every write succeeds at once, and the views catch up.',
    where: 'The Simulator object, one per sandbox; the bakery-events Queue; the CRM’s projections.',
    see: 'Start traffic in the console, then watch the board fill and the timelines trail the orders.',
    screen: { href: '/app/', label: 'The console' },
  },
  'time-travel': {
    problem:
      'Most of what a bakery does happens later: a hold lapses in 15 minutes, a reminder fires in a week, tomorrow’s bake list starts at midnight. A visitor cannot wait for any of it.',
    technique: 'A logical clock: business time is the wall clock plus an offset you can move.',
    how: 'The Sandbox keeps the offset and hands it to every object, and each object works out its timers in business time and sets its alarm again when the clock moves. Each click carries its own Idempotency-Key, so a repeated request moves the clock once. The platform’s alarms, the nightly wipe, cookies and Stripe’s timestamps keep the wall clock: the offset moves what the bakery decides, not what the platform does.',
    where: 'The Sandbox’s clock offset; every object’s timers table; the ClockAdvanced event.',
    see: 'Advance a day in the console and watch expiries, reminders and tomorrow’s bake list fire in order.',
    screen: { href: '/app/', label: 'The console' },
  },
  sandbox: {
    problem:
      'A demo that lets anyone change prices, cancel orders and send campaigns needs every visitor to have a bakery of their own, and none of it to outlive the night.',
    technique:
      'A sandbox per visitor: its own set of objects, born from a seed and deleted every night.',
    how: 'Every object’s name carries its sandbox’s id, and every one is born through the Sandbox, which keeps a register of them, so one sandbox cannot reach another’s data and the wipe knows everything there is to delete. Two sandboxes from the same seed and birth date are the same byte for byte. Every sandbox is deleted at 10:00 UTC.',
    where:
      'The Sandbox object and its register of children; the seed; SandboxSeeded and SandboxWiped.',
    see: 'Open the console to see your sandbox’s id, its seed and when it will be wiped; Wipe now deletes it on the spot.',
    screen: { href: '/app/', label: 'The console' },
  },
  'no-personal-data': {
    problem: 'A demo visited by strangers must not become a store of their names, emails or cards.',
    technique: 'Not asking: the system has nowhere to put personal data.',
    how: 'Sign-in keeps only a keyed hash of the number Google or GitHub gives for your account, and no email, name or picture. The customers, venues, addresses and cards are made up; the only free text is an order note and a catering brief, each checked when it is written; and the inbox exists because the bakery has no address to send mail to.',
    where:
      'The Account object’s keyed hash; the checks on the note and the brief; the Inbox object.',
    see: 'Read the privacy page, then GET /v1/session: its answer is the whole of what the bakery knows about you.',
    screen: { href: '/privacy/', label: 'Privacy' },
  },
  api: {
    problem:
      'A demo you can only click proves the screens work. An engineer wants to call it from a terminal and see the same thing happen.',
    technique:
      'One contract, written in Rust, from which the route table, the TypeScript types and the API reference are generated.',
    how: 'The console is a client of the same public API as your terminal: every one of its actions is a route in the OpenAPI document, which is generated from the contract and checked against the Worker’s route table. A signed-in sandbox can issue a bearer token that lasts 24 hours, dies with the sandbox and can be rotated, and every part the guide explains shows its request as a curl to copy.',
    where: 'crates/contracts; the API Worker’s route table; the reference at /docs/api/.',
    see: 'Issue a token in the console, copy any Under the hood curl and run it.',
    screen: { href: '/docs/api/', label: 'The API reference' },
  },
  breaker: {
    problem:
      'A loop that no visitor started, such as an alarm that re-arms itself, can spend the account’s money in hours, and the bakery’s own counters do not see it. Cloudflare’s budget alerts arrive a day later.',
    technique:
      'A circuit breaker driven by the platform’s own meter: a cron job reads the last complete 15-minute slot of usage, prices it, and trips in steps.',
    how: 'Every 15 minutes the API Worker asks Cloudflare’s GraphQL Analytics API for five meters, prices them at the overage rates and hands the reads to the Control object, which decides with a pure function in the same transaction that raises the flag. A window over a line sets read-only, and a window past four times the dollar line sets off and enables a pre-built WAF rule. The state never goes down by itself: a person resets it, because an automatic reset would let a loop start again.',
    where:
      'The 15-minute cron in the API Worker; the breaker_state table in the Control object; the Rulesets API; the Breaker line on the status page.',
    see: 'Open the status page and read the Breaker line, then ask GET /v1/status for the breaker’s last run and the meters it could not read.',
    screen: { href: '/status/', label: 'The status page' },
  },
};

/** The page's sections, in order: the table joined with its prose. */
export function sections(): Section[] {
  return PRINCIPLE_TABLE.map((identity) => ({ ...identity, ...PROSE[identity.id] }));
}

/** A principle with its links: the one place they are made. */
export function principleOf(section: Identity): Principle {
  const lab = labUrl(section.lab);
  const essay = essayOf(section.id);
  return {
    id: section.id,
    name: section.name,
    lab: section.lab,
    adr: section.adr,
    ...(lab === undefined ? {} : { labUrl: lab }),
    adrUrl: adrUrl(section.adr),
    howUrl: howUrl(section.id),
    ...(essay === undefined ? {} : { essay: { url: essay.path, title: essay.title } }),
  };
}

/** Every principle, by its section's id. */
export const PRINCIPLES: Readonly<Record<string, Principle>> = Object.fromEntries(
  PRINCIPLE_TABLE.map((identity) => [identity.id, principleOf(identity)]),
);

/** The principle of one section, by id; an unknown id is a build error, not a missing link. */
export function principle(id: PrincipleId): Principle {
  const found = PRINCIPLES[id];
  if (found === undefined) throw new Error(`no How it's built section "${id}"`);
  return found;
}
