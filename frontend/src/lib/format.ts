/**
 * Kigali/RWF formatting. The backend holds its own copy of this file
 * (plan.md, Stack decisions: no shared package); both are asserted against
 * `docs/fixtures/format.json`, so a divergence fails a test in both projects.
 */

/** UTC+2, no DST (spec §6.5). Every instant is stored UTC and rendered here. */
export const TIME_ZONE = 'Africa/Kigali'

/** Prices are whole RWF integers. There is no minor unit. */
export const CURRENCY = 'RWF'

/** Thrown when an amount is not a whole number of RWF. */
export class MoneyPrecisionError extends Error {
  override readonly name = 'MoneyPrecisionError'

  constructor(amount: number) {
    super(`Money must be a whole number of ${CURRENCY}, received ${amount}`)
  }
}

const dateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

// A calendar date or month is a day on the wall, not an instant, so it is
// formatted at UTC midnight in UTC, where no zone can move it to another day.
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

const monthFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' })

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

const numberFormatter = new Intl.NumberFormat('en-GB')

/** Renders a UTC instant as Kigali wall time: `1 Jul 2026, 08:00`. */
export function formatDateTime(instant: Date | string): string {
  const date = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid date: ${String(instant)}`)
  }
  return dateTimeFormatter.format(date)
}

/** Renders a UTC instant as a Kigali clock time: `08:00`. */
export function formatTime(instant: Date | string): string {
  const date = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid date: ${String(instant)}`)
  }
  return timeFormatter.format(date)
}

/** Renders a Kigali calendar date, `YYYY-MM-DD`: `Wednesday, 1 July 2026`. */
export function formatDate(date: string): string {
  const midnight = new Date(`${date}T00:00:00Z`)
  // The round trip refuses a day the calendar does not have, such as 2026-02-30.
  if (!DATE_PATTERN.test(date) || Number.isNaN(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`Expected a YYYY-MM-DD date, received: ${date}`)
  }
  return dateFormatter.format(midnight)
}

/** Renders a calendar month, `YYYY-MM`: `October 2026`. */
export function formatMonth(month: string): string {
  if (!MONTH_PATTERN.test(month)) {
    throw new RangeError(`Expected a YYYY-MM month, received: ${month}`)
  }
  return monthFormatter.format(new Date(`${month}-01T00:00:00Z`))
}

/** Renders a whole-RWF amount: `45,000 RWF`. Throws on anything else. */
export function formatMoney(amountRwf: number): string {
  if (!Number.isInteger(amountRwf)) {
    throw new MoneyPrecisionError(amountRwf)
  }
  return `${numberFormatter.format(amountRwf)} ${CURRENCY}`
}
