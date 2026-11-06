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

export const TOURS: Record<ScreenId, TourStep[]> = {
  home: HOME,
  signin: SIGNIN,
  menu: MENU,
  checkout: CHECKOUT,
  console: [...CONSOLE, ...KITCHEN, ...CRM, ...CONTROLS],
  catering: CATERING,
  inbox: INBOX,
  dispatch: DISPATCH,
  api: API_PAGE,
  privacy: PRIVACY,
  status: STATUS,
};

export const stepsFor = (screen: ScreenId): TourStep[] => TOURS[screen];
