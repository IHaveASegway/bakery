// The menu as the storefront reads it: the same shape from the static file (the seed's menu,
// src/data/menu.json) and from `GET /v1/sandboxes/{id}/menu`, so every component takes either.
import type {
  MenuCategory,
  MenuDraftsResponse,
  MenuItem,
  MenuResponse,
  MenuVariant,
} from '../contracts';
import staticMenu from '../data/menu.json';
import { DEFAULT_TAX_BP, dollars, taxPercent } from './money';

export type ItemView = MenuItem;
export type VariantView = MenuVariant;
/** The API's menu; the static menu is the same shape with no version, as nothing has published it. */
export type MenuView = Omit<MenuResponse, 'version'> & { version: number | null };
/** The days the menu names its baking days by (`days_baked` is a list of these). */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** The demo's own menu: version null, since no sandbox has published it. */
export const STATIC_MENU: MenuView = {
  version: null,
  categories: staticMenu.categories as MenuCategory[],
};

export interface Found {
  item: ItemView;
  variant: VariantView;
  category: string;
}

/**
 * The tax rate a menu was published with, in basis points. The static menu has none, and a menu
 * cached before the field existed leaves it out: both read as the default.
 */
export function taxBpOf(menu: MenuView): number {
  return menu.tax_bp ?? DEFAULT_TAX_BP;
}

/** The item and variant a variant slug names, if the menu has it. */
export function findVariant(menu: MenuView, slug: string): Found | null {
  for (const category of menu.categories) {
    for (const item of category.items) {
      const variant = item.variants.find((v) => v.slug === slug);
      if (variant) return { item, variant, category: category.slug };
    }
  }
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 15 to Mar 15" for a season written as `MM-DD`. */
export function seasonText(season: { from: string; to: string }): string {
  const part = (text: string) => {
    const [m, d] = text.split('-').map(Number);
    return `${MONTHS[(m ?? 1) - 1] ?? '?'} ${d ?? '?'}`;
  };
  return `${part(season.from)} to ${part(season.to)}`;
}

/** Whether `MM-DD` falls in a season, inclusive, wrapping over the new year as the domain does. */
export function inSeason(
  season: { from: string; to: string } | null | undefined,
  month: number,
  day: number,
): boolean {
  if (season == null) return true;
  const now = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return season.from <= season.to
    ? season.from <= now && now <= season.to
    : now >= season.from || now <= season.to;
}

/** The allergens as words: "tree-nuts" is "tree nuts". */
export function allergenText(allergens: string[]): string {
  return allergens.length === 0
    ? 'none of the nine major allergens'
    : allergens.map((a) => a.replaceAll('-', ' ')).join(', ');
}

/** "2 hours", "48 hours", "30 minutes", or "none" for a drink poured while you wait. */
export function leadText(minutes: number): string {
  if (minutes <= 0) return 'none';
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `${minutes} minutes`;
}

/** "Whole and Half", "Small, Medium and Large": a list of labels as a sentence says it. */
export function andList(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The name a variant's price field is known by (roadmap R86, 2026-11-10: each variant has its own
 * price field, since `PATCH .../menu/items/{slug}` takes a `variant`). An item with one variant
 * keeps the item's name alone, as its one field always had.
 */
export function priceFieldName(
  item: Pick<ItemView, 'name' | 'variants'>,
  variant: Pick<VariantView, 'label'>,
): string {
  return item.variants.length < 2 ? item.name : `${item.name}, ${variant.label}`;
}

/** What the editor says after a price is drafted: the variant's price, or the item's for one. */
export function priceSaid(
  item: Pick<ItemView, 'name' | 'variants'>,
  variant: Pick<VariantView, 'label'>,
  cents: number,
): string {
  return `${priceFieldName(item, variant)}: ${dollars(cents)} drafted. Publish to put it on sale.`;
}

/**
 * The note under a variant's field: the price that waits for Publish when it differs from the
 * published one, else null.
 */
export function waitingPriceText(published: number, draft: number | undefined): string | null {
  return draft === undefined || draft === published
    ? null
    : `Waiting for publish: ${dollars(draft)}.`;
}

/**
 * The editor's sentence after a pause or a resume. Neither is a draft: the Catalog publishes it at
 * once as a version of its own (crates/domain/src/catalog.rs, the module comment), and any price
 * drafts keep waiting.
 */
export function statusSaid(name: string, paused: boolean, version: number): string {
  return paused
    ? `${name} is paused. That was published at once as version ${version}: the storefront shows it paused now. Price drafts still wait for Publish.`
    : `${name} is on sale again. That was published at once as version ${version}. Price drafts still wait for Publish.`;
}

/** What the editor says after a tax rate is set: published at once, or already the rate. */
export function taxRateSaid(bp: number, before: number | null, version: number): string {
  if (before === version) return `Tax is already ${taxPercent(bp)}%. Nothing was published.`;
  return `Tax is now ${taxPercent(bp)}%. That was published at once as version ${version}: the next order pays it, and orders already placed keep their rate. Price drafts still wait for Publish.`;
}

/** What the editor shows as waiting for Publish, read from `GET .../menu/drafts`. */
export interface Drafts {
  /** The slugs of every item with a draft, in slug order. */
  pending: string[];
  /** The draft price of every variant of those items, by variant slug. */
  prices: Record<string, number>;
}

/**
 * The editor's waiting prices from the drafts the server holds, so a draft made before a reload
 * is shown after it. The drafts route gives each pending item's whole draft copy, every variant
 * with its own price, so each variant's field shows its own (roadmap R86); a variant whose draft
 * price is the published one has nothing waiting. An item with no variant has no price to show,
 * but still counts as waiting.
 */
export function draftsFrom(response: MenuDraftsResponse): Drafts {
  const prices: Record<string, number> = {};
  for (const draft of response.pending) {
    for (const v of draft.variants) prices[v.slug] = v.price_cents;
  }
  return { pending: response.pending.map((d) => d.slug), prices };
}

/**
 * The slugs the server holds a draft for that the page did not know of: a price drafted in another
 * tab. Null `shown` means the drafts have not been read yet, so nothing can be new.
 */
export function unseenDrafts(shown: string[] | null, read: string[]): string[] {
  if (shown === null) return [];
  return read.filter((slug) => !shown.includes(slug));
}

/** What Publish says when the look it takes first finds drafts the page did not show. */
export function anotherTabText(names: string[]): string {
  const one = names.length === 1;
  return `Another tab drafted a price for ${andList(names)}. ${one ? 'It is' : 'They are'} listed now. Press Publish menu again to put everything that waits on sale.`;
}

/**
 * The line beside Publish, from the drafts the server holds (`GET .../menu/drafts` on load and
 * after a publish, and every edit's answer after that). Null while they are being read.
 */
export function waitingText(waiting: number | null): string {
  if (waiting === null) return 'Reading what waits for Publish…';
  if (waiting === 0) return 'No item waits for Publish.';
  return `${waiting} ${waiting === 1 ? 'item has a price' : 'items have prices'} waiting for Publish.`;
}
