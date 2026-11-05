// Words for what went wrong, one place so every form says the same thing.
import { ApiError, NetworkError } from './api';

export interface Message {
  title: string;
  detail: string | null;
}

/** "about 12 minutes", for a Retry-After in seconds. */
function wait(seconds: number): string {
  if (seconds < 90) return 'a minute';
  if (seconds < 5400) return `about ${Math.round(seconds / 60)} minutes`;
  return `about ${Math.round(seconds / 3600)} hours`;
}

export function describeError(error: unknown): Message {
  if (error instanceof NetworkError) {
    return {
      title: 'The API is unreachable',
      detail: 'Check your connection and try again. Nothing was changed.',
    };
  }
  if (error instanceof ApiError) {
    const retry = error.retryAfter === null ? '' : ` Try again in ${wait(error.retryAfter)}.`;
    const detail = error.detail ?? '';
    return { title: error.title, detail: `${detail}${retry}`.trim() || null };
  }
  return { title: 'Something went wrong', detail: 'Reload the page and try again.' };
}

/** One plain sentence for each `?error=` slug the API's OAuth callbacks redirect with. */
const OAUTH_ERRORS: Record<string, string> = {
  state: 'Sign-in took too long or came from another browser window, so it was stopped. Try again.',
  exchange: 'The provider would not confirm the sign-in. Try again in a moment.',
  token: 'The provider’s answer could not be checked, so no one was signed in. Try again.',
  provider: 'The provider could not be reached or refused the sign-in. Try again later.',
  oauth: 'Sign-in could not be completed. Try again, or use a demo account or a guest sandbox.',
};

/** The sentence for a slug; an unknown slug gets the general one, never the raw text. */
export function oauthErrorSentence(slug: string | null): string | null {
  if (slug === null || slug === '') return null;
  return OAUTH_ERRORS[slug] ?? OAUTH_ERRORS['oauth']!;
}
