import { businessNowMs } from '../../lib/when';
import Console, { type WorkspaceProps } from '../Console';
import Ledger from '../Ledger';
import Seeding from './Seeding';

/** /app/money/: the ledger. Refunds are made from an order's card on the kitchen board. */
export function MoneyView({ sandbox }: WorkspaceProps) {
  if (sandbox.state === 'seeding') return <Seeding />;
  return (
    <div className="workspace">
      <div className="panel">
        <Ledger sandboxId={sandbox.id} refresh={0} now={businessNowMs(sandbox.clock_offset_s)} />
      </div>
    </div>
  );
}

export default function MoneyWorkspace() {
  return <Console workspace="money" View={MoneyView} />;
}
