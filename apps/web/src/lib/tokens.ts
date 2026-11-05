import { formatHex, parse, type Color } from 'culori';

// Reads tokens.css, the one owner of every color (ADR 0010). The contrast test and the Open Graph
// renderer both resolve colors through here, so neither keeps a copy of a value.

/** The CSS with its comments removed. */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of the first `{ ... }` block whose prelude is exactly `selector`, braces balanced.
 *  Searching inside `within` (an @media body, say) keeps a selector from matching elsewhere. */
export function block(within: string, selector: string): string {
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
  let start = 0;
  while (start < within.length) {
    const open = within.indexOf('{', start);
    if (open < 0) break;
    const prelude = within.slice(within.lastIndexOf('}', open) + 1, open);
    let depth = 0;
    let close = open;
    for (; close < within.length; close++) {
      if (within[close] === '{') depth++;
      if (within[close] === '}' && --depth === 0) break;
    }
    if (flat(prelude) === flat(selector)) return within.slice(open + 1, close);
    // Look inside this block as well as after it: a selector can sit inside an at-rule.
    const inner = within.slice(open + 1, close);
    if (inner.includes('{')) {
      try {
        return block(inner, selector);
      } catch {
        // not in here
      }
    }
    start = close + 1;
  }
  throw new Error(`tokens.css has no block for ${selector}`);
}

/** The custom properties declared directly in a block, without nested blocks. */
export function declarations(body: string): Map<string, string> {
  const flat = body.replace(/\{[^{}]*\}/g, '');
  const found = new Map<string, string>();
  for (const [, name, value] of flat.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    if (name && value) found.set(name, value.trim());
  }
  return found;
}

/** Resolves var() references within one theme and parses each value as a color. */
export function resolve(theme: Map<string, string>): Map<string, Color> {
  const colors = new Map<string, Color>();
  const valueOf = (name: string, seen: string[] = []): string => {
    const raw = theme.get(name);
    if (raw === undefined) throw new Error(`--${name} is not declared in this theme`);
    if (seen.includes(name)) throw new Error(`--${name} refers to itself`);
    const reference = /^var\(--([\w-]+)\)$/.exec(raw);
    return reference?.[1] ? valueOf(reference[1], [...seen, name]) : raw;
  };
  for (const name of theme.keys()) {
    // A theme block holds colors only: a value culori cannot read would escape every check.
    const color = parse(valueOf(name));
    if (!color) throw new Error(`--${name} is not a color this parser can read`);
    colors.set(name, color);
  }
  return colors;
}

/** The selectors of the theme blocks, as tokens.css writes them. Light is the default since ADR
 *  0027: the bare :root holds it, and dark is a stored choice or the OS's. */
export const SELECTORS = {
  light: ":root, :root[data-theme='light']",
  dark: ":root[data-theme='dark']",
  darkMedia: '@media (prefers-color-scheme: dark)',
  darkFromOs: ":root:where(:not([data-theme='light']))",
} as const;

/** The three theme blocks: light, dark by choice, and dark from the OS. */
export function themeBlocks(css: string): {
  light: Map<string, string>;
  dark: Map<string, string>;
  darkFromOs: Map<string, string>;
} {
  const source = stripComments(css);
  return {
    light: declarations(block(source, SELECTORS.light)),
    dark: declarations(block(source, SELECTORS.dark)),
    darkFromOs: declarations(block(block(source, SELECTORS.darkMedia), SELECTORS.darkFromOs)),
  };
}

/** Every color token of one theme, resolved. The dark theme starts from the light one, the way the
 *  cascade does, so a token dark forgot to redeclare would show up with its light value. */
export function themeColors(css: string, theme: 'dark' | 'light'): Map<string, Color> {
  const { dark, light } = themeBlocks(css);
  return resolve(theme === 'light' ? light : new Map([...light, ...dark]));
}

/** A color as #rrggbb, for renderers that cannot read OKLCH, such as satori. */
export function hex(color: Color): string {
  return formatHex(color);
}

/** The browser chrome's color in one theme (`<meta name="theme-color">`): the page's own
 *  background, as #rrggbb, so the bar above the page never shows a color the page does not. */
export function chromeColor(css: string, theme: 'dark' | 'light'): string {
  const background = themeColors(css, theme).get('background');
  if (!background) throw new Error(`tokens.css has no --background in the ${theme} theme`);
  return hex(background);
}
