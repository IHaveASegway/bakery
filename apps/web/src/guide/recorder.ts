// The recorder panel's own explanation: why the guide reads the server's flight recorder as it
// does. Every reason is ADR 0015's or ADR 0016's (section 6, tracing), restated, none added.
import type { GuideEntry } from '../lib/guide';
import { QUEUE } from './principles';

export const RECORDER: Pick<
  GuideEntry,
  'id' | 'title' | 'what' | 'why' | 'whenNot' | 'principle' | 'api'
> & {
  /** How the guide reads it, for a note and for this panel. */
  reads: string;
  /** What no hop carries. */
  carries: string;
} = {
  id: 'guide-recorder',
  title: 'The flight recorder',
  what: 'One Recorder object a sandbox keeps the last 200 batches the Queue’s consumer delivered: each event, how long after it was written it was taken, and how each subscriber class answered on each attempt. It records after the acks, so it can lose a hop and never delays a delivery.',
  why: 'A ring in one object a sandbox is a visitor’s own hops, readable by them, which a tracing product scoped to the operator is not.',
  whenNot:
    'Not as an audit log, which must be complete: that is a durable write in the event path, with its cost and its failures.',
  principle: QUEUE,
  api: {
    routeId: 'get-trace',
    method: 'GET',
    path: '/v1/sandboxes/{id}/trace',
    note: 'The hops after ?after=<cursor>, at most 50 batches, with the next cursor, more and missed. The socket at /trace/ws takes the session cookie only.',
  },
  reads:
    'A note reads the recorder at most three times after your write is answered, and stops once it has seen every event it expects; this panel holds the recorder’s socket while it is open and the tab is shown, and reads every 5 seconds if the socket is refused.',
  carries: 'No hop carries a note, a name or an amount: identifiers, types and times only.',
};
