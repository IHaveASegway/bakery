// Every screen's tour, in the order a visitor meets it. The console's steps come from four files
// because it is the largest screen; they are one tour.
import type { ScreenId, TourStep } from '../lib/tour';
import { CATERING } from './catering';
import { CONSOLE } from './console';
import { CONTROLS } from './controls';
import { CRM } from './crm';
import { DISPATCH } from './dispatch';
import { INBOX } from './inbox';
import { KITCHEN } from './kitchen';
import { API_PAGE, CHECKOUT, HOME, MENU, PRIVACY, SIGNIN, STATUS } from './simple';

// The console's steps in the order its sections render (components/Console.tsx), so Next walks
// down the page and never jumps back up. The step files group steps by topic; this list is the
// page's order. A step missing from it, or named twice, throws when the module loads.
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

function inPageOrder(steps: TourStep[], order: string[]): TourStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.size !== steps.length || order.length !== steps.length) {
    throw new Error('The console tour order does not list each step once.');
  }
  return order.map((id) => {
    const step = byId.get(id);
    if (step === undefined) throw new Error(`The console tour order names an unknown step: ${id}`);
    return step;
  });
}

export const TOURS: Record<ScreenId, TourStep[]> = {
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

export const stepsFor = (screen: ScreenId): TourStep[] => TOURS[screen];
