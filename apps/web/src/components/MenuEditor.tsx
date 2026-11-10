import { useCallback, useEffect, useRef, useState } from 'react';
import type { MenuItemStatus, MenuResponse } from '../contracts';
import { getMenu, getMenuDrafts, patchMenuItem, publishMenu, setTaxRate } from '../lib/api';
import {
  anotherTabText,
  draftsFrom,
  priceFieldName,
  priceSaid,
  statusSaid,
  taxBpOf,
  taxRateSaid,
  unseenDrafts,
  waitingPriceText,
  waitingText,
  type ItemView,
  type VariantView,
} from '../lib/menu';
import { describeError, type Message as Text } from '../lib/messages';
import { dollars, dollarsField, parseDollars, parseTaxPercent, taxPercent } from '../lib/money';
import { itemName } from '../lib/words';
import GuestNote from './GuestNote';
import Message from './Message';

const BAD_PRICE: Text = {
  title: 'That is not a price',
  detail: 'Type dollars and cents, such as 9.50. A price is more than zero.',
};

const BAD_RATE: Text = {
  title: 'That is not a tax rate',
  detail: 'Type a percentage from 0 to 30 with at most two decimals, such as 8.5 or 8.50.',
};

/** The tax rate field's id, which is also its key in `fieldError`. */
const RATE_ID = 'tax-rate';

/**
 * A price is a draft until "Publish menu": each variant has its own field and its own Set price
 * (roadmap R86, 2026-11-10: a half loaf is priced apart from a whole one), and one publish
 * bumps the version, which is what invalidates the cached menu (docs/domain.md, "MenuItem
 * availability"). A pause or a resume is not a draft: the Catalog publishes it at once as a
 * version of its own and leaves the price drafts waiting. The list shows what is published; a note
 * under an item shows the price that waits.
 *
 * The page reads the menu and the drafts the server holds together (`GET .../menu` and
 * `GET .../menu/drafts`), on load and again after a publish or a pause, so a draft made before a
 * reload, or in another tab, is shown with its price. Between reads each edit's answer keeps the
 * list of waiting items current. A guest cannot read the drafts (the route is signed-in only) and
 * cannot publish, so a guest's page reads the menu alone.
 *
 * A price drafted in another tab is read in again when this window regains the focus or becomes
 * visible, and once more before Publish acts: a draft the page had not shown stops that Publish,
 * lists it, and asks for another press, so nothing goes on sale unseen. No timer asks in between.
 *
 * The tax rate is set in percent and sent in basis points. Like a pause it is not a draft: the
 * Catalog publishes it at once as a version of its own, so the next order pays it and the price
 * drafts keep waiting. The field shows the published rate until it is edited.
 */
export default function MenuEditor({
  sandboxId,
  isGuest,
  onPublished,
}: {
  sandboxId: string;
  isGuest: boolean;
  /** The menu changed (a publish, a pause or a resume): the version it is now. */
  onPublished?: (version: number) => void;
}) {
  const [menu, setMenu] = useState<MenuResponse | null>(null);
  // The draft price of each variant of an item with a draft, by variant slug: the server's on load,
  // then this page's edits.
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  // The slugs the server says wait for a publish (the drafts route, then each edit's answer);
  // null until the drafts are read, and for a guest, who cannot read them.
  const [pending, setPending] = useState<string[] | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  // What is typed in the tax rate field; null shows the published rate.
  const [rateField, setRateField] = useState<string | null>(null);
  // A bad price, said beside its own field as well as at the end of the list.
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [said, setSaid] = useState('');

  const load = useCallback(async () => {
    // Both at once; a failed drafts read still shows the menu, and says why beneath it.
    const [answer, waiting] = await Promise.allSettled([
      getMenu(sandboxId),
      isGuest ? Promise.resolve(null) : getMenuDrafts(sandboxId),
    ]);
    if (answer.status === 'fulfilled') {
      if (answer.value.modified) setMenu(answer.value.menu);
    } else {
      setError(describeError(answer.reason));
    }
    if (waiting.status === 'fulfilled') {
      if (waiting.value) {
        const read = draftsFrom(waiting.value);
        setPending(read.pending);
        setDrafts(read.prices);
      }
    } else if (answer.status === 'fulfilled') {
      setError(describeError(waiting.reason));
    }
  }, [sandboxId, isGuest]);

  useEffect(() => {
    void load();
  }, [load]);

  // What the page shows and is doing, for the listeners below and for Publish.
  const shown = useRef<string[] | null>(null);
  shown.current = pending;
  const working = useRef(false);
  working.current = busy;
  const reading = useRef<Promise<string[]> | null>(null);

  /** Reads the drafts the server holds into the page and returns their slugs; throws if it cannot. */
  const reread = useCallback((): Promise<string[]> => {
    // Focus and visibility often arrive together: one read answers both.
    if (reading.current !== null) return reading.current;
    const read = getMenuDrafts(sandboxId)
      .then(draftsFrom)
      .then((got) => {
        setPending(got.pending);
        setDrafts(got.prices);
        return got.pending;
      })
      .finally(() => {
        reading.current = null;
      });
    reading.current = read;
    return read;
  }, [sandboxId]);

  useEffect(() => {
    if (isGuest) return;
    const again = () => {
      if (document.visibilityState !== 'visible' || working.current) return;
      reread().catch(() => undefined);
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [isGuest, reread]);

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setFieldError(null);
    setSaid('');
    try {
      await run();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const setPrice = (item: ItemView, variant: VariantView, cents: number) =>
    act(async () => {
      const edit = await patchMenuItem(sandboxId, item.slug, {
        price_cents: cents,
        variant: variant.slug,
      });
      setPending(edit.pending);
      setDrafts((d) => ({ ...d, [variant.slug]: cents }));
      setSaid(priceSaid(item, variant, cents));
    });

  /** One variant's price field and its Set price, with the note of what waits for Publish. */
  const priceRow = (item: ItemView, variant: VariantView) => {
    const id = `price-${variant.slug.replaceAll('/', '-')}`;
    const name = priceFieldName(item, variant);
    const field = fields[variant.slug] ?? dollarsField(drafts[variant.slug] ?? variant.price_cents);
    const bad = fieldError === variant.slug;
    const waits = waitingPriceText(variant.price_cents, drafts[variant.slug]);
    const set = (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={isGuest}
        aria-disabled={busy || undefined}
        aria-label={`Set the price of ${name}`}
        onClick={() => {
          if (busy) return;
          const cents = parseDollars(field);
          if (cents === null) {
            setSaid('');
            setError(BAD_PRICE);
            setFieldError(variant.slug);
            return;
          }
          void setPrice(item, variant, cents);
        }}
      >
        Set price
      </button>
    );
    const input = (
      <input
        id={id}
        aria-label={`Price of ${name}, in dollars`}
        type="text"
        inputMode="decimal"
        value={field}
        disabled={isGuest}
        aria-invalid={bad || undefined}
        aria-describedby={bad ? `${id}-error` : undefined}
        onChange={(e) => setFields((f) => ({ ...f, [variant.slug]: e.target.value }))}
      />
    );
    const error = bad && (
      <span id={`${id}-error`} className="problem">
        <strong>{BAD_PRICE.title}.</strong> {BAD_PRICE.detail}
      </span>
    );
    return { id, input, set, error, waits };
  };

  const setStatus = (slug: string, name: string, status: MenuItemStatus) =>
    act(async () => {
      const edit = await patchMenuItem(sandboxId, slug, { status });
      setPending(edit.pending);
      // Published already: read the menu again, so the version and the item's status are the new ones.
      await load();
      onPublished?.(edit.version);
      setSaid(statusSaid(name, status === 'paused', edit.version));
    });

  const setRate = (bp: number) =>
    act(async () => {
      const before = menu?.version ?? null;
      const edit = await setTaxRate(sandboxId, bp);
      setPending(edit.pending);
      setRateField(null);
      // Published already (or unchanged): read the menu again for the version and the rate.
      await load();
      if (edit.version !== before) onPublished?.(edit.version);
      setSaid(taxRateSaid(bp, before, edit.version));
    });

  const waiting = pending === null ? null : pending.length;
  const publishedRate = menu === null ? null : taxBpOf(menu);
  const rateBad = fieldError === RATE_ID;

  return (
    <>
      <h3 id="menu-heading" tabIndex={-1} data-tour="controls-menu">
        Menu
      </h3>
      <p className="hint">
        Version {menu?.version ?? '…'} is published; prices wait for Publish, while Pause, Resume
        and the tax rate publish at once.
      </p>
      {isGuest && <GuestNote />}
      <section aria-labelledby="tax-heading" data-tour="controls-tax">
        <h4 id="tax-heading">Tax rate</h4>
        <p>
          <label htmlFor={RATE_ID}>Tax rate, in percent</label>
          <input
            id={RATE_ID}
            type="text"
            inputMode="decimal"
            value={rateField ?? (publishedRate === null ? '' : taxPercent(publishedRate))}
            disabled={isGuest}
            aria-invalid={rateBad || undefined}
            aria-describedby={rateBad ? `${RATE_ID}-hint ${RATE_ID}-error` : `${RATE_ID}-hint`}
            onChange={(e) => setRateField(e.target.value)}
          />
          <span id={`${RATE_ID}-hint`} className="hint">
            {publishedRate === null
              ? 'Reading the published rate…'
              : `Published: ${taxPercent(publishedRate)}%. 0 to 30%, published at once.`}
          </span>
          {rateBad && (
            <span id={`${RATE_ID}-error`} className="problem">
              <strong>{BAD_RATE.title}.</strong> {BAD_RATE.detail}
            </span>
          )}
        </p>
        <p className="actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={isGuest}
            aria-disabled={busy || undefined}
            onClick={() => {
              if (busy) return;
              const typed =
                rateField ?? (publishedRate === null ? null : taxPercent(publishedRate));
              if (typed === null) return;
              const bp = parseTaxPercent(typed);
              if (bp === null) {
                setSaid('');
                setError(BAD_RATE);
                setFieldError(RATE_ID);
                return;
              }
              void setRate(bp);
            }}
          >
            Set tax rate
          </button>
        </p>
      </section>
      {menu !== null && (
        <p className="hint editor-note">
          Prices are in dollars. Each variant, such as Whole and Half, has its own price and its own
          Set price.
        </p>
      )}
      {menu?.categories.map((category) => (
        <section key={category.slug} aria-labelledby={`edit-${category.slug}`}>
          <h4 id={`edit-${category.slug}`}>{category.name}</h4>
          <ul className="editor">
            {category.items.map((item) => {
              const differs = item.variants.some(
                (v) => waitingPriceText(v.price_cents, drafts[v.slug]) !== null,
              );
              const earlier = !differs && (pending?.includes(item.slug) ?? false);
              const status = item.status;
              const pause = (
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  disabled={isGuest}
                  aria-disabled={busy || undefined}
                  aria-label={`${status === 'paused' ? 'Resume' : 'Pause'} ${item.name}`}
                  onClick={() => {
                    if (busy) return;
                    void setStatus(
                      item.slug,
                      item.name,
                      status === 'paused' ? 'available' : 'paused',
                    );
                  }}
                >
                  {status === 'paused' ? 'Resume' : 'Pause'}
                </button>
              );
              const title = (
                <>
                  <strong>{item.name}</strong>
                  {status === 'paused' && (
                    <>
                      {' '}
                      <span className="badge" data-tone="pending">
                        paused
                      </span>
                    </>
                  )}
                </>
              );
              const another = earlier && (
                <p className="hint">
                  Waiting for publish: a price drafted in another tab. Reload to see it.
                </p>
              );
              const only = item.variants.length === 1 ? item.variants[0] : undefined;
              if (only !== undefined) {
                // One variant: one field, as the editor has always shown it.
                const row = priceRow(item, only);
                return (
                  <li key={item.slug}>
                    <p>
                      {title}
                      <br />
                      <span className="hint">
                        {only.label} {dollars(only.price_cents)}
                      </span>
                    </p>
                    <p>
                      {row.input}
                      {row.error}
                    </p>
                    <p className="actions">
                      {row.set}
                      {pause}
                    </p>
                    {row.waits && <p className="hint">{row.waits}</p>}
                    {another}
                  </li>
                );
              }
              return (
                <li key={item.slug} className="editor-variants">
                  <div className="editor-head">
                    <p>{title}</p>
                    <p className="actions">{pause}</p>
                  </div>
                  {item.variants.map((v) => {
                    const row = priceRow(item, v);
                    return (
                      <div key={v.slug} className="price-row">
                        <label htmlFor={row.id}>
                          {v.label} <span className="hint">now {dollars(v.price_cents)}</span>
                        </label>
                        {row.input}
                        {row.set}
                        {row.error}
                        {row.waits && <p className="hint">{row.waits}</p>}
                      </div>
                    );
                  })}
                  {another}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="publish-bar">
        <button
          type="button"
          className="btn btn-primary"
          disabled={isGuest}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (busy) return;
            void act(async () => {
              // Look first: a price drafted elsewhere since the last read goes on sale with this one.
              const known = shown.current;
              const unseen = unseenDrafts(known, await reread());
              if (unseen.length > 0) {
                const names = new Map(
                  (menu?.categories ?? []).flatMap((c) => c.items.map((i) => [i.slug, i.name])),
                );
                setSaid(anotherTabText(unseen.map((slug) => names.get(slug) ?? itemName(slug))));
                return;
              }
              const published = await publishMenu(sandboxId);
              setDrafts({});
              setPending([]);
              setFields({});
              await load();
              onPublished?.(published.version);
              setSaid(`Menu published. It is now version ${published.version}.`);
            });
          }}
        >
          Publish menu
        </button>{' '}
        {!isGuest && <span className="hint">{waitingText(waiting)}</span>}
      </p>
      <Message error={error}>{said && <p className="hint">{said}</p>}</Message>
    </>
  );
}
