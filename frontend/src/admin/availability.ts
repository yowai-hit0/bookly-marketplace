import { z } from 'zod'
import { ApiError, adminFetch } from './api'
import { formatMinuteOfDay } from './catalogue'

/**
 * Working hours and availability blocks (plan.md Task 8, spec §3.3, §6.3,
 * §6.4). Both answer the same question -- when can a client book? -- so one
 * page edits them and one module talks to their two endpoints.
 *
 * The form schemas are a convenience with no authority: the API revalidates
 * every payload. They turn a form's strings into the payload the API takes and
 * name the fields that are wrong.
 *
 * Nothing here reads the browser's timezone. A working-hours window is a minute
 * of the day, which no zone applies to; a block's instants are built from Kigali
 * wall time and the fixed +02:00 offset (spec §6.5).
 */

/** The API numbers weekdays with `getUTCDay`: 0 is Sunday. */
export const SUNDAY = 0

/** Monday first, the week as the photographer reads it. */
export const WEEKDAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, SUNDAY]

/** Kigali is UTC+2 all year (spec §6.5), so a literal offset is exact. */
const KIGALI_OFFSET = '+02:00'

const MAX_NOTE_LENGTH = 500

export type AdminWorkingHours = {
  id: string
  /** 0-6, or null when this row is a dated override. */
  weekday: number | null
  /** `YYYY-MM-DD`, or null when this row is a weekly rule. */
  effectiveDate: string | null
  opensMinute: number | null
  closesMinute: number | null
  isOpen: boolean
  note: string | null
}

export type AdminBlock = {
  id: string
  startsAt: string
  endsAt: string
  isAllDay: boolean
  /** Private to the admin; the public side never selects it (spec P-03). */
  reason: string | null
}

/** A confirmed booking a block would cover (spec §6.4). */
export type OverlappingBooking = {
  id: string
  reference: string
  contactName: string
  startsAt: string
  endsAt: string
}

const overlapSchema = z.object({
  error: z.literal('block_overlaps_confirmed_bookings'),
  bookings: z.array(
    z.object({
      id: z.string(),
      reference: z.string(),
      contactName: z.string(),
      startsAt: z.string(),
      endsAt: z.string(),
    }),
  ),
})

/**
 * The bookings a refused save would have covered, or null when the error is
 * anything else. The API answers 409 rather than saving, and the same payload
 * resent with `confirm: true` goes through (spec §6.4).
 */
export function overlappingBookingsOf(error: unknown): OverlappingBooking[] | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const parsed = overlapSchema.safeParse(error.body)
  return parsed.success ? parsed.data.bookings : null
}

// --- API -------------------------------------------------------------------------

function send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return adminFetch<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

export const availabilityApi = {
  loadWorkingHours: () => adminFetch<{ workingHours: AdminWorkingHours[] }>('/admin/working-hours'),
  createWorkingHours: (body: WorkingHoursPayload) =>
    send<{ workingHours: AdminWorkingHours }>('POST', '/admin/working-hours', body),
  /** A PUT replaces the whole row, key included, so a rule can move to another day. */
  updateWorkingHours: (id: string, body: WorkingHoursPayload) =>
    send<{ workingHours: AdminWorkingHours }>('PUT', `/admin/working-hours/${id}`, body),
  deleteWorkingHours: (id: string) => send<void>('DELETE', `/admin/working-hours/${id}`),

  loadBlocks: () => adminFetch<{ blocks: AdminBlock[] }>('/admin/blocks'),
  createBlock: (body: BlockPayload) => send<{ block: AdminBlock }>('POST', '/admin/blocks', body),
  updateBlock: (id: string, body: BlockPayload) => send<{ block: AdminBlock }>('PUT', `/admin/blocks/${id}`, body),
  deleteBlock: (id: string) => send<void>('DELETE', `/admin/blocks/${id}`),
}

// --- Times and dates -------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/** A calendar date the API will accept. Years below 100 are refused there. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value) || Number(value.slice(0, 4)) < 100) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function isClockTime(value: string): boolean {
  return TIME_PATTERN.test(value)
}

/** `09:00` → `540`. A minute of the day, not an instant, so no zone applies. */
export function minuteOfDayOf(time: string): number {
  const [hours = '0', minutes = '0'] = time.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/** A Kigali wall-clock date and time as the instant it names. */
export function kigaliInstant(date: string, time: string): string {
  return `${date}T${time}:00${KIGALI_OFFSET}`
}

/** The Kigali wall-clock date and time an instant falls on. */
export function kigaliWallTime(instant: string): { date: string; time: string } {
  const shifted = new Date(Date.parse(instant) + 2 * 3_600_000).toISOString()
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) }
}

export { formatMinuteOfDay }

// --- Working-hours form ----------------------------------------------------------

export type WorkingHoursFields = {
  opensMinute: number | null
  closesMinute: number | null
  isOpen: boolean
  note: string | null
}

/**
 * A weekly rule or a dated override, never both: the API takes a union of
 * strict objects, so sending both keys is a malformed request rather than a
 * rule violation.
 */
export type WorkingHoursPayload =
  | ({ weekday: number } & WorkingHoursFields)
  | ({ effectiveDate: string } & WorkingHoursFields)

const blankToNull = (value: string) => (value.trim() === '' ? null : value.trim())

export const workingHoursFormSchema = z
  .object({
    kind: z.enum(['weekday', 'date']),
    weekday: z.string(),
    effectiveDate: z.string(),
    isOpen: z.boolean(),
    opens: z.string(),
    closes: z.string(),
    note: z.string(),
  })
  .superRefine((values, ctx) => {
    const fail = (path: string) => ctx.addIssue({ code: 'custom', path: [path], message: path })

    if (values.kind === 'weekday') {
      if (!/^[0-6]$/.test(values.weekday)) fail('weekday')
    } else if (!isCalendarDate(values.effectiveDate)) {
      fail('effectiveDate')
    }

    // A closed day needs no window; the API stores nulls for it.
    if (values.isOpen) {
      if (!isClockTime(values.opens)) fail('opens')
      if (!isClockTime(values.closes)) fail('closes')
      else if (isClockTime(values.opens) && minuteOfDayOf(values.closes) <= minuteOfDayOf(values.opens)) fail('closes')
    }

    if (values.note.trim().length > MAX_NOTE_LENGTH) fail('note')
  })
  .transform((values): WorkingHoursPayload => {
    const fields: WorkingHoursFields = {
      isOpen: values.isOpen,
      opensMinute: values.isOpen ? minuteOfDayOf(values.opens) : null,
      closesMinute: values.isOpen ? minuteOfDayOf(values.closes) : null,
      note: blankToNull(values.note),
    }
    return values.kind === 'weekday'
      ? { weekday: Number(values.weekday), ...fields }
      : { effectiveDate: values.effectiveDate, ...fields }
  })

export type WorkingHoursFormValues = {
  kind: 'weekday' | 'date'
  weekday: string
  effectiveDate: string
  isOpen: boolean
  opens: string
  closes: string
  note: string
}

const DEFAULT_OPENS = '09:00'
const DEFAULT_CLOSES = '17:00'

export function workingHoursFormValues(row?: AdminWorkingHours): WorkingHoursFormValues {
  return {
    kind: row?.effectiveDate == null ? 'weekday' : 'date',
    weekday: row?.weekday == null ? '1' : String(row.weekday),
    effectiveDate: row?.effectiveDate ?? '',
    isOpen: row?.isOpen ?? true,
    opens: row?.opensMinute == null ? DEFAULT_OPENS : formatMinuteOfDay(row.opensMinute),
    closes: row?.closesMinute == null ? DEFAULT_CLOSES : formatMinuteOfDay(row.closesMinute),
    note: row?.note ?? '',
  }
}

// --- Block form ------------------------------------------------------------------

export type BlockPayload =
  | { isAllDay: true; startDate: string; endDate: string; reason: string | null; confirm: boolean }
  | { isAllDay: false; startsAt: string; endsAt: string; reason: string | null; confirm: boolean }

export const blockFormSchema = z
  .object({
    mode: z.enum(['all-day', 'time-range']),
    startDate: z.string(),
    endDate: z.string(),
    date: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    reason: z.string(),
  })
  .superRefine((values, ctx) => {
    const fail = (path: string) => ctx.addIssue({ code: 'custom', path: [path], message: path })

    if (values.mode === 'all-day') {
      if (!isCalendarDate(values.startDate)) fail('startDate')
      if (!isCalendarDate(values.endDate)) fail('endDate')
      // ISO dates order correctly as strings.
      else if (isCalendarDate(values.startDate) && values.endDate < values.startDate) fail('endDate')
    } else {
      if (!isCalendarDate(values.date)) fail('date')
      if (!isClockTime(values.startTime)) fail('startTime')
      if (!isClockTime(values.endTime)) fail('endTime')
      else if (isClockTime(values.startTime) && values.endTime <= values.startTime) fail('endTime')
    }

    if (values.reason.trim().length > MAX_NOTE_LENGTH) fail('reason')
  })
  .transform((values): BlockPayload => {
    const reason = blankToNull(values.reason)
    return values.mode === 'all-day'
      ? { isAllDay: true, startDate: values.startDate, endDate: values.endDate, reason, confirm: false }
      : {
          isAllDay: false,
          startsAt: kigaliInstant(values.date, values.startTime),
          endsAt: kigaliInstant(values.date, values.endTime),
          reason,
          confirm: false,
        }
  })

export type BlockFormValues = {
  mode: 'all-day' | 'time-range'
  startDate: string
  endDate: string
  date: string
  startTime: string
  endTime: string
  reason: string
}

/** `today` prefills a new block, so the calendar can open the form on the day in view. */
export function blockFormValues(block?: AdminBlock, today = ''): BlockFormValues {
  if (block === undefined) {
    return {
      mode: 'all-day',
      startDate: today,
      endDate: today,
      date: today,
      startTime: DEFAULT_OPENS,
      endTime: DEFAULT_CLOSES,
      reason: '',
    }
  }

  const from = kigaliWallTime(block.startsAt)
  const to = kigaliWallTime(block.endsAt)
  // An all-day block ends at the midnight after its last day, so the inclusive
  // last day is the day before that boundary.
  const lastDay = kigaliWallTime(new Date(Date.parse(block.endsAt) - 1).toISOString()).date

  return {
    mode: block.isAllDay ? 'all-day' : 'time-range',
    startDate: from.date,
    endDate: block.isAllDay ? lastDay : from.date,
    date: from.date,
    startTime: block.isAllDay ? DEFAULT_OPENS : from.time,
    endTime: block.isAllDay ? DEFAULT_CLOSES : to.time,
    reason: block.reason ?? '',
  }
}
