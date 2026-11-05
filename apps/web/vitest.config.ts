import { defineConfig } from 'vitest/config';

// headers.test.ts reads dist/, so `pnpm build` comes before `pnpm test`.
export default defineConfig({ test: { environment: 'node', include: ['test/**/*.test.ts'] } });
