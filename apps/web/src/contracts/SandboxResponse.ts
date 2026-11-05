/**
 * Generated from crates/contracts/schemas/SandboxResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * Whose a sandbox is: a guest's, behind Turnstile, or a signed-in account's.
 */
export type SandboxKind = 'guest' | 'account';
/**
 * A sandbox's lifecycle (docs/domain.md, "Sandbox").
 */
export type SandboxState = ('seeding' | 'live' | 'wiped') | 'wiping';

/**
 * `POST /v1/sandboxes` (201 or 200) and `GET /v1/sandboxes/{id}`.
 */
export interface SandboxResponse {
  /**
   * A wall time.
   */
  born: string;
  /**
   * Registered child objects; none in PR 3.
   */
  children: number;
  /**
   * Business time minus wall time, in seconds (docs/architecture.md, "Time travel").
   */
  clock_offset_s: number;
  /**
   * Bumped by every clock advance.
   */
  clock_v: number;
  faults: Faults;
  /**
   * The sandbox's ULID.
   */
  id: string;
  kind: SandboxKind;
  /**
   * The seed the sandbox was generated from. A JSON number: JavaScript reads it exactly only
   * below 2^53, so the router mints seeds in that range.
   */
  seed: number;
  state: SandboxState;
  /**
   * Bumped by every API token rotation.
   */
  token_v: number;
  /**
   * The first 10:00 UTC after `born`, a wall time.
   */
  wipe_at: string;
}
/**
 * The sandbox's fault switches. `inbox` makes the broken-subscriber demo's Inbox fail (PR 4).
 */
export interface Faults {
  inbox: boolean;
}
