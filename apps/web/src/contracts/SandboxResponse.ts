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
   * Registered child objects: the Catalog, the Kitchen and the 12 seeded orders once
   * seeding is done, then one more for each order placed.
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
   * The visitor's customer persona: the seed's first customer's ULID. Orders the visitor
   * places are this customer's.
   */
  persona: string;
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
 * The sandbox's fault switches: the Queue Lab's broken subscriber, live. `kitchen` makes the
 * Kitchen refuse every delivery with 503, so a message retries three times and lands in the
 * dead-letter queue (PR 4); `inbox` does the same to the Inbox when it arrives (PR 8).
 */
export interface Faults {
  inbox: boolean;
  kitchen: boolean;
}
