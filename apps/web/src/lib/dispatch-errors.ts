// Words for what the dispatch routes refuse with. A refused dispatch step is a 409 or 422 problem
// `dispatch` whose `detail` names the rule as a whole word: for a proposal `vans`, `capacity`,
// `no-stops` or `place-unknown`; for the browser's plan `route-ends`, `vans`, `stop-unknown`,
// `stop-twice`, `over-capacity` or `stop-missing`; for a publish `no-plan` or `stop-missing`; for a
// completion `no-plan` or `stop-unknown`. A day outside the sandbox's days is a 404 `no-such-day`,
// and a staff action as a guest is a 403 `guest-scope`. The sentences name the rule and nothing a
// visitor typed: every value here is chosen from a list or is a number the page checks.
import { ApiError } from './api';
import { describeError, type Message } from './messages';

const SENTENCES: Record<string, string> = {
  vans: 'A day plans with 1 to 4 vans, and every van of a plan is named once.',
  capacity: 'A van must carry at least 1 unit.',
  'no-stops': 'There are no confirmed stops for this day yet, so there is nothing to plan.',
  'place-unknown':
    'A stop is at a place the travel-time matrix does not have, so it cannot be planned.',
  'route-ends': 'Every van must start and end at the bakery. That plan did not, so it was refused.',
  'stop-unknown':
    'The plan names a stop that is not a confirmed stop of this day. Refresh the stops and plan again.',
  'stop-twice': 'The plan lists a stop more than once, so it was refused.',
  'over-capacity': 'A van in that plan carries more than its capacity, so it was refused.',
  'stop-missing':
    'That plan leaves a confirmed stop out, so it cannot be used. Raise the vans or the capacity and plan again.',
  'no-plan': 'There is no plan of that kind to use yet. Propose or plan first.',
  'no-such-day': 'The sandbox has no dispatch for that day. Choose one of the days listed.',
  'guest-scope':
    'Guests can look at dispatch. Sign in to propose, plan, publish or complete a stop.',
};

// Longest first, so `stop-missing` wins over a shorter slug it might contain.
const RULES = Object.keys(SENTENCES).sort((a, b) => b.length - a.length);

/** The rule a problem's detail names as a whole word, if it names one these screens know. */
export function ruleOf(detail: string | null): string | null {
  if (detail === null) return null;
  const lower = detail.toLowerCase();
  return RULES.find((rule) => new RegExp(`(^|[^a-z-])${rule}($|[^a-z-])`).test(lower)) ?? null;
}

/** The rule of an ApiError: the detail's, else its problem slug (`no-such-day`, `guest-scope`). */
export function ruleOfError(error: ApiError): string | null {
  return ruleOf(error.detail) ?? (error.slug in SENTENCES ? error.slug : null);
}

/** The rule's sentence, or null for a rule these screens do not know. */
export const sentenceFor = (rule: string): string | null => SENTENCES[rule] ?? null;

/**
 * A message for a refused dispatch step: the title the API sent and the rule's sentence, with the
 * API's own words after it when they say more. Anything that is not a dispatch refusal gets the
 * general wording.
 */
export function describeDispatchError(error: unknown): Message {
  if (error instanceof ApiError && [403, 404, 409, 422].includes(error.status)) {
    const rule = ruleOfError(error);
    const sentence = rule === null ? null : sentenceFor(rule);
    if (sentence !== null) return { title: error.title, detail: sentence };
    if (error.status === 404) {
      return {
        title: error.title,
        detail:
          'That is not in this sandbox any more. Refresh the page; the sandbox may have been wiped.',
      };
    }
    if (error.detail !== null) return { title: error.title, detail: error.detail };
  }
  return describeError(error);
}

/** Why the browser's solver could not run. */
export type SolverFailure = 'unsupported' | 'load' | 'timeout' | 'vroom';

const SOLVER_WORDS: Record<SolverFailure, string> = {
  unsupported: 'This browser cannot run the solver: it needs WebAssembly and module Web Workers.',
  load: 'The solver’s files did not load, or the browser refused to run the WebAssembly in them.',
  timeout: 'The solver did not answer in time, so it was stopped.',
  vroom: 'The solver ran but could not make a plan from this day’s stops.',
};

/** The plain sentence for a solver failure; the page adds what still works. */
export const solverSentence = (failure: SolverFailure): string => SOLVER_WORDS[failure];

/** What still works without the browser's solver. */
export const WITHOUT_SOLVER =
  'The server’s plan is unaffected: you can still propose, publish it and complete its stops. The comparison shows the server’s figures alone.';
