import { useCallback, useEffect, useState } from 'react';
import type { MenuItemPatch, MenuResponse } from '../contracts';
import { getMenu, patchMenuItem, publishMenu } from '../lib/api';
import { describeError, type Message as Text } from '../lib/messages';
import { dollars, dollarsField, parseDollars } from '../lib/money';
import GuestNote from './GuestNote';
import Message from './Message';

interface Draft {
  price_cents?: number;
  status?: 'paused' | 'available';
}

/**
 * Staff edits are drafts until "Publish menu": the price applies to every variant of an item, and
 * one publish bumps the version, which is what invalidates the cached menu (docs/domain.md,
 * "MenuItem availability"). The list shows what is published; a note shows what waits.
 */
export default function MenuEditor({
  sandboxId,
  isGuest,
}: {
  sandboxId: string;
  isGuest: boolean;
}) {
  const [menu, setMenu] = useState<MenuResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // The slugs the API says wait for a publish (its answer to every edit).
  const [pending, setPending] = useState<string[]>([]);
  const [fields, setFields] = useState<Record<string, string>>({});
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
    setSaid('');
    try {
      await run();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const patch = (slug: string, body: MenuItemPatch, draft: Draft, said: string) =>
    act(async () => {
      const edit = await patchMenuItem(sandboxId, slug, body);
      setPending(edit.pending);
      setDrafts((d) => ({ ...d, [slug]: { ...d[slug], ...draft } }));
      setSaid(said);
    });

  const waiting = pending.length;

  return (
    <>
      <h3 data-tour="controls-menu">Menu</h3>
      <p>
        Version {menu?.version ?? '…'} is published. Changes wait as drafts until you publish; one
        publish makes a new version, and the next read of the menu misses the cache once.
      </p>
      {isGuest && <GuestNote />}
      {menu?.categories.map((category) => (
        <section key={category.slug} aria-labelledby={`edit-${category.slug}`}>
          <h4 id={`edit-${category.slug}`}>{category.name}</h4>
          <ul className="editor">
            {category.items.map((item) => {
              const draft = drafts[item.slug];
              const status = draft?.status ?? item.status;
              const field = fields[item.slug] ?? dollarsField(item.variants[0]?.price_cents ?? 0);
              const id = `price-${item.slug}`;
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
                      onChange={(e) => setFields((f) => ({ ...f, [item.slug]: e.target.value }))}
                    />
                  </p>
                  <p className="actions">
                    <button
                      type="button"
                      disabled={busy || isGuest}
                      aria-label={`Set the price of ${item.name}`}
                      onClick={() => {
                        const cents = parseDollars(field);
                        if (cents === null) {
                          setError({
                            title: 'That is not a price',
                            detail:
                              'Type dollars and cents, such as 9.50. A price is more than zero.',
                          });
                          return;
                        }
                        void patch(
                          item.slug,
                          { price_cents: cents },
                          { price_cents: cents },
                          `${item.name}: ${dollars(cents)} drafted for every variant.`,
                        );
                      }}
                    >
                      Set price
                    </button>
                    <button
                      type="button"
                      disabled={busy || isGuest}
                      aria-label={`${status === 'paused' ? 'Resume' : 'Pause'} ${item.name}`}
                      onClick={() => {
                        const next = status === 'paused' ? 'available' : 'paused';
                        void patch(
                          item.slug,
                          { status: next },
                          { status: next },
                          `${item.name}: ${next === 'paused' ? 'pause' : 'resume'} drafted.`,
                        );
                      }}
                    >
                      {status === 'paused' ? 'Resume' : 'Pause'}
                    </button>
                  </p>
                  {draft && (
                    <p className="hint">
                      Waiting for publish:
                      {draft.price_cents !== undefined && ` price ${dollars(draft.price_cents)}`}
                      {draft.status !== undefined && ` ${draft.status}`}.
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
          disabled={busy || isGuest}
          onClick={() =>
            void act(async () => {
              const published = await publishMenu(sandboxId);
              setDrafts({});
              setPending([]);
              setFields({});
              await load();
              setSaid(`Menu published. It is now version ${published.version}.`);
            })
          }
        >
          Publish menu
        </button>{' '}
        <span className="hint">
          {waiting} {waiting === 1 ? 'item' : 'items'} with changes waiting.
        </span>
      </p>
      <Message error={error}>{said && <p className="hint">{said}</p>}</Message>
    </>
  );
}
