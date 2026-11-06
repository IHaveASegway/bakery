/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Where the browser reaches the API. Also the origin src/policy.ts allows in connect-src. */
  readonly PUBLIC_API_ORIGIN?: string;
  /** Turnstile's site key. Unset, the documented always-pass test key is used. */
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
  /**
   * Stripe's publishable key for the checkout. Empty means payments are not configured on this build;
   * anything but a pk_test_ key fails the build (src/lib/publishable-key.ts).
   */
  readonly PUBLIC_STRIPE_PUBLISHABLE_KEY?: string;
}

/** The ADR directory's file names, read at build (scripts/adr-files.mjs). */
declare module 'virtual:adr-files' {
  const files: readonly string[];
  export default files;
}
