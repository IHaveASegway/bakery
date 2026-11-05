/*
  Hand-written for now. These shapes follow the PR 3 build spec's JSON exactly (field names,
  nullability). They are replaced by generated types when the schemas land in
  crates/contracts/schemas/: run `pnpm --filter web contracts`, delete this file and drop its line
  from index.ts. Nobody edits it after that.
*/

export type AccountKind = 'guest' | 'google' | 'github' | 'demo';

/** `GET /v1/session` and `POST /v1/auth/demo/signin`. */
export interface SessionResponse {
  kind: AccountKind;
  /** The 64-hex account id; null for a guest. */
  account: string | null;
  /** The ULID of the visitor's live sandbox, if any. */
  sandbox: string | null;
  /** WallTime, UTC, ending in Z. */
  expires_at: string;
}

export interface SandboxFaults {
  inbox: boolean;
}

/** `POST /v1/sandboxes`, `GET /v1/sandboxes/{id}`. */
export interface SandboxResponse {
  id: string;
  kind: 'guest' | 'account';
  state: 'seeding' | 'live' | 'wiping' | 'wiped';
  /** WallTime. */
  born: string;
  /** WallTime: the next 10:00 UTC after `born`. */
  wipe_at: string;
  seed: number;
  clock_offset_s: number;
  clock_v: number;
  token_v: number;
  faults: SandboxFaults;
  children: number;
}

/** `POST /v1/auth/demo`. */
export interface DemoSignupRequest {
  password: string;
  turnstile_token: string;
}

export interface DemoSignupResponse {
  username: string;
}

/** `POST /v1/auth/demo/signin`. */
export interface DemoSigninRequest {
  username: string;
  password: string;
}

/** `POST /v1/sandboxes`. */
export interface CreateSandboxRequest {
  turnstile_token?: string | null;
  replace?: boolean;
}

/** `POST /v1/sandboxes/{id}/faults`. */
export interface FaultRequest {
  fault: 'inbox';
  on: boolean;
}

export interface FaultsResponse {
  faults: SandboxFaults;
}

/** `DELETE /v1/sandboxes/{id}`. */
export interface WipedResponse {
  id: string;
  state: 'wiped';
}
