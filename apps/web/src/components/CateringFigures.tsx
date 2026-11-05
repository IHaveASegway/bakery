import type { CateringResponse } from '../contracts';
import { estimate, figuresOf, packageLabel, stateLabel, venueLabel } from '../lib/catering';
import { dollars } from '../lib/money';
import { dateLabel, startText } from '../lib/schedule';

/**
 * One event's facts and figures as the API sent them: the day, package, headcount and venue, the
 * quote with its deadline, the deposit and balance, the payment and invoice once there are some.
 * Before a quote it shows what the package would come to, labelled as an estimate: the figures
 * that count are the API's.
 */
export default function CateringFigures({ event }: { event: CateringResponse }) {
  const figures = figuresOf(event);
  const guess = figures === null ? estimate(event) : null;
  return (
    <dl className="totals">
      <dt>State</dt>
      <dd>
        <strong>{stateLabel(event.state)}</strong>
      </dd>
      <dt>Day</dt>
      <dd>{dateLabel(event.date)}</dd>
      <dt>Package</dt>
      <dd>{packageLabel(event.package)}</dd>
      <dt>Headcount</dt>
      <dd>{event.headcount}</dd>
      <dt>Venue</dt>
      <dd>{venueLabel(event.venue)}</dd>
      {figures !== null && (
        <>
          <dt>Quote</dt>
          <dd>
            <strong>{dollars(figures.total_cents)}</strong>
          </dd>
          <dt>Deposit (25%)</dt>
          <dd>{dollars(figures.deposit_cents)}</dd>
          <dt>Balance</dt>
          <dd>{dollars(figures.balance_cents)}</dd>
        </>
      )}
      {guess !== null && (
        <>
          <dt>Estimate</dt>
          <dd>{dollars(guess.total_cents)} at the package price; the bakery’s quote may differ</dd>
        </>
      )}
      {event.valid_until && (
        <>
          <dt>Quote valid until</dt>
          <dd>
            <time dateTime={event.valid_until}>{startText(event.valid_until)}</time>
          </dd>
        </>
      )}
      {event.deposit_payment && (
        <>
          <dt>Deposit payment</dt>
          <dd>
            <code>{event.deposit_payment}</code>
          </dd>
        </>
      )}
      {event.invoice && (
        <>
          <dt>Balance invoice</dt>
          <dd>
            <code>{event.invoice}</code>
            {event.invoice_due && <>, due {dateLabel(event.invoice_due)}</>}
          </dd>
        </>
      )}
      {event.refund_deposit !== null && event.refund_deposit !== undefined && (
        <>
          <dt>Deposit on cancelling</dt>
          <dd>{event.refund_deposit ? 'goes back' : 'stays with the bakery'}</dd>
        </>
      )}
    </dl>
  );
}
