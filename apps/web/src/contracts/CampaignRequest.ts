/**
 * Generated from crates/contracts/schemas/CampaignRequest.schema.json by apps/web/scripts/contracts.mjs.
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
 * A campaign's subject, chosen from a fixed list; staff never type one (Q14).
 */
export type SubjectTemplate =
  'weekend-bake' | 'cake-week' | 'new-season' | 'we-miss-you' | 'catering-season' | 'thank-you';

/**
 * `POST /v1/sandboxes/{id}/campaigns`, staff only: a draft, `201` with the `CampaignResponse`
 * (`200` with `Idempotent-Replayed: true` for the same key again).
 * `PATCH /v1/sandboxes/{id}/campaigns/{cid}` takes the same body and edits a draft: `200`, or
 * `409` problem of type `campaign` naming the rule (`out-of-order`) once it is scheduled, sent
 * or cancelled. A guest gets `403` `guest-scope` on both.
 */
export interface CampaignRequest {
  body: BodyTemplate;
  segment: Segment;
  subject: SubjectTemplate;
}
