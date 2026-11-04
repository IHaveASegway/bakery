import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://bakery.ihaveasegway.com',
  // Trailing slashes everywhere, written as <path>/index.html.
  trailingSlash: 'always',
  build: {
    format: 'directory',
    // External stylesheets only: the policy has no 'unsafe-inline' and no hashes, and /_astro/
    // files are cached for a year by content hash.
    inlineStylesheets: 'never',
  },
  vite: {
    plugins: [tailwindcss()],
    // No asset becomes a data: URI, which img-src and font-src 'self' would refuse.
    build: { assetsInlineLimit: 0 },
  },
});
