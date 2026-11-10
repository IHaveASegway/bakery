import { bakeLineText, groupBakeLines, type BakeList as Day } from '../lib/kitchen';
import { dateLabel } from '../lib/schedule';
import { clockOfText } from '../lib/when';

/**
 * The kitchen board's bake lists, one panel per bakery day, today first: what to have ready for
 * each pickup slot or delivery window, and how many places are reserved that day. The Kitchen
 * draws it from the Schedule's events and never decides it.
 */
export default function BakeList({ lists, today }: { lists: Day[]; today: string }) {
  return (
    <>
      <h3 id="bake-heading" tabIndex={-1} data-tour="kitchen-bake">
        Bake list
      </h3>
      {lists.length === 0 ? (
        <p className="hint">
          No day from today on has a plan yet. A day gets one when an order or a catering deposit
          for it is paid. Moving the clock does not make one: it only changes which day is today.
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
                          <time dateTime={group.start}>{clockOfText(group.start)}</time>
                        </strong>
                      </p>
                      <ul className="card-lines">
                        {group.items.map((line) => (
                          <li key={line.item}>{bakeLineText(line)}</li>
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
    </>
  );
}
