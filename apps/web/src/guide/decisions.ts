// The decision table on How it's built: one row per principle, read from the guide's own entries
// so the table and the notes say the same words. Each principle names the entry whose why and
// when-not speak for it; test/guide.test.ts checks that every principle has one, of its own.
import type { GuideEntry } from '../lib/guide';
import { PRINCIPLE_TABLE } from '../lib/how-its-built';
import { ALL_ENTRIES } from './index';

export const DECISIONS: Record<(typeof PRINCIPLE_TABLE)[number]['id'], string> = {
  queue: 'controls-faults',
  cache: 'controls-menu-publish',
  backfill: 'crm-rebuild',
  routes: 'dispatch-plan',
  raft: 'kitchen-board',
  'idempotency-keys': 'checkout-form',
  'payment-keys': 'checkout-pay',
  sagas: 'crm-quote',
  leases: 'checkout-cancel',
  admission: 'signin-guest',
  cqrs: 'crm-customers',
  load: 'controls-traffic-start',
  'time-travel': 'controls-clock',
  sandbox: 'home-intro',
  'no-personal-data': 'privacy-lead',
  api: 'console-token',
  breaker: 'status-breaker',
};

/** The table's rows, in the page's order of principles. */
export function decisionRows(): GuideEntry[] {
  return PRINCIPLE_TABLE.map((p) => {
    const entry = ALL_ENTRIES.find((e) => e.id === DECISIONS[p.id]);
    if (entry === undefined) throw new Error(`No entry speaks for ${p.id}`);
    return entry;
  });
}
