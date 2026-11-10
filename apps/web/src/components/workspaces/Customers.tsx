import { useState } from 'react';
import Activity from '../Activity';
import Campaigns from '../Campaigns';
import { businessNowMs } from '../../lib/when';
import Console, { type WorkspaceProps } from '../Console';
import Customers from '../Customers';
import Rebuild from '../Rebuild';
import Segments from '../Segments';
import Seeding from './Seeding';

/** /app/customers/: customers and their timelines, segments, campaigns, activity, the rebuild. */
export function CustomersView({ sandbox, isGuest }: WorkspaceProps) {
  // Bumped when something the CRM screens derive from changes: a consent flag, a finished rebuild.
  const [crmTick, setCrmTick] = useState(0);
  if (sandbox.state === 'seeding') return <Seeding />;
  return (
    <div className="workspace panel-grid">
      <div className="panel two-thirds">
        <Customers
          sandboxId={sandbox.id}
          isGuest={isGuest}
          personaId={sandbox.persona}
          refresh={crmTick}
          now={businessNowMs(sandbox.clock_offset_s)}
          onConsent={() => setCrmTick((n) => n + 1)}
        />
      </div>
      <div className="panel third">
        <Segments sandboxId={sandbox.id} refresh={crmTick} />
      </div>
      <div className="panel two-thirds">
        <Campaigns sandboxId={sandbox.id} isGuest={isGuest} clockOffsetS={sandbox.clock_offset_s} />
      </div>
      <div className="panel third">
        <Activity
          sandboxId={sandbox.id}
          refresh={crmTick}
          now={businessNowMs(sandbox.clock_offset_s)}
        />
      </div>
      <div className="panel half">
        <Rebuild
          sandboxId={sandbox.id}
          isGuest={isGuest}
          onFinished={() => setCrmTick((n) => n + 1)}
        />
      </div>
      <div className="panel half panel-link">
        <p>Every message the bakery sends lands in the inbox.</p>
        <a className="btn btn-secondary" href="/inbox/">
          Open the inbox
        </a>
      </div>
    </div>
  );
}

export default function CustomersWorkspace() {
  return <Console workspace="customers" View={CustomersView} />;
}
