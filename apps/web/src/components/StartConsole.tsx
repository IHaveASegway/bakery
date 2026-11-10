import Console from './Console';
import { KitchenView } from './workspaces/Kitchen';

/**
 * /app/start/: where a Google or GitHub sign-in lands. The Kitchen's console, which first makes the
 * session a sandbox when it has no live one, then shows itself at /app/ (Console's `start`).
 */
export default function StartConsole() {
  return <Console workspace="kitchen" View={KitchenView} start />;
}
