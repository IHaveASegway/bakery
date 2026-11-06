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
export const howUrl = (id: string): string => `${HOW_PATH}#${id}`;

/** An essay of How it's built: its path on this site and its title, which is also its h1. */
export interface Essay {
  path: string;
  title: string;
}

/** The idempotency essay, which two principles share: keys on commands and keys at Stripe. */
const IDEMPOTENCY_ESSAY = {
  path: '/how-its-built/idempotency/',
  title: 'Why pressing the button twice never orders twice',
} as const satisfies Essay;

/** The lag essay, which two principles share: CQRS and the load that makes its lag visible. */
const LAG_ESSAY = {
  path: '/how-its-built/lag/',
  title: 'Why the CRM trails the orders, and why you can watch it',
} as const satisfies Essay;

/** The sandbox essay, which two principles share: a private sandbox and no personal data. */
const SANDBOX_ESSAY = {
  path: '/how-its-built/sandbox/',
  title: 'Why nothing here is real, by construction',
} as const satisfies Essay;

/**
 * The essays, keyed by the id of the principle's section on How it's built. A lab principle's
 * essay says what the bakery does for real that the lab page shows in the small; one with no lab
 * page explains the principle itself and links the lab's index. Two ids may share one page, as the
 * two idempotency principles, CQRS and load, and the sandbox and no personal data do. Every
 * principle has one; a principle with no entry would have no essay, and its section and tour step
 * would link none.
 */
export const ESSAYS = {
  queue: {
    path: '/how-its-built/outbox/',
    title: 'Why a paid order is never lost and never doubled',
  },
  cache: { path: '/how-its-built/cache/', title: 'Why the menu is cached by version, not by time' },
  backfill: {
    path: '/how-its-built/rebuild/',
    title: 'Why the CRM can be thrown away and rebuilt',
  },
  routes: {
    path: '/how-its-built/routes/',
    title: 'Why the browser plans the route and the object decides',
  },
  raft: {
    path: '/how-its-built/single-writer/',
    title: 'Why a single-writer object needs no consensus',
  },
  'idempotency-keys': IDEMPOTENCY_ESSAY,
  'payment-keys': IDEMPOTENCY_ESSAY,
  sagas: {
    path: '/how-its-built/sagas/',
    title: 'Why a catering job is a saga that only moves forward',
  },
  leases: {
    path: '/how-its-built/leases/',
    title: 'Why every hold and every sandbox has an end',
  },
  admission: {
    path: '/how-its-built/admission/',
    title: 'Why a refusal is the cheapest thing the bakery does',
  },
  cqrs: LAG_ESSAY,
  load: LAG_ESSAY,
  'time-travel': {
    path: '/how-its-built/time-travel/',
    title: 'Why the bakery’s clock is yours to move',
  },
  sandbox: SANDBOX_ESSAY,
  'no-personal-data': SANDBOX_ESSAY,
  api: {
    path: '/how-its-built/api/',
    title: 'Why the console is just another client',
  },
} as const satisfies Record<string, Essay>;

/**
 * Each essay page once, in the order of its first principle: the list How it's built gives and
 * the pages the build has, whichever principles share them.
 */
export const ESSAY_PAGES: readonly Essay[] = Object.values(ESSAYS).filter(
  (essay, i, all) => all.findIndex((e) => e.path === essay.path) === i,
);

export type EssayId = keyof typeof ESSAYS;

export const hasEssay = (id: string): id is EssayId => Object.hasOwn(ESSAYS, id);

/** The essay that goes with a principle, by its section's id, or undefined for one with none. */
export function essayOf(id: string): Essay | undefined {
  return hasEssay(id) ? ESSAYS[id] : undefined;
}

/** The essay's path on this site, or undefined for a principle with none. */
export const essayUrl = (id: string): string | undefined => essayOf(id)?.path;
