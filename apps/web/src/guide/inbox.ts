// The inbox: where every message the bakery would have sent lands.
import type { GuideEntry } from '../lib/guide';
import { CQRS, QUEUE } from './principles';

export const INBOX: GuideEntry[] = [
  {
    id: 'inbox-list',
    screen: 'inbox',
    target: 'inbox-list',
    title: 'The inbox',
    what: 'Every message the bakery sends lands here, because it holds no email address for anyone. Opens and clicks are simulated by the inbox’s own alarms.',
    why: 'Messages are sent by consumers of events, so a slow inbox never slows an order.',
    whenNot: 'Not a real mail system: nothing leaves the bakery.',
    events: ['MessageDelivered'],
    principle: QUEUE,
    triggers: [],
    facts: [
      'A message is addressed to a customer, and the name shown is that persona’s made-up display name.',
      'Opens and clicks are simulated by the inbox’s own alarms from the seed: a little under half are opened, and a third of those clicked. Nobody opens anything, and this page never makes one happen.',
    ],
    api: {
      routeId: 'list-inbox',
      method: 'GET',
      path: '/v1/sandboxes/{id}/inbox',
      note: 'Newest first. Narrow it with ?kind=, ?to= and ?limit= (the default is 50).',
    },
  },
  {
    id: 'inbox-message',
    screen: 'inbox',
    target: 'inbox-message',
    title: 'One message',
    what: 'Opening a message reads it; nothing is sent. Its opened and clicked marks are simulated, and the CRM counts them for the campaign.',
    why: 'The campaign’s figures are a projection of the inbox’s events, so counting is not the inbox’s job.',
    whenNot: 'Not a measure of real people: the opens are drawn from the seed.',
    events: ['MessageOpened', 'MessageClicked'],
    principle: CQRS,
    triggers: [],
    api: {
      routeId: 'get-message',
      method: 'GET',
      path: '/v1/sandboxes/{id}/inbox/{mid}',
      note: 'The message with its kind, recipient and body.',
    },
  },
];
