// The tools in the build, and what was not chosen (/how-its-built/tools/). Data only: the page
// renders it and test/tools.test.ts holds it to the records. Every sentence restates a cited line
// of the decision records (docs/adr/, docs/stack.md, docs/architecture.md, docs/security.md), as
// read on 2026-11-10. No sentence here is a new reason. Where a reason is the owner's rule or
// direction, the row says so; where an alternative was never compared, it says that too.
// Backticks mark code; the page sets it in the code face.
import type { EssayId } from '../lib/links';

/** The groups, in the order the page reads. */
export const TOOL_GROUPS = [
  { id: 'platform', title: 'Platform' },
  { id: 'state', title: 'State and messaging' },
  { id: 'guarding', title: 'Watching and guarding' },
  { id: 'payments', title: 'Payments and identity' },
  { id: 'contract', title: 'The contract' },
  { id: 'site', title: 'The site' },
  { id: 'dispatch', title: 'Dispatch' },
  { id: 'delivery', title: 'Delivery and checks' },
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number]['id'];

/** A record a sentence restates: an ADR (with its section where one is named), or a document. */
export type RecordRef =
  | { adr: string; section?: string }
  | { doc: 'stack' | 'architecture' | 'security' }
  | { essay: EssayId };

/** The date of ADR 0016, which weighed ten alternatives after the build. */
export const WEIGHED_AFTER = '2026-11-10';

/** What a record says was never measured, compared or checked, in ADR 0016's own words. */
export interface Never {
  kind: 'measured' | 'compared' | 'checked';
  text: string;
}

/** An alternative a record weighed and did not choose. */
export interface Alternative {
  name: string;
  /** What it would have stood in for. */
  replaces: string;
  whyNot: string;
  /** When it would be right, or "Not recorded." where the record does not say. */
  whenRight: string;
  record: RecordRef;
  /** One of the ten alternatives ADR 0016 weighed after the build, on 2026-11-10. */
  after?: true;
  /** What ADR 0016 says was never measured, compared or checked. */
  never?: Never;
}

/** A tool in the build. */
export interface Tool {
  id: string;
  name: string;
  group: ToolGroup;
  /** The version, plan or file, as the records give it. */
  version: string;
  /** The date the version or plan holds as of, where the record gives one. */
  asOf?: string;
  doesHere: string;
  whyHere: string;
  whenNot: string;
  records: RecordRef[];
  essays?: EssayId[];
  /** The reason is the owner's rule or direction, and the row says so in those words. */
  ownersRule?: 'rule' | 'direction';
  /** What was never measured, with its roadmap item when one exists. */
  notMeasured?: string;
  /** The dependencies (package.json or the workspace's Cargo.toml) this row names. */
  packages?: string[];
  alternatives?: Alternative[];
}

/** What the page says when a record names no case for an alternative. */
export const NOT_RECORDED = 'Not recorded.';

const after = (section: string) => ({ adr: '0016', section }) as const;

export const TOOLS: Tool[] = [
  // Platform
  {
    id: 'rust',
    name: 'Rust, the language of every backend',
    group: 'platform',
    version: 'channel 1.97 (`rust-toolchain.toml`)',
    doesHere:
      'All server code: the `bakery-api` Worker, its Durable Object classes, the Queue consumer and the cron handler, and the platform-free crates.',
    whyHere:
      'It is the owner’s rule, not an engineering verdict; the engineering case is a domain tested natively in seconds, and the measured cost is the WebAssembly.',
    whenNot:
      'When Durable Object RPC, Workflows or a first-party object test harness matter, which workers-rs does not give.',
    records: [{ adr: '0002' }, after('1')],
    ownersRule: 'rule',
    notMeasured: 'A TypeScript Worker with the same objects beside the Rust one (roadmap R78).',
    packages: ['bakery-domain', 'bakery-app', 'bakery-seed'],
    alternatives: [
      {
        name: 'TypeScript on Workers, the site’s choice',
        replaces: 'Every Worker and object.',
        whyNot: 'It fails the owner’s rule outright, and the site already shows this stack.',
        whenRight:
          'Where a first-class SDK, RPC, Workflows and `@cloudflare/vitest-plugin` matter.',
        record: { adr: '0002' },
      },
      {
        name: 'Go, through workers-go or native Go in Containers',
        replaces: 'The backend.',
        whyNot:
          'workers-go is untagged and lacks typed auto-response, attachments and RPC, and Containers are Paid-only with cold starts of 1 to 3 s.',
        whenRight: NOT_RECORDED,
        record: { adr: '0002' },
      },
      {
        name: 'Python Workers',
        replaces: 'The backend.',
        whyNot: 'There is no test harness for its objects, and it fails the owner’s rule.',
        whenRight: NOT_RECORDED,
        record: { adr: '0002' },
      },
      {
        name: 'A TypeScript shell with a Rust core as WebAssembly',
        replaces:
          'The Rust Worker’s adapters, to get RPC, Workflows and Vitest while keeping Rust.',
        whyNot:
          'Two languages in every request path and a hand-written boundary, and the adapters, where most bugs live, are not Rust.',
        whenRight: 'Spike S6 named it as the fallback had the Rust queue consumer failed.',
        record: { adr: '0002' },
      },
      {
        name: 'Rust in Containers, native, with Tokio, axum and sqlx',
        replaces: 'The backend.',
        whyNot:
          'Paid-only and billed while awake, cold starts in seconds, and the state leaves the Durable Objects.',
        whenRight: NOT_RECORDED,
        record: { adr: '0002' },
      },
      {
        name: 'A TypeScript Worker for the API',
        replaces: 'The Rust Worker `bakery-api` and workers-rs.',
        whyNot:
          'The owner’s rule that every backend is Rust, which is a rule, not an engineering verdict.',
        whenRight:
          'When the Worker needs what workers-rs does not bind, which ADR 0002 lists as of 2026-11-04: Durable Object RPC, Workflows, point-in-time recovery and a first-party test harness for objects.',
        record: after('1'),
        after: true,
        never: {
          kind: 'measured',
          text: 'A TypeScript Worker with the same objects; spike S1 measured only the Rust one (roadmap R78).',
        },
      },
    ],
  },
  {
    id: 'workers-rs',
    name: 'workers-rs, the Rust SDK',
    group: 'platform',
    version: '`worker` =0.8.7, `worker-build` 0.8.7 (`Cargo.toml`)',
    doesHere:
      'The Durable Object trait, SQLite storage, alarms, Queues and the entrypoints for Rust on Workers.',
    whyHere: 'It is Cloudflare’s own SDK and the only Rust one with Hibernation and SQL storage.',
    whenNot: 'When the code needs Workflows, DO RPC, point-in-time recovery or a stable 1.x API.',
    records: [{ adr: '0002' }],
    packages: ['worker', 'wasm-bindgen'],
    alternatives: [
      {
        name: '`tokio`',
        replaces: 'The async runtime.',
        whyNot: 'workers-rs does not support it on `wasm32`; async runs on the Workers event loop.',
        whenRight: 'Never on this target.',
        record: { doc: 'stack' },
      },
    ],
  },
  {
    id: 'workers-paid',
    name: 'Workers Paid',
    group: 'platform',
    version: 'since 2026-11-06',
    asOf: '2026-11-06',
    doesHere: 'The account plan: 30 s of CPU by default, 50M rows written a month included.',
    whyHere:
      'On Free, rows written would stop every object at about 20 sandboxes a day, and 10 ms of CPU forces weak hashing.',
    whenNot: 'When a hard $0 ceiling matters more than headroom: Paid has no spend cap.',
    records: [{ adr: '0010' }],
    essays: ['breaker'],
    alternatives: [
      {
        name: 'Staying on Workers Free, with caps',
        replaces: 'Workers Paid.',
        whyNot:
          'Rows written darken every Durable Object on the account at about 20 sandboxes a day.',
        whenRight: 'Its gain is a hard $0 ceiling, the only one Cloudflare offers.',
        record: { adr: '0010' },
      },
      {
        name: 'Paid without `Control`’s budgets',
        replaces: 'Paid with the budgets.',
        whyNot: 'No ceiling but the breaker, which acts after the money is spent.',
        whenRight: NOT_RECORDED,
        record: { adr: '0010' },
      },
      {
        name: 'A second Cloudflare account',
        replaces: 'The account the bakery shares with the site.',
        whyNot: 'The bakery would need another domain.',
        whenRight: NOT_RECORDED,
        record: { adr: '0010' },
      },
      {
        name: 'A $50 ceiling',
        replaces: 'The $100 ceiling set on 2026-11-04.',
        whyNot: 'The thresholds trip on ordinary growth.',
        whenRight: NOT_RECORDED,
        record: { adr: '0010' },
      },
      {
        name: 'Paid from PR 2',
        replaces: 'Paid from the launch.',
        whyNot: 'Time spent on previews and tests for software nobody uses.',
        whenRight: NOT_RECORDED,
        record: { adr: '0010' },
      },
      {
        name: 'A usage-based platform outside Cloudflare with a spend cap',
        replaces: 'Cloudflare.',
        whyNot: 'The bakery’s state lives in Durable Objects, which exist only here.',
        whenRight: NOT_RECORDED,
        record: { adr: '0010' },
      },
      {
        name: 'A Pro zone plan',
        replaces: 'The zone’s Free plan.',
        whyNot: 'Capacity the demo would not use.',
        whenRight: NOT_RECORDED,
        record: { doc: 'stack' },
      },
    ],
  },
  {
    id: 'static-assets',
    name: 'Workers static assets, the assets-only `bakery-web`',
    group: 'platform',
    version: 'no `main` (`apps/web/wrangler.jsonc`)',
    doesHere: 'Serves every page from `apps/web/dist/` without running Worker code.',
    whyHere: 'Asset requests are free and never invoke the Worker.',
    whenNot: 'When a page needs per-request HTML.',
    records: [{ adr: '0008' }],
    alternatives: [
      {
        name: 'The pages served from the API Worker’s assets',
        replaces: 'A Worker of its own for the pages.',
        whyNot: 'Every page deploy restarts every object and drops every kitchen socket.',
        whenRight: 'If there were no static pages to protect.',
        record: { adr: '0008' },
      },
      {
        name: 'Cloudflare Pages',
        replaces: 'An assets-only Worker.',
        whyNot: 'Cloudflare ships new features on Workers first.',
        whenRight: 'When a trigger in the site’s ADR 0002 fires.',
        record: { adr: '0008' },
      },
      {
        name: 'Workers Cache on `bakery-web`',
        replaces: 'Plain static assets.',
        whyNot:
          'With Workers Cache on, every request is billed at the standard rate, static assets included.',
        whenRight: NOT_RECORDED,
        record: { essay: 'cache' },
      },
    ],
  },
  {
    id: 'custom-domains',
    name: 'Workers Custom Domains',
    group: 'platform',
    version: 'both `wrangler.jsonc` files, `custom_domain: true`',
    doesHere: 'Each Worker on its own hostname, with its own certificate.',
    whyHere:
      'A Custom Domain certifies a multi-level subdomain, and the API’s own hostname is a kill switch that cannot hit a page.',
    whenNot:
      'When preflights or a second origin become a real cost, a same-origin route is the shape.',
    records: [{ adr: '0009' }],
    alternatives: [
      {
        name: 'A same-origin route, `/api/*` on the storefront’s hostname',
        replaces: 'The API’s own hostname.',
        whyNot:
          'A wrong route pattern makes page views Worker invocations, and the kill switch would be keyed on a path.',
        whenRight: 'When preflights or a second origin become a real cost.',
        record: { adr: '0009' },
      },
      {
        name: 'A path on the site’s apex',
        replaces: 'The bakery’s own hostnames.',
        whyNot:
          'It ties the bakery to the site’s hostname, its route table and its deploy history.',
        whenRight: NOT_RECORDED,
        record: { adr: '0009' },
      },
      {
        name: 'A separate zone or account, through Cloudflare for SaaS or an Enterprise subdomain',
        replaces: 'A subdomain of the site’s zone.',
        whyNot: 'Neither is on the plans in use.',
        whenRight: NOT_RECORDED,
        record: { adr: '0009' },
      },
    ],
  },

  // State and messaging
  {
    id: 'durable-objects',
    name: 'Durable Objects, SQLite backend',
    group: 'state',
    version: '15 classes, `"storage": "sqlite"` (`workers/api/wrangler.jsonc`)',
    doesHere: 'Every aggregate’s log, outbox, state and timers, one object per aggregate.',
    whyHere:
      'A single writer per aggregate holds invariants without locks, with storage local to the code.',
    whenNot:
      'When the system needs queries across tenants, or more than about 1,000 requests a second on one key.',
    records: [{ adr: '0003' }],
    essays: ['raft'],
    alternatives: [
      {
        name: 'D1 as one central database',
        replaces: 'The objects as the system of record.',
        whyNot:
          'No single-writer guarantee per aggregate, D1 is alpha in workers-rs, and the demo’s point, aggregates as objects, is lost.',
        whenRight: 'When the bakery needs queries across sandboxes.',
        record: { adr: '0003' },
      },
      {
        name: 'One object per sandbox holding everything',
        replaces: 'One object per aggregate.',
        whyNot: 'Every command and every socket in a sandbox serializes behind one thread.',
        whenRight: 'If the demo were about one object.',
        record: { adr: '0003' },
      },
      {
        name: 'Workers KV',
        replaces: 'The objects’ state, and the sessions.',
        whyNot:
          'Eventually consistent, with no transactions and no single writer, so unfit for an order’s state machine.',
        whenRight: 'For a global, read-heavy value that tolerates staleness.',
        record: { adr: '0003' },
      },
      {
        name: 'Postgres through Hyperdrive',
        replaces: 'The objects as the system of record.',
        whyNot: 'A database to run and patch, for data that is per-sandbox and disposable.',
        whenRight: 'When relational queries across sandboxes are needed.',
        record: { doc: 'stack' },
      },
      {
        name: 'An event store elsewhere, with objects as caches',
        replaces: 'The log inside each object.',
        whyNot: 'Every command depends on an external service.',
        whenRight: NOT_RECORDED,
        record: { adr: '0003' },
      },
      {
        name: 'The key-value storage backend for Durable Objects',
        replaces: 'The SQLite backend.',
        whyNot: 'SQLite-backed classes only, so the way back to Free stays open.',
        whenRight: NOT_RECORDED,
        record: { adr: '0010' },
      },
      {
        name: 'Row-level security in a shared database',
        replaces: 'Isolation by object, one sandbox’s objects apart from another’s.',
        whyNot: 'One missing or wrong policy exposes every tenant; here there is no shared table.',
        whenRight: 'It is the design a single D1 or Postgres database would need.',
        record: { doc: 'security' },
      },
    ],
  },
  {
    id: 'alarms',
    name: 'Durable Object alarms, behind a `timers` table',
    group: 'state',
    version: 'one alarm per object',
    doesHere: 'Order expiry, reminders, saga steps, outbox retries and every object’s backstop.',
    whyHere: 'An object may hold no timer of its own, so its alarm is its only wake-up.',
    whenNot: 'When a process must outlive one object and a workflow engine exists in the language.',
    records: [{ adr: '0004' }],
    essays: ['sagas', 'leases', 'time-travel'],
    alternatives: [
      {
        name: 'Workflows, for the catering saga and fan-out',
        replaces: 'A saga by alarm.',
        whyNot: 'JavaScript and TypeScript only.',
        whenRight: 'When workers-rs binds it and a saga must outlive a Durable Object.',
        record: { adr: '0004' },
      },
    ],
  },
  {
    id: 'websockets',
    name: 'Hibernatable WebSockets',
    group: 'state',
    version: '`State::accept_web_socket` (`workers/api/src/objects/kitchen.rs`)',
    doesHere: 'The kitchen board’s live connections, two-way.',
    whyHere: 'An idle socket costs no duration, and the board sends commands on the same socket.',
    whenNot:
      'Polling is the right shape where a screen can be seconds stale and the client cannot hold a connection.',
    records: [{ adr: '0003' }, after('2')],
    essays: ['cqrs'],
    notMeasured: 'The duration cost or the code size of a polling board against the socket.',
    alternatives: [
      {
        name: 'Server-Sent Events or polling for the kitchen board',
        replaces: 'The hibernating WebSocket on the `Kitchen` object.',
        whyNot:
          'The board is two-way, and Cloudflare’s guide “Use WebSockets”, read on 2026-11-10, supports hibernation only when an object is a WebSocket server, so an event stream would not hibernate as an idle socket does.',
        whenRight:
          'Polling, where a screen can be seconds stale and the client cannot hold a connection; event streams, where updates flow one way only.',
        record: after('2'),
        after: true,
        never: {
          kind: 'measured',
          text: 'The duration cost or the code size of a polling board against the socket.',
        },
      },
      {
        name: 'Agents SDK and PartyServer',
        replaces: 'The kitchen socket on the bakery’s own object.',
        whyNot: 'Both are JavaScript.',
        whenRight: 'If a Rust equivalent appears.',
        record: { doc: 'stack' },
      },
    ],
  },
  {
    id: 'queues',
    name: 'Cloudflare Queues, with the dead-letter queue',
    group: 'state',
    version: '`bakery-events`, 3 retries, then `bakery-events-dlq` (`workers/api/wrangler.jsonc`)',
    doesHere:
      'Carries every relayed event to the one consumer; a message that fails three times becomes a dead letter.',
    whyHere: 'A slow or failing subscriber never blocks the aggregate that produced the event.',
    whenNot: 'When subscribers are few, fast and in one failure domain, direct calls are simpler.',
    records: [{ adr: '0004' }],
    essays: ['queue'],
    alternatives: [
      {
        name: 'Direct object-to-object calls from the producer',
        replaces: 'The queue between objects.',
        whyNot:
          'The producer knows every subscriber, and fan-out and retries live in the producer.',
        whenRight: 'When subscribers are few, fast and in one failure domain.',
        record: { adr: '0004' },
      },
      {
        name: 'An in-object broker, as the site’s Outbox Lab simulates',
        replaces: 'The queue between objects.',
        whyNot: 'Across every class it becomes a central object every event passes through.',
        whenRight: 'It is fine for one object.',
        record: { adr: '0004' },
      },
      {
        name: 'Projections polling the source objects',
        replaces: 'Events pushed through the queue.',
        whyNot:
          'Requests and duration on every poll, across every object, and as stale as the interval.',
        whenRight: NOT_RECORDED,
        record: { adr: '0004' },
      },
      {
        name: 'A third-party broker',
        replaces: 'Cloudflare Queues.',
        whyNot:
          'Another account, credentials in the Worker, traffic leaving Cloudflare, and a bill outside the guardrails.',
        whenRight: 'Its gains, as recorded, are ordering, replay and consumer groups.',
        record: { adr: '0004' },
      },
    ],
  },
  {
    id: 'cron',
    name: 'Cron Triggers',
    group: 'state',
    version: '`0 10 * * *` and `*/15 * * * *` (`workers/api/wrangler.jsonc`)',
    doesHere: 'The nightly wipe, the retry sweep, the status snapshot and the breaker.',
    whyHere: 'Cron covers what no object owns.',
    whenNot: 'Work that one object owns goes on that object’s alarm.',
    records: [{ adr: '0005' }],
    essays: ['sandbox'],
  },
  {
    id: 'cache-api',
    name: 'The Cache API, for the menu',
    group: 'state',
    version: '`workers/api/src/http/menu.rs`',
    doesHere: 'An edge copy of each sandbox’s published menu, keyed by version.',
    whyHere: 'A key that names the version needs no purge.',
    whenNot: 'Not for a value shared across data centers.',
    records: [{ adr: '0003' }],
    essays: ['cache'],
  },

  // Watching and guarding
  {
    id: 'analytics-engine',
    name: 'Analytics Engine',
    group: 'guarding',
    version: 'binding `METRICS` (`workers/api/wrangler.jsonc`)',
    doesHere: 'Eight fire-and-forget business points, read for the status page.',
    whyHere: 'Counters without an agent, and a missing binding never fails a request.',
    whenNot: 'Not as a per-visitor read path.',
    records: [{ doc: 'stack' }],
  },
  {
    id: 'workers-logs',
    name: 'Workers Logs',
    group: 'guarding',
    version: '`invocation_logs: false` (`workers/api/wrangler.jsonc`)',
    doesHere: 'The API’s JSON log lines, with an HMAC of the IP.',
    whyHere:
      'Built in, with no agent; invocation logs stay off because they record location fields.',
    whenNot: 'Not as a store a visitor reads back.',
    records: [{ doc: 'stack' }],
    alternatives: [
      {
        name: 'Workers Logs or Analytics Engine as the flight recorder’s store',
        replaces: 'The `Recorder` object.',
        whyNot: 'Logs are minutes behind and account-wide.',
        whenRight:
          'When the system has a tracing backend that accepts spans per request and can be scoped to a tenant.',
        record: { adr: '0015' },
      },
      {
        name: 'Tracing and error tracking',
        replaces:
          'Nothing directly: the bakery has Workers Logs, Analytics Engine points and a per-sandbox flight recorder.',
        whyNot:
          'It was not weighed before the build, and the recorder answers a different question, a visitor’s own event hops, scoped to their sandbox and readable by them.',
        whenRight: 'For the operator, debugging one request across the Worker and its objects.',
        record: after('6'),
        after: true,
        never: {
          kind: 'measured',
          text: 'Whether Cloudflare’s traces work on this Worker, and what they would cost; whether they instrument a workers-rs Worker was not checked.',
        },
      },
    ],
  },
  {
    id: 'rate-limiting',
    name: 'Rate Limiting binding',
    group: 'guarding',
    version: 'four namespaces (`workers/api/wrangler.jsonc`)',
    doesHere: 'Cheap refusals per IP hash, session or token before any object is asked.',
    whyHere: 'Cheap refusals before an object is asked.',
    whenNot: 'Never as a budget: it counts approximately and per location.',
    records: [{ adr: '0010' }],
    essays: ['admission'],
  },
  {
    id: 'turnstile',
    name: 'Turnstile',
    group: 'guarding',
    version: '`apps/web/src/components/Turnstile.tsx`',
    doesHere: 'A challenge before guest sandboxes and demo sign-ups, checked server side.',
    whyHere: 'Bots pay before the expensive path, for free.',
    whenNot: 'Not as the only bound: caps and rate limits do the bounding.',
    records: [{ adr: '0009' }, { adr: '0005' }],
    essays: ['admission'],
  },
  {
    id: 'breaker',
    name: 'The breaker’s Cloudflare APIs and the WAF kill rule',
    group: 'guarding',
    version: '`workers/api/src/breaker.rs`; unconfigured as of 2026-11-09',
    asOf: '2026-11-09',
    doesHere:
      'Reads five platform meters every 15 minutes and can enable the rule that blocks the API’s hostname.',
    whyHere:
      'Workers Paid has no spend cap, and the platform’s meter sees what the bakery’s counters cannot.',
    whenNot: 'Not as the only guard: a breaker acts after the money is spent.',
    records: [{ adr: '0010' }],
    essays: ['breaker'],
    alternatives: [
      {
        name: 'Analytics Engine points as the breaker’s usage source',
        replaces: 'The platform’s own meters.',
        whyNot: 'The bakery’s own points cannot see a loop in alarms.',
        whenRight: NOT_RECORDED,
        record: { doc: 'stack' },
      },
    ],
  },

  // Payments and identity
  {
    id: 'stripe',
    name: 'Stripe, in its sandbox',
    group: 'payments',
    version: '`STRIPE_API_VERSION` `2026-10-28.endive` (`workers/api/wrangler.jsonc`)',
    doesHere: 'Intents, invoices, refunds and signed webhooks for `Billing`.',
    whyHere: 'Real webhooks, 3-D Secure and declines, free, with no money moving.',
    whenNot: 'When a real payment is wanted, which needs a new decision and a real privacy policy.',
    records: [{ adr: '0007' }],
    essays: ['idempotency-keys'],
    alternatives: [
      {
        name: 'Worldpay',
        replaces: 'Stripe’s sandbox.',
        whyNot:
          'Its sandbox access goes through a merchant application, and the record says those specifics are not sourced.',
        whenRight:
          'As a candidate second adapter behind the port, once a provider has a free, self-serve sandbox.',
        record: { adr: '0007' },
      },
      {
        name: 'Adyen’s test environment',
        replaces: 'Stripe’s sandbox.',
        whyNot: 'A test account to apply for, and a second dashboard.',
        whenRight: NOT_RECORDED,
        record: { adr: '0007' },
      },
      {
        name: 'A fake gateway in Rust as the main path',
        replaces: 'Stripe’s sandbox.',
        whyNot: 'No real webhooks, no 3-D Secure and no real declines.',
        whenRight: 'As the test double behind the port, where it is kept.',
        record: { adr: '0007' },
      },
      {
        name: 'A community Stripe crate for Rust',
        replaces: 'The bakery’s own calls to Stripe.',
        whyNot:
          'The community crates were written for native runtimes with an async executor, and whether any builds for wasm32 without Tokio is untested.',
        whenRight: NOT_RECORDED,
        record: { adr: '0007' },
      },
      {
        name: 'Stripe’s mock server in place of the bakery’s fake',
        replaces: '`scripts/fake-stripe.mjs`, the fake the e2e suite and the smokes pay against.',
        whyNot:
          'The payment flow needs state, and the README of `stripe-mock`, read on 2026-11-10, says it is stateless.',
        whenRight:
          'Checking that each request’s path and parameters match Stripe’s API, which the fake does not check.',
        record: after('9'),
        after: true,
        never: {
          kind: 'compared',
          text: 'Whether `stripe-mock` would refuse a request the fake accepts; spike S3, against the real sandbox, has not run either, as of 2026-11-09.',
        },
      },
    ],
  },
  {
    id: 'payment-element',
    name: 'Stripe’s Payment Element',
    group: 'payments',
    version:
      '`@stripe/stripe-js` 10.2.1, `@stripe/react-stripe-js` 7.0.1 (`apps/web/package.json`)',
    doesHere: "Takes the card in Stripe’s frames with `fields.billingDetails: 'never'`.",
    whyHere: 'The visitor never types a name, email, phone or address into Stripe.',
    whenNot: 'Where the privacy rule does not bind, hosted Checkout is less code.',
    records: [{ adr: '0007' }],
    essays: ['idempotency-keys'],
    packages: ['@stripe/stripe-js', '@stripe/react-stripe-js'],
    alternatives: [
      {
        name: 'Stripe’s hosted Checkout page',
        replaces: 'The Payment Element on the bakery’s page.',
        whyNot: 'The visitor types a name and email into Stripe’s sandbox.',
        whenRight:
          'As the fallback, if spike S3 shows the Element cannot suppress billing details.',
        record: { adr: '0007' },
      },
      {
        name: 'Payment Links',
        replaces: 'The Payment Element.',
        whyNot: 'Amounts are fixed ahead of time, which a cart and a deposit cannot use.',
        whenRight: NOT_RECORDED,
        record: { adr: '0007' },
      },
      {
        name: 'The Checkout Sessions API with the Payment Element',
        replaces: 'PaymentIntents.',
        whyNot: 'PaymentIntents keep every field the bakery sends to Stripe explicit.',
        whenRight: 'It stays open if spike S3 shows it can run with no billing fields at all.',
        record: { adr: '0007' },
      },
    ],
  },
  {
    id: 'google-signin',
    name: 'Google sign-in, `openid` alone',
    group: 'payments',
    version: '`GOOGLE_CLIENT_ID` (`workers/api/wrangler.jsonc`)',
    doesHere: 'Keeps only an HMAC of the provider’s id.',
    whyHere: 'With `openid` alone Google sends no email or name.',
    whenNot: 'If Google refuses `openid` alone, the weaker `openid email` design is the fallback.',
    records: [{ adr: '0006' }],
    essays: ['sandbox'],
    alternatives: [
      {
        name: 'Cloudflare Access in front of the console',
        replaces: 'The bakery’s own sign-in.',
        whyNot: 'It hides the console from visitors behind an identity wall.',
        whenRight: 'For an operator-only console later.',
        record: { adr: '0006' },
      },
      {
        name: 'Magic links by email, now',
        replaces: 'Sign-in through Google and GitHub.',
        whyNot:
          'The address passes through the Worker and Cloudflare’s delivery logs, and the form can be used to email-bomb.',
        whenRight: 'If the owner moves Q43 earlier, under the rule that an address is transient.',
        record: { adr: '0006' },
      },
      {
        name: 'Passkeys only',
        replaces: 'Sign-in through Google and GitHub.',
        whyNot:
          'It needs a recovery story, and a recruiter on a borrowed laptop may not have one set up.',
        whenRight: 'If demo passwords prove painful.',
        record: { adr: '0006' },
      },
      {
        name: 'Guests only, no accounts',
        replaces: 'Accounts.',
        whyNot: 'No sandbox across devices.',
        whenRight: NOT_RECORDED,
        record: { adr: '0006' },
      },
      {
        name: 'A social login with the `email` scope',
        replaces: '`openid` alone.',
        whyNot: 'The privacy page could no longer say it never receives one.',
        whenRight: 'As the fallback if Google refuses `openid` alone.',
        record: { adr: '0006' },
      },
      {
        name: 'Cloudflare Email Service for any real send',
        replaces: 'The `Inbox` object as the mailbox.',
        whyNot:
          'The bakery holds no address for anyone, and the `Inbox` object is the mailbox by design.',
        whenRight: 'Never, while the bakery holds no personal data.',
        record: { doc: 'stack' },
      },
      {
        name: 'A hosted identity provider, an auth library, or a signed token as the session',
        replaces:
          'The bakery’s own code flows for Google and GitHub and its HMAC-signed `__Host-session` cookie.',
        whyNot:
          'A hosted provider would hold each visitor’s identity on a third party’s service, outside the promise that the API receives no email or name, and a signed token would be another encoding of what the cookie already is.',
        whenRight:
          'A product with real users who need password reset, a second factor and account recovery, where holding an email is part of the service.',
        record: after('4'),
        after: true,
        never: { kind: 'compared', text: 'No provider or library was tried.' },
      },
    ],
  },
  {
    id: 'github-signin',
    name: 'GitHub sign-in, numeric `id` alone',
    group: 'payments',
    version: '`GITHUB_CLIENT_ID` (`workers/api/wrangler.jsonc`)',
    doesHere: 'One `GET /user`, an HMAC of the id, the rest discarded.',
    whyHere: 'GitHub returns an `id` on every account, so no email scope is needed.',
    whenNot: 'If GitHub starts returning an email or name to an app with no scopes.',
    records: [{ adr: '0006' }],
    essays: ['sandbox'],
    alternatives: [
      {
        name: 'A GitHub App instead of an OAuth app',
        replaces: 'The OAuth app.',
        whyNot: 'More setup for the same `id`.',
        whenRight: NOT_RECORDED,
        record: { doc: 'stack' },
      },
    ],
  },
  {
    id: 'rustcrypto',
    name: 'RustCrypto: `argon2`, `hmac`, `sha2`, `rsa`',
    group: 'payments',
    version: '`Cargo.toml`',
    doesHere: 'Demo password hashes, cookie and webhook HMACs, RS256 ID tokens.',
    whyHere: 'Pure Rust that builds for wasm32, where `ring` has limited support.',
    whenNot: 'On Free’s 10 ms of CPU argon2id cannot fit.',
    records: [{ adr: '0006' }],
    essays: ['sandbox'],
    packages: ['argon2', 'hmac', 'sha2', 'rsa'],
    alternatives: [
      {
        name: 'PBKDF2 through WebCrypto',
        replaces: 'argon2id for demo passwords.',
        whyNot: 'argon2id fits inside Paid’s CPU.',
        whenRight: 'As the fallback on Free, where the stateless Worker gets 10 ms of CPU.',
        record: { doc: 'security' },
      },
      {
        name: '`ring`',
        replaces: 'RustCrypto.',
        whyNot: 'Limited `wasm32` support, and RustCrypto does the same work in pure Rust.',
        whenRight: 'When `ring` documents full support for the target.',
        record: { doc: 'stack' },
      },
      {
        name: '`jsonwebtoken`',
        replaces: 'The hand-rolled RS256 check.',
        whyNot: 'Its backends are one more build choice for stack.md to police.',
        whenRight: NOT_RECORDED,
        record: { doc: 'security' },
      },
    ],
  },

  // The contract
  {
    id: 'contracts',
    name: 'The contract chain: `serde`, `schemars`, generated TypeScript and OpenAPI',
    group: 'contract',
    version: '`crates/contracts`',
    doesHere:
      'One Rust source for every type, rendered to JSON Schema, TypeScript and OpenAPI, each drift-checked.',
    whyHere: 'One source lets a test compare every neighbour with it.',
    whenNot: 'The generator is the bakery’s own, so OpenAPI features it does not emit cost code.',
    records: [{ adr: '0013' }],
    essays: ['api'],
    packages: ['bakery-contracts', 'serde', 'serde_json', 'schemars'],
    alternatives: [
      {
        name: 'A hand-written OpenAPI document as the source',
        replaces: 'The Rust types as the source.',
        whyNot: 'The types in Rust and the document can disagree, and nothing but review notices.',
        whenRight: NOT_RECORDED,
        record: { adr: '0013' },
      },
      {
        name: 'GraphQL',
        replaces: 'A REST contract.',
        whyNot:
          'Query cost limits and per-field authorization to build, for a demo whose actions are commands with business rules.',
        whenRight: NOT_RECORDED,
        record: { adr: '0013' },
      },
      {
        name: 'gRPC or another binary RPC',
        replaces: 'JSON over HTTP.',
        whyNot: 'A browser needs a translation layer, and a visitor’s `curl` no longer works.',
        whenRight: NOT_RECORDED,
        record: { adr: '0013' },
      },
      {
        name: 'Versioning by header or media type',
        replaces: 'The version in the path.',
        whyNot: 'A header is easy to forget and invisible in a log line.',
        whenRight: NOT_RECORDED,
        record: { adr: '0013' },
      },
      {
        name: 'No visitor API',
        replaces: 'One contract for the console and a visitor.',
        whyNot: 'The console and a visitor’s `curl` calling one contract is what PR 10 teaches.',
        whenRight: NOT_RECORDED,
        record: { adr: '0013' },
      },
    ],
  },
  {
    id: 'route-table',
    name: 'The bakery’s own route table, not the SDK’s `Router`',
    group: 'contract',
    version: '`workers/api/src/http/routes.rs`',
    doesHere: 'Every route’s method, pattern, scope, limit and bearer rule as one list.',
    whyHere:
      'The table is data the tests and the generated documents are held to; the SDK’s `Router` cannot list its routes.',
    whenNot:
      'When two tables kept by hand disagree more than once, the Worker should read the shared one.',
    records: [{ adr: '0013' }],
    essays: ['api'],
    alternatives: [
      {
        name: 'axum inside the Worker, through `worker`’s `http` feature',
        replaces: 'The route table.',
        whyNot:
          'Deferred: its cost in WebAssembly size, against a 64 MiB limit and a 1 s startup, is unmeasured.',
        whenRight: 'If spike S1 measures size and startup and both are acceptable.',
        record: { doc: 'stack' },
      },
    ],
  },

  // The site
  {
    id: 'astro',
    name: 'Astro, static, no adapter',
    group: 'site',
    version: '7.4.7 (`apps/web/package.json`)',
    doesHere: 'Builds every page as static HTML; 18 pages carry no script.',
    whyHere:
      'Static pages with islands only where a screen needs state, and no JavaScript on a page that has none.',
    whenNot:
      'When a screen needs server-rendered HTML, or Astro’s majors cost more than a day a quarter.',
    records: [{ adr: '0008' }],
    packages: ['astro'],
    alternatives: [
      {
        name: 'Server rendering with Astro’s Cloudflare adapter',
        replaces: 'The static build.',
        whyNot:
          'Every page view is a Worker invocation, and a JavaScript Worker would be a backend outside Rust.',
        whenRight: 'When a public page needs per-request content.',
        record: { adr: '0008' },
      },
      {
        name: 'A single-page app for everything',
        replaces: 'Static pages with islands.',
        whyNot: 'A shared link unfurls nothing specific, and every visitor pays React’s 69.5 KiB.',
        whenRight: 'Not expected.',
        record: { adr: '0008' },
      },
      {
        name: 'TanStack Start',
        replaces: 'Astro.',
        whyNot:
          'Every page pays React, text pages included, and it is a server runtime to host, outside Rust.',
        whenRight: NOT_RECORDED,
        record: { adr: '0008' },
      },
    ],
  },
  {
    id: 'react',
    name: 'React islands',
    group: 'site',
    version: '`react` 19.3.1, `@astrojs/react` 7.1.4 (`apps/web/package.json`)',
    doesHere:
      'Renders the console, the checkout, the order and catering pages, status and the guide on the client.',
    whyHere:
      'One island library, not two; Stripe’s React bindings need React on the two payment screens; the cost is the React runtime on every island page.',
    whenNot:
      'Preact would be the right choice for a site whose islands do not include those bindings.',
    records: [{ adr: '0008' }, after('3')],
    notMeasured: 'A Preact build of any island page (roadmap R81).',
    packages: ['react', 'react-dom', '@astrojs/react'],
    alternatives: [
      {
        name: 'Another island library',
        replaces: 'React through `@astrojs/react`.',
        whyNot:
          'One island library and not two; the cost is the React runtime on every island page, 65,840 B gzipped of the lightest page class’s 93,993 B first load, measured 2026-11-09.',
        whenRight:
          'A site whose islands do not include Stripe’s React bindings; whether they run under `preact/compat` is not checked, nor are Svelte, Solid and Vue.',
        record: after('3'),
        after: true,
        never: { kind: 'measured', text: 'A Preact build of any island page (roadmap R81).' },
      },
    ],
  },

  // Dispatch
  {
    id: 'vroom',
    name: 'VROOM in the browser',
    group: 'dispatch',
    version: '1.15.0, `apps/web/solver.lock.json`',
    doesHere: 'Plans the day in a module Web Worker; the object validates its plan.',
    whyHere: 'It runs at no cost to the server and is the yardstick for the heuristic.',
    whenNot: 'On a phone where a solve passes 2 s, or a browser below the WebAssembly floor.',
    records: [{ adr: '0012' }],
    essays: ['routes'],
    alternatives: [
      {
        name: 'Rust only, no browser solver',
        replaces: 'VROOM beside the heuristic.',
        whyNot: 'A weaker plan with nothing to compare it against.',
        whenRight: NOT_RECORDED,
        record: { adr: '0012' },
      },
      {
        name: 'The browser only',
        replaces: 'The object’s check of the plan.',
        whyNot: 'A plan nobody validated becomes the record.',
        whenRight: NOT_RECORDED,
        record: { adr: '0012' },
      },
      {
        name: 'A routing API per solve',
        replaces: 'A solver in the browser.',
        whyNot: 'A third party, its quota, and visitors’ choices leaving the site.',
        whenRight: NOT_RECORDED,
        record: { adr: '0012' },
      },
      {
        name: 'VROOM in a Container',
        replaces: 'VROOM in the browser.',
        whyNot: 'Containers are not used, and a cold start is 1 to 3 s.',
        whenRight: 'When a solver must run server-side beyond the Worker’s limits.',
        record: { adr: '0012' },
      },
      {
        name: 'Porting VROOM to Rust',
        replaces: 'VROOM as WebAssembly.',
        whyNot: 'Weeks of work, and a second implementation to keep right against upstream.',
        whenRight: NOT_RECORDED,
        record: { adr: '0012' },
      },
    ],
  },
  {
    id: 'savings',
    name: 'The savings heuristic in Rust, in `Dispatch`',
    group: 'dispatch',
    version: '`crates/domain/src/dispatch/savings.rs`',
    doesHere:
      'Proposes the day’s routes inside the object; measured natively at a median of 0.69 ms on 2026-11-10.',
    whyHere:
      'A pure function tested natively, cheap enough for the object’s handler: a median of 0.69 ms, natively, on the build session’s machine, 2026-11-10, not as WebAssembly and not on the edge.',
    whenNot:
      'When its gap to a real solver passes 25% of drive time, or the problem has more than one depot.',
    records: [{ adr: '0012' }],
    essays: ['routes'],
    notMeasured: 'Its time as WebAssembly inside the `Dispatch` object (roadmap R80).',
  },
  {
    id: 'openrouteservice',
    name: 'openrouteservice and osmium-tool, build time only',
    group: 'dispatch',
    version: 'v9.10.0; osmium-tool 1.16.0 (`docs/stack.md`)',
    doesHere: 'Builds the committed travel-time matrix and isochrones once, offline.',
    whyHere:
      'The owner’s direction of 2026-11-05 chose it over OSRM; both self-host from the same extract, with no measured difference; either needs no API key and no quota.',
    whenNot: 'Not when the times must be rebuilt identically on demand.',
    records: [{ adr: '0012' }, after('5')],
    essays: ['routes'],
    ownersRule: 'direction',
    notMeasured: 'A matrix from OSRM beside the committed one (roadmap R79).',
    alternatives: [
      {
        name: 'Another solver or routing engine',
        replaces: 'VROOM in the browser and openrouteservice at build time.',
        whyNot:
          'VROOM is the Route Lab’s solver, and openrouteservice replaced OSRM by the owner’s direction of 2026-11-05, with no engineering comparison.',
        whenRight:
          'OR-Tools, for a server-side solver with constraints VROOM does not model; another routing engine, if its matrix differs from openrouteservice’s in a way the plans notice.',
        record: after('5'),
        after: true,
        never: {
          kind: 'measured',
          text: 'A matrix from OSRM beside the committed one (roadmap R79), and any solver but VROOM and the savings heuristic.',
        },
      },
      {
        name: 'A hosted routing API for the build',
        replaces: 'A self-hosted engine.',
        whyNot: 'A key, a quota and a third party.',
        whenRight: NOT_RECORDED,
        record: { doc: 'stack' },
      },
      {
        name: 'Reusing the Route Lab’s Seattle data',
        replaces: 'A matrix for the bakery’s own city.',
        whyNot: 'A city other than the one the owner chose.',
        whenRight: NOT_RECORDED,
        record: { adr: '0012' },
      },
    ],
  },

  // Delivery and checks
  {
    id: 'github-actions',
    name: 'GitHub Actions and Wrangler',
    group: 'delivery',
    version: '`ci.yml`; Wrangler 4, pinned in the workspace catalog (`pnpm-workspace.yaml`)',
    doesHere:
      'Build once, scan, preview, test, deploy the API then the storefront, smoke, roll back.',
    whyHere:
      'The firewall passes before anything is published, and one writer per Worker deploys the scanned bytes.',
    whenNot:
      'When Workers Builds can make a preview wait for GitHub checks; as read on 2026-11-10 its documentation describes no such way.',
    records: [{ adr: '0011' }],
    alternatives: [
      {
        name: 'Workers Builds for both Workers',
        replaces: 'GitHub Actions as the one deployer.',
        whyNot: 'A public preview can exist before the firewall passes.',
        whenRight: 'When Workers Builds can make a preview wait for GitHub checks.',
        record: { adr: '0011' },
      },
      {
        name: 'Manual `wrangler deploy` from a laptop',
        replaces: 'Deploys from CI.',
        whyNot: 'An edit credential at rest on a laptop.',
        whenRight: NOT_RECORDED,
        record: { adr: '0011' },
      },
      {
        name: 'A separate workflow per Worker',
        replaces: 'One workflow for both Workers.',
        whyNot:
          'Two deploy groups can race, so the storefront can promote before the API it needs.',
        whenRight: NOT_RECORDED,
        record: { adr: '0011' },
      },
      {
        name: 'The full pipeline from PR 2',
        replaces: 'The pipeline grown to launch.',
        whyNot: 'Time goes to previews and tests for software nobody uses.',
        whenRight:
          'If two regressions reach `main` before PR 11 that `e2e` or a preview would have caught.',
        record: { adr: '0011' },
      },
      {
        name: 'Deploying the API from the web Worker’s step',
        replaces: 'A deploy step per Worker.',
        whyNot: 'Every storefront change would redeploy the API and drop every kitchen socket.',
        whenRight: NOT_RECORDED,
        record: { adr: '0011' },
      },
      {
        name: 'Infrastructure as code for the Cloudflare account',
        replaces:
          'Setup by hand: the two queues, made once in the dashboard, and the WAF kill rule and the tokens, made from operations.md.',
        whyNot:
          'The account objects are few and made once, and the Workers’ own settings are already code in each `wrangler.jsonc`.',
        whenRight:
          'A second environment, a second operator, or account settings that change often enough to drift.',
        record: after('7'),
        after: true,
        never: {
          kind: 'measured',
          text: 'Whether anything has drifted from operations.md; which resources Cloudflare’s Terraform provider covers was not checked.',
        },
      },
    ],
  },
  {
    id: 'cargo-test',
    name: '`cargo test` with `proptest`',
    group: 'delivery',
    version: '`proptest` =1.12.0 (`Cargo.toml`)',
    doesHere: 'The domain and app layers, natively, with property tests.',
    whyHere: 'The domain has no platform dependency, so its tests run in seconds.',
    whenNot: 'Not for the objects and HTTP, which are tested against `wrangler dev`.',
    records: [{ adr: '0002' }],
    packages: ['proptest'],
    alternatives: [
      {
        name: '`@cloudflare/vitest-plugin`',
        replaces: 'Integration tests against `wrangler dev` for the objects.',
        whyNot: 'It cannot drive Rust objects.',
        whenRight: 'For TypeScript Workers.',
        record: { adr: '0002' },
      },
      {
        name: 'Other test runners: cargo-nextest, Jest, Cypress',
        replaces: '`cargo test`, Vitest and Playwright.',
        whyNot:
          'The web tools are the site’s, so both repositories test the same way, and `cargo test` is the Rust default.',
        whenRight: 'Not checked for any of the three.',
        record: after('10'),
        after: true,
        never: { kind: 'compared', text: 'None of the three was tried.' },
      },
    ],
  },
  {
    id: 'lighthouse',
    name: 'Lighthouse CI',
    group: 'delivery',
    version: '`@lhci/cli` 0.15.1 (`tools/lighthouse/package.json`)',
    doesHere: 'Scores each web preview’s public pages against four budgets.',
    whyHere: 'Budgets on the real edge.',
    whenNot:
      'Not for signed-in screens: the preview calls the production API, whose CORS refuses it.',
    records: [{ adr: '0008' }],
  },
  {
    id: 'gitleaks',
    name: 'gitleaks, the content firewall',
    group: 'delivery',
    version: '8.30.1 (`scripts/firewall/gitleaks.version`)',
    doesHere:
      'Scans the tree, commits, pull request text and both built bundles with private rules.',
    whyHere: 'Public from the first push, so a leaked term cannot be taken back.',
    whenNot: 'GitHub’s own secret and code scanning belong alongside it, not instead.',
    records: [{ adr: '0011' }, after('8')],
    notMeasured:
      'Whether GitHub’s secret scanning and push protection are on for this repository, never checked (roadmap R82).',
    alternatives: [
      {
        name: 'Other secret scanners, and code scanning',
        replaces: 'gitleaks with private rules, the content firewall.',
        whyNot:
          'The firewall’s terms are private and never written into the repository, and it runs before a push as well as in CI over the built bundles; GitHub’s scanning runs after a push, on its own patterns.',
        whenRight:
          'Both alongside, not instead: code scanning looks for flaws in code, which the firewall does not.',
        record: after('8'),
        after: true,
        never: {
          kind: 'checked',
          text: 'Whether GitHub’s secret scanning and push protection are on for this repository (roadmap R82).',
        },
      },
    ],
  },
  {
    id: 'cargo-deny',
    name: '`cargo-deny` and `cargo-audit`',
    group: 'delivery',
    version: '0.20.2 and 0.22.2 (`Cargo.toml`)',
    doesHere: 'Licences, advisories, bans, sources and build scripts.',
    whyHere: 'A large `worker` tree in a public repository.',
    whenNot:
      'Where every crate must be reviewed by a person, `cargo-vet` is stronger, at more process.',
    records: [{ adr: '0011' }],
    alternatives: [
      {
        name: '`cargo-vet`',
        replaces: '`cargo-deny` and `cargo-audit`.',
        whyNot: 'Stronger, at more process.',
        whenRight: NOT_RECORDED,
        record: { doc: 'stack' },
      },
    ],
  },
  {
    id: 'dependabot',
    name: 'Dependabot',
    group: 'delivery',
    version: '`.github/dependabot.yml`',
    doesHere: 'Grouped weekly updates, majors one at a time.',
    whyHere: 'Native, free, reads `Cargo.lock`.',
    whenNot:
      'Not for a 0.x crate whose minor can break: `worker`, `worker-build` and `wasm-bindgen` move by hand.',
    records: [{ doc: 'stack' }],
    alternatives: [
      {
        name: 'pnpm 12',
        replaces: 'pnpm 11.',
        whyNot: 'Its lockfile is invisible to GitHub’s dependency graph.',
        whenRight: 'When the graph reads it.',
        record: { doc: 'stack' },
      },
    ],
  },
];

/** Every alternative, with the tool it sits under. */
export const alternatives = (): { tool: Tool; alternative: Alternative }[] =>
  TOOLS.flatMap((tool) => (tool.alternatives ?? []).map((alternative) => ({ tool, alternative })));
