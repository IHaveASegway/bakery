import Console, { type WorkspaceProps } from '../Console';
import KitchenBoard from '../KitchenBoard';
import Seeding from './Seeding';

/** /app/: the kitchen board, the activity feed as a live strip under it, and the bake list. */
export function KitchenView({ sandbox, isGuest, onBoardWiped }: WorkspaceProps) {
  if (sandbox.state === 'seeding') return <Seeding />;
  return (
    <div className="workspace">
      <KitchenBoard
        sandboxId={sandbox.id}
        isGuest={isGuest}
        clockOffsetS={sandbox.clock_offset_s}
        onWiped={onBoardWiped}
        onRefunded={() => undefined}
      />
    </div>
  );
}

export default function KitchenWorkspace() {
  return <Console workspace="kitchen" View={KitchenView} />;
}
