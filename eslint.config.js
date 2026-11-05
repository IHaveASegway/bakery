// One flat config for the repository: JavaScript, TypeScript and Astro files.
import js from '@eslint/js';
import astro from 'eslint-plugin-astro';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['**/dist/', '**/.astro/', '**/.wrangler/', '**/target/', 'workers/api/build/', 'tools/route-data/work/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  astro.configs.recommended,
  {
    // Everything here runs in Node: build-time templates, tests and configs.
    languageOptions: { globals: { ...globals.node } },
  },
]);
