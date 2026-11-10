import { useRef, useState } from 'react';
import { confirmation, replacedText } from '../lib/confirmations';
import ConfirmStep from './ConfirmStep';

/**
 * Wipe now and New sandbox, each asked in the page first (ConfirmStep): the System page's actions
 * and the top bar's sandbox menu. After a replace the line under them says which sandbox is yours
 * now; it carries `data-guide-result`, so the guide can place its note for the replace on it, as
 * on the board's result line.
 */
export default function SandboxActions({
  sandboxId,
  isGuest,
  busy,
  small = false,
  onWipe,
  onReplace,
}: {
  sandboxId: string;
  isGuest: boolean;
  busy: boolean;
  small?: boolean;
  onWipe: () => void;
  onReplace: () => void;
}) {
  const [asking, setAsking] = useState<'wipe' | 'replace' | null>(null);
  // The sandbox a replace was asked for: once the page holds another, the replace is done.
  const [replacing, setReplacing] = useState<string | null>(null);
  const wipeButton = useRef<HTMLButtonElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  const short = (id: string) => id.slice(-6);
  const size = small ? ' btn-sm' : '';

  const cancel = () => {
    const back = asking === 'wipe' ? wipeButton : replaceButton;
    setAsking(null);
    // The question's buttons go with it: the focus goes back to the button that asked.
    requestAnimationFrame(() => back.current?.focus());
  };

  return (
    <>
      {asking === null ? (
        <p className="actions">
          <button
            ref={wipeButton}
            type="button"
            className={`btn btn-danger${size}`}
            disabled={busy}
            onClick={() => setAsking('wipe')}
          >
            Wipe now
          </button>
          {!isGuest && (
            <button
              ref={replaceButton}
              type="button"
              className={`btn btn-secondary${size}`}
              disabled={busy}
              onClick={() => setAsking('replace')}
            >
              New sandbox
            </button>
          )}
        </p>
      ) : (
        <ConfirmStep
          asked={confirmation(asking, short(sandboxId))}
          busy={busy}
          onCancel={cancel}
          onConfirm={() => {
            if (asking === 'replace') {
              setReplacing(sandboxId);
              onReplace();
              // The question's buttons go with it: the focus waits on the line that will say so.
              requestAnimationFrame(() => result.current?.focus());
            } else {
              onWipe();
            }
            setAsking(null);
          }}
        />
      )}
      <p className="hint" role="status" data-guide-result="" ref={result} tabIndex={-1}>
        {replacing !== null && replacing !== sandboxId
          ? replacedText(short(replacing), short(sandboxId))
          : ''}
      </p>
    </>
  );
}
