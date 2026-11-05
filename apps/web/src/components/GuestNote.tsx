/** The one sentence a guest sees wherever the console would let them write (security.md, Q45). */
export default function GuestNote() {
  return (
    <p className="hint">
      Guests browse, order and pay. Sign in to use the console’s writes.{' '}
      <a href="/signin/">Sign in</a>.
    </p>
  );
}
