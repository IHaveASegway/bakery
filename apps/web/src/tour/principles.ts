// The principles the tour names (docs/domain.md, "The principle map"; Q33 · Q-principles): a name,
// the lab page's name and the ADR's number. The links arrive in PR 12; until then they are names.
import type { Principle } from '../lib/tour';

const NONE = 'none yet';

export const QUEUE: Principle = {
  name: 'Transactional outbox, idempotent consumer and the dead-letter queue',
  lab: 'Queue Lab',
  adr: '0004',
};
export const CACHE: Principle = {
  name: 'Cache invalidation by version',
  lab: 'Cache Lab',
  adr: '0003',
};
export const BACKFILL: Principle = {
  name: 'Rebuilding derived data from a log',
  lab: 'Backfill Lab',
  adr: '0003',
};
export const ROUTE: Principle = {
  name: 'Vehicle routing, and computing where it is free',
  lab: 'Route Lab',
  adr: '0012',
};
export const RAFT: Principle = {
  name: 'Consensus, and when a single writer needs none',
  lab: 'Raft Lab',
  adr: '0003',
};
export const IDEMPOTENCY: Principle = { name: 'Idempotency keys', lab: NONE, adr: '0004' };
export const PAYMENTS: Principle = {
  name: 'Idempotency keys on payments and webhooks',
  lab: NONE,
  adr: '0007',
};
export const SAGA: Principle = { name: 'Sagas by alarm', lab: NONE, adr: '0004' };
export const LEASE: Principle = { name: 'Leases and TTLs', lab: NONE, adr: '0005' };
export const ADMISSION: Principle = { name: 'Admission control', lab: NONE, adr: '0005' };
export const CQRS: Principle = {
  name: 'CQRS: aggregates write, the CRM reads',
  lab: NONE,
  adr: '0003',
};
export const LOAD: Principle = {
  name: 'Load you can watch: lag between writes and projections',
  lab: NONE,
  adr: '0004',
};
export const CLOCK: Principle = {
  name: 'Time travel with a logical clock',
  lab: NONE,
  adr: '0004',
};
export const SANDBOX: Principle = {
  name: 'A private sandbox per visitor, wiped nightly',
  lab: NONE,
  adr: '0005',
};
export const NO_DATA: Principle = {
  name: 'No personal data, by construction',
  lab: NONE,
  adr: '0005',
};
export const API: Principle = {
  name: 'An API as a first-class client, from one contract',
  lab: NONE,
  adr: '0013',
};
