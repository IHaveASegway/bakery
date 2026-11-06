/**
 * Generated from crates/contracts/schemas/InboxResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * What a message is.
 */
export type MessageKind =
  | 'receipt'
  | 'ready'
  | 'on_its_way'
  | 'refund'
  | 'declined'
  | 'acknowledgement'
  | 'quote'
  | 'notice'
  | 'reminder'
  | 'invoice'
  | 'campaign';

/**
 * `GET /v1/sandboxes/{id}/inbox`: the newest messages first, and how many there are in all.
 * `?kind=` keeps one kind, `?to=` one customer's, `?limit=` the newest that many (50 when left
 * out, at most 500). Any session of the sandbox, a guest's included, sees every customer's
 * messages: the persona is not filtered to its own, and `?to=` is how a reader narrows to one.
 */
export interface InboxResponse {
  messages: MessageResponse[];
  total: number;
}
/**
 * One message in the sandbox's inbox, and `GET /v1/sandboxes/{id}/inbox/{mid}`.
 */
export interface MessageResponse {
  body: string;
  clicked_at?: string | null;
  /**
   * Business times.
   */
  delivered_at: string;
  kind: MessageKind;
  /**
   * The message's ULID.
   */
  message: string;
  opened_at?: string | null;
  /**
   * The ULID of the order, catering event or campaign it is about.
   */
  ref: string;
  /**
   * From a fixed template, filled with the event's own figures; never free text.
   */
  subject: string;
  /**
   * The customer's ULID: the only recipient there is.
   */
  to: string;
}
