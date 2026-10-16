/**
 * The little date arithmetic the admin calendar still does itself (plan.md
 * Task 9). FullCalendar draws the views and renders every time in
 * Africa/Kigali; this covers the edges around it -- reading `?date=` from the
 * URL, placing an all-day block, and turning a fetch range into API dates.
 *
 * The browser's own timezone plays no part (spec §6.5). A calendar day is a
 * `YYYY-MM-DD` string whose arithmetic is done at UTC midnight, where no zone
 * can shift it; an instant becomes a Kigali day through the fixed offset below.
 */

/** A Kigali calendar date, `YYYY-MM-DD`. A day on his wall, not an instant. */
export type KigaliDate = string

export type CalendarView = 'month' | 'week' | 'day'

export const CALENDAR_VIEWS: readonly CalendarView[] = ['month', 'week', 'day']

const MS_PER_DAY = 86_400_000
/** UTC+2 with no DST (spec §6.5), so a constant is exact. */
const KIGALI_UTC_OFFSET_MS = 2 * 3_600_000
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Years below 100 are refused because the API refuses them (its engine's
 *  `Date.UTC` reads them as 19xx); accepting one here would request a range
 *  that can only fail, instead of falling back to today. */
const MIN_YEAR = 100

export function isKigaliDate(value: string): boolean {
  return (
    DATE_PATTERN.test(value) &&
    Number(value.slice(0, 4)) >= MIN_YEAR &&
    !Number.isNaN(utcMidnight(value)) &&
    toDate(utcMidnight(value)) === value
  )
}

/** The Kigali calendar date an instant falls on. */
export function kigaliDateOf(instant: Date | string): KigaliDate {
  return toDate(new Date(instant).getTime() + KIGALI_UTC_OFFSET_MS)
}

export function addDays(date: KigaliDate, days: number): KigaliDate {
  return toDate(utcMidnight(date) + days * MS_PER_DAY)
}

function utcMidnight(date: KigaliDate): number {
  return Date.parse(`${date}T00:00:00Z`)
}

function toDate(epochMs: number): KigaliDate {
  return new Date(epochMs).toISOString().slice(0, 10)
}
