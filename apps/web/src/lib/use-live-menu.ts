// The menu the storefront shows: the seed's static menu until a sandbox is live, then that
// sandbox's own, from `GET /v1/sandboxes/{id}/menu`. The ETag of the copy in hand goes back as
// `If-None-Match`, so asking again for an unchanged menu costs a 304 and no body. Each read is a
// story read (lib/trace.ts): the guide's menu note shows its `ETag` and `Bakery-Cache`, and its
// "Ask again" button calls `refresh` through the repeat this hook registers.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getMenu } from './api';
import { storyReads } from './trace';
import { describeError, type Message } from './messages';
import { STATIC_MENU, type MenuView } from './menu';
import type { Phase } from './use-session';

export interface LiveMenu {
  menu: MenuView;
  /** True once the menu came from the API. */
  live: boolean;
  etag: string | null;
  /** `hit` or `miss`, as the API's `Bakery-Cache` header said for the last answer. */
  cache: string | null;
  /** The status of the last answer: 200, or 304 when the copy in hand was current. */
  status: 200 | 304 | null;
  error: Message | null;
  checking: boolean;
  refresh(): Promise<void>;
}

export function useLiveMenu(phase: Phase): LiveMenu {
  const id = phase.name === 'live' ? phase.id : null;
  const etag = useRef<string | null>(null);
  const [state, setState] = useState<Omit<LiveMenu, 'refresh' | 'checking'>>({
    menu: STATIC_MENU,
    live: false,
    etag: null,
    cache: null,
    status: null,
    error: null,
  });
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    if (id === null) return;
    setChecking(true);
    try {
      const answer = await getMenu(id, etag.current);
      if (answer.modified) {
        etag.current = answer.etag;
        setState({
          menu: answer.menu,
          live: true,
          etag: answer.etag,
          cache: answer.cache,
          status: 200,
          error: null,
        });
      } else {
        setState((s) => ({
          ...s,
          etag: answer.etag ?? s.etag,
          cache: answer.cache,
          status: 304,
          error: null,
        }));
      }
    } catch (e) {
      setState((s) => ({ ...s, error: describeError(e) }));
    } finally {
      setChecking(false);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (id === null) return;
    return storyReads.register('menu', () => void refresh());
  }, [id, refresh]);

  return { ...state, checking, refresh };
}
