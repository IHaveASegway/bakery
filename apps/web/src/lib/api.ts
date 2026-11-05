// The storefront's whole contact with the API. The session is a cookie on the API's host, so
// every call sends credentials and no script ever sees a token.
import type {
  CreateSandboxRequest,
  DemoSigninRequest,
  DemoSignupRequest,
  DemoSignupResponse,
  FaultRequest,
  FaultsResponse,
  SandboxResponse,
  SessionResponse,
  WipedResponse,
} from '../contracts';
import { DEFAULT_API_ORIGIN, normalizeOrigin } from '../policy';
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
  /** Seconds from a Retry-After header, when there is one. */
  readonly retryAfter: number | null;

  constructor(problem: ProblemInfo, retryAfter: number | null) {
    super(problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.type = problem.type;
    this.title = problem.title;
    this.detail = problem.detail;
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // A fresh key per call: the API replays the answer to a repeated key, so a retry is a new call.
  if (method === 'POST') headers['Idempotency-Key'] = ulid();

  let response: Response;
  try {
    response = await fetch(`${apiOrigin}${path}`, {
      method,
      credentials: 'include',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new NetworkError();
  }

  if (!response.ok) {
    const retry = Number(response.headers.get('Retry-After'));
    throw new ApiError(
      parseProblem(response.status, await response.text()),
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const sandboxPath = (id: string) => `/v1/sandboxes/${encodeURIComponent(id)}`;

export const getSession = () => request<SessionResponse>('GET', '/v1/session');
export const demoSignup = (req: DemoSignupRequest) =>
  request<DemoSignupResponse>('POST', '/v1/auth/demo', req);
export const demoSignin = (req: DemoSigninRequest) =>
  request<SessionResponse>('POST', '/v1/auth/demo/signin', req);
export const signOut = () => request<void>('POST', '/v1/auth/signout');
export const createSandbox = (req: CreateSandboxRequest) =>
  request<SandboxResponse>('POST', '/v1/sandboxes', req);
export const getSandbox = (id: string) => request<SandboxResponse>('GET', sandboxPath(id));
export const wipeSandbox = (id: string) => request<WipedResponse>('DELETE', sandboxPath(id));
export const setFault = (id: string, req: FaultRequest) =>
  request<FaultsResponse>('POST', `${sandboxPath(id)}/faults`, req);

/** The sign-in links are navigations through the API, not fetches (security.md, "Sign-in"). */
export const signinUrl = (provider: 'google' | 'github') =>
  `${apiOrigin}/v1/auth/${provider}/start?return=/app/`;
