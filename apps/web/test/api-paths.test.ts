// The console's request helpers (src/lib/api.ts) against the OpenAPI document that
// crates/contracts generates. tour.test.ts compares the tour's steps with the document; this
// compares the other hand-written list of routes, the one the console really sends.
//
// How the paths are found: every exported helper is called against a recording `fetch`, and the
// method and URL it sent are read back. That is robust to how a helper builds its path (a
// literal, `sandboxPath(id)`, `cateringPath(id, cid)`, a query string), where reading api.ts as
// text would have to follow each of those. A helper added without a row in CALLS fails the
// "every exported helper is exercised" test, so the list cannot fall behind. The two helpers that
// return a URL for a navigation or a socket (signinUrl, kitchenSocketUrl, traceSocketUrl) are read
// the same way.
//
// Ids and other parameters are fed in as one marker that needs URL-encoding, so the test also
// proves each id goes through encodeURIComponent. A path segment equal to the encoded marker
// becomes `{}`, and so does every `{name}` of the document: names are not compared, shapes are.
// Offline and deterministic: no network, no clock.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as api from '../src/lib/api';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const doc = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/docs/api/openapi.json', import.meta.url)), 'utf8'),
) as { paths: Record<string, Record<string, unknown>> };

/** "METHOD /v1/a/{}/b": the document's operations with every parameter shown as `{}`. */
const documented = new Set<string>();
for (const [path, item] of Object.entries(doc.paths)) {
  for (const method of Object.keys(item)) {
    if (METHODS.includes(method)) {
      documented.add(`${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, '{}')}`);
    }
  }
}

// One synthetic value for every id, slug and date; the space and the slash need encoding.
const X = 'a b/c';
const ENCODED = encodeURIComponent(X);
const B = {} as never; // a request body: its shape is the contracts' business, not this test's

/** Every helper that sends a request, called once with marker arguments. */
const CALLS: Record<string, () => Promise<unknown>> = {
  getStatus: () => api.getStatus(),
  getSession: () => api.getSession(),
  demoSignup: () => api.demoSignup(B),
  demoSignin: () => api.demoSignin(B),
  signOut: () => api.signOut(),
  createSandbox: () => api.createSandbox(B),
  getSandbox: () => api.getSandbox(X),
  wipeSandbox: () => api.wipeSandbox(X),
  setFault: () => api.setFault(X, B),
  getMenu: () => api.getMenu(X),
  getTrace: () => api.getTrace(X, 0),
  placeOrder: () => api.placeOrder(X, B, 'k'),
  getOrder: () => api.getOrder(X, X),
  createPayment: () => api.createPayment(X, X),
  getSandboxPersona: () => api.getSandboxPersona(X),
  refundOrder: () => api.refundOrder(X, X, B),
  getLedger: () => api.getLedger(X),
  heartbeat: () => api.heartbeat(X),
  getTraffic: () => api.getTraffic(X),
  startTraffic: () => api.startTraffic(X, 1),
  stopTraffic: () => api.stopTraffic(X),
  patchMenuItem: () => api.patchMenuItem(X, X, B),
  publishMenu: () => api.publishMenu(X),
  getMenuDrafts: () => api.getMenuDrafts(X),
  setTaxRate: () => api.setTaxRate(X, 850),
  getDeadLetters: () => api.getDeadLetters(X),
  redrive: () => api.redrive(X, X),
  advanceClock: () => api.advanceClock(X, 5),
  getSchedule: () => api.getSchedule(X, X),
  setCapacity: () => api.setCapacity(X, X, B),
  submitInquiry: () => api.submitInquiry(X, B, 'k'),
  listCatering: () => api.listCatering(X),
  getCatering: () => api.getCatering(X, X),
  acceptQuote: () => api.acceptQuote(X, X),
  createDeposit: () => api.createDeposit(X, X),
  payBalance: () => api.payBalance(X, X),
  cancelCatering: () => api.cancelCatering(X, X, B),
  sendQuote: () => api.sendQuote(X, X, B),
  declineInquiry: () => api.declineInquiry(X, X, B),
  startCateringProduction: () => api.startCateringProduction(X, X),
  markCateringDelivered: () => api.markCateringDelivered(X, X),
  staffCancelCatering: () => api.staffCancelCatering(X, X, B),
  listCustomers: () => api.listCustomers(X),
  getCustomer: () => api.getCustomer(X, X),
  getTimeline: () => api.getTimeline(X, X),
  setConsent: () => api.setConsent(X, X, B),
  listSegments: () => api.listSegments(X),
  getSegment: () => api.getSegment(X, X),
  listCampaigns: () => api.listCampaigns(X),
  createCampaign: () => api.createCampaign(X, B),
  getCampaign: () => api.getCampaign(X, X),
  editCampaign: () => api.editCampaign(X, X, B, 'k'),
  scheduleCampaign: () => api.scheduleCampaign(X, X, B),
  cancelCampaign: () => api.cancelCampaign(X, X),
  listInbox: () =>
    api.listInbox(X, { kind: 'order_confirmation' as never, to: 'a@b.test', limit: 5 }),
  getMessage: () => api.getMessage(X, X),
  getLeads: () => api.getLeads(X),
  getActivity: () => api.getActivity(X, 5),
  startRebuild: () => api.startRebuild(X),
  getRebuild: () => api.getRebuild(X),
  getDispatch: () => api.getDispatch(X, X),
  proposeDispatch: () => api.proposeDispatch(X, X, B),
  submitPlan: () => api.submitPlan(X, X, B),
  publishDispatch: () => api.publishDispatch(X, X, B),
  completeStop: () => api.completeStop(X, X, B),
  getTokenInfo: () => api.getTokenInfo(X),
  issueToken: () => api.issueToken(X),
  rotateToken: () => api.rotateToken(X),
};

/** Exports that are not request helpers: the origin, the two error classes, the two URL builders. */
const NOT_REQUESTS = [
  'apiOrigin',
  'ApiError',
  'NetworkError',
  'signinUrl',
  'kitchenSocketUrl',
  'traceSocketUrl',
];

interface Sent {
  method: string;
  url: string;
}

/** The console's operations, shaped as the document's are: `METHOD /v1/path/{}`. */
function shape(method: string, url: string): string {
  expect(url.startsWith(api.apiOrigin), `${url} is not under the API origin`).toBe(true);
  const path = new URL(url).pathname;
  const segments = path.split('/').map((s) => (s === ENCODED ? '{}' : s));
  return `${method} ${segments.join('/')}`;
}

const calls = new Map<string, string>(); // helper name -> "METHOD /v1/path/{}"
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      sent.push({ url, method: init.method ?? 'GET' });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('the console calls only operations the OpenAPI document has', () => {
  test('every exported helper is exercised here, so a new one cannot slip past', () => {
    const exported = Object.keys(api).filter((name) => !NOT_REQUESTS.includes(name));
    expect(Object.keys(CALLS).sort()).toEqual(exported.sort());
  });

  test.each(Object.keys(CALLS))('%s sends one documented operation', async (name) => {
    await CALLS[name]!();
    expect(sent, `${name} should send exactly one request`).toHaveLength(1);
    const operation = shape(sent[0]!.method, sent[0]!.url);
    calls.set(name, operation);
    // No parameter was sent literally, and the path carries no marker that was not encoded.
    expect(operation, name).not.toContain(X);
    expect(documented.has(operation), `${name} sends ${operation}, which the document lacks`).toBe(
      true,
    );
  });

  test.each([
    ['signinUrl google', api.signinUrl('google')],
    ['signinUrl github', api.signinUrl('github')],
    ['kitchenSocketUrl', api.kitchenSocketUrl(X).replace(/^ws(s?):/, 'http$1:')],
    ['traceSocketUrl', api.traceSocketUrl(X).replace(/^ws(s?):/, 'http$1:')],
  ])('%s is a documented GET', (name, url) => {
    // A navigation and a socket upgrade are both GETs.
    const operation = shape('GET', url);
    calls.set(name, operation);
    expect(documented.has(operation), `${name} is ${operation}, which the document lacks`).toBe(
      true,
    );
  });

  test('the document may have operations the console never calls; they are listed here', () => {
    // Not an assertion about the document: the gap is shown so it is seen, not hidden.
    const used = new Set(calls.values());
    const unused = [...documented].filter((op) => !used.has(op)).sort();
    console.info(
      `The console calls ${used.size} of the document's ${documented.size} operations. ` +
        `Never called (${unused.length}):\n  ${unused.join('\n  ')}`,
    );
    expect(used.size).toBeGreaterThan(0);
    expect([...used].every((op) => documented.has(op))).toBe(true);
  });
});
