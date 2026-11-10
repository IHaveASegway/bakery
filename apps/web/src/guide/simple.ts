// The guide's entries for the pages with little on them: the start page, sign-in, the menu, the
// checkout, the API reference, the privacy page and the status page. Entries are data
// (lib/guide.ts, GuideEntry); test/guide.test.ts checks every `api` against the OpenAPI document,
// every body against its request schema and every trigger against the routes and the event catalog.
import type { GuideEntry } from '../lib/guide';
import {
  ADMISSION,
  API,
  BREAKER,
  CACHE,
  IDEMPOTENCY,
  LEASE,
  NO_DATA,
  PAYMENTS,
  QUEUE,
  SANDBOX,
} from './principles';

export const HOME: GuideEntry[] = [
  {
    id: 'home-intro',
    screen: 'home',
    target: 'home-intro',
    title: 'A bakery that is a demonstration',
    what: 'A made-up bakery built as a real business system. Every visitor gets a private sandbox of synthetic data, wiped every night.',
    why: 'A sandbox per visitor lets a stranger press every button, refunds and wipes included, without touching anyone else’s data.',
    whenNot: 'Not for a product whose users must share data: there the isolation is the bug.',
    events: ['SandboxSeeded'],
    principle: SANDBOX,
    triggers: [],
    api: {
      routeId: 'status',
      method: 'GET',
      path: '/v1/status',
      note: 'The API’s own status, public and cheap: a good first request to check that your terminal can reach it.',
    },
  },
  {
    id: 'home-links',
    screen: 'home',
    target: 'home-links',
    title: 'Try it in a minute',
    what: 'Try it as a guest, pick from the menu, pay with Stripe’s test card, read the receipt in the inbox, then open the console. The console is the staff side.',
    why: 'The sandbox is made on the first click, so the path starts with no sign-up form.',
    whenNot: 'Not when a demo must keep its data between visits: this one is gone at 10:00 UTC.',
    events: [],
    principle: SANDBOX,
    triggers: [],
    api: {
      routeId: 'session',
      method: 'GET',
      path: '/v1/session',
      note: 'What the session cookie says about you, read without touching a sandbox. It takes the cookie only, so from a terminal it answers 401.',
    },
  },
  {
    id: 'home-path',
    screen: 'home',
    target: 'home-path',
    title: 'The path of one click',
    what: 'One order drawn as the path it takes: the browser, the API Worker, the order’s own object, the Queue and the kitchen board. Each part links to the essay that argues for it.',
    why: 'Drawing the path shows the line the code keeps: a request stops at one object, and everything after it travels as an event.',
    whenNot:
      'Not a promise of timing: the Queue’s hop takes a moment, not a fixed delay, and the figure draws no retries.',
    events: ['OrderPlaced', 'OrderPaid'],
    principle: QUEUE,
    api: {
      routeId: 'place-order',
      method: 'POST',
      path: '/v1/sandboxes/{id}/orders',
      body: {
        kind: 'pickup',
        slot: '2026-11-07T09:45:00-07:00',
        lines: [{ variant: 'country-loaf/whole', qty: 1 }],
      },
      note: 'The click the figure follows, from a terminal.',
    },
    triggers: [],
  },
];

export const SIGNIN: GuideEntry[] = [
  {
    id: 'signin-providers',
    screen: 'signin',
    target: 'signin-providers',
    title: 'Signing in with Google or GitHub',
    what: 'Google and GitHub tell the bakery only a number for the account, kept as a keyed hash. These are links: the browser goes to the provider and comes back with a session cookie.',
    why: 'Delegating sign-in means the bakery stores no password and no email for these accounts.',
    whenNot:
      'Not for a visitor without such an account, which is why a demo account and a guest pass sit beside it.',
    events: [],
    principle: ADMISSION,
    triggers: [],
    api: {
      routeId: 'google-start',
      method: 'GET',
      path: '/v1/auth/google/start',
      note: 'Starts the sign-in; the browser follows the redirect. The `return` query parameter says where to come back to.',
    },
  },
  {
    id: 'signin-demo',
    screen: 'signin',
    target: 'signin-demo',
    title: 'A demo account',
    what: 'A generated username and a password you choose, with no email. Turnstile guards the sign-up, because it makes an account.',
    why: 'A check that you are a person before anything is created keeps a script from minting accounts for free.',
    whenNot:
      'Not on every request: a challenge per click would cost the visitor more than the abuse it stops.',
    events: [],
    principle: ADMISSION,
    triggers: ['demo-signup'],
    api: {
      routeId: 'demo-signup',
      method: 'POST',
      path: '/v1/auth/demo',
      body: {
        password: '<a password of 12 to 128 characters>',
        turnstile_token: '<the token Turnstile gives the page>',
      },
      note: 'Needs a Turnstile token only a browser can get, so this one is for reading. The API token for a terminal is issued in the console after you sign in.',
    },
  },
  {
    id: 'signin-guest',
    screen: 'signin',
    target: 'signin-guest',
    title: 'Try it as a guest',
    what: 'No account: a Turnstile pass buys a sandbox and a cookie. Guests browse, order, pay with a test card and move their own orders on the kitchen board; the console’s other writes need a sign-in.',
    why: 'Admission happens once, at the door, so every later request is cheap and the daily cap is counted in one place.',
    whenNot:
      'Not where a refusal is unacceptable: on a busy day the cap turns a visitor away rather than spend more.',
    events: ['SandboxSeeded'],
    principle: ADMISSION,
    triggers: ['create-sandbox'],
    api: {
      routeId: 'create-sandbox',
      method: 'POST',
      path: '/v1/sandboxes',
      body: { turnstile_token: '<the token Turnstile gives the page>', replace: false },
      note: 'Makes your sandbox and sets the session cookie. The first alarm seeds it, so poll GET /v1/sandboxes/{id} until its state is live.',
    },
  },
];

// The entries run down the page: the cart, the list, then the note about where the menu came from.
// The list's entry is anchored to the first card, since the whole list is thousands of pixels tall.
export const MENU: GuideEntry[] = [
  {
    id: 'menu-start',
    screen: 'menu',
    target: 'menu-start',
    title: 'Your own bakery first',
    what: 'Ordering needs a sandbox of your own; until then this is the demo’s seed menu. A guest sandbox takes a few seconds and is wiped tonight.',
    why: 'A sandbox per visitor means an order you place can never land in anyone else’s kitchen.',
    whenNot:
      'Not for a shop that must sell to a stranger at once: here a check that you are a person comes before the first order.',
    events: ['SandboxSeeded'],
    principle: SANDBOX,
    api: {
      routeId: 'create-sandbox',
      method: 'POST',
      path: '/v1/sandboxes',
      body: { turnstile_token: '<the token Turnstile gives the page>', replace: false },
      note: 'What the sign-in page’s guest button sends.',
    },
    triggers: [],
  },
  {
    id: 'menu-categories',
    screen: 'menu',
    target: 'menu-categories',
    title: 'One read for the whole menu',
    what: 'These links jump down the one menu page and load nothing. The whole menu came in one read, cached by its version.',
    why: 'One versioned read serves the whole page, so moving between categories costs no request.',
    whenNot:
      'Not for a catalogue of thousands of items: one read of everything would be too large, and it would be paged.',
    events: [],
    principle: CACHE,
    api: {
      routeId: 'get-menu',
      method: 'GET',
      path: '/v1/sandboxes/{id}/menu',
      note: 'The one read this page makes for its menu.',
    },
    triggers: [],
  },
  {
    id: 'menu-cart',
    screen: 'menu',
    target: 'menu-cart',
    title: 'The cart lives in this tab',
    what: 'The cart lives in this tab only, at most 20 lines. Nothing reaches the API until you check out, so adding a line makes no event.',
    why: 'Keeping the cart in the tab means the server holds nothing until there is an order worth an idempotency key.',
    whenNot:
      'Not for a cart that must follow a customer across devices: that needs a cart on the server, with its own expiry.',
    events: [],
    principle: IDEMPOTENCY,
    triggers: [],
    api: {
      routeId: 'place-order',
      method: 'POST',
      path: '/v1/sandboxes/{id}/orders',
      body: {
        kind: 'pickup',
        slot: '2026-11-07T09:45:00-07:00',
        lines: [{ variant: 'country-loaf/whole', qty: 1 }],
      },
      note: 'What Check out sends. The Idempotency-Key is new for each attempt and the same for its retries, so a dropped connection never places two orders.',
    },
  },
  {
    id: 'menu-list',
    screen: 'menu',
    target: 'menu-list',
    title: 'Twenty-four items, drawn not photographed',
    what: 'The first card is ringed; each of the 24 items is a card like it, with its prices, allergens and notice. A price changed in the console stays a draft until it is published.',
    why: 'The menu is cached by version, so publishing makes the next read miss once and nothing has to be found and deleted.',
    whenNot:
      'Not for data that changes on every write, such as stock counts: each change would be a new version and every read a miss.',
    events: ['MenuItemChanged', 'MenuPublished'],
    principle: CACHE,
    triggers: [],
    api: {
      routeId: 'get-menu',
      method: 'GET',
      path: '/v1/sandboxes/{id}/menu',
      note: 'The same menu the page draws, as JSON with prices in integer cents.',
    },
  },
  {
    id: 'menu-how',
    screen: 'menu',
    target: 'menu-how',
    title: 'Where the menu came from',
    what: 'Without a sandbox this is the demo’s seed menu, the one every new sandbox starts with. With a sandbox, the menu comes from its own Catalog object through the API, with an ETag and a Bakery-Cache header.',
    why: 'A menu is read far more than it changes, so a cache keyed by its version spares its single writer, the Catalog object.',
    whenNot:
      'Not for a read that must be current, such as an order’s status, or a body that differs per visitor, such as a cart.',
    events: ['MenuPublished'],
    principle: CACHE,
    triggers: ['get-menu'],
    facts: [
      'Asking again with the ETag in hand costs a 304 and no body until a change is published in the console.',
      'Publishing a change bumps the menu’s version, so the first read of the new version misses the cache once and fills it.',
    ],
    api: {
      routeId: 'get-menu',
      method: 'GET',
      path: '/v1/sandboxes/{id}/menu',
      note: 'Returns the menu with an ETag. Send it back as If-None-Match and an unchanged menu costs a 304 and no body; the Bakery-Cache header says whether the API’s cache answered.',
    },
  },
];

export const CHECKOUT: GuideEntry[] = [
  {
    id: 'checkout-cart',
    screen: 'checkout',
    target: 'checkout-cart',
    title: 'Your cart, priced by the API',
    what: 'The lines come from this tab’s cart, and the totals are an estimate. The API prices the order from the menu version it names, and that answer is the record.',
    why: 'Pricing on the server from a named version means a stale page can never charge an old price.',
    whenNot:
      'Not for a price that must be quoted and held for days, such as catering: that needs a quote with its own expiry.',
    events: [],
    principle: CACHE,
    triggers: [],
    api: {
      routeId: 'get-menu',
      method: 'GET',
      path: '/v1/sandboxes/{id}/menu',
      note: 'The prices the order will be checked against.',
    },
  },
  {
    id: 'checkout-menu',
    screen: 'checkout',
    target: 'checkout-menu',
    title: 'The menu this checkout read',
    what: 'The checkout reads your sandbox’s menu to show its lines and totals. The read goes through the same cache as the menu page, keyed by the menu’s version.',
    why: 'A cache keyed by the menu’s version answers the many reads of a menu that rarely changes, and never serves an old version.',
    whenNot:
      'Not for the price you pay: the API prices the order itself from the version it names.',
    events: [],
    principle: CACHE,
    triggers: ['get-menu'],
    api: {
      routeId: 'get-menu',
      method: 'GET',
      path: '/v1/sandboxes/{id}/menu',
      note: 'The menu with an ETag and a Bakery-Cache header. Send the ETag back as If-None-Match and an unchanged menu costs a 304 and no body.',
    },
    facts: [
      'Asking again with that ETag costs a 304 and no body until you publish a change in the console.',
    ],
  },
  {
    id: 'checkout-form',
    screen: 'checkout',
    target: 'checkout-form',
    title: 'Placing the order',
    what: 'Pickup or delivery, a slot and an optional note of at most 140 characters. Placing the order holds its places for 15 minutes of bakery time.',
    why: 'Each attempt carries its own Idempotency-Key, so a retry after a lost answer gets the first order back instead of a second.',
    whenNot:
      'Not for reads, which are safe to repeat, and no substitute for validation: the same key with a changed body is refused.',
    events: ['OrderPlaced', 'SlotHeld'],
    principle: IDEMPOTENCY,
    triggers: ['place-order', 'OrderPlaced', 'SlotHeld'],
    api: {
      routeId: 'place-order',
      method: 'POST',
      path: '/v1/sandboxes/{id}/orders',
      body: {
        kind: 'delivery',
        slot: '2026-11-07T11:00:00-07:00',
        zone: 'z2',
        lines: [
          { variant: 'country-loaf/whole', qty: 2 },
          { variant: 'seeded-rye/half', qty: 1 },
        ],
      },
      note: 'Send the same Idempotency-Key again and you get the first answer back with Idempotent-Replayed: true; the same key with a different body is a 422.',
    },
  },
  {
    id: 'checkout-pay',
    screen: 'checkout',
    target: 'checkout-pay',
    title: 'Paying with a test card',
    what: 'Stripe’s Payment Element, in test mode, takes only a test card; no money moves. The order stays held until Stripe’s webhook says the payment succeeded.',
    why: 'The order is paid only on Stripe’s signed webhook, so a tab closed after paying still ends with a paid order.',
    whenNot:
      'Not where the answer must be immediate, such as a till: a webhook arrives a moment later and can arrive twice.',
    events: ['PaymentIntentCreated', 'PaymentSucceeded', 'OrderPaid'],
    principle: PAYMENTS,
    triggers: ['pay', 'PaymentSucceeded', 'OrderPaid'],
    api: {
      routeId: 'pay',
      method: 'POST',
      path: '/v1/sandboxes/{id}/orders/{oid}/payment',
      note: 'Returns the PaymentIntent’s client secret for the Payment Element. The order’s id is the idempotency key, so asking twice gets the same intent.',
    },
  },
];

export const API_PAGE: GuideEntry[] = [
  {
    id: 'api-index',
    screen: 'api',
    target: 'api-index',
    title: 'One contract, three readers',
    what: 'This page is built from the same route table and schemas the Worker and the console use. Each operation has an anchor you can link to.',
    why: 'One contract generates the reference, so the reference cannot disagree with the server.',
    whenNot:
      'Not free for a young API: after acceptance a field is only added, never renamed, until a /v2/.',
    events: [],
    principle: API,
    triggers: [],
    api: {
      routeId: 'health',
      method: 'GET',
      path: '/v1/health',
      note: 'The simplest call there is. If this works from your terminal, the rest is a token away.',
    },
  },
  {
    id: 'api-token',
    screen: 'api',
    target: 'api-token',
    title: 'Your token, in a terminal',
    what: 'Sign in, open the console and press Issue token. It is shown once, held in memory, and lasts 24 hours or until the sandbox is wiped or you rotate it.',
    why: 'A bearer token scoped to one sandbox lets a terminal do what the console does and reach nothing else.',
    whenNot:
      'Not for the account’s own routes, which take the cookie only, so a token can never mint its successor.',
    events: ['ApiTokenRotated'],
    principle: API,
    triggers: [],
    api: {
      routeId: 'get-token',
      method: 'GET',
      path: '/v1/sandboxes/{id}/token',
      note: 'What the API knows about the current token: its version, its times and its masked form, never the token.',
    },
  },
  {
    id: 'api-operations',
    screen: 'api',
    target: 'api-operations',
    title: 'Reading an operation',
    what: 'Each operation shows its method, path, who may call it, its body and its answers. Errors are application/problem+json, with a type you can match on.',
    why: 'Problem details give every refusal a stable type, so a client branches on a slug and not on a sentence.',
    whenNot:
      'Not a place for prose a client must parse: the detail is for people, the type is for code.',
    events: [],
    principle: API,
    triggers: [],
    api: {
      routeId: 'get-sandbox',
      method: 'GET',
      path: '/v1/sandboxes/{id}',
      note: 'Your sandbox: its state, persona, clock offset and when it is wiped.',
    },
  },
  {
    id: 'api-socket',
    screen: 'api',
    target: 'api-socket',
    title: 'The kitchen socket',
    what: 'The kitchen board is live over a WebSocket that takes the cookie only. A terminal can watch the board’s effects through the activity feed.',
    why: 'A socket pushes each event as the Kitchen applies it, so the board moves without polling.',
    whenNot:
      'Not for a client that only checks now and then: a GET of the activity feed is simpler and holds no connection open.',
    events: ['OrderProductionStarted', 'OrderReady'],
    principle: QUEUE,
    triggers: [],
    api: {
      routeId: 'get-activity',
      method: 'GET',
      path: '/v1/sandboxes/{id}/activity',
      note: 'Newest first; add ?limit=20 to keep the newest twenty.',
    },
  },
];

export const PRIVACY: GuideEntry[] = [
  {
    id: 'privacy-lead',
    screen: 'privacy',
    target: 'privacy-lead',
    title: 'Nothing personal, by construction',
    what: 'The bakery never asks for or stores your name, email, address or card. The only free text is an order note and a catering brief, each checked when it is written.',
    why: 'Data never collected cannot leak, so the demo can be handed to strangers.',
    whenNot: 'Not for a real shop, which must deliver to an address and send a receipt somewhere.',
    events: [],
    principle: NO_DATA,
    triggers: [],
    api: {
      routeId: 'session',
      method: 'GET',
      path: '/v1/session',
      note: 'The whole of what the bakery knows about you: a kind (guest or signed in), an expiry and a sandbox id.',
    },
  },
  {
    id: 'privacy-table',
    screen: 'privacy',
    target: 'privacy-table',
    title: 'What is kept, and for how long',
    what: 'Each row says what is kept, for how long and why. A sandbox lasts until the nightly wipe, with a 36-hour backstop.',
    why: 'Every object arms its own backstop, so one the wipe misses still deletes itself.',
    whenNot:
      'Not erasure on the platform: Cloudflare keeps deleted storage restorable for 30 days.',
    events: ['SandboxWiped'],
    principle: LEASE,
    triggers: [],
    api: {
      routeId: 'get-sandbox',
      method: 'GET',
      path: '/v1/sandboxes/{id}',
      note: 'Shows `wipe_at`, the moment your sandbox will be deleted.',
    },
  },
  {
    id: 'privacy-wipe',
    screen: 'privacy',
    target: 'privacy-wipe',
    title: 'Deleting the sandbox at once',
    what: 'Wipe now runs the night’s wipe for your sandbox alone, right away. There is no undo.',
    why: 'The Sandbox registers every object it makes, so one command can find and delete all of them.',
    whenNot:
      'Not for data a person may want back: the wipe is final, and a real product would offer an export first.',
    events: ['SandboxWiped'],
    principle: SANDBOX,
    triggers: ['wipe-sandbox', 'SandboxWiped'],
    api: {
      routeId: 'wipe-sandbox',
      method: 'DELETE',
      path: '/v1/sandboxes/{id}',
      note: 'Deletes the sandbox and, with it, every token for it. There is no undo.',
    },
  },
];

export const STATUS: GuideEntry[] = [
  {
    id: 'status-breaker',
    screen: 'status',
    target: 'status-breaker',
    title: 'A breaker that reads the meter',
    what: 'Every 15 minutes a cron job reads the account’s usage and gives the verdict to the Control object. Read-only and off are tripped states, and a person resets them.',
    why: 'A breaker that reads the meter bounds the bill before it arrives, not after.',
    whenNot:
      'Not a way to stop a loop inside an object: that needs its own guard, the cap on alarm re-arms.',
    events: [],
    principle: BREAKER,
    triggers: [],
    api: {
      routeId: 'status',
      method: 'GET',
      path: '/v1/status',
      note: 'Public and cheap. The breaker field holds its state, since when, the last run, that run’s price in dollars and the meters it could not read.',
    },
  },
];
