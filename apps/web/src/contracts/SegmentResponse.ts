/**
 * Generated from crates/contracts/schemas/SegmentResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * A segment: a fixed rule over Crm's projection, evaluated at the business time asked.
 */
export type Segment =
  'everyone' | 'cake-last-30-days' | 'delivery-customers' | 'lapsed-60-days' | 'catering-leads';

/**
 * `GET /v1/sandboxes/{id}/segments/{segment}`: how many customers the rule holds now, and a
 * few of their ids. Consent is not applied here; a send applies it. An unknown segment is
 * `404`.
 */
export interface SegmentResponse {
  members: number;
  /**
   * Up to five member ULIDs, smallest first.
   */
  sample: string[];
  segment: Segment;
}
