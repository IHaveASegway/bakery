import { useEffect, useId, useRef } from 'react';
import type { Confirmation } from '../lib/confirmations';

/**
 * A question asked in the page before something is deleted (lib/confirmations.ts): what will go,
 * then the action and the way back. The way back takes the focus when it appears, so Enter or a
 * second press cannot delete by accident, and Escape takes it too; the caller puts the focus back
 * on the button that asked. Not a modal: the page stays usable around it.
 */
export default function ConfirmStep({
  asked,
  busy,
  onConfirm,
  onCancel,
}: {
  asked: Confirmation;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const title = useId();
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => keep.current?.focus(), []);
  return (
    <div
      className="confirm-step"
      role="group"
      aria-labelledby={title}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // The question's own Escape: a popover around it stays open, and only the question closes.
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        onCancel();
      }}
    >
      <p id={title}>
        <strong>{asked.title}</strong>
      </p>
      {asked.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <p className="actions">
        <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={onConfirm}>
          {asked.confirm}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" ref={keep} onClick={onCancel}>
          {asked.cancel}
        </button>
      </p>
    </div>
  );
}
