/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Where the browser reaches the API. Also the origin src/policy.ts allows in connect-src. */
  readonly PUBLIC_API_ORIGIN?: string;
  /** Turnstile's site key. Unset, the documented always-pass test key is used. */
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
}
