import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { adrFilesPlugin } from './scripts/adr-files.mjs';
import { hashesByRule } from './scripts/inline-hashes.mjs';
import { checkPublishableKey } from './src/lib/publishable-key.ts';
import { DEFAULT_API_ORIGIN, RULE_PATHS, headersFile } from './src/policy.ts';

/**
 * Writes dist/_headers from src/policy.ts once the build is done, so `pnpm build` stays one
 * command. The API origin is read the way the islands read it, from Vite's resolved env, so a
 * PUBLIC_API_ORIGIN in .env or in the shell reaches the policy and the client alike. The same
 * resolved env carries PUBLIC_STRIPE_PUBLISHABLE_KEY, which is empty or a pk_test_ key or the build
 * stops here (docs/security.md, "Payments safety").
 */
function pagePolicy() {
  let apiOrigin = DEFAULT_API_ORIGIN;
  return {
    name: 'page-policy',
    hooks: {
      'astro:config:setup': ({ updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'page-policy-env',
                configResolved(config) {
                  checkPublishableKey(config.env.PUBLIC_STRIPE_PUBLISHABLE_KEY);
                  apiOrigin = config.env.PUBLIC_API_ORIGIN || DEFAULT_API_ORIGIN;
                },
              },
            ],
          },
        });
      },
      'astro:build:done': ({ dir }) => {
        const out = fileURLToPath(dir);
        mkdirSync(out, { recursive: true });
        writeFileSync(`${out}_headers`, headersFile(apiOrigin, hashesByRule(out, RULE_PATHS)));
      },
    },
  };
}

export default defineConfig({
  site: 'https://bakery.ihaveasegway.com',
  // Trailing slashes everywhere, written as <path>/index.html.
  trailingSlash: 'always',
  integrations: [react(), pagePolicy()],
  build: {
    format: 'directory',
    // External stylesheets only: the policy has no 'unsafe-inline' and no hashes, and /_astro/
    // files are cached for a year by content hash.
    inlineStylesheets: 'never',
  },
  vite: {
    // adrFilesPlugin: the ADR file names as `virtual:adr-files` (src/lib/links.ts).
    plugins: [tailwindcss(), adrFilesPlugin()],
    // No asset becomes a data: URI, which img-src and font-src 'self' would refuse.
    build: { assetsInlineLimit: 0 },
  },
});
