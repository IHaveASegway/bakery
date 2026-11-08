// One bakery day's schedule from `GET /v1/sandboxes/{id}/schedule/{date}`, fetched when the sandbox
// or the date changes and again on `refresh()` (after a refusal, or a staff edit).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduleResponse } from '../contracts';
import { getSchedule } from './api';
import { describeError, type Message } from './messages';

export interface LiveSchedule {
  /** The schedule for `date`, or null while it loads or after a failure. */
  schedule: ScheduleResponse | null;
  loading: boolean;
  error: Message | null;
  /** Reads the day again; the answer, or null when it failed or the page has moved to another day. */
  refresh(): Promise<ScheduleResponse | null>;
  /** Replaces the copy in hand with an answer from elsewhere, such as a capacity change. */
  set(schedule: ScheduleResponse): void;
}

export function useSchedule(sandboxId: string | null, date: string): LiveSchedule {
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  // The answer for a date the page has already left must not overwrite the one it shows now.
  const wanted = useRef('');
  wanted.current = `${sandboxId ?? ''}/${date}`;

  const refresh = useCallback(async (): Promise<ScheduleResponse | null> => {
    if (sandboxId === null || date === '') return null;
    const asked = `${sandboxId}/${date}`;
    setLoading(true);
    try {
      const answer = await getSchedule(sandboxId, date);
      if (wanted.current !== asked) return null;
      setSchedule(answer);
      setError(null);
      return answer;
    } catch (e) {
      if (wanted.current !== asked) return null;
      setSchedule(null);
      setError(describeError(e));
      return null;
    } finally {
      if (wanted.current === asked) setLoading(false);
    }
  }, [sandboxId, date]);

  useEffect(() => {
    setSchedule(null);
    void refresh();
  }, [refresh]);

  const set = useCallback((next: ScheduleResponse) => {
    setSchedule(next);
    setError(null);
  }, []);

  return { schedule, loading, error, refresh, set };
}
