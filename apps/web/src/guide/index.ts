import type { ReadName } from '../lib/trace';
// Every screen's entries, in the order a visitor meets them on the page. The console's come from four
// files because it is the largest screen; they are one list.
import type { GuideEntry, RouteShape, ScreenId } from '../lib/guide';
import { CATERING } from './catering';
import { CONSOLE } from './console';
import { CONTROLS } from './controls';
import { CRM } from './crm';
import { DISPATCH } from './dispatch';
import { INBOX } from './inbox';
import { KITCHEN } from './kitchen';
import { ORDER } from './order';
import { API_PAGE, CATERING_START, CHECKOUT, HOME, MENU, PRIVACY, SIGNIN, STATUS } from './simple';

export { PATHS } from './paths';

// The console's entries in the order its sections render (components/Console.tsx), so the recorder
// panel lists them down the page. The entry files group them by topic; this list is the page's
// order. An entry missing from it, or named twice, throws when the module loads.
export const CONSOLE_ORDER = [
  'console-sandbox',
  'console-token',
  'kitchen-board',
  'kitchen-rate-limit',
  'kitchen-read-only',
  'kitchen-guest',
  'kitchen-refund',
  'kitchen-bake',
  'kitchen-ledger',
  'controls-traffic-start',
  'controls-traffic-stop',
  'controls-menu-edit',
  'controls-menu-publish',
  'controls-menu-tax',
  'controls-capacity',
  'crm-quote',
  'crm-decline',
  'crm-start-production',
  'crm-delivered',
  'crm-staff-cancel',
  'crm-customers',
  'crm-segments',
  'crm-campaign-draft',
  'crm-campaign-edit',
  'crm-campaign-schedule',
  'crm-campaign-cancel',
  'crm-leads',
  'crm-activity',
  'crm-rebuild',
  'controls-faults',
  'kitchen-dead-letters',
  'controls-clock',
  'controls-wipe',
  'controls-new-sandbox',
];

function inPageOrder(entries: GuideEntry[], order: string[]): GuideEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length || order.length !== entries.length) {
    throw new Error('The console order does not list each entry once.');
  }
  return order.map((id) => {
    const entry = byId.get(id);
    if (entry === undefined) throw new Error(`The console order names an unknown entry: ${id}`);
    return entry;
  });
}

export const ENTRIES: Record<ScreenId, GuideEntry[]> = {
  home: HOME,
  signin: SIGNIN,
  menu: MENU,
  checkout: CHECKOUT,
  order: ORDER,
  console: inPageOrder([...CONSOLE, ...KITCHEN, ...CRM, ...CONTROLS], CONSOLE_ORDER),
  // The gate comes first: a visitor with no sandbox meets it before the inquiry.
  catering: [CATERING_START, ...CATERING],
  inbox: INBOX,
  dispatch: DISPATCH,
  api: API_PAGE,
  privacy: PRIVACY,
  status: STATUS,
};

export const entriesFor = (screen: ScreenId): GuideEntry[] => ENTRIES[screen];

/** Every entry of every screen, in screen order. */
export const ALL_ENTRIES: GuideEntry[] = Object.values(ENTRIES).flat();

/**
 * The writes the page makes that no entry's `api` names (the token panel's own, and the account's
 * sign-in and sign-out), so the recorder can still name their route. Checked against the document
 * in test/guide.test.ts.
 */
export const OTHER_WRITES: RouteShape[] = [
  { routeId: 'issue-token', method: 'POST', path: '/v1/sandboxes/{id}/token' },
  { routeId: 'rotate-token', method: 'POST', path: '/v1/sandboxes/{id}/token/rotate' },
  { routeId: 'demo-signin', method: 'POST', path: '/v1/auth/demo/signin' },
  { routeId: 'signout', method: 'POST', path: '/v1/auth/signout' },
];

/** Every route the guide can name from a request: the entries' and the others. */
export const ROUTE_SHAPES: RouteShape[] = [...ALL_ENTRIES.map((e) => e.api), ...OTHER_WRITES];

/**
 * The route of each story read (lib/trace.ts, STORY_READS): the only reads that open a note, each
 * on the entries that name it in their triggers.
 */
export const STORY_READ_ROUTES: Record<ReadName, string> = { menu: 'get-menu' };
