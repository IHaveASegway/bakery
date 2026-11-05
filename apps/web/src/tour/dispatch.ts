// The dispatch screen: one day's delivery stops, two plans and the one that is published.
import type { TourStep } from '../lib/tour';
import { HOW } from './how';
import { IDEMPOTENCY, ROUTE } from './principles';

const STOPS = ['01JC8Z5R0T2B6Y8C4V1N3K7Q01', '01JC8Z5R0T2B6Y8C4V1N3K7Q02'];

export const DISPATCH: TourStep[] = [
  {
    id: 'dispatch-how',
    screen: 'dispatch',
    target: 'dispatch-root',
    title: 'Two plans, one record',
    what: HOW.dispatch,
    events: ['RouteProposed', 'PlanSubmitted', 'RoutePublished'],
    principle: ROUTE,
    api: {
      routeId: 'get-dispatch',
      method: 'GET',
      path: '/v1/sandboxes/{id}/dispatch/{date}',
      note: 'The day’s stops and plans. A date outside the sandbox’s days is 404 no-such-day.',
    },
  },
  {
    id: 'dispatch-propose',
    screen: 'dispatch',
    target: 'dispatch-propose',
    title: 'The server’s plan',
    what: 'Pick one to four vans and how many units each carries; the server plans the confirmed stops with a savings heuristic and stores the plan.',
    events: ['RouteProposed'],
    principle: ROUTE,
    api: {
      routeId: 'propose-dispatch',
      method: 'POST',
      path: '/v1/sandboxes/{id}/dispatch/{date}/propose',
      body: { vans: 2, capacity: 40 },
      note: 'Signed-in sandboxes only. A refused request is 422 dispatch, naming the rule.',
    },
  },
  {
    id: 'dispatch-plan',
    screen: 'dispatch',
    target: 'dispatch-plan',
    title: 'The browser’s plan',
    what: 'VROOM, compiled to WebAssembly, plans the same stops in your browser. Nothing is solved on the server; the plan is sent to the Dispatch object, which recomputes its minutes from its own matrix and refuses anything that misses a stop, repeats one or overloads a van.',
    events: ['PlanSubmitted'],
    principle: ROUTE,
    api: {
      routeId: 'submit-plan',
      method: 'POST',
      path: '/v1/sandboxes/{id}/dispatch/{date}/plan',
      body: { vans: [{ van: 1, stops: STOPS }] },
      note: 'It carries no minutes. A refused plan is 422 dispatch, such as stop-missing or over-capacity.',
    },
  },
  {
    id: 'dispatch-publish',
    screen: 'dispatch',
    target: 'dispatch-publish',
    title: 'Publishing a plan',
    what: 'Publishing makes one stored plan the record: each stop’s order goes out for delivery. It is checked again against the day’s stops, and a repeat with the same key publishes nothing more.',
    events: ['RoutePublished', 'OrderOutForDelivery'],
    principle: IDEMPOTENCY,
    api: {
      routeId: 'publish-dispatch',
      method: 'POST',
      path: '/v1/sandboxes/{id}/dispatch/{date}/publish',
      body: { plan: 'proposed' },
      note: 'The plan is proposed or submitted. The same Idempotency-Key again replays the first answer.',
    },
  },
  {
    id: 'dispatch-complete',
    screen: 'dispatch',
    target: 'dispatch-complete',
    title: 'Completing a stop',
    what: 'Once a plan is published, staff mark each stop delivered, and the order becomes delivered. Marking a delivered stop again changes nothing.',
    events: ['StopCompleted', 'OrderDelivered'],
    principle: IDEMPOTENCY,
    api: {
      routeId: 'complete-stop',
      method: 'POST',
      path: '/v1/sandboxes/{id}/dispatch/{date}/complete',
      body: { stop: 1 },
      note: 'The stop’s number in the published plan, from 1. Without a published plan: 409 no-plan.',
    },
  },
];
