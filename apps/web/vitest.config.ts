import { defineConfig } from 'vitest/config';

// headers.test.ts reads dist/, so `pnpm build` comes before `pnpm test`. The tsconfig keeps JSX as
// written for Astro's own build, so the one test that renders a component asks for the automatic
// runtime here.
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
