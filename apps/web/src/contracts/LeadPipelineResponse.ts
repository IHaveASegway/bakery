/**
 * Generated from crates/contracts/schemas/LeadPipelineResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * A catering lead's stage in Crm's pipeline.
 */
export type LeadStage = ('inquiry' | 'quoted' | 'accepted' | 'closed') | 'won' | 'lost';

/**
 * `GET /v1/sandboxes/{id}/crm/leads`: every stage, in order, with its catering events.
 */
export interface LeadPipelineResponse {
  stages: LeadStageView[];
}
export interface LeadStageView {
  count: number;
  /**
   * The catering events' ULIDs.
   */
  events: string[];
  stage: LeadStage;
}
