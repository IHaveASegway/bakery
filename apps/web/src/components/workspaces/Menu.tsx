import { useState } from 'react';
import CapacityEditor from '../CapacityEditor';
import Console, { type WorkspaceProps } from '../Console';
import MenuEditor from '../MenuEditor';
import Seeding from './Seeding';

/** /app/menu/: the menu editor with its drafts and Publish, the tax rate, and capacity. */
export function MenuView({ sandbox, isGuest }: WorkspaceProps) {
  // Bumped, with the version it reached, when the menu is published or an item is paused or
  // resumed: the capacity panel reads the day again, since the day's caps follow the menu.
  const [menuChange, setMenuChange] = useState({ tick: 0, version: 0 });
  if (sandbox.state === 'seeding') return <Seeding />;
  return (
    <div className="workspace panel-grid">
      <div className="panel two-thirds">
        <MenuEditor
          sandboxId={sandbox.id}
          isGuest={isGuest}
          onPublished={(version) => setMenuChange((c) => ({ tick: c.tick + 1, version }))}
        />
      </div>
      <div className="panel third">
        <CapacityEditor
          sandboxId={sandbox.id}
          isGuest={isGuest}
          clockOffsetS={sandbox.clock_offset_s}
          menuTick={menuChange.tick}
          menuVersion={menuChange.version}
        />
      </div>
    </div>
  );
}

export default function MenuWorkspace() {
  return <Console workspace="menu" View={MenuView} />;
}
