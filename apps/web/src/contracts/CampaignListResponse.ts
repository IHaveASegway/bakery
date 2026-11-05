/**
 * Generated from crates/contracts/schemas/CampaignListResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * A campaign's body, chosen from a fixed list.
 */
export type BodyTemplate =
  | 'announcement'
  | 'fresh-bread'
  | 'cake-orders'
  | 'seasonal-menu'
  | 'come-back'
  | 'catering-invite';
/**
 * A segment: a fixed rule over Crm's projection, evaluated at the business time asked.
 */
export type Segment =
  'everyone' | 'cake-last-30-days' | 'delivery-customers' | 'lapsed-60-days' | 'catering-leads';
/**
 * Where a campaign is (docs/domain.md, "Campaign", the diagram).
 */
export type CampaignState = 'draft' | 'scheduled' | 'sent' | 'cancelled';
/**
 * A campaign's subject, chosen from a fixed list; staff never type one (Q14).
 */
export type SubjectTemplate =
  'weekend-bake' | 'cake-week' | 'new-season' | 'we-miss-you' | 'catering-season' | 'thank-you';

/**
 * `GET /v1/sandboxes/{id}/campaigns`: every campaign, by id.
 */
export interface CampaignListResponse {
  campaigns: CampaignResponse[];
}
/**
 * `GET /v1/sandboxes/{id}/campaigns/{cid}`, and the answer to every campaign command.
 */
export interface CampaignResponse {
  body: BodyTemplate;
  /**
   * The campaign's ULID.
   */
  campaign: string;
  clicked: number;
  /**
   * Messages the Inbox delivered, opened and clicked, from its events.
   */
  delivered: number;
  opened: number;
  /**
   * The frozen recipients' count: the segment's members with marketing consent at the send.
   */
  recipients: number;
  segment: Segment;
  /**
   * While scheduled, and after the send: the business time it is due or was sent.
   */
  send_at?: string | null;
  state: CampaignState;
  subject: SubjectTemplate;
}
