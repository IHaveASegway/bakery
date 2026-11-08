import { useCallback, useEffect, useState } from 'react';
import type { MenuItemStatus, MenuResponse } from '../contracts';
import { getMenu, patchMenuItem, publishMenu } from '../lib/api';
import { priceSetsText, statusSaid, waitingText } from '../lib/menu';
import { describeError, type Message as Text } from '../lib/messages';
import { dollars, dollarsField, parseDollars } from '../lib/money';
import GuestNote from './GuestNote';
import Message from './Message';

const BAD_PRICE: Text = {
  title: 'That is not a price',
  detail: 'Type dollars and cents, such as 9.50. A price is more than zero.',
};

/**
 * A price is a draft until "Publish menu": it applies to every variant of an item, and one publish
 * bumps the version, which is what invalidates the cached menu (docs/domain.md, "MenuItem
 * availability"). A pause or a resume is not a draft: the Catalog publishes it at once as a
 * version of its own and leaves the price drafts waiting. The list shows what is published; a note
 * under an item shows the price that waits.
 *
 * No route lists the drafts the server holds, so after a reload this page does not know them until
 * the next edit's answer names them; the line beside Publish says so (Publish applies them anyway).
 */
export default function MenuEditor({
  sandboxId,
  isGuest,
}: {
  sandboxId: string;
  isGuest: boolean;
}) {
  const [menu, setMenu] = useState<MenuResponse | null>(null);
  // Prices drafted on this page, by item.
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  // The slugs the API says wait for a publish (its answer to every edit); null before the first.
  const [pending, setPending] = useState<string[] | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  // A bad price, said beside its own field as well as at the end of the list.
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Text | null>(null);
  const [said, setSaid] = useState('');

  const load = useCallback(async () => {
    try {
      const answer = await getMenu(sandboxId);
      if (answer.modified) setMenu(answer.menu);
    } catch (e) {
      setError(describeError(e));
    }
  }, [sandboxId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const setPrice = (slug: string, name: string, cents: number) =>
    act(async () => {
      const edit = await patchMenuItem(sandboxId, slug, { price_cents: cents });
      setPending(edit.pending);
      setDrafts((d) => ({ ...d, [slug]: cents }));
      setSaid(`${name}: ${dollars(cents)} drafted for every variant. Publish to put it on sale.`);
    });

  const setStatus = (slug: string, name: string, status: MenuItemStatus) =>
    act(async () => {
      const edit = await patchMenuItem(sandboxId, slug, { status });
      setPending(edit.pending);
      // Published already: read the menu again, so the version and the item's status are the new ones.
      await load();
      setSaid(statusSaid(name, status === 'paused', edit.version));
    });

  const waiting = pending?.length ?? 0;

  return (
    <>
      <h3 data-tour="controls-menu">Menu</h3>
      <p>
        Version {menu?.version ?? '…'} is published. A new price waits as a draft until you publish;
        one publish makes a new version, and the next read of the menu misses the cache once. Pause
        and Resume take effect at once: each publishes a version of its own, and any price drafts
        keep waiting.
      </p>
      {isGuest && <GuestNote />}
      {menu?.categories.map((category) => (
        <section key={category.slug} aria-labelledby={`edit-${category.slug}`}>
          <h4 id={`edit-${category.slug}`}>{category.name}</h4>
          <ul className="editor">
            {category.items.map((item) => {
              const draft = drafts[item.slug];
              const earlier = draft === undefined && (pending?.includes(item.slug) ?? false);
              const status = item.status;
              const field = fields[item.slug] ?? dollarsField(item.variants[0]?.price_cents ?? 0);
              const id = `price-${item.slug}`;
              const sets = priceSetsText(item);
              const bad = fieldError === item.slug;
              const described = [sets && `${id}-sets`, bad && `${id}-error`]
                .filter(Boolean)
                .join(' ');
              return (
                <li key={item.slug}>
                  <p>
                    <strong>{item.name}</strong>
                    {status === 'paused' && ' (paused)'}
                    <br />
                    <span className="hint">
                      {item.variants.map((v) => `${v.label} ${dollars(v.price_cents)}`).join(', ')}
                    </span>
                  </p>
                  <p>
                    <label htmlFor={id}>Price for every variant, in dollars</label>
                    <input
                      id={id}
                      type="text"
                      inputMode="decimal"
                      value={field}
                      disabled={isGuest}
                      aria-invalid={bad || undefined}
                      aria-describedby={described || undefined}
                      onChange={(e) => setFields((f) => ({ ...f, [item.slug]: e.target.value }))}
                    />
                    {sets && (
                      <span id={`${id}-sets`} className="hint">
                        {sets}
                      </span>
                    )}
                    {bad && (
                      <span id={`${id}-error`} className="problem">
                        <strong>{BAD_PRICE.title}.</strong> {BAD_PRICE.detail}
                      </span>
                    )}
                  </p>
                  <p className="actions">
                    <button
                      type="button"
                      disabled={isGuest}
                      aria-disabled={busy || undefined}
                      aria-label={`Set the price of ${item.name}`}
                      onClick={() => {
                        if (busy) return;
                        const cents = parseDollars(field);
                        if (cents === null) {
                          setSaid('');
                          setError(BAD_PRICE);
                          setFieldError(item.slug);
                          return;
                        }
                        void setPrice(item.slug, item.name, cents);
                      }}
                    >
                      Set price
                    </button>
                    <button
                      type="button"
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
                  </p>
                  {draft !== undefined && (
                    <p className="hint">Waiting for publish: price {dollars(draft)}.</p>
                  )}
                  {earlier && (
                    <p className="hint">
                      Waiting for publish: a price drafted before this page loaded.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p>
        <button
          type="button"
          disabled={isGuest}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (busy) return;
            void act(async () => {
              const published = await publishMenu(sandboxId);
              setDrafts({});
              setPending([]);
              setFields({});
              await load();
              setSaid(`Menu published. It is now version ${published.version}.`);
            });
          }}
        >
          Publish menu
        </button>{' '}
        <span className="hint">{waitingText(waiting, pending !== null)}</span>
      </p>
      <Message error={error}>{said && <p className="hint">{said}</p>}</Message>
    </>
  );
}
