/**
 * Generated from crates/contracts/schemas/ScheduleRequest.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `POST /v1/sandboxes/{id}/campaigns/{cid}/schedule`, staff only: `200` with the
 * `CampaignResponse`, now `scheduled`. A `send_at` less than 15 minutes of business time after
 * now is `422` problem naming `schedule-too-soon`, its detail the earliest time allowed; a
 * campaign not in `draft` is `409` `campaign` naming `out-of-order`.
 * `POST .../campaigns/{cid}/cancel` (no body) takes a scheduled campaign back to `draft` and a
 * draft to `cancelled`; a sent one is `409` `campaign` naming `out-of-order`.
 */
export interface ScheduleRequest {
  /**
   * A business time, such as `2026-11-08T09:00:00-07:00`.
   */
  send_at: string;
}
