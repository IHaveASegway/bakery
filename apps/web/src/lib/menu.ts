// The menu as the storefront reads it: the same shape from the static file (the seed's menu,
// src/data/menu.json) and from `GET /v1/sandboxes/{id}/menu`, so every component takes either.
import type { MenuCategory, MenuItem, MenuResponse, MenuVariant } from '../contracts';
import staticMenu from '../data/menu.json';

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
