import CateringQueue from '../CateringQueue';
import { businessNowMs } from '../../lib/when';
import Console, { type WorkspaceProps } from '../Console';
import LeadPipeline from '../LeadPipeline';
import Seeding from './Seeding';

/** /app/catering/: the catering queue and the lead pipeline beside it. */
export function CateringView({ sandbox, isGuest }: WorkspaceProps) {
  if (sandbox.state === 'seeding') return <Seeding />;
  return (
    <div className="workspace panel-grid">
      <div className="panel two-thirds">
        <CateringQueue
          sandboxId={sandbox.id}
          isGuest={isGuest}
          now={businessNowMs(sandbox.clock_offset_s)}
        />
      </div>
      <div className="panel third">
        <LeadPipeline sandboxId={sandbox.id} refresh={0} />
      </div>
    </div>
  );
}

export default function CateringWorkspace() {
  return <Console workspace="catering" View={CateringView} />;
}
