import { useCallback, useEffect, useState } from 'react';
import type { LeadStageView } from '../contracts';
import { getLeads } from '../lib/api';
import { leadStageLabel, orderedStages } from '../lib/crm';
import { describeError, type Message as Text } from '../lib/messages';
import Message from './Message';

/**
 * The catering lead pipeline: how many leads sit at each stage, from inquiry to the three ways a
 * lead ends. The Crm projects it from the catering events, so a stage changes when an inquiry is
 * quoted, accepted or paid; the page looks again every ten seconds and when `refresh` changes.
 */
export default function LeadPipeline({
  sandboxId,
  refresh,
}: {
  sandboxId: string;
  refresh: number;
}) {
  const [stages, setStages] = useState<LeadStageView[] | null>(null);
  const [error, setError] = useState<Text | null>(null);

  const load = useCallback(() => {
    getLeads(sandboxId).then(
      (answer) => {
        setStages(orderedStages(answer.stages));
        setError(null);
      },
      (e: unknown) => setError(describeError(e)),
    );
  }, [sandboxId]);

  useEffect(load, [load, refresh]);
  useEffect(() => {
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <section aria-labelledby="leads-heading">
      <h3 id="leads-heading" tabIndex={-1} data-tour="crm-leads">
        Catering lead pipeline
      </h3>
      <p>Every catering inquiry is a lead. It moves right as the event does.</p>
      <Message error={error} />
      {stages === null ? (
        error === null && <p aria-live="polite">Loading the pipeline…</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <caption className="sr-only">Leads by stage</caption>
            <thead>
              <tr>
                <th scope="col">Stage</th>
                <th scope="col" className="num">
                  Leads
                </th>
              </tr>
            </thead>
            <tbody>
              {stages.map((s) => (
                <tr key={s.stage}>
                  <th scope="row">{leadStageLabel(s.stage)}</th>
                  <td className="num">{s.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
