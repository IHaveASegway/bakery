// What the storefront's islands need to know about the visitor: whether there is a session, whether
// it has a sandbox, and whether that sandbox is still seeding (the first alarm seeds it, ADR 0005;
// the page asks every second until it is live).
import { useEffect, useState } from 'react';
import type { SandboxResponse, SessionKind } from '../contracts';
import { ApiError, NetworkError, getSandbox } from './api';
import { readSession, refreshSession } from './session';

export type Phase =
  | { name: 'loading' }
  | { name: 'offline' }
  | { name: 'nosession' }
  | { name: 'nosandbox' }
  | { name: 'seeding'; id: string; kind: SessionKind }
  /**
   * `clockOffsetS`: business time minus wall time, from the sandbox as of this look.
   * `personaZone`: the persona's delivery zone, their place's, where a delivery goes (R69).
   * `personaName`: the made-up customer every order and message of this sandbox is addressed to.
   */
  | {
      name: 'live';
      id: string;
      kind: SessionKind;
      clockOffsetS: number;
      personaZone?: string | null;
      personaName?: string | null;
    };

// The page's first read of a sandbox, shared by every island that asks for the same id, as
// readSession shares the session: a console page's frame and its dispatch view ask once between
// them. A later look (a reload, the seeding poll) asks the API again.
const firstReads = new Map<string, Promise<SandboxResponse>>();

export function readSandbox(id: string): Promise<SandboxResponse> {
  let read = firstReads.get(id);
  if (read === undefined) {
    read = getSandbox(id);
    firstReads.set(id, read);
  }
  return read;
}

// Every mounted phase hook on the page, so a screen that has just made a sandbox in place (the
// checkout's and the menu's Start ordering) can tell them all to look again.
const lookers = new Set<() => void>();

/**
 * The visitor now has a session and a sandbox they did not have when the page loaded: ask the API
 * once more, for every island on the page and for the header's link, without a reload, so the
 * visitor stays where they were with what they had chosen.
 */
export function lookAgain(): void {
  void refreshSession().catch(() => undefined);
  for (const look of lookers) look();
}

export function useSandboxPhase(): Phase {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function look(id: string | null, kind: SessionKind | null, first = false) {
      try {
        if (id === null || kind === null) {
          const session = await readSession();
          if (stopped) return;
          if (!session.sandbox) return setPhase({ name: 'nosandbox' });
          return look(session.sandbox, session.kind, true);
        }
        const sandbox = await (first ? readSandbox(id) : getSandbox(id));
        if (stopped) return;
        if (sandbox.state === 'seeding') {
          setPhase({ name: 'seeding', id, kind });
          timer = setTimeout(() => void look(id, kind), 1_000);
        } else if (sandbox.state === 'live') {
          setPhase({
            name: 'live',
            id,
            kind,
            clockOffsetS: sandbox.clock_offset_s,
            personaZone: sandbox.persona_zone ?? null,
            personaName: sandbox.persona_name ?? null,
          });
        } else {
          setPhase({ name: 'nosandbox' });
        }
      } catch (e) {
        if (stopped) return;
        if (e instanceof NetworkError) setPhase({ name: 'offline' });
        else if (e instanceof ApiError && e.status === 401) setPhase({ name: 'nosession' });
        else if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
          setPhase({ name: 'nosandbox' });
        } else setPhase({ name: 'offline' });
      }
    }
    void look(null, null);
    const again = () => {
      clearTimeout(timer);
      void look(null, null);
    };
    lookers.add(again);
    return () => {
      stopped = true;
      clearTimeout(timer);
      lookers.delete(again);
    };
  }, []);

  return phase;
}
