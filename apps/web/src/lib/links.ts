// Where the bakery's explanations live, derived in one place (Q32 · Q-links, docs/domain.md, "The
// principle map"): a lab page's URL from its name, through the one map of lab names to the site's
// slugs, and an ADR's URL from its number, through the ADR directory's file names read at build
// (scripts/adr-files.mjs). No principle types a URL of its own.
import adrFiles from 'virtual:adr-files';

/** The site the lab lives on, and the bakery's public repository. */
export const SITE = 'https://ihaveasegway.com';
export const SITE_LAB = `${SITE}/lab/`;
export const REPO = 'https://github.com/IHaveASegway/bakery';

/** The lab pages there are, by name, and each one's slug on the site: `/lab/<slug>/`. */
export const LAB_SLUGS = {
  'Queue Lab': 'queue',
  'Cache Lab': 'cache',
  'Backfill Lab': 'backfill',
  'Route Lab': 'routes',
  'Raft Lab': 'raft',
} as const;

export type LabName = keyof typeof LAB_SLUGS;
/** What a principle with no lab page names instead of one. */
export const NO_LAB = 'none yet';
export type LabOrNone = LabName | typeof NO_LAB;

export const isLab = (lab: string): lab is LabName => Object.hasOwn(LAB_SLUGS, lab);

/** The lab page's URL on the site, or undefined for "none yet". */
export function labUrl(lab: LabOrNone): string | undefined {
  return isLab(lab) ? `${SITE_LAB}${LAB_SLUGS[lab]}/` : undefined;
}

/** The ADR's file name, such as `0004-queues-between-objects-and-alarms-for-time.md`. */
export function adrFile(number: string, files: readonly string[] = adrFiles): string {
  const found = files.find((name) => name.startsWith(`${number}-`));
  if (!/^\d{4}$/.test(number) || found === undefined) {
    throw new Error(`no ADR numbered ${number} in docs/adr/`);
  }
  return found;
}

/** The ADR on GitHub, as it reads on main. */
export function adrUrl(number: string, files: readonly string[] = adrFiles): string {
  return `${REPO}/blob/main/docs/adr/${adrFile(number, files)}`;
}

/** The storefront's own explanation pages. */
export const HOW_PATH = '/how-its-built/';
export const ESSAY_PATH = '/how-its-built/single-writer/';
export const howUrl = (id: string): string => `${HOW_PATH}#${id}`;
