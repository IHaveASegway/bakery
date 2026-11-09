// The principles the guide names (docs/domain.md, "The principle map"; Q33 · Q-principles). Each is
// a section of the How it's built page, read from lib/how-its-built.ts with its links to the lab
// page, the ADR and the section itself, so the guide and the page cannot drift.
import { principle } from '../lib/how-its-built';

export const QUEUE = principle('queue');
export const CACHE = principle('cache');
export const BACKFILL = principle('backfill');
export const ROUTE = principle('routes');
export const RAFT = principle('raft');
export const IDEMPOTENCY = principle('idempotency-keys');
export const PAYMENTS = principle('payment-keys');
export const SAGA = principle('sagas');
export const LEASE = principle('leases');
export const ADMISSION = principle('admission');
export const CQRS = principle('cqrs');
export const LOAD = principle('load');
export const CLOCK = principle('time-travel');
export const SANDBOX = principle('sandbox');
export const NO_DATA = principle('no-personal-data');
export const API = principle('api');
export const BREAKER = principle('breaker');
