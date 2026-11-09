// Whether this island has hydrated. A button the server renders inside a `client:load` island
// looks pressable before React has attached its handler, and a press then does nothing (or, in a
// form, submits it natively). Render such a button disabled until this says true, and mark it
// `data-hydrating` so it keeps its enabled look meanwhile (styles/shop.css): no flash, no dead click.
import { useEffect, useState } from 'react';

export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/** The attribute a not-yet-hydrated control carries, or nothing once it is live. */
export const hydrating = (mounted: boolean): { 'data-hydrating'?: '' } =>
  mounted ? {} : { 'data-hydrating': '' };
