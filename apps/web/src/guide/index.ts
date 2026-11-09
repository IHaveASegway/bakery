// Every screen's entries, in the order a visitor meets them on the page. The console's come from four
// files because it is the largest screen; they are one list. The short paths ("Show me around")
// pick at most five of a screen's entries and say what to do at each.
import type { GuideEntry, PathStep, ScreenId } from '../lib/guide';
import { CATERING } from './catering';
import { CONSOLE } from './console';
import { CONTROLS } from './controls';
import { CRM } from './crm';
import { DISPATCH } from './dispatch';
import { INBOX } from './inbox';
import { KITCHEN } from './kitchen';
import { API_PAGE, CHECKOUT, HOME, MENU, PRIVACY, SIGNIN, STATUS } from './simple';

// The console's entries in the order its sections render (components/Console.tsx), so the recorder
// panel lists them down the page. The entry files group them by topic; this list is the page's
// order. An entry missing from it, or named twice, throws when the module loads.
export const CONSOLE_ORDER = [
  'console-sandbox',
  'console-token',
  'kitchen-board',
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
  console: inPageOrder([...CONSOLE, ...KITCHEN, ...CRM, ...CONTROLS], CONSOLE_ORDER),
  catering: CATERING,
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
 * The short paths: the signature minute strung across the shop and the console, at most five
 * stops a screen. Each waits for the visitor to do its thing (a click inside the entry's element,
 * or a request on one of its triggers), and can be skipped. A screen with none offers no path.
 */
export const PATHS: Partial<Record<ScreenId, PathStep[]>> = {
  signin: [{ entry: 'signin-guest', do: 'Try it as a guest, or sign in.' }],
  menu: [
    { entry: 'menu-list', do: 'Add something to the cart.' },
    { entry: 'menu-cart', do: 'Go to the checkout.' },
  ],
  checkout: [
    { entry: 'checkout-form', do: 'Pick a time and place the order.' },
    { entry: 'checkout-pay', do: 'Pay with Stripe’s test card.' },
    { entry: 'checkout-receipt', do: 'Read the receipt, then open the console.' },
  ],
  console: [
    { entry: 'kitchen-board', do: 'Press a card’s button to move it on.' },
    { entry: 'controls-clock', do: 'Advance the clock.' },
    { entry: 'controls-menu-publish', do: 'Change a price, then publish the menu.' },
    { entry: 'crm-activity', do: 'Find your actions in the feed.' },
  ],
  catering: [
    { entry: 'catering-inquiry', do: 'Send an inquiry.' },
    { entry: 'catering-events', do: 'Open your event.' },
  ],
  dispatch: [
    { entry: 'dispatch-propose', do: 'Ask the server for a plan.' },
    { entry: 'dispatch-plan', do: 'Plan the same stops in your browser.' },
    { entry: 'dispatch-publish', do: 'Publish one of the plans.' },
  ],
  inbox: [{ entry: 'inbox-list', do: 'Open a message.' }],
};
