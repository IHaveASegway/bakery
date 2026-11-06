// The inbox: where every message the bakery would have sent lands.
import type { TourStep } from '../lib/tour';
import { HOW } from './how';
import { CQRS, QUEUE } from './principles';

export const INBOX: TourStep[] = [
  {
    id: 'inbox-list',
    screen: 'inbox',
    target: 'inbox-list',
    title: 'The inbox',
    what: HOW.inbox,
    events: ['MessageDelivered'],
    principle: QUEUE,
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
    what: 'Opening a message reads it from the inbox; nothing is sent. A message’s opened and clicked marks are simulated by the inbox’s alarms, and the CRM counts them for the campaign.',
    events: ['MessageOpened', 'MessageClicked'],
    principle: CQRS,
    api: {
      routeId: 'get-message',
      method: 'GET',
      path: '/v1/sandboxes/{id}/inbox/{mid}',
      note: 'The message with its kind, recipient and body.',
    },
  },
];
