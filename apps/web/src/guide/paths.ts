// The short paths ("Show me around"), kept apart from the entries so the guide's bar can tell
// whether a screen has one without loading them.
import type { PageId, PathStep } from '../lib/guide';

/**
 * The short paths: the signature minute strung across the shop and the console, at most five
 * stops a screen. Each waits for the visitor to do its thing (a click inside the entry's element,
 * or a request on one of its triggers), and can be skipped. A screen with none offers no path.
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
    { entry: 'kitchen-refund', do: 'Refund an order from a card’s menu.' },
    { entry: 'kitchen-bake', do: 'Read the day’s bake list.' },
  ],
  'console-menu': [
    { entry: 'controls-menu-edit', do: 'Change a price.' },
    { entry: 'controls-menu-publish', do: 'Publish the menu.' },
    { entry: 'controls-menu-tax', do: 'Set the tax rate.' },
    { entry: 'controls-capacity', do: 'Change a slot’s capacity.' },
  ],
  'console-system': [
    { entry: 'console-token', do: 'Issue an API token.' },
    { entry: 'controls-traffic-start', do: 'Start simulated traffic.' },
    { entry: 'controls-faults', do: 'Turn on a fault.' },
    { entry: 'controls-clock', do: 'Advance the clock.' },
  ],
  'console-catering': [
    { entry: 'crm-quote', do: 'Send a quote from an inquiry’s card.' },
    { entry: 'crm-start-production', do: 'Start production once the deposit is paid.' },
    { entry: 'crm-delivered', do: 'Mark the event delivered.' },
  ],
  'console-customers': [
    { entry: 'crm-customers', do: 'Change a customer’s consent.' },
    { entry: 'crm-campaign-draft', do: 'Draft a campaign.' },
    { entry: 'crm-campaign-schedule', do: 'Schedule the campaign.' },
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
