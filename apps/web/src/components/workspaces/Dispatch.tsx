import Console, { type WorkspaceProps } from '../Console';
import Dispatch from '../Dispatch';
import Seeding from './Seeding';

/** /app/dispatch/: the map with the two plans beside it, the stops under them at full width. */
export function DispatchView({ sandbox }: WorkspaceProps) {
  if (sandbox.state === 'seeding') return <Seeding />;
  return <Dispatch />;
}

export default function DispatchWorkspace() {
  return <Console workspace="dispatch" View={DispatchView} />;
}
