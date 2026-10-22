import { addDays, isKigaliDate, kigaliDateOf } from '@/admin/calendar-dates'
import { DIRECTORY_PARAMS, type DirectoryParam, type DirectoryQuery } from '@/catalogue/api'

/**
 * The directory's state lives in its URL (`design-system/bookly/pages/
 * directory.md`; marketplace spec R6.3): `/photographers?category&district&
 * min&max&date&page`. This module reads the URL into filters and writes
 * filters back, so a filtered page is shareable and Back undoes a change.
 *
 * Empty values are never written (the API answers an empty value with 400),
 * nor are unknown keys; a repeated key counts once, by its first value.
 * Values are otherwise passed through as typed: the API is the judge, and its
 * 422 names what it refuses.
 */

/** The four filters a visitor sets; `page` is navigation, not a filter. */
export type FilterKey = Exclude<DirectoryParam, 'page'>

/** How far ahead a date may be, as the API accepts (`DIRECTORY_DATE_HORIZON_DAYS`). */
export const DATE_HORIZON_DAYS = 365

/** The filters in a URL: the first non-empty value of each known key. */
export function readQuery(params: URLSearchParams): DirectoryQuery {
  const query: DirectoryQuery = {}
  for (const key of DIRECTORY_PARAMS) {
    const value = params.get(key)?.trim()
    if (value) query[key] = value
  }
  return query
}

/** The URL for `query`: known keys only, in a fixed order, no empty value, and no `page=1`. */
export function writeQuery(query: DirectoryQuery): URLSearchParams {
  const params = new URLSearchParams()
  for (const key of DIRECTORY_PARAMS) {
    const value = query[key]?.trim()
    if (!value || (key === 'page' && value === '1')) continue
    params.set(key, value)
  }
  return params
}

/** `query` with `changes` applied; any filter change starts again at page 1. */
export function withFilters(query: DirectoryQuery, changes: Partial<Record<FilterKey, string | null>>): DirectoryQuery {
  const next: DirectoryQuery = { ...query }
  delete next.page
  for (const [key, value] of Object.entries(changes) as [FilterKey, string | null | undefined][]) {
    const trimmed = value?.trim()
    if (trimmed) next[key] = trimmed
    else delete next[key]
  }
  return next
}

/** `query` on another page. */
export function onPage(query: DirectoryQuery, page: number): DirectoryQuery {
  return { ...query, page: String(page) }
}

/** The page the URL asks for: a whole number from 1, else 1. */
export function pageNumber(query: DirectoryQuery): number {
  const page = Number(query.page)
  return Number.isInteger(page) && page >= 1 ? page : 1
}

/** One chip per active filter: the price range is one chip. */
export type ActiveFilter = 'category' | 'district' | 'price' | 'date'

export function activeFilters(query: DirectoryQuery): ActiveFilter[] {
  const active: ActiveFilter[] = []
  if (query.category) active.push('category')
  if (query.district) active.push('district')
  if (query.min || query.max) active.push('price')
  if (query.date) active.push('date')
  return active
}

/** Whether a typed price is whole RWF, digits only (12 at most, as the API reads them). */
export function isWholeAmount(value: string): boolean {
  return /^\d{1,12}$/.test(value)
}

/** Today in Kigali, and the last date the directory accepts. */
export function dateWindow(now: Date = new Date()): { min: string; max: string } {
  const today = kigaliDateOf(now)
  return { min: today, max: addDays(today, DATE_HORIZON_DAYS) }
}

/** Whether `value` is a real calendar date, so it can be formatted for a chip or a sentence. */
export function isCalendarDate(value: string | undefined): value is string {
  return value !== undefined && isKigaliDate(value)
}

/** The sentence a refused field is worded with (the API's `422 fields`), by field. */
export type FieldErrors = Partial<Record<FilterKey | 'price' | 'page', string>>

/**
 * The i18n keys for the fields a 422 names. `min` and `max` together, with the
 * lowest above the highest, is one sentence on the price group; either alone
 * is too large (a negative cannot be typed: it is not digits).
 */
export function fieldErrorKeys(fields: readonly string[], query: DirectoryQuery): FieldErrors {
  const errors: FieldErrors = {}
  if (fields.includes('category')) errors.category = 'directory:invalid.category'
  if (fields.includes('district')) errors.district = 'directory:invalid.district'
  const min = fields.includes('min')
  const max = fields.includes('max')
  if (min && max && query.min !== undefined && query.max !== undefined && Number(query.min) > Number(query.max)) {
    errors.price = 'directory:invalid.minAboveMax'
  } else {
    if (min) errors.min = 'directory:invalid.amount'
    if (max) errors.max = 'directory:invalid.amount'
  }
  if (fields.includes('date')) errors.date = 'directory:invalid.date'
  if (fields.includes('page')) errors.page = 'directory:invalid.page'
  return errors
}

/** Which chip a refused field belongs to. */
export function chipOf(field: keyof FieldErrors): ActiveFilter | null {
  if (field === 'min' || field === 'max' || field === 'price') return 'price'
  if (field === 'page') return null
  return field
}
