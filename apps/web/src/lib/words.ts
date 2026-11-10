// The console's words for the API's keys. A slug, a slot key or a target is how the API names a
// thing; a person reads its name: "Country loaf", not `country-loaf`; "7:45 am", not
// `slot:07:45`. Every place the console prints one of these goes through a formatter here (the
// list is `FORMATTERS`, which apps/web/test/words.test.ts holds to the rule). An id that is the
// thing itself, an order's short code or a sandbox's code, is not a key in this sense and stays.

/** A slug as words, the first one capitalized: `country-loaf` is "Country loaf". */
export function itemName(slug: string): string {
  const words = slug.replaceAll(/[^A-Za-z0-9]+/g, ' ').trim();
  return words === '' ? 'An item' : words.charAt(0).toUpperCase() + words.slice(1);
}

/** A variant's slug, `<item>/<variant>`, as words: `country-loaf/half` is "Country loaf, half". */
export function variantName(slug: string): string {
  const [item = '', ...rest] = slug.split('/');
  const variant = rest
    .join(' ')
    .replaceAll(/[^A-Za-z0-9]+/g, ' ')
    .trim();
  return variant === '' ? itemName(item) : `${itemName(item)}, ${variant}`;
}

/** `HH:MM` on the bakery's clock, as the console says a time: `07:45` is "7:45 am". */
export function hhmmText(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (m === null) return 'a time';
  const hour = Number(m[1]);
  const minute = m[2] ?? '00';
  if (hour > 23 || Number(minute) > 59) return 'a time';
  return `${hour % 12 === 0 ? 12 : hour % 12}:${minute} ${hour < 12 ? 'am' : 'pm'}`;
}

/**
 * A capacity target (`CapacityRequest.target`) as a person says it: `slot:07:45` is "the 7:45 am
 * slot", `zone:z2` is "zone 2", `item:croissant` is "Croissant's daily cap" and `catering` is
 * "catering events". Anything else is "that target".
 */
export function targetText(target: string): string {
  const [kind = '', ...rest] = target.trim().split(':');
  const name = rest.join(':');
  switch (kind) {
    case 'slot':
      return /^\d{2}:\d{2}$/.test(name) ? `the ${hhmmText(name)} slot` : 'a slot';
    case 'zone':
      return /^z\d+$/.test(name) ? `zone ${name.slice(1)}` : 'a zone';
    case 'item':
      return name === '' ? 'an item’s daily cap' : `${itemName(name)}’s daily cap`;
    case 'catering':
      return 'catering events';
    default:
      return 'that target';
  }
}

/** What a customer likes, by the menu's names: "Seeded rye, Croissant". */
export function likesText(slugs: readonly string[]): string {
  return slugs.length === 0 ? 'nothing yet' : slugs.map(itemName).join(', ');
}

/**
 * Every formatter above, by name, with the kind of key it is given, for the test that holds them
 * to the rule (apps/web/test/words.test.ts).
 */
export const FORMATTERS = {
  itemName: { format: itemName, takes: 'slug' },
  variantName: { format: variantName, takes: 'variant' },
  hhmmText: { format: hhmmText, takes: 'time' },
  targetText: { format: targetText, takes: 'target' },
  likesText: { format: (s: string) => likesText(s.split(',')), takes: 'slugs' },
} as const;
