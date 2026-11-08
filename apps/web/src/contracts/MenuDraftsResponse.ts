/**
 * Generated from crates/contracts/schemas/MenuDraftsResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * `GET /v1/sandboxes/{id}/menu/drafts`, signed-in sessions only: every item with a draft
 * waiting for `POST .../menu/publish`, in slug order, and the published version. The console's
 * menu editor reads it with `GET .../menu` on load and again after a publish, and shows each
 * item's waiting price under its published one, so a draft made before a reload is still shown.
 * The published prices are in the menu it already holds, so they are not repeated here.
 */
export interface MenuDraftsResponse {
  pending: MenuDraft[];
  version: number;
}
/**
 * One item with edits waiting for a publish, as its draft copy stands: the variants carry
 * their draft prices.
 */
export interface MenuDraft {
  name: string;
  slug: string;
  /**
   * The draft copy's status: `draft` for an item never published, else the published one,
   * since a pause or a resume is never a draft.
   */
  status: 'draft' | 'available' | 'paused' | 'retired';
  variants: MenuVariant[];
}
export interface MenuVariant {
  label: string;
  lead_minutes: number;
  price_cents: number;
  /**
   * `<item slug>/<suffix>`, such as `croissant/box-6`.
   */
  slug: string;
}
