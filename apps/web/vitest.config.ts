import { defineConfig } from 'vitest/config';
import { adrFilesPlugin } from './scripts/adr-files.mjs';

// headers.test.ts reads dist/, so `pnpm build` comes before `pnpm test`. The tsconfig keeps JSX as
// written for Astro's own build, so the one test that renders a component asks for the automatic
// runtime here. The ADR file names are the build's virtual module (scripts/adr-files.mjs).
export default defineConfig({
  plugins: [adrFilesPlugin()],
  oxc: { jsx: { runtime: 'automatic' } },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
