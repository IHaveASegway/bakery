/** What a workspace shows while the sandbox's first alarm is still seeding it (ADR 0005). */
export default function Seeding() {
  return (
    <p aria-live="polite" className="empty">
      <strong>Seeding your bakery.</strong> The menu, the kitchen and the day’s open orders are
      being made. This page updates by itself.
    </p>
  );
}
