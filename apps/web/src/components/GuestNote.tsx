import type { ReactNode } from 'react';

/**
 * The one sentence a guest sees wherever the console would let them write (security.md, Q45),
 * or the panel's own sentence when a guest may do part of it, as on the kitchen board.
 */
export default function GuestNote({
  children,
  tour,
}: {
  children?: ReactNode;
  /** The guide's target on this sentence, where an entry explains it (the kitchen board's). */
  tour?: string;
}) {
  return (
    <p className="hint" data-tour={tour}>
      {children ?? 'Guests browse, order and pay. Sign in to use the console’s writes.'}{' '}
      <a href="/signin/">Sign in</a>.
    </p>
  );
}
