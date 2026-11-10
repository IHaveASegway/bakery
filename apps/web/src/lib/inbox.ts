// What the inbox page knows without asking: the kinds of message and their labels, the filter as
// the query the API takes, the recipient's display name, and the sentence for a message's opens
// and clicks. The system holds no email address: a message is addressed to a customer id, and the
// name shown is the persona's synthetic display name from the customers list. Opens and clicks
// are simulated by the Inbox's alarms from the seed; the page shows them as they appear and
// never makes one (docs/architecture.md, "A campaign send").
import type { CustomerResponse, MessageKind, MessageResponse } from '../contracts';
import type { InboxFilter } from './api';
import { momentText } from './when';

/** Every kind of message the Inbox holds, in the order the filter lists them. */
export const MESSAGE_KINDS: { kind: MessageKind; label: string }[] = [
  { kind: 'receipt', label: 'Receipt' },
  { kind: 'ready', label: 'Order ready' },
  { kind: 'on_its_way', label: 'On its way' },
  { kind: 'refund', label: 'Refund' },
  { kind: 'declined', label: 'Declined' },
  { kind: 'acknowledgement', label: 'Acknowledgement' },
  { kind: 'quote', label: 'Quote' },
  { kind: 'notice', label: 'Notice' },
  { kind: 'reminder', label: 'Reminder' },
  { kind: 'invoice', label: 'Invoice' },
  { kind: 'campaign', label: 'Campaign' },
];

export const kindLabel = (kind: string): string =>
  MESSAGE_KINDS.find((k) => k.kind === kind)?.label ?? kind.replaceAll('_', ' ');

/** The value of the filter's select: a kind, or `all`. */
export const ALL_KINDS = 'all';

/** The filter the select and the recipient choice make; `all` and blank mean no filter. */
export function filterOf(kind: string, to: string, limit?: number): InboxFilter {
  return {
    kind: MESSAGE_KINDS.some((k) => k.kind === kind) ? (kind as MessageKind) : undefined,
    to: to === '' ? undefined : to,
    limit,
  };
}

/** Customer ids to display names. */
export function namesOf(customers: Pick<CustomerResponse, 'customer' | 'display_name'>[]) {
  return new Map(customers.map((c) => [c.customer, c.display_name]));
}

/** The recipient's display name, or a short form of the id when the list has not arrived. */
export function recipientName(names: Map<string, string>, id: string): string {
  return names.get(id) ?? `customer ${id.slice(-6)}`;
}

/** "Opened Saturday ..., clicked ..." for a message; "Not opened" when it has not been. */
export function engagementText(m: Pick<MessageResponse, 'opened_at' | 'clicked_at'>): string {
  const opened = m.opened_at ? `Opened ${momentText(m.opened_at)}` : 'Not opened';
  return m.clicked_at ? `${opened}, clicked ${momentText(m.clicked_at)}` : opened;
}

/**
 * The line above the list: how many are shown of how many the sandbox holds. With a kind chosen,
 * none of it says "No receipt messages.", since the inbox itself may not be empty.
 */
export function countText(shown: number, total: number, kind: string = ALL_KINDS): string {
  if (total === 0) {
    const known = MESSAGE_KINDS.find((k) => k.kind === kind);
    return known === undefined
      ? 'The inbox is empty.'
      : `No ${known.label.toLowerCase()} messages.`;
  }
  return shown >= total
    ? `${total} ${total === 1 ? 'message' : 'messages'}.`
    : `Showing the newest ${shown} of ${total} messages.`;
}
