// What the storefront's islands need to know about the visitor: whether there is a session, whether
// it has a sandbox, and whether that sandbox is still seeding (the first alarm seeds it, ADR 0005;
// the page asks every second until it is live).
import { useEffect, useState } from 'react';
import type { SessionKind } from '../contracts';
import { ApiError, NetworkError, getSandbox } from './api';
import { readSession } from './session';

export type Phase =
  | { name: 'loading' }
  | { name: 'offline' }
  | { name: 'nosession' }
  | { name: 'nosandbox' }
  | { name: 'seeding'; id: string; kind: SessionKind }
  /** `clockOffsetS`: business time minus wall time, from the sandbox as of this look. */
  | { name: 'live'; id: string; kind: SessionKind; clockOffsetS: number };

export function useSandboxPhase(): Phase {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function look(id: string | null, kind: SessionKind | null) {
      try {
        if (id === null || kind === null) {
          const session = await readSession();
          if (stopped) return;
          if (!session.sandbox) return setPhase({ name: 'nosandbox' });
          return look(session.sandbox, session.kind);
        }
        const sandbox = await getSandbox(id);
        if (stopped) return;
        if (sandbox.state === 'seeding') {
          setPhase({ name: 'seeding', id, kind });
          timer = setTimeout(() => void look(id, kind), 1_000);
        } else if (sandbox.state === 'live') {
          setPhase({ name: 'live', id, kind, clockOffsetS: sandbox.clock_offset_s });
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
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  return phase;
}
