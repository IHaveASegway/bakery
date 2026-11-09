import { useEffect, useState } from 'react';
import {
  allergenText,
  inSeason,
  leadText,
  seasonText,
  type ItemView,
  type MenuView,
  type Weekday,
} from '../lib/menu';
import { dollars } from '../lib/money';
import { mountainLocal } from '../lib/slots';
import Glyph from './Glyphs';

const ORDER: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SHORT: Record<Weekday, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

/** "Tue to Sun" for a run of days, a list for anything else. */
export function daysText(days: string[]): string {
  const sorted = ORDER.filter((d) => days.includes(d));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return 'no days';
  const run = ORDER.indexOf(last) - ORDER.indexOf(first) + 1 === sorted.length;
  if (sorted.length === 1) return SHORT[first];
  return run && sorted.length > 2
    ? `${SHORT[first]} to ${SHORT[last]}`
    : sorted.map((d) => SHORT[d]).join(', ');
}

interface Props {
  menu: MenuView;
  /** Called with a variant slug; without it the list is read-only. */
  onAdd?: (variant: string, label: string) => void;
}

/** Whether an item is in season on any of the next 8 bakery days. Unknown (server render): yes. */
function seasonOpen(item: ItemView, now: number | null): boolean {
  if (!item.season || now === null) return true;
  for (let day = 0; day < 8; day++) {
    const l = mountainLocal(now + day * 86_400_000);
    if (inSeason(item.season, l.month, l.day)) return true;
  }
  return false;
}

export default function MenuList({ menu, onAdd }: Props) {
  // The season is read from the clock after mount, so the server's HTML and the first render match.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);

  return (
    <div className="menu">
      {menu.categories.map((category, categoryIndex) => (
        <section key={category.slug} aria-labelledby={`cat-${category.slug}`} className="category">
          <h2 id={`cat-${category.slug}`}>{category.name}</h2>
          <ul className="items">
            {category.items.map((item, itemIndex) => {
              const paused = item.status === 'paused';
              const inSeasonNow = seasonOpen(item, now);
              const unavailable = paused || !inSeasonNow;
              return (
                <li
                  key={item.slug}
                  className="item"
                  // The tour rings the first card only: the whole list is thousands of pixels tall.
                  data-tour={categoryIndex === 0 && itemIndex === 0 ? 'menu-list' : undefined}
                >
                  <Glyph category={category.slug} className="glyph" />
                  <div className="item-body">
                    <h3>{item.name}</h3>
                    <p className="hint">
                      Contains: {allergenText(item.allergens)}. Baked {daysText(item.days_baked)}.
                      {item.season && ` In season ${seasonText(item.season)}.`}
                      {item.pickup_only && ' Pickup only.'}
                      {item.bulk_lead &&
                        ` More than ${item.bulk_lead.over_qty} of one needs ${leadText(item.bulk_lead.lead_minutes)}.`}
                    </p>
                    {paused && (
                      <p className="hint">
                        <strong>Paused.</strong> The bakery is not taking this one right now.
                      </p>
                    )}
                    {!paused && !inSeasonNow && (
                      <p className="hint">
                        <strong>Out of season.</strong> Back{' '}
                        {item.season ? seasonText(item.season).split(' to ')[0] : ''}.
                      </p>
                    )}
                    <ul className="variants">
                      {item.variants.map((variant) => (
                        <li key={variant.slug}>
                          <span className="variant-name">{variant.label}</span>
                          <span className="price">{dollars(variant.price_cents)}</span>
                          <span className="hint">Ahead: {leadText(variant.lead_minutes)}</span>
                          {onAdd && (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={unavailable}
                              aria-label={`Add ${item.name}, ${variant.label}, to the cart`}
                              onClick={() => onAdd(variant.slug, `${item.name}, ${variant.label}`)}
                            >
                              Add
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
