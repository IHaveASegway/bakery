// The console's first entries: the sandbox itself and the API token panel. The rest of the console's
// entries are in kitchen.ts (the board and the money), crm.ts (catering, customers and campaigns)
// and controls.ts (faults, the clock, traffic, the menu, capacity and the sandbox's own actions).
import type { GuideEntry } from '../lib/guide';
import { API, SANDBOX } from './principles';

export const CONSOLE: GuideEntry[] = [
  {
    id: 'console-sandbox',
    screen: 'console',
    target: 'console-sandbox',
    title: 'Your sandbox',
    what: 'The private bakery made for you: its id, its seed, when it was born and when it is deleted. Every control here acts on this sandbox only.',
    why: 'Every object’s name carries the sandbox’s id, so nothing here can reach another visitor’s data.',
    whenNot: 'Not for data meant to outlive the visit: a sandbox is deleted at 10:00 UTC.',
    events: ['SandboxSeeded'],
    principle: SANDBOX,
    triggers: [],
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
    what: 'A signed-in sandbox can issue a bearer token for a terminal. It is shown once, held in this page’s memory, and lasts 24 hours.',
    why: 'The console is just another client of the public API, so a token gives a terminal exactly the console’s reach.',
    whenNot:
      'Not for a guest, and never in a URL: a guest gets no token, and a token goes in the Authorization header only.',
    events: ['ApiTokenRotated'],
    principle: API,
    triggers: ['issue-token', 'rotate-token', 'ApiTokenRotated'],
    api: {
      routeId: 'get-token',
      method: 'GET',
      path: '/v1/sandboxes/{id}/token',
      note: 'Issue and rotate take the console’s cookie only, because a token never mints its successor. Reading what is known about the token takes a token.',
    },
  },
];
