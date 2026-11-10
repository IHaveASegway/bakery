// The `cause` a command's events carry, as its answer names it in `Bakery-Cause` (ADR 0013's
// postscript of 2026-11-10). lib/api.ts records it as the call's key in the guide's trace, so the
// trace store ties the write's events to the call (lib/trace.ts, `createTraceStore`).

/** The answer's `Bakery-Cause`, or null when it names none (a read, a refusal, no answer). */
export function causeOf(response: Pick<Response, 'headers'> | null): string | null {
  const cause = response?.headers.get('Bakery-Cause')?.trim();
  return cause === undefined || cause === '' ? null : cause;
}
