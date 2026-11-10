import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DispatchResponse, PlanChoice, PlanView } from '../contracts';
import {
  completeStop,
  getDispatch,
  proposeDispatch,
  publishDispatch,
  submitPlan,
} from '../lib/api';
import { KeyedAction } from '../lib/crm';
import { usePoll } from '../lib/use-poll';
import {
  FOLLOW_UP_MS,
  ISOCHRONES_URL,
  ROUTE_DATA_URL,
  VroomError,
  buildProblem,
  completable,
  dayFromQuery,
  queryWithDay,
  dispatchDays,
  parseIsochrones,
  parseRouteData,
  plannable,
  planRequest,
  proposedSaid,
  readSolution,
  report,
  shortId,
  solveOptions,
  vanClass,
  type BrowserSolver,
  type Isochrones,
  type RouteData,
} from '../lib/dispatch';
import {
  WITHOUT_SOLVER,
  describeDispatchError,
  sentenceFor,
  solverSentence,
  type SolverFailure,
} from '../lib/dispatch-errors';
import { type Message as Text } from '../lib/messages';
import { firstOpenDate, isOpenDate } from '../lib/schedule';
import { SolverUnavailable, createSolverClient, type SolverClient } from '../lib/solver';
import { businessNowMs, dayText, windowText } from '../lib/when';
import { useSandboxPhase } from '../lib/use-session';
import DispatchComparison from './DispatchComparison';
import DispatchMap from './DispatchMap';
import DispatchPlan from './DispatchPlan';
import DispatchStops from './DispatchStops';
import GuestNote from './GuestNote';
import Message from './Message';
import StatusLine from './StatusLine';

type Shown = 'proposed' | 'submitted' | 'published';

const SHOWN_NAMES: Record<Shown, string> = {
  proposed: 'Server’s proposal',
  submitted: 'Browser’s plan',
  published: 'Published plan',
};

const PRIORITY: Shown[] = ['published', 'submitted', 'proposed'];

/** The static route data, fetched once: the map and the solver's matrix. Never the API. */
type Loaded = { data: RouteData; isochrones: Isochrones };
type RouteState = { ready: Loaded | null; failed: Text | null };

function useRouteData(): RouteState {
  const [state, setState] = useState<RouteState>({ ready: null, failed: null });
  useEffect(() => {
    let stopped = false;
    async function read(url: string): Promise<unknown> {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return response.json();
    }
    Promise.all([read(ROUTE_DATA_URL), read(ISOCHRONES_URL)]).then(
      ([data, isochrones]) => {
        if (stopped) return;
        try {
          setState({
            ready: { data: parseRouteData(data), isochrones: parseIsochrones(isochrones) },
            failed: null,
          });
        } catch (e) {
          setState({
            ready: null,
            failed: { title: 'The route data are not usable', detail: String(e) },
          });
        }
      },
      () => {
        if (!stopped) {
          setState({
            ready: null,
            failed: {
              title: 'The route data did not load',
              detail:
                'The map and the browser’s solver need the build’s route data. The server’s plan still works.',
            },
          });
        }
      },
    );
    return () => {
      stopped = true;
    };
  }, []);
  return state;
}

/**
 * The /app/dispatch/ island: one bakery day's delivery stops on a map and in a table, the server's
 * proposed plan, the browser's own plan from VROOM, the two compared, and the one that is published.
 *
 * The Dispatch object decides (ADR 0012): the screen sends the browser's plan as stop lists with no
 * totals, and every figure it shows for a plan is what the API answered. A guest reads; the writes
 * are for a signed-in session.
 */
export default function Dispatch() {
  const phase = useSandboxPhase();
  const sandboxId = phase.name === 'live' ? phase.id : null;
  const isGuest = phase.name === 'live' && phase.kind === 'guest';
  const clockOffsetS = phase.name === 'live' ? phase.clockOffsetS : 0;
  const days = useMemo(() => dispatchDays(clockOffsetS), [clockOffsetS]);
  const [chosen, setChosen] = useState('');
  // A closed today (a Monday) has no stops: open on the first open day, as the checkout does.
  const firstDay = firstOpenDate(days);
  const date = days.includes(chosen) ? chosen : firstDay;

  // The chosen day rides in the address (?day=2026-11-10), so a reload or a shared link keeps it.
  // Read once on load, in an effect so the server render and the first paint agree; written with
  // replaceState, so the Back button is not filled with days. Nothing goes in browser storage.
  useEffect(() => {
    const fromAddress = dayFromQuery(window.location.search);
    if (fromAddress !== null) setChosen(fromAddress);
  }, []);
  const chooseDay = (next: string) => {
    setChosen(next);
    const search = queryWithDay(window.location.search, next, firstDay || next);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search}${window.location.hash}`,
    );
  };

  const route = useRouteData();
  const [day, setDay] = useState<DispatchResponse | null>(null);
  const [error, setError] = useState<Text | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [shown, setShown] = useState<Shown | null>(null);
  const [vans, setVans] = useState('');
  const [capacity, setCapacity] = useState('');
  const [publish, setPublish] = useState<PlanChoice>('proposed');

  const [solver, setSolver] = useState<BrowserSolver>('idle');
  const [failure, setFailure] = useState<SolverFailure | null>(null);
  const [solved, setSolved] = useState<{ ms: number; version: string } | null>(null);
  const client = useRef<SolverClient | null>(null);
  const capacityField = useRef<HTMLInputElement>(null);
  const completion = useRef<HTMLHeadingElement>(null);
  const [focusCompletion, setFocusCompletion] = useState(false);
  useEffect(() => {
    if (!focusCompletion) return;
    completion.current?.focus();
    setFocusCompletion(false);
  }, [focusCompletion]);

  const keys = useRef({
    propose: new KeyedAction(),
    plan: new KeyedAction(),
    publish: new KeyedAction(),
    complete: new KeyedAction(),
  });
  // An answer for a day the page has already left must not overwrite the one it shows now.
  const wanted = useRef('');
  wanted.current = `${sandboxId ?? ''}/${date}`;

  const load = useCallback(async () => {
    if (sandboxId === null || date === '') return;
    const asked = `${sandboxId}/${date}`;
    setLoading(true);
    try {
      const answer = await getDispatch(sandboxId, date);
      if (wanted.current !== asked) return;
      setDay(answer);
      setError(null);
    } catch (e) {
      if (wanted.current !== asked) return;
      setDay(null);
      setError(describeDispatchError(e));
    } finally {
      if (wanted.current === asked) setLoading(false);
    }
  }, [sandboxId, date]);

  useEffect(() => {
    setDay(null);
    setShown(null);
    setSaid('');
    void load();
  }, [load]);

  // The page holds no socket, and a stop changes without it: an order paid, made ready on the
  // board, or sent out by a publish moves its stop a moment later, in the Dispatch log. So the
  // page reads the day again every ten seconds while it is shown (lib/use-poll.ts), and twice
  // soon after a publish or a delivery (`FOLLOW_UP_MS`), quietly: no "Reading" line, the shown
  // error kept, and never over an action that is still running.
  const busyNow = useRef<string | null>(null);
  busyNow.current = busy;
  const look = useCallback(async (): Promise<boolean> => {
    if (sandboxId === null || date === '' || busyNow.current !== null) return true;
    const asked = `${sandboxId}/${date}`;
    try {
      const answer = await getDispatch(sandboxId, date);
      if (wanted.current === asked && busyNow.current === null) setDay(answer);
      return true;
    } catch {
      return false;
    }
  }, [sandboxId, date]);
  usePoll(look, sandboxId !== null && date !== '');
  const followUps = useRef<ReturnType<typeof setTimeout>[]>([]);
  const followUp = () => {
    for (const timer of followUps.current) clearTimeout(timer);
    followUps.current = FOLLOW_UP_MS.map((ms) => setTimeout(() => void look(), ms));
  };
  useEffect(
    () => () => {
      for (const timer of followUps.current) clearTimeout(timer);
    },
    [look],
  );

  // The form starts from the day's own vans and capacity, and follows them when a plan changes them.
  useEffect(() => {
    if (day === null) return;
    setVans(String(day.vans));
    setCapacity(String(day.capacity));
  }, [day?.date, day?.vans, day?.capacity]);

  // The browser may not be able to run the solver at all; say so before anyone presses anything.
  useEffect(() => {
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
      setSolver('unavailable');
      setFailure('unsupported');
    }
    return () => client.current?.close();
  }, []);

  const available = (day === null ? [] : PRIORITY.filter((p) => day[p])) as Shown[];
  const effective: Shown | null =
    shown !== null && available.includes(shown) ? shown : (available[0] ?? null);
  const plan: PlanView | null =
    day !== null && effective !== null ? (day[effective] ?? null) : null;

  /** Runs one action: busy while it runs, the day replaced by the API's answer, a refusal shown. */
  async function act(
    name: string,
    run: () => Promise<DispatchResponse>,
    then: (answer: DispatchResponse) => void,
  ) {
    const asked = wanted.current;
    setBusy(name);
    setError(null);
    setSaid('');
    try {
      const answer = await run();
      if (wanted.current !== asked) return;
      setDay(answer);
      then(answer);
    } catch (e) {
      if (wanted.current === asked) setError(describeDispatchError(e));
    } finally {
      setBusy(null);
    }
  }

  const propose = () => {
    if (sandboxId === null) return;
    // The API's rule, checked here first so an empty or zero box costs no request and no key.
    const units = capacity.trim() === '' ? NaN : Number(capacity);
    if (!Number.isInteger(units) || units < 1) {
      setSaid('');
      setError({
        title: 'Give the van a capacity',
        detail: 'A van must carry at least 1 unit. Type a whole number, 1 or more.',
      });
      capacityField.current?.focus();
      return;
    }
    const body = { vans: Number(vans), capacity: units };
    void act(
      'propose',
      () =>
        keys.current.propose.run(`${date}:${JSON.stringify(body)}`, (key) =>
          proposeDispatch(sandboxId, date, body, key),
        ),
      (answer) => {
        setShown('proposed');
        setPublish('proposed');
        setSaid(proposedSaid(answer.proposed, answer.vans));
      },
    );
  };

  async function planInBrowser() {
    if (sandboxId === null || day === null) return;
    const stops = plannable(day);
    if (stops.length === 0) {
      setError({ title: 'Nothing to plan', detail: sentenceFor('no-stops') });
      return;
    }
    if (route.ready === null) {
      setError(
        route.failed ?? {
          title: 'The route data are still loading',
          detail: 'Try again in a moment.',
        },
      );
      return;
    }
    const { data: routeData } = route.ready;
    const asked = wanted.current;
    setBusy('plan');
    setError(null);
    setSaid('');
    setSolver('working');
    try {
      client.current ??= createSolverClient();
      const problem = buildProblem(routeData, stops, day.vans, day.capacity, day.date);
      const answer = await client.current.solve(problem.input, solveOptions(stops.length));
      const mine = readSolution(answer.output, problem);
      setSolver('ready');
      setFailure(null);
      setSolved({ ms: answer.ms, version: answer.version });
      const body = planRequest(mine);
      const next = await keys.current.plan.run(`${date}:${JSON.stringify(body)}`, (key) =>
        submitPlan(sandboxId, date, body, key),
      );
      if (wanted.current !== asked) return;
      setDay(next);
      setShown('submitted');
      setPublish('submitted');
      setSaid('The browser’s plan was checked by the API. The figures below are the API’s.');
    } catch (e) {
      if (e instanceof SolverUnavailable) {
        setSolver('unavailable');
        setFailure(e.reason);
      } else if (e instanceof VroomError) {
        setSolver('ready');
        setError({
          title: 'The solver could not plan this day',
          detail: `${solverSentence('vroom')} ${e.message}`,
        });
      } else {
        setSolver('ready');
        if (wanted.current === asked) setError(describeDispatchError(e));
      }
    } finally {
      setBusy(null);
    }
  }

  const publishPlan = () => {
    if (sandboxId === null || day === null) return;
    const version = day[publish]?.plan_v ?? 0;
    void act(
      'publish',
      () =>
        keys.current.publish.run(`${date}:${publish}:${version}`, (key) =>
          publishDispatch(sandboxId, date, { plan: publish }, key),
        ),
      (answer) => {
        setShown('published');
        setSaid(`Published plan version ${answer.plan_v}.`);
        followUp();
      },
    );
  };

  const complete = (stop: number) => {
    if (sandboxId === null || busy !== null) return;
    void act(
      `complete-${stop}`,
      () =>
        keys.current.complete.run(`${date}:${stop}`, (key) =>
          completeStop(sandboxId, date, { stop }, key),
        ),
      () => {
        setSaid(`Stop ${stop} is delivered.`);
        // Its button is gone with it: focus goes to the section's heading, not the page's body.
        setFocusCompletion(true);
        followUp();
      },
    );
  };

  if (phase.name !== 'live') {
    return (
      <StatusLine
        phase={phase}
        signedOut="You have no sandbox yet, so there is nothing to dispatch."
      />
    );
  }

  const staff = !isGuest;
  const rep = report(day, solver);
  const ready = route.ready;
  const todo = day === null ? [] : completable(day);
  const published = day?.published ?? null;
  const picked = day?.[publish] ?? null;

  return (
    <section data-tour="dispatch-root">
      <p>
        <label htmlFor="dispatch-day">Day</label>
        <select
          id="dispatch-day"
          value={date}
          disabled={busy !== null}
          onChange={(e) => chooseDay(e.target.value)}
        >
          {days.map((d) => (
            <option key={d} value={d}>
              {`${dayText(d, { now: businessNowMs(clockOffsetS) })}${isOpenDate(d) ? '' : ', closed'}`}
            </option>
          ))}
        </select>
      </p>
      {date !== '' && !isOpenDate(date) && (
        <p className="hint">The bakery is closed this day, so it has no delivery stops.</p>
      )}
      {isGuest && <GuestNote />}
      <Message error={error}>{said !== '' && <p>{said}</p>}</Message>
      {loading && day === null && <p className="hint">Reading the day’s stops…</p>}
      {error !== null && day === null && (
        <button type="button" className="btn btn-primary" onClick={() => void load()}>
          Try again
        </button>
      )}

      {day !== null && (
        <div className="dispatch-layout">
          <div className="panel dispatch-map-panel">
            <h2>Map</h2>
            {available.length > 1 && (
              <fieldset>
                <legend>Routes on the map</legend>
                {available.map((p) => (
                  <div key={p}>
                    <label className="check">
                      <input
                        type="radio"
                        name="dispatch-shown"
                        value={p}
                        checked={effective === p}
                        onChange={() => setShown(p)}
                      />{' '}
                      {SHOWN_NAMES[p]}
                    </label>
                  </div>
                ))}
              </fieldset>
            )}
            {ready === null ? (
              <p className="hint" aria-live="polite">
                {route.failed === null
                  ? 'Loading the map…'
                  : `${route.failed.title}. ${route.failed.detail ?? ''}`}
              </p>
            ) : (
              <>
                <DispatchMap
                  data={ready.data}
                  isochrones={ready.isochrones}
                  stops={day.stops}
                  plan={plan}
                  caption={`Map of Salt Lake City: the bakery, the reach of a van from it in 5 to 30 minutes, and ${day.stops.length} stops${
                    effective === null
                      ? ''
                      : `, with the routes of the ${SHOWN_NAMES[effective].toLowerCase()}`
                  }`}
                />
                <ul className="legend">
                  {plan?.vans.map((v) => (
                    <li key={v.van}>
                      <span className={`swatch swatch-${vanClass(v.van)}`} aria-hidden="true" />
                      Van {v.van}: {v.stops.length} {v.stops.length === 1 ? 'stop' : 'stops'},{' '}
                      {v.minutes} min
                    </li>
                  ))}
                </ul>
                <p className="hint">
                  Routes are drawn as straight lines between stops: the route data carry travel
                  times, not road geometry. The shaded bands are the minutes a van needs from the
                  bakery, without traffic. Numbers count the stops across the vans, van 1 first;
                  open circles are stops no plan has yet. The 64 faint points are the places a
                  delivery can go: public parks, libraries and stations that stand in for made-up
                  addresses.
                </p>
              </>
            )}
          </div>
          <div className="dispatch-plans">
            <div className="panel">
              <h2>Server’s plan</h2>
              <p className="hint">
                The server plans the day’s confirmed stops with a savings heuristic written in Rust.
              </p>
              <form
                aria-label="Propose a plan"
                data-tour="dispatch-propose"
                onSubmit={(e) => {
                  e.preventDefault();
                  propose();
                }}
              >
                <p>
                  <label htmlFor="dispatch-vans">Vans</label>
                  <select
                    id="dispatch-vans"
                    value={vans}
                    disabled={!staff || busy !== null}
                    onChange={(e) => setVans(e.target.value)}
                  >
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </p>
                <p>
                  <label htmlFor="dispatch-capacity">Capacity of a van, in units</label>
                  <input
                    ref={capacityField}
                    id="dispatch-capacity"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={capacity}
                    disabled={!staff || busy !== null}
                    onChange={(e) => setCapacity(e.target.value)}
                  />
                </p>
                <p>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={!staff || busy !== null}
                  >
                    {busy === 'propose' ? 'Proposing…' : 'Propose'}
                  </button>
                </p>
              </form>
              {day.proposed ? (
                <DispatchPlan plan={day.proposed} title="Server’s proposal" />
              ) : (
                <p className="hint">No proposal yet for this day.</p>
              )}
            </div>

            <div className="panel">
              <h2 data-tour="dispatch-plan">Browser’s plan</h2>
              <p className="hint">
                VROOM plans the same stops in this browser, in a Web Worker, within the same
                windows.
              </p>
              <p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!staff || busy !== null || day.stops.length === 0}
                  onClick={() => void planInBrowser()}
                >
                  {busy === 'plan'
                    ? 'Planning…'
                    : solver === 'unavailable'
                      ? 'Try the browser solver again'
                      : 'Plan in the browser'}
                </button>
              </p>
              <div aria-live="polite">
                {solver === 'unavailable' && (
                  <p className="problem">
                    <strong>The browser’s solver is unavailable.</strong>{' '}
                    {solverSentence(failure ?? 'load')} {WITHOUT_SOLVER}
                  </p>
                )}
                {solver === 'ready' && solved !== null && (
                  <p className="hint">
                    VROOM {solved.version} planned in {Math.max(1, Math.round(solved.ms))} ms in
                    this browser.
                  </p>
                )}
              </div>
              {day.submitted ? (
                <DispatchPlan plan={day.submitted} title="Browser’s plan, as the API checked it" />
              ) : (
                <p className="hint">No browser plan yet for this day.</p>
              )}
            </div>
          </div>

          <div className="panel dispatch-stops">
            <h2>Stops</h2>
            <DispatchStops day={day} data={ready?.data ?? null} />
          </div>

          <div className="panel dispatch-compare">
            <h2>Comparison</h2>
            <DispatchComparison report={rep} solver={solver} />
          </div>

          <div className="panel dispatch-publish">
            <h2>Publish</h2>
            <p className="hint">
              The published plan is the record drivers, the board and each order read.
            </p>
            <form
              aria-label="Publish a plan"
              data-tour="dispatch-publish"
              onSubmit={(e) => {
                e.preventDefault();
                publishPlan();
              }}
            >
              <fieldset>
                <legend>Which plan</legend>
                {(['proposed', 'submitted'] as const).map((p) => (
                  <div key={p}>
                    <label className="check">
                      <input
                        type="radio"
                        name="dispatch-publish"
                        value={p}
                        checked={publish === p}
                        disabled={!staff || busy !== null || !day[p]}
                        onChange={() => setPublish(p)}
                      />{' '}
                      {SHOWN_NAMES[p]}
                      {day[p] ? '' : ' (none yet)'}
                    </label>
                  </div>
                ))}
              </fieldset>
              {picked !== null && picked.unassigned.length > 0 && (
                <p className="hint">
                  This plan leaves {picked.unassigned.length} stop out. The API will refuse to
                  publish it.
                </p>
              )}
              <p>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!staff || busy !== null || picked === null}
                >
                  {busy === 'publish' ? 'Publishing…' : 'Publish'}
                </button>
              </p>
            </form>
            {published !== null && (
              <>
                <DispatchPlan
                  plan={published}
                  title={`Published plan, version ${published.plan_v}, made by the ${published.source}`}
                />
                <h3 data-tour="dispatch-complete" ref={completion} tabIndex={-1}>
                  Stop completion
                </h3>
                {todo.length === 0 ? (
                  <p className="hint">Every stop of the published plan is delivered.</p>
                ) : (
                  <ul className="choices">
                    {todo.map((row) => (
                      <li key={row.order}>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={!staff}
                          aria-disabled={busy !== null || undefined}
                          onClick={() => complete(row.stop ?? 0)}
                        >
                          {busy === `complete-${row.stop}`
                            ? 'Saving…'
                            : `Stop ${row.stop} delivered`}
                        </button>{' '}
                        van {row.van}, order <code>{shortId(row.order)}</code>, window{' '}
                        {windowText(row.window)}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
