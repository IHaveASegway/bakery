// The ADR directory's file names, read at build, as the module `virtual:adr-files` (a sorted
// array of names such as "0004-queues-between-objects-and-alarms-for-time.md"). The tour and the
// How it's built page build each ADR's URL from these names (src/lib/links.ts), so a renamed or
// missing ADR fails the build's tests instead of shipping a dead link, and no name is typed twice.
// astro.config.mjs and vitest.config.ts both load the plugin.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ID = 'virtual:adr-files';
const RESOLVED = `\0${ID}`;
export const ADR_DIR = fileURLToPath(new URL('../../../docs/adr/', import.meta.url));

/** The numbered ADRs: `NNNN-<slug>.md`, sorted. The README and the template are not ADRs. */
export function adrFiles(dir = ADR_DIR) {
  return readdirSync(dir)
    .filter((name) => /^\d{4}-[a-z0-9-]+\.md$/.test(name))
    .sort();
}

export function adrFilesPlugin() {
  return {
    name: 'adr-files',
    resolveId(id) {
      return id === ID ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      // A new or renamed ADR is picked up by the dev server's next load of this module.
      this.addWatchFile(ADR_DIR);
      return `export default ${JSON.stringify(adrFiles())};`;
    },
  };
}
