// The storefront's whole contact with the API. The session is a cookie on the API's host, so
// every call sends credentials and no script ever sees a token.
import type {
  CapacityRequest,
  ClockRequest,
  ClockResponse,
  CreateSandboxRequest,
  DeadLetter,
  DemoSigninRequest,
  DemoSignupRequest,
  DemoSignupResponse,
  FaultRequest,
  FaultsResponse,
  MenuEditResponse,
  MenuItemPatch,
  MenuResponse,
  LedgerResponse,
  OrderRequest,
  OrderResponse,
  PaymentResponse,
  RefundRequest,
  RefundResponse,
  SandboxResponse,
  ScheduleResponse,
  SessionResponse,
  TrafficResponse,
  WipedResponse,
} from '../contracts';
import { DEFAULT_API_ORIGIN, normalizeOrigin, socketOrigin } from '../policy';
import { parseProblem, problemSlug, type ProblemInfo } from './problem';
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
  options: { body?: unknown; key?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  // A fresh key per call unless the caller names one: the API replays the answer to a repeated
  // key, so a retry of the same intent passes its key again and a new intent never does.
  if (method === 'POST') headers['Idempotency-Key'] = options.key ?? ulid();
  try {
    return await fetch(`${apiOrigin}${path}`, {
      method,
      credentials: 'include',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
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
 * headers the API exposes for the "How this works" line.
 */
export async function getMenu(id: string, etag: string | null = null): Promise<MenuAnswer> {
  const response = await send('GET', `${sandboxPath(id)}/menu`, {
    headers: etag === null ? {} : { 'If-None-Match': etag },
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

/** The sign-in links are navigations through the API, not fetches (security.md, "Sign-in"). */
export const signinUrl = (provider: 'google' | 'github') =>
  `${apiOrigin}/v1/auth/${provider}/start?return=/app/`;

/** Where the kitchen board's socket is: the API's own origin with ws: or wss: (src/policy.ts). */
export const kitchenSocketUrl = (id: string) =>
  `${socketOrigin(apiOrigin)}${sandboxPath(id)}/kitchen/ws`;
