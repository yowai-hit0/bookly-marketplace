import { type KigaliDate, addDays, kigaliDateOf } from '@/admin/calendar-dates'
import { env } from '@/env'

/**
 * Public availability, as `GET /api/availability` serves it (plan.md Task 12),
 * plus the month arithmetic the slot picker needs. Every rule that decides a
 * start lives in the API's engine; nothing here filters, adds or caches one.
 *
 * Months and days are Kigali calendar values (spec §6.5). The browser's own
 * timezone plays no part: "this month" is read off the Kigali date of now.
 */

/** A Kigali calendar month, `YYYY-MM`. */
export type KigaliMonth = string

export type DayAvailability = {
  date: KigaliDate
  /** ISO-8601 UTC instants, ascending. */
  starts: string[]
}

/** The API could not be reached, or refused the request. `status` is null for a network failure. */
export class AvailabilityLoadError extends Error {
  override readonly name = 'AvailabilityLoadError'
  readonly status: number | null

  constructor(status: number | null) {
    super(status === null ? 'network_error' : `http_${status}`)
    this.status = status
  }
}

export async function fetchAvailability(
  packageId: string,
  month: KigaliMonth,
  signal?: AbortSignal,
): Promise<DayAvailability[]> {
  const query = new URLSearchParams({ packageId, month })
  let res: Response
  try {
    // `no-store`: a remembered copy is how a visitor picks a slot taken a minute ago.
    res = await fetch(`${env.VITE_API_BASE_URL}/availability?${query}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new AvailabilityLoadError(null)
  }
  if (!res.ok) throw new AvailabilityLoadError(res.status)
  let body: unknown
  try {
    body = await res.json()
  } catch (error) {
    if (signal?.aborted) throw error
    throw new AvailabilityLoadError(res.status)
  }
  const days = (body as { days?: unknown } | null)?.days
  if (!Array.isArray(days)) throw new AvailabilityLoadError(res.status)
  return days as DayAvailability[]
}

export function kigaliMonthOf(instant: Date | string): KigaliMonth {
  return kigaliDateOf(instant).slice(0, 7)
}

export function addMonths(month: KigaliMonth, months: number): KigaliMonth {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number]
  const index = year * 12 + (monthNumber - 1) + months
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`
}

/**
 * The month as a Monday-first grid: `null` for each blank before the 1st, then
 * every date of the month. Rwanda's week starts on Monday.
 */
export function monthGrid(month: KigaliMonth): (KigaliDate | null)[] {
  const first = `${month}-01`
  // 0 = Sunday ... 6 = Saturday; shifted so Monday is column 0.
  const leadingBlanks = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7

  const cells: (KigaliDate | null)[] = Array.from({ length: leadingBlanks }, () => null)
  for (let date = first; date.startsWith(month); date = addDays(date, 1)) {
    cells.push(date)
  }
  return cells
}
