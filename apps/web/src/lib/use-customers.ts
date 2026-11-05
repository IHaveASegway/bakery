// The sandbox's customers, for the screens that show a name for an id. Loaded when the sandbox
// is known and again when `refresh` changes or, if asked, every `pollMs`.
import { useCallback, useEffect, useState } from 'react';
import type { CustomerResponse } from '../contracts';
import { listCustomers } from './api';
import { describeError, type Message } from './messages';

export function useCustomers(
  sandboxId: string | null,
  refresh = 0,
  pollMs: number | null = null,
): {
  customers: CustomerResponse[] | null;
  error: Message | null;
  reload: () => void;
  replace: (customer: CustomerResponse) => void;
} {
  const [customers, setCustomers] = useState<CustomerResponse[] | null>(null);
  const [error, setError] = useState<Message | null>(null);

  const reload = useCallback(() => {
    if (sandboxId === null) return;
    listCustomers(sandboxId).then(
      (answer) => {
        setCustomers(answer.customers);
        setError(null);
      },
      (e: unknown) => setError(describeError(e)),
    );
  }, [sandboxId]);

  useEffect(reload, [reload, refresh]);

  useEffect(() => {
    if (pollMs === null) return;
    const timer = setInterval(reload, pollMs);
    return () => clearInterval(timer);
  }, [reload, pollMs]);

  /** Puts one customer's fresh answer (a consent change) into the list. */
  const replace = useCallback((customer: CustomerResponse) => {
    setCustomers((list) =>
      list === null ? list : list.map((c) => (c.customer === customer.customer ? customer : c)),
    );
  }, []);

  return { customers, error, reload, replace };
}
