import Console, { type WorkspaceProps } from '../Console';
import Dispatch from '../Dispatch';
import Seeding from './Seeding';

/** /app/dispatch/: the map large, with the stops, the two plans and their comparison beside it. */
export function DispatchView({ sandbox }: WorkspaceProps) {
  if (sandbox.state === 'seeding') return <Seeding />;
  return <Dispatch />;
}

export default function DispatchWorkspace() {
  return <Console workspace="dispatch" View={DispatchView} />;
}
