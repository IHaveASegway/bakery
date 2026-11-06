import { groupBakeLines, type BakeList as Day } from '../lib/kitchen';
import { clockLabel, mountainLocal } from '../lib/slots';
import { dateLabel } from '../lib/schedule';
import { HOW } from '../tour/how';

/** `country-loaf` as "country loaf". */
const itemWords = (slug: string) => slug.replaceAll('-', ' ');

/** "9:45 am" for a business time, as the bakery's wall clock reads it. */
function startWords(start: string): string {
  const ms = Date.parse(start);
  if (Number.isNaN(ms)) return start;
  const l = mountainLocal(ms);
  return clockLabel(l.hour * 60 + l.minute);
}

/**
 * The kitchen board's bake lists, one panel per bakery day, today first: what to have ready for
 * each pickup slot or delivery window, and how many places are reserved that day. The Kitchen
 * draws it from the Schedule's events and never decides it.
 */
export default function BakeList({ lists, today }: { lists: Day[]; today: string }) {
  return (
    <>
      <h3 id="bake-heading" data-tour="kitchen-bake">
        Bake list
      </h3>
      {lists.length === 0 ? (
        <p className="hint">
          No day has a plan yet. A day gets one when an order for it is paid, or when the clock
          moves to it.
        </p>
      ) : (
        lists.map((day) => {
          const groups = groupBakeLines(day.lines);
          return (
            <section key={day.date} aria-labelledby={`bake-${day.date}`} className="column">
              <h4 id={`bake-${day.date}`}>
                {dateLabel(day.date)}
                {day.date === today && ' (today)'}
              </h4>
              <p className="hint">
                Version {day.version}. {day.reserved} {day.reserved === 1 ? 'place' : 'places'}{' '}
                reserved.
              </p>
              {groups.length === 0 ? (
                <p className="hint">Nothing to bake yet for this day.</p>
              ) : (
                <ul className="cards">
                  {groups.map((group) => (
                    <li key={group.start} className="card">
                      <p>
                        <strong>
                          <time dateTime={group.start}>{startWords(group.start)}</time>
                        </strong>
                      </p>
                      <ul className="card-lines">
                        {group.items.map((line) => (
                          <li key={line.item}>
                            {line.qty} × {itemWords(line.item)}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
      <p className="hint">How this works: {HOW.bake}</p>
    </>
  );
}
