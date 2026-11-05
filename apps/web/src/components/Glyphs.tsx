// One technical drawing per category, as the site draws things (docs/product.md, Q7 · Q-images):
// thin strokes in `currentColor`, no fill, a dashed construction line, and no text inside the
// picture. They are decorative, so each is hidden from assistive technology and the item's name
// sits beside it. First version: a glyph per category, not per item.
import type { SVGProps } from 'react';

type Props = Omit<SVGProps<SVGSVGElement>, 'children'>;

function Drawing({ children, ...rest }: Props & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width="64"
      height="64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** A country loaf in section: the crust, three scores and the centerline. */
export function Loaf(props: Props) {
  return (
    <Drawing {...props}>
      <path d="M7 44c0-15 11-26 25-26s25 11 25 26z" />
      <path d="M20 26l5 12M30 22l4 16M41 26l-3 12" />
      <path d="M32 12v40" strokeDasharray="2 3" strokeWidth="0.75" />
      <path d="M7 50h50M7 48v4M57 48v4" strokeWidth="0.75" />
    </Drawing>
  );
}

/** A croissant seen from above: two arcs and the folds between them. */
export function Croissant(props: Props) {
  return (
    <Drawing {...props}>
      <path d="M5 44Q32 2 59 44" />
      <path d="M15 44Q32 20 49 44" />
      <path d="M5 44q4 4 10 0M49 44q6 4 10 0" />
      <path d="M13 28l7 11M22 22l5 12M32 19v14M42 22l-5 12M51 28l-7 11" />
      <path d="M32 10v44" strokeDasharray="2 3" strokeWidth="0.75" />
    </Drawing>
  );
}

/** A three-layer cake with a candle. */
export function LayerCake(props: Props) {
  return (
    <Drawing {...props}>
      <rect x="10" y="44" width="44" height="10" rx="1" />
      <rect x="15" y="34" width="34" height="10" rx="1" />
      <rect x="20" y="24" width="24" height="10" rx="1" />
      <path d="M32 24v-9" />
      <path d="M32 15c-2-2-2-4 0-6 2 2 2 4 0 6z" />
      <path d="M32 8v48" strokeDasharray="2 3" strokeWidth="0.75" />
      <path d="M6 58h52" strokeWidth="0.75" />
    </Drawing>
  );
}

/** A hand pie: the half-moon, its crimped seam and two vents. */
export function HandPie(props: Props) {
  return (
    <Drawing {...props}>
      <path d="M8 46a24 24 0 0 1 48 0z" />
      <path d="M8 46h48" />
      <path
        d="M12 49v3M18 49v3M24 49v3M30 49v3M36 49v3M42 49v3M48 49v3M54 49v3"
        strokeWidth="0.75"
      />
      <path d="M24 34l4 5M34 31l4 6" />
      <path d="M32 12v34" strokeDasharray="2 3" strokeWidth="0.75" />
    </Drawing>
  );
}

/** A cup on a saucer with steam. */
export function Cup(props: Props) {
  return (
    <Drawing {...props}>
      <path d="M14 26h34l-4 24H18z" />
      <path d="M48 30c9 0 9 12-2 12" />
      <path d="M10 54h44" />
      <path
        d="M24 20c-3-3 3-5 0-9M33 20c-3-3 3-5 0-9M42 20c-3-3 3-5 0-9"
        strokeDasharray="2 2"
        strokeWidth="0.75"
      />
      <path d="M31 24v28" strokeDasharray="2 3" strokeWidth="0.75" />
    </Drawing>
  );
}

const BY_CATEGORY: Record<string, (props: Props) => React.JSX.Element> = {
  breads: Loaf,
  pastries: Croissant,
  cakes: LayerCake,
  savory: HandPie,
  drinks: Cup,
};

/** The category's drawing; a category the menu gains later gets the loaf rather than nothing. */
export default function Glyph({ category, ...props }: Props & { category: string }) {
  const Draw = BY_CATEGORY[category] ?? Loaf;
  return <Draw {...props} />;
}
