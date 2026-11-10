import type { ReactNode } from 'react';

/**
 * A card's "How this works" words, closed until asked for: a quiet line under the card's work
 * that opens to the explanation. The words stay in the page, where the guide will take them from.
 */
export default function HowItWorks({ children }: { children: ReactNode }) {
  return (
    <details className="how">
      <summary>How this works</summary>
      <div className="how-body">{children}</div>
    </details>
  );
}
