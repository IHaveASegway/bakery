// The short paths ("Show me around"), kept apart from the entries so the guide's bar can tell
// whether a screen has one without loading them.
import type { PageId, PathStep } from '../lib/guide';

/**
 * The short paths: the signature minute strung across the shop and the console, at most five
 * stops a screen. Each waits for the visitor to do its thing (a click inside the entry's element,
 * or a request on one of its triggers), and can be skipped. A screen with none offers no path.
 * A step marked `signedIn` is a write only a signed-in session may make (a guest gets 403
 * `guest-scope`): a guest is told so and moves past it. Since 2026-11-10 (R72) the board's moves
 * are a guest's too, so the board's step is not marked, and the refund's is.
 */
export const PATHS: Partial<Record<PageId, PathStep[]>> = {
  signin: [{ entry: 'signin-guest', do: 'Try it as a guest, or sign in.' }],
  menu: [
    { entry: 'menu-list', do: 'Add something to the cart.' },
    { entry: 'menu-cart', do: 'Go to the checkout.' },
  ],
  checkout: [
    { entry: 'checkout-form', do: 'Pick a time and place the order.' },
    { entry: 'checkout-pay', do: 'Pay with Stripe’s test card.' },
  ],
  order: [
    { entry: 'order-tracker', do: 'Watch your order move as the kitchen works it.' },
    { entry: 'checkout-receipt', do: 'Read the receipt, then open the console.' },
  ],
  console: [
    { entry: 'kitchen-board', do: 'Press a card’s button to move it on.' },
    { entry: 'kitchen-refund', do: 'Refund an order from a card’s menu.', signedIn: true },
    { entry: 'kitchen-bake', do: 'Read the day’s bake list.' },
  ],
  'console-menu': [
    { entry: 'controls-menu-edit', do: 'Change a price.', signedIn: true },
    { entry: 'controls-menu-publish', do: 'Publish the menu.', signedIn: true },
    { entry: 'controls-menu-tax', do: 'Set the tax rate.', signedIn: true },
    { entry: 'controls-capacity', do: 'Change a slot’s capacity.', signedIn: true },
  ],
  'console-system': [
    { entry: 'console-token', do: 'Issue an API token.', signedIn: true },
    { entry: 'controls-traffic-start', do: 'Start simulated traffic.', signedIn: true },
    { entry: 'controls-faults', do: 'Turn on a fault.', signedIn: true },
    { entry: 'controls-clock', do: 'Advance the clock.', signedIn: true },
  ],
  'console-catering': [
    { entry: 'crm-quote', do: 'Send a quote from an inquiry’s card.', signedIn: true },
    {
      entry: 'crm-start-production',
      do: 'Start production once the deposit is paid.',
      signedIn: true,
    },
    { entry: 'crm-delivered', do: 'Mark the event delivered.', signedIn: true },
  ],
  'console-customers': [
    { entry: 'crm-customers', do: 'Change a customer’s consent; a guest, their own persona’s.' },
    { entry: 'crm-campaign-draft', do: 'Draft a campaign.', signedIn: true },
    { entry: 'crm-campaign-schedule', do: 'Schedule the campaign.', signedIn: true },
  ],
  catering: [
    { entry: 'catering-inquiry', do: 'Send an inquiry.' },
    { entry: 'catering-events', do: 'Open your event.' },
  ],
  dispatch: [
    { entry: 'dispatch-propose', do: 'Ask the server for a plan.', signedIn: true },
    { entry: 'dispatch-plan', do: 'Plan the same stops in your browser.', signedIn: true },
    { entry: 'dispatch-publish', do: 'Publish one of the plans.', signedIn: true },
  ],
  inbox: [{ entry: 'inbox-list', do: 'Open a message.' }],
};
