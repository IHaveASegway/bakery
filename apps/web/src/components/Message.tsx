import type { Message as Text } from '../lib/messages';

interface Props {
  /** An error, or a plain result. Nothing renders, but the live region stays for announcements. */
  error?: Text | null;
  children?: React.ReactNode;
}

/** A live region for a form's result. The error is bold text and a bar, never color alone. */
export default function Message({ error, children }: Props) {
  return (
    <div aria-live="polite" className="messages">
      {error && (
        <p className="problem">
          <strong>{error.title}.</strong> {error.detail}
        </p>
      )}
      {children}
    </div>
  );
}
