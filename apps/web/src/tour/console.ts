// The console's first steps: the sandbox itself and the API token panel. The rest of the console's
// tour is in kitchen.ts (the board and the money), crm.ts (catering, customers and campaigns) and
// controls.ts (faults, the clock, traffic, the menu, capacity and the sandbox's own actions).
import type { TourStep } from '../lib/tour';
import { API, SANDBOX } from './principles';

export const CONSOLE: TourStep[] = [
  {
    id: 'console-sandbox',
    screen: 'console',
    target: 'console-sandbox',
    title: 'Your sandbox',
    what: 'This is the private bakery made for you: its id, the seed that made it, when it was born and when it is deleted. Everything below acts on this sandbox only, and the console is just a client of the API: each control calls a route that curl can call too.',
    events: ['SandboxSeeded'],
    principle: SANDBOX,
    api: {
      routeId: 'get-sandbox',
      method: 'GET',
      path: '/v1/sandboxes/{id}',
      note: 'The sandbox’s state (seeding or live), persona, clock offset, faults and wipe time.',
    },
  },
  {
    id: 'console-token',
    screen: 'console',
    target: 'console-token',
    title: 'Your API token',
    what: 'A signed-in sandbox can issue a bearer token and use the API from a terminal. It is shown once, held in this page’s memory only, and lasts 24 hours or until the sandbox is wiped or you rotate it. The curl examples in this tour fill it in for you, masked on screen and whole in the copy.',
    events: ['ApiTokenRotated'],
    principle: API,
    api: {
      routeId: 'get-token',
      method: 'GET',
      path: '/v1/sandboxes/{id}/token',
      note: 'Issue and rotate take the console’s cookie only, because a token never mints its successor. Reading what is known about the token takes a token.',
    },
  },
];
