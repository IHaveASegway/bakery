/**
 * Generated from crates/contracts/schemas/MatrixResponse.schema.json by apps/web/scripts/contracts.mjs.
 * Do not edit: change the Rust type, run the `export-schemas` binary in crates/contracts, then
 * `pnpm --filter web contracts`.
 */

/**
 * The travel-time matrix the dispatch screen loads to run VROOM. It is not an API response: it
 * is a static asset of the web Worker, the same JSON as the committed fixture
 * `crates/seed/data/<city>/matrix.json` (ADR 0012, decision 7), and this type only fixes its
 * shape.
 */
export interface MatrixResponse {
  /**
   * When the build ran, or `seed:<n>` for the synthetic city.
   */
  built: string;
  /**
   * The city the build is for, or `synthetic`.
   */
  city: string;
  /**
   * The bakery's place, where every route starts and ends; 0 when left out.
   */
  depot?: number;
  /**
   * `minutes[i][j]`: whole minutes driving from place `i` to place `j`, 0 on the diagonal.
   * Not necessarily symmetric.
   */
  minutes: number[][];
  places: MatrixPlace[];
  /**
   * Where the travel times come from, with the attribution the data's licence asks for.
   */
  source: string;
}
/**
 * One place of the travel-time matrix.
 */
export interface MatrixPlace {
  /**
   * 0 to the places' count less one, in order.
   */
  index: number;
  /**
   * The map label, `p1` to `p64`; no name, coordinate or street.
   */
  label: string;
}
