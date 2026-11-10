// The storefront's whole contact with the API. The session is a cookie on the API's host, so
// every call sends credentials and no script ever sees a token.
import type {
  ActivityResponse,
  CampaignListResponse,
  CampaignRequest,
  CampaignResponse,
  CapacityRequest,
  CateringCancelRequest,
  CateringInquiryRequest,
  CateringListResponse,
  CateringResponse,
  ClockRequest,
  ClockResponse,
  ConsentRequest,
  CompleteStopRequest,
  CreateSandboxRequest,
  CustomerListResponse,
  CustomerResponse,
  DeadLetter,
  DeclineRequest,
  DemoSigninRequest,
  DemoSignupRequest,
  DemoSignupResponse,
  DispatchResponse,
  FaultRequest,
  FaultsResponse,
  InboxResponse,
  LeadPipelineResponse,
  MenuDraftsResponse,
  MenuEditResponse,
  MenuItemPatch,
  MenuResponse,
  TaxRateRequest,
  LedgerResponse,
  MessageKind,
  MessageResponse,
  OrderRequest,
  OrderResponse,
  PaymentResponse,
  PlanRequest,
  ProposeRequest,
  PublishRequest,
  QuoteRequest,
  RebuildResponse,
  RefundRequest,
  RefundResponse,
  SandboxResponse,
  ScheduleRequest,
  ScheduleResponse,
  SegmentListResponse,
  SegmentResponse,
  SessionResponse,
  StatusResponse,
  TimelineResponse,
  TokenInfoResponse,
  TokenResponse,
  TraceResponse,
  TrafficResponse,
  WipedResponse,
} from '../contracts';
import { DEFAULT_API_ORIGIN, normalizeOrigin, socketOrigin } from '../policy';
import { parseProblem, problemSlug, type ProblemInfo } from './problem';
import { causeOf } from './cause';
import { pageSource, type ReadName } from './trace';
import { ulid } from './ulid';

/** The same value src/policy.ts puts in connect-src, so a call the policy blocks cannot happen. */
export const apiOrigin = normalizeOrigin(import.meta.env.PUBLIC_API_ORIGIN || DEFAULT_API_ORIGIN);

/** The API answered with a problem. */
export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string | null;
  /** The next free slot a `slot-full` problem names (RFC 9457 extension member), else null. */
  readonly next_free: string | null;
  /** Seconds from a Retry-After header, when there is one. */
  readonly retryAfter: number | null;

  constructor(problem: ProblemInfo, retryAfter: number | null) {
    super(problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.type = problem.type;
    this.title = problem.title;
    this.detail = problem.detail;
    this.next_free = problem.next_free;
    this.retryAfter = retryAfter;
  }

  get slug(): string {
    return problemSlug(this.type);
  }
}

/** The request never got an answer: offline, DNS, a blocked origin. */
export class NetworkError extends Error {
  constructor() {
    super('The API is unreachable');
    this.name = 'NetworkError';
  }
}

/** Sends one request with the session cookie; a network failure is a NetworkError. */
async function send(
  method: string,
  path: string,
  options: { body?: unknown; key?: string; headers?: Record<string, string>; read?: ReadName } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  // A fresh key per call unless the caller names one: the API replays the answer to a repeated
  // key, so a retry of the same intent passes its key again and a new intent never does. A PATCH
  // or PUT sends a key only when the caller names one (the campaign edit does; PR 8).
  if (method === 'POST' || options.key !== undefined) {
    headers['Idempotency-Key'] = options.key ?? ulid();
  }
  const started = performance.now();
  // The guide's trace (lib/trace.ts) hears every write: its route, status, time and the cause its
  // events carry, never its body. A read is traced only when it is a story read (trace.ts, STORY_READS), with what its
  // answer's headers said; the page's other reads change nothing and are not traced.
  const traced = (response: Response | null) => {
    if (method === 'GET' && options.read === undefined) return;
    const ms = performance.now() - started;
    // The trace's key is what the write's events carry as their `cause`, so the guide ties them
    // to this call: the API names it in `Bakery-Cause` on a command's success (the key, the key
    // with the route's prefix such as `capacity:`, a payment's id, or for a PATCH sent without a
    // key the one the API made). Without that header, the key that was sent, if any.
    const key = causeOf(response) ?? headers['Idempotency-Key'] ?? null;
    const status = response?.status ?? null;
    const read =
      options.read === undefined
        ? {}
        : {
            read: {
              name: options.read,
              cache: response?.headers.get('Bakery-Cache') ?? null,
              etag: response?.headers.get('ETag') ?? null,
              asked: headers['If-None-Match'] ?? null,
            },
          };
    pageSource.emit({ kind: 'call', key, method, path, status, ms, at: Date.now(), ...read });
  };
  try {
    const response = await fetch(`${apiOrigin}${path}`, {
      method,
      credentials: 'include',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    traced(response);
    return response;
  } catch {
    traced(null);
    throw new NetworkError();
  }
}

/** An error response as the ApiError it is. */
async function problemOf(response: Response): Promise<ApiError> {
  const retry = Number(response.headers.get('Retry-After'));
  return new ApiError(
    parseProblem(response.status, await response.text()),
    Number.isFinite(retry) && retry > 0 ? retry : null,
  );
}

async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown; key?: string } = {},
): Promise<T> {
  const response = await send(method, path, options);
  if (!response.ok) throw await problemOf(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const sandboxPath = (id: string) => `/v1/sandboxes/${encodeURIComponent(id)}`;

/** `GET /v1/status`: public, no session needed. The status page reads it (lib/status.ts). */
export const getStatus = () => request<StatusResponse>('GET', '/v1/status');
export const getSession = () => request<SessionResponse>('GET', '/v1/session');
export const demoSignup = (req: DemoSignupRequest) =>
  request<DemoSignupResponse>('POST', '/v1/auth/demo', { body: req });
export const demoSignin = (req: DemoSigninRequest) =>
  request<SessionResponse>('POST', '/v1/auth/demo/signin', { body: req });
export const signOut = () => request<void>('POST', '/v1/auth/signout');
export const createSandbox = (req: CreateSandboxRequest) =>
  request<SandboxResponse>('POST', '/v1/sandboxes', { body: req });
export const getSandbox = (id: string) => request<SandboxResponse>('GET', sandboxPath(id));
export const wipeSandbox = (id: string) => request<WipedResponse>('DELETE', sandboxPath(id));
export const setFault = (id: string, req: FaultRequest) =>
  request<FaultsResponse>('POST', `${sandboxPath(id)}/faults`, { body: req });

/** The live menu, or "not modified" when the ETag the caller holds is still current. */
export type MenuAnswer =
  | { modified: true; menu: MenuResponse; etag: string | null; cache: string | null }
  | { modified: false; etag: string | null; cache: string | null };

/**
 * `GET /v1/sandboxes/{id}/menu`. With the ETag of the copy in hand it sends `If-None-Match` and a
 * 304 comes back as `modified: false`. `Bakery-Cache` (`hit` or `miss`) and `ETag` are the two
 * headers the API exposes; the guide's menu note shows them (a story read, lib/trace.ts).
 */
export async function getMenu(id: string, etag: string | null = null): Promise<MenuAnswer> {
  const response = await send('GET', `${sandboxPath(id)}/menu`, {
    headers: etag === null ? {} : { 'If-None-Match': etag },
    read: 'menu',
  });
  const seen = {
    etag: response.headers.get('ETag'),
    cache: response.headers.get('Bakery-Cache'),
  };
  if (response.status === 304) return { modified: false, ...seen };
  if (!response.ok) throw await problemOf(response);
  return { modified: true, menu: (await response.json()) as MenuResponse, ...seen };
}

/**
 * `POST /v1/sandboxes/{id}/orders`. The caller owns the idempotency key: the same key for a retry
 * of the same attempt, a new one for a new attempt (see lib/attempt.ts).
 */
export const placeOrder = (id: string, req: OrderRequest, key: string) =>
  request<OrderResponse>('POST', `${sandboxPath(id)}/orders`, { body: req, key });

export const getOrder = (id: string, orderId: string) =>
  request<OrderResponse>('GET', `${sandboxPath(id)}/orders/${encodeURIComponent(orderId)}`);

/**
 * `POST .../orders/{oid}/payment`: the PaymentIntent's client secret for the Payment Element. The
 * order's own id is the idempotency key, so a remount or a retry gets the same intent back.
 */
export const createPayment = (id: string, orderId: string) =>
  request<PaymentResponse>(
    'POST',
    `${sandboxPath(id)}/orders/${encodeURIComponent(orderId)}/payment`,
    {
      key: orderId,
    },
  );

/** The sandbox with the synthetic persona the Element's billing details come from. */
export const getSandboxPersona = (id: string) => request<SandboxResponse>('GET', sandboxPath(id));

/** `POST .../orders/{oid}/refund`, staff only. A fresh key per click: each click is its own intent. */
export const refundOrder = (id: string, orderId: string, req: RefundRequest) =>
  request<RefundResponse>(
    'POST',
    `${sandboxPath(id)}/orders/${encodeURIComponent(orderId)}/refund`,
    {
      body: req,
    },
  );

export const getLedger = (id: string) =>
  request<LedgerResponse>('GET', `${sandboxPath(id)}/billing/ledger`);

export const heartbeat = (id: string) => request<void>('POST', `${sandboxPath(id)}/heartbeat`);

export const getTraffic = (id: string) =>
  request<TrafficResponse>('GET', `${sandboxPath(id)}/traffic`);
export const startTraffic = (id: string, rate: number) =>
  request<TrafficResponse>('POST', `${sandboxPath(id)}/traffic`, { body: { rate } });
export const stopTraffic = (id: string) =>
  request<TrafficResponse>('DELETE', `${sandboxPath(id)}/traffic`);

export const patchMenuItem = (id: string, slug: string, patch: MenuItemPatch) =>
  request<MenuEditResponse>('PATCH', `${sandboxPath(id)}/menu/items/${encodeURIComponent(slug)}`, {
    body: patch,
  });
export const publishMenu = (id: string) =>
  request<MenuEditResponse>('POST', `${sandboxPath(id)}/menu/publish`);
/** `PATCH /v1/sandboxes/{id}/menu/tax-rate`: the rate in basis points, published at once. */
export const setTaxRate = (id: string, taxBp: number) =>
  request<MenuEditResponse>('PATCH', `${sandboxPath(id)}/menu/tax-rate`, {
    body: { tax_bp: taxBp } satisfies TaxRateRequest,
  });
/** `GET /v1/sandboxes/{id}/menu/drafts`: the draft copy of every item waiting for Publish. */
export const getMenuDrafts = (id: string) =>
  request<MenuDraftsResponse>('GET', `${sandboxPath(id)}/menu/drafts`);

export const getDeadLetters = async (id: string): Promise<DeadLetter[]> => {
  const list = await request<unknown>('GET', `${sandboxPath(id)}/dead-letters`);
  return Array.isArray(list) ? (list as DeadLetter[]) : [];
};
export const redrive = (id: string, eventId: string) =>
  request<unknown>(
    'POST',
    `${sandboxPath(id)}/dead-letters/${encodeURIComponent(eventId)}/redrive`,
  );

/**
 * Moves the sandbox's business clock forward; the offset only ever grows. Give a named step
 * (`{ step: '1d' }`) or, as before, a plain count of minutes. The caller may own the
 * idempotency key (one per click, see lib/clock.ts); without one the call mints its own.
 */
export const advanceClock = (id: string, advance: ClockRequest | number, key?: string) =>
  request<ClockResponse>('POST', `${sandboxPath(id)}/clock`, {
    body: typeof advance === 'number' ? { minutes: advance } : advance,
    ...(key === undefined ? {} : { key }),
  });

/** One bakery day's places, caps and bake list (`date` is `YYYY-MM-DD`). */
export const getSchedule = (id: string, date: string) =>
  request<ScheduleResponse>('GET', `${sandboxPath(id)}/schedule/${encodeURIComponent(date)}`);

/** Staff set one capacity for a day; the answer is the day's schedule. Signed-in sessions only. */
export const setCapacity = (id: string, date: string, req: CapacityRequest) =>
  request<ScheduleResponse>(
    'PATCH',
    `${sandboxPath(id)}/schedule/${encodeURIComponent(date)}/capacity`,
    { body: req },
  );

const cateringPath = (id: string, cid?: string) =>
  `${sandboxPath(id)}/catering${cid === undefined ? '' : `/${encodeURIComponent(cid)}`}`;

/**
 * `POST /v1/sandboxes/{id}/catering`: a catering inquiry, from any session of the sandbox. The
 * caller owns the idempotency key, as with an order (see lib/attempt.ts). 201, or 200 with
 * `Idempotent-Replayed` for a repeated key; a refused inquiry is a 422 `catering` naming the rule.
 */
export const submitInquiry = (id: string, req: CateringInquiryRequest, key: string) =>
  request<CateringResponse>('POST', cateringPath(id), { body: req, key });

/** `GET .../catering`: the sandbox's catering events, newest first. */
export const listCatering = (id: string) => request<CateringListResponse>('GET', cateringPath(id));

/** `GET .../catering/{cid}`. */
export const getCatering = (id: string, cid: string) =>
  request<CateringResponse>('GET', cateringPath(id, cid));

/** `POST .../catering/{cid}/accept`: accept the quote, which holds one of the day's two places. */
export const acceptQuote = (id: string, cid: string) =>
  request<CateringResponse>('POST', `${cateringPath(id, cid)}/accept`);

/**
 * `POST .../catering/{cid}/deposit`: the deposit's PaymentIntent for the Payment Element, exactly
 * as an order's `/payment`. The catering id is the idempotency key, so a remount or a retry gets
 * the same intent back.
 */
export const createDeposit = (id: string, cid: string) =>
  request<PaymentResponse>('POST', `${cateringPath(id, cid)}/deposit`, { key: cid });

/**
 * `POST .../catering/{cid}/pay-balance`: pays the balance invoice with Stripe's test card; 202.
 * The catering id is the key. The page then asks `getCatering` until the event is `paid`/`closed`.
 */
export const payBalance = (id: string, cid: string) =>
  request<CateringResponse>('POST', `${cateringPath(id, cid)}/pay-balance`, { key: cid });

/** `POST .../catering/{cid}/cancel`: the customer cancels; the Worker derives `by: customer`. */
export const cancelCatering = (id: string, cid: string, req: CateringCancelRequest) =>
  request<CateringResponse>('POST', `${cateringPath(id, cid)}/cancel`, { body: req });

/** Staff: `POST .../catering/{cid}/quote`. Without `total_cents` the API prices it. */
export const sendQuote = (id: string, cid: string, req: QuoteRequest) =>
  request<CateringResponse>('POST', `${cateringPath(id, cid)}/quote`, { body: req });

/** Staff: `POST .../catering/{cid}/decline`. */
export const declineInquiry = (id: string, cid: string, req: DeclineRequest) =>
  request<CateringResponse>('POST', `${cateringPath(id, cid)}/decline`, { body: req });

/** Staff: `POST .../catering/{cid}/start-production`. */
export const startCateringProduction = (id: string, cid: string) =>
  request<CateringResponse>('POST', `${cateringPath(id, cid)}/start-production`);

/** Staff: `POST .../catering/{cid}/delivered`; the invoice is raised afterwards, from the Queue. */
export const markCateringDelivered = (id: string, cid: string) =>
  request<CateringResponse>('POST', `${cateringPath(id, cid)}/delivered`);

/** Staff: `POST .../catering/{cid}/staff-cancel`; the Worker derives `by: staff`. */
export const staffCancelCatering = (id: string, cid: string, req: CateringCancelRequest) =>
  request<CateringResponse>('POST', `${cateringPath(id, cid)}/staff-cancel`, { body: req });

// ---- PR 8: customers, segments, campaigns, the inbox, leads, activity and the rebuild ----
// Every route is under /v1/sandboxes/{id}. Each write takes the idempotency key as its last
// argument; leave it out and the call mints one, which is right for a click that is never retried
// (lib/crm.ts, KeyedAction, keeps a key across a retry of the same intent).

const customerPath = (id: string, cid?: string) =>
  `${sandboxPath(id)}/customers${cid === undefined ? '' : `/${encodeURIComponent(cid)}`}`;
const campaignPath = (id: string, cid?: string) =>
  `${sandboxPath(id)}/campaigns${cid === undefined ? '' : `/${encodeURIComponent(cid)}`}`;

/** `GET .../customers`: the sandbox's synthetic customers. */
export const listCustomers = (id: string) => request<CustomerListResponse>('GET', customerPath(id));

/** `GET .../customers/{cid}`; 404 for an unknown customer. */
export const getCustomer = (id: string, cid: string) =>
  request<CustomerResponse>('GET', customerPath(id, cid));

/** `GET .../customers/{cid}/timeline`. */
export const getTimeline = (id: string, cid: string) =>
  request<TimelineResponse>('GET', `${customerPath(id, cid)}/timeline`);

/** `POST .../customers/{cid}/consent`: the visitor's own persona or staff; answers the customer. */
export const setConsent = (id: string, cid: string, req: ConsentRequest, key?: string) =>
  request<CustomerResponse>('POST', `${customerPath(id, cid)}/consent`, {
    body: req,
    ...(key === undefined ? {} : { key }),
  });

/** `GET .../segments`: the five segments with their member counts and a sample. */
export const listSegments = (id: string) =>
  request<SegmentListResponse>('GET', `${sandboxPath(id)}/segments`);

/** `GET .../segments/{segment}`; 404 for an unknown segment. */
export const getSegment = (id: string, segment: string) =>
  request<SegmentResponse>('GET', `${sandboxPath(id)}/segments/${encodeURIComponent(segment)}`);

/** Staff: `GET .../campaigns`. */
export const listCampaigns = (id: string) => request<CampaignListResponse>('GET', campaignPath(id));

/** Staff: `POST .../campaigns`, a draft from the templates; 201 with a `Location`. */
export const createCampaign = (id: string, req: CampaignRequest, key?: string) =>
  request<CampaignResponse>('POST', campaignPath(id), {
    body: req,
    ...(key === undefined ? {} : { key }),
  });

/** `GET .../campaigns/{cid}`. */
export const getCampaign = (id: string, cid: string) =>
  request<CampaignResponse>('GET', campaignPath(id, cid));

/** Staff: `PATCH .../campaigns/{cid}`, a draft only (else 409 `campaign`, `out-of-order`). */
export const editCampaign = (id: string, cid: string, req: CampaignRequest, key: string) =>
  request<CampaignResponse>('PATCH', campaignPath(id, cid), { body: req, key });

/** Staff: `POST .../campaigns/{cid}/schedule`; 422 `campaign`, `schedule-too-soon`, with the time. */
export const scheduleCampaign = (id: string, cid: string, req: ScheduleRequest, key?: string) =>
  request<CampaignResponse>('POST', `${campaignPath(id, cid)}/schedule`, {
    body: req,
    ...(key === undefined ? {} : { key }),
  });

/** Staff: `POST .../campaigns/{cid}/cancel`: a scheduled one returns to draft, a draft is cancelled. */
export const cancelCampaign = (id: string, cid: string, key?: string) =>
  request<CampaignResponse>('POST', `${campaignPath(id, cid)}/cancel`, {
    ...(key === undefined ? {} : { key }),
  });

/** What the inbox list can be narrowed by: a kind, a recipient, and how many (the API's default is 50). */
export interface InboxFilter {
  kind?: MessageKind | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

/** `GET .../inbox`, newest first; the filter becomes `?kind=`, `?to=` and `?limit=`. */
export const listInbox = (id: string, filter: InboxFilter = {}) => {
  const query = new URLSearchParams();
  if (filter.kind) query.set('kind', filter.kind);
  if (filter.to) query.set('to', filter.to);
  if (filter.limit !== undefined) query.set('limit', String(filter.limit));
  const text = query.toString();
  return request<InboxResponse>('GET', `${sandboxPath(id)}/inbox${text === '' ? '' : `?${text}`}`);
};

/** `GET .../inbox/{mid}`. */
export const getMessage = (id: string, mid: string) =>
  request<MessageResponse>('GET', `${sandboxPath(id)}/inbox/${encodeURIComponent(mid)}`);

/** `GET .../leads`: the catering lead pipeline by stage. */
export const getLeads = (id: string) =>
  request<LeadPipelineResponse>('GET', `${sandboxPath(id)}/leads`);

/** `GET .../activity`, newest first; `limit` becomes `?limit=`. */
export const getActivity = (id: string, limit?: number) =>
  request<ActivityResponse>(
    'GET',
    `${sandboxPath(id)}/activity${limit === undefined ? '' : `?limit=${limit}`}`,
  );

/** Staff: `POST .../rebuild`; 202, or 409 `rebuild` while one runs. */
export const startRebuild = (id: string, key?: string) =>
  request<RebuildResponse>('POST', `${sandboxPath(id)}/rebuild`, {
    ...(key === undefined ? {} : { key }),
  });

/** `GET .../rebuild`: the cursor; ask every second while `rebuilding`. */
export const getRebuild = (id: string) =>
  request<RebuildResponse>('GET', `${sandboxPath(id)}/rebuild`);

// ---- PR 9: dispatch ----
// Every route is under /v1/sandboxes/{id}/dispatch/{date} (`date` is `YYYY-MM-DD`, a bakery day). A
// guest reads; the four writes are signed-in only (403 `guest-scope`). Each write answers the day's
// DispatchResponse, and takes the idempotency key as its last argument: leave it out and the call
// mints one, which is right for a click that is never retried (lib/crm.ts, KeyedAction, keeps a key
// across a retry of the same intent, which is what a publish needs).

const dispatchPath = (id: string, date: string) =>
  `${sandboxPath(id)}/dispatch/${encodeURIComponent(date)}`;

/** `GET .../dispatch/{date}`: the day's stops and plans; 404 `no-such-day` outside the sandbox's days. */
export const getDispatch = (id: string, date: string) =>
  request<DispatchResponse>('GET', dispatchPath(id, date));

/** Staff: `POST .../propose`, the server's savings plan for the confirmed stops; 422 `dispatch`. */
export const proposeDispatch = (id: string, date: string, req: ProposeRequest, key?: string) =>
  request<DispatchResponse>('POST', `${dispatchPath(id, date)}/propose`, {
    body: req,
    ...(key === undefined ? {} : { key }),
  });

/** Staff: `POST .../plan`, the browser's plan; the answer carries `submitted` and `comparison`. */
export const submitPlan = (id: string, date: string, req: PlanRequest, key?: string) =>
  request<DispatchResponse>('POST', `${dispatchPath(id, date)}/plan`, {
    body: req,
    ...(key === undefined ? {} : { key }),
  });

/** Staff: `POST .../publish`; a repeated key replays the first answer (`Idempotent-Replayed`). */
export const publishDispatch = (id: string, date: string, req: PublishRequest, key?: string) =>
  request<DispatchResponse>('POST', `${dispatchPath(id, date)}/publish`, {
    body: req,
    ...(key === undefined ? {} : { key }),
  });

/** Staff: `POST .../complete`, one stop of the published plan is delivered; 409 `no-plan`. */
export const completeStop = (id: string, date: string, req: CompleteStopRequest, key?: string) =>
  request<DispatchResponse>('POST', `${dispatchPath(id, date)}/complete`, {
    body: req,
    ...(key === undefined ? {} : { key }),
  });

// ---- PR 10: the sandbox's API token ----
// Signed-in sessions only (a guest gets 403 `guest-scope`), and the cookie only: a token never mints
// its successor. The token comes back once, in the answer to issue or rotate; the caller keeps it in
// memory (lib/token-store.ts) and nowhere else.

/** `GET .../token`: the token's version, its times and its masked form, never the token. */
export const getTokenInfo = (id: string) =>
  request<TokenInfoResponse>('GET', `${sandboxPath(id)}/token`);

/** `POST .../token`: a token for this sandbox, shown once. Leave the key out for a new click. */
export const issueToken = (id: string, key?: string) =>
  request<TokenResponse>('POST', `${sandboxPath(id)}/token`, key === undefined ? {} : { key });

/** `POST .../token/rotate`: a new token, and the old one stops at once. */
export const rotateToken = (id: string, key?: string) =>
  request<TokenResponse>(
    'POST',
    `${sandboxPath(id)}/token/rotate`,
    key === undefined ? {} : { key },
  );

/** The sign-in links are navigations through the API, not fetches (security.md, "Sign-in"). */
/**
 * Where "Continue with Google" and "Continue with GitHub" go. The API sends the visitor back to
 * the return path, which may be any lower-case path and never a query (crates/app/src/auth/oauth.rs,
 * `return_path`), so the way in has a landing of its own, /app/start/, which makes the account its
 * sandbox when it has no live one; /app/ itself never does (the audit of 2026-11-10).
 */
export const SIGNIN_RETURN = '/app/start/';
export const signinUrl = (provider: 'google' | 'github') =>
  `${apiOrigin}/v1/auth/${provider}/start?return=${SIGNIN_RETURN}`;

/** Where the kitchen board's socket is: the API's own origin with ws: or wss: (src/policy.ts). */
/**
 * `GET /v1/sandboxes/{id}/trace?after=<cursor>`: the flight recorder's hops after a cursor (ADR
 * 0015). Untraced, like every read that is not a story read. Its route spends no rate limit
 * (`Limit::None` in workers/api/src/http/routes.rs); each read is one Worker request and one
 * Recorder request, so the guide keeps its own use bounded (lib/recorder.ts).
 */
export const getTrace = (id: string, after: number) =>
  request<TraceResponse>('GET', `${sandboxPath(id)}/trace?after=${after}`);

/** The recorder's socket: the cookie only, the exact Origin, the session's upgrade limit. */
export const traceSocketUrl = (id: string) =>
  `${socketOrigin(apiOrigin)}${sandboxPath(id)}/trace/ws`;

export const kitchenSocketUrl = (id: string) =>
  `${socketOrigin(apiOrigin)}${sandboxPath(id)}/kitchen/ws`;
