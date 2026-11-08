// The tours of the pages with little on them: the start page, sign-in, the menu, the checkout, the
// API reference, the privacy page and the status page. Steps are data (lib/tour.ts, TourStep); test/tour.test.ts
// checks every `api` against the OpenAPI document and every body against its request schema.
import type { TourStep } from '../lib/tour';
import { HOW } from './how';
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

export const HOME: TourStep[] = [
  {
    id: 'home-intro',
    screen: 'home',
    target: 'home-intro',
    title: 'A bakery that is a demonstration',
    what: 'This is a made-up bakery built as a real business system, to show the principles of the site’s lab running in production code: Rust on Cloudflare, with a private sandbox of synthetic data for every visitor, wiped every night. Each screen has a tour like this one that says what you are looking at, what happened underneath and how to do the same thing from a terminal.',
    events: ['SandboxSeeded'],
    principle: SANDBOX,
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
    what: 'Five steps: sign in or try it as a guest, which makes your sandbox; the menu; a checkout paid with Stripe’s test card; the receipt in the inbox; and the console. The console, at /app/, is the staff side: the kitchen board, the clock and every control that changes the bakery.',
    events: [],
    principle: SANDBOX,
    api: {
      routeId: 'session',
      method: 'GET',
      path: '/v1/session',
      note: 'What the session cookie says about you, read without touching a sandbox. It takes the cookie only, so from a terminal it answers 401.',
    },
  },
];

export const SIGNIN: TourStep[] = [
  {
    id: 'signin-providers',
    screen: 'signin',
    target: 'signin-providers',
    title: 'Sign in with an account you have',
    what: 'Google and GitHub tell the bakery only a number that identifies the account, and the bakery keeps it as a keyed hash. These are links, not requests: your browser goes to the provider and comes back with a session cookie.',
    events: [],
    principle: ADMISSION,
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
    what: 'A generated username and a password you choose, with no email. A check that you are a person (Turnstile) guards the sign-up, because it makes an account. The account has no sandbox yet: you sign in with it and make one in the console.',
    events: [],
    principle: ADMISSION,
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
    what: 'No account: a Turnstile pass buys a sandbox and a cookie, nothing else. Guests browse, order and pay with a test card; the console’s writes and the API token need a sign-in.',
    events: ['SandboxSeeded'],
    principle: ADMISSION,
    api: {
      routeId: 'create-sandbox',
      method: 'POST',
      path: '/v1/sandboxes',
      body: { turnstile_token: '<the token Turnstile gives the page>', replace: false },
      note: 'Makes your sandbox and sets the session cookie. The first alarm seeds it, so poll GET /v1/sandboxes/{id} until its state is live.',
    },
  },
];

// The steps run down the page, on a phone too: the cart, the list, then the note about where the menu
// came from. The list step rings the first card, since the whole list is thousands of pixels tall.
export const MENU: TourStep[] = [
  {
    id: 'menu-cart',
    screen: 'menu',
    target: 'menu-cart',
    title: 'The cart lives in this tab',
    what: 'The cart is kept in this tab only and holds at most 20 lines. Nothing reaches the API until you check out, so adding and removing lines is free and makes no event.',
    events: [],
    principle: IDEMPOTENCY,
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
    what: 'The first card is ringed; each of the 24 items is a card like it. A card shows its variants, prices in US dollars, allergens and how far ahead it needs notice. A price you change in the console is a draft until you publish; publishing bumps the menu’s version, which is what makes the cache miss.',
    events: ['MenuItemChanged', 'MenuPublished'],
    principle: CACHE,
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
    what: HOW.menuSeed,
    events: ['MenuPublished'],
    principle: CACHE,
    api: {
      routeId: 'get-menu',
      method: 'GET',
      path: '/v1/sandboxes/{id}/menu',
      note: 'Returns the menu with an ETag. Send it back as If-None-Match and an unchanged menu costs a 304 and no body; the Bakery-Cache header says whether the API’s cache answered.',
    },
  },
];

export const CHECKOUT: TourStep[] = [
  {
    id: 'checkout-cart',
    screen: 'checkout',
    target: 'checkout-cart',
    title: 'Your cart, priced by the API',
    what: 'The lines come from this tab’s cart. The totals you see are an estimate; the API prices the order from the menu version it publishes at the moment you place it, and that answer is the record.',
    events: [],
    principle: CACHE,
    api: {
      routeId: 'get-menu',
      method: 'GET',
      path: '/v1/sandboxes/{id}/menu',
      note: 'The prices the order will be checked against.',
    },
  },
  {
    id: 'checkout-form',
    screen: 'checkout',
    target: 'checkout-form',
    title: 'Placing the order',
    what: 'Pickup or delivery, a slot, and an optional note of at most 140 characters that may not hold an email address, phone number, card number or link. Placing it holds your places for 15 minutes of bakery time; unpaid, the hold lapses.',
    events: ['OrderPlaced', 'SlotHeld'],
    principle: IDEMPOTENCY,
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
    what: 'The Payment Element is Stripe’s, running in test mode, and collects only a test card: no money moves and no billing detail of yours is asked for. The order stays held until Stripe’s webhook says the payment succeeded.',
    events: ['PaymentIntentCreated', 'PaymentSucceeded', 'OrderPaid'],
    principle: PAYMENTS,
    api: {
      routeId: 'pay',
      method: 'POST',
      path: '/v1/sandboxes/{id}/orders/{oid}/payment',
      note: 'Returns the PaymentIntent’s client secret for the Payment Element. The order’s id is the idempotency key, so asking twice gets the same intent.',
    },
  },
  {
    id: 'checkout-receipt',
    screen: 'checkout',
    target: 'checkout-receipt',
    title: 'The receipt is the order, read back',
    what: 'The page asks the API for the order until it is paid, so what you read is the order object’s own state, not a guess made by this page.',
    events: ['OrderPaid'],
    principle: PAYMENTS,
    api: {
      routeId: 'get-order',
      method: 'GET',
      path: '/v1/sandboxes/{id}/orders/{oid}',
      note: 'The order with its lines, totals and state.',
    },
  },
  {
    id: 'checkout-cancel',
    screen: 'checkout',
    target: 'checkout-receipt',
    title: 'A hold is a lease',
    what: 'A place held for an unpaid order is released when the lease runs out or the order is cancelled. The storefront has no cancel button yet; the API does the same thing.',
    events: ['OrderCancelled', 'SlotReleased'],
    principle: LEASE,
    api: {
      routeId: 'cancel-order',
      method: 'POST',
      path: '/v1/sandboxes/{id}/orders/{oid}/cancel',
      note: 'Releases the held places. An order that is already paid or closed answers 409.',
    },
  },
];

export const API_PAGE: TourStep[] = [
  {
    id: 'api-index',
    screen: 'api',
    target: 'api-index',
    title: 'One contract, three readers',
    what: 'This page is built from the same route table and schemas the Worker and the console use, so it cannot disagree with them. The index lists every operation by area; each one has an anchor you can link to.',
    events: [],
    principle: API,
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
    what: 'Sign in, open the console and press Issue token. It is shown once, in memory only, and lives 24 hours or until the sandbox is wiped or you rotate it. It goes in Authorization: Bearer, never in a URL.',
    events: ['ApiTokenRotated'],
    principle: API,
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
    what: 'Each operation shows its method and path, who may call it, whether a token is accepted, its parameters, the request body and the answers with their problem types. Errors are application/problem+json, and their type ends in a slug you can match on.',
    events: [],
    principle: API,
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
    what: 'The kitchen board is live over a WebSocket that takes the cookie only. Its frames are listed here. A terminal that cannot open a socket can still watch the board’s effects through the activity feed.',
    events: ['OrderProductionStarted', 'OrderReady'],
    principle: QUEUE,
    api: {
      routeId: 'get-activity',
      method: 'GET',
      path: '/v1/sandboxes/{id}/activity',
      note: 'Newest first; add ?limit=20 to keep the newest twenty.',
    },
  },
];

export const PRIVACY: TourStep[] = [
  {
    id: 'privacy-lead',
    screen: 'privacy',
    target: 'privacy-lead',
    title: 'Nothing personal, by construction',
    what: 'The bakery never asks for or stores your name, email, address or card. The only free text it accepts is an order note and a catering brief, each checked on write, and every sandbox is deleted at 10:00 UTC.',
    events: [],
    principle: NO_DATA,
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
    what: 'Each row says what is kept, for how long and why. The sandbox’s contents last until the nightly wipe, with a 36-hour backstop for anything it misses.',
    events: ['SandboxWiped'],
    principle: LEASE,
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
    title: 'Wipe now',
    what: 'Wipe now runs the night’s wipe for your sandbox alone, right away. Cloudflare keeps deleted storage restorable for 30 days; the bakery never restores a sandbox.',
    events: ['SandboxWiped'],
    principle: SANDBOX,
    api: {
      routeId: 'wipe-sandbox',
      method: 'DELETE',
      path: '/v1/sandboxes/{id}',
      note: 'Deletes the sandbox and, with it, every token for it. There is no undo.',
    },
  },
];

export const STATUS: TourStep[] = [
  {
    id: 'status-breaker',
    screen: 'status',
    target: 'status-breaker',
    title: 'A breaker that reads the meter',
    what: 'Every 15 minutes a cron job reads the account’s usage for the slot before, prices it and gives the verdict to the Control object. Armed means under every line. Read-only and off are tripped states: they never lower by themselves, and a person resets them. Not configured means the run has no token yet.',
    events: [],
    principle: BREAKER,
    api: {
      routeId: 'status',
      method: 'GET',
      path: '/v1/status',
      note: 'Public and cheap. The breaker field holds its state, since when, the last run, that run’s price in dollars and the meters it could not read.',
    },
  },
];
