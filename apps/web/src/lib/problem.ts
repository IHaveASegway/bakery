// Errors from the API are `application/problem+json` (RFC 9457), the contracts' Problem type.
import type { Problem } from '../contracts';

/** What the pages need from a problem. */
export interface ProblemInfo {
  status: number;
  type: string;
  title: string;
  detail: string | null;
  /** The `slot-full` problem's extension member: the next pickup start with a place free. */
  next_free: string | null;
}

/**
 * Reads a response body as a problem. Anything else (an HTML error page from a proxy, an empty
 * body) still yields a problem, built from the status, so a caller never handles two shapes.
 */
export function parseProblem(status: number, body: string): ProblemInfo {
  try {
    const value: unknown = JSON.parse(body);
    if (value !== null && typeof value === 'object') {
      const p = value as Partial<Problem>;
      if (typeof p.title === 'string') {
        return {
          status: typeof p.status === 'number' ? p.status : status,
          type: typeof p.type === 'string' ? p.type : 'about:blank',
          title: p.title,
          detail: typeof p.detail === 'string' ? p.detail : null,
          next_free: typeof p.next_free === 'string' ? p.next_free : null,
        };
      }
    }
  } catch {
    // Not JSON: fall through to the generic problem.
  }
  return {
    status,
    type: 'about:blank',
    title: `The API answered ${status}`,
    detail: null,
    next_free: null,
  };
}

/** The last path segment of a problem type: `.../problems/sandbox-cap` is `sandbox-cap`. */
export function problemSlug(type: string): string {
  return type.split('/').filter(Boolean).pop() ?? '';
}
