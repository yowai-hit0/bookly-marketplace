import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import {
  type AdminBlock,
  type AdminWorkingHours,
  type BlockFormValues,
  type WorkingHoursFormValues,
  blockFormSchema,
  blockFormValues,
  isCalendarDate,
  kigaliInstant,
  kigaliWallTime,
  minuteOfDayOf,
  overlappingBookingsOf,
  workingHoursFormSchema,
  workingHoursFormValues,
} from './availability'

/**
 * The availability forms' own rules (plan.md Task 8). They are a convenience
 * with no authority -- the API revalidates everything -- so what matters here
 * is that they produce exactly the payload the API takes, and that the two
 * shapes each endpoint accepts never blur into one.
 */

const hoursInput: WorkingHoursFormValues = {
  kind: 'weekday',
  weekday: '1',
  effectiveDate: '',
  isOpen: true,
  opens: '09:00',
  closes: '17:00',
  note: '',
}

const blockInput: BlockFormValues = {
  mode: 'all-day',
  startDate: '2026-10-07',
  endDate: '2026-10-09',
  date: '2026-10-07',
  startTime: '14:00',
  endTime: '16:00',
  reason: '',
}

/** The field names a failed parse blames, so a form can mark them. */
function badFields(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  return result.success ? [] : [...new Set(result.error?.issues.map((issue) => String(issue.path[0])) ?? [])]
}

describe('the working-hours form schema', () => {
  it('turns a weekly rule into a payload carrying the weekday and no date', () => {
    const result = workingHoursFormSchema.safeParse({ ...hoursInput, weekday: '3', note: '  Late start  ' })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      weekday: 3,
      opensMinute: 540,
      closesMinute: 1020,
      isOpen: true,
      note: 'Late start',
    })
    // Sending both keys would be a malformed request, not a resolved choice.
    expect(result.data).not.toHaveProperty('effectiveDate')
  })

  it('turns a dated override into a payload carrying the date and no weekday', () => {
    const result = workingHoursFormSchema.safeParse({
      ...hoursInput,
      kind: 'date',
      effectiveDate: '2026-12-24',
      closes: '12:30',
    })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      effectiveDate: '2026-12-24',
      opensMinute: 540,
      closesMinute: 750,
      isOpen: true,
      note: null,
    })
    expect(result.data).not.toHaveProperty('weekday')
  })

  it('stores no window for a closed day, whatever times are in the form', () => {
    const result = workingHoursFormSchema.safeParse({ ...hoursInput, isOpen: false, opens: 'nonsense', closes: '' })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ isOpen: false, opensMinute: null, closesMinute: null })
  })

  it.each<[string, Partial<typeof hoursInput>, string[]]>([
    ['no weekday chosen', { weekday: '' }, ['weekday']],
    ['a weekday outside 0-6', { weekday: '7' }, ['weekday']],
    ['a malformed date', { kind: 'date', effectiveDate: '24/12/2026' }, ['effectiveDate']],
    ['a date the calendar does not have', { kind: 'date', effectiveDate: '2026-02-30' }, ['effectiveDate']],
    ['an unparseable opening time', { opens: '9am' }, ['opens']],
    ['a 25th hour', { opens: '25:00' }, ['opens']],
    ['a closing time before the opening one', { opens: '17:00', closes: '09:00' }, ['closes']],
    ['a closing time equal to the opening one', { opens: '09:00', closes: '09:00' }, ['closes']],
    ['a note over 500 characters', { note: 'x'.repeat(501) }, ['note']],
  ])('refuses %s and blames that field', (_label, patch, expected) => {
    const result = workingHoursFormSchema.safeParse({ ...hoursInput, ...patch })

    expect(result.success).toBe(false)
    expect(badFields(result)).toEqual(expected)
  })
})

describe('working-hours form values', () => {
  it('opens a new row on Monday, open, with the seeded window', () => {
    expect(workingHoursFormValues()).toEqual({
      kind: 'weekday',
      weekday: '1',
      effectiveDate: '',
      isOpen: true,
      opens: '09:00',
      closes: '17:00',
      note: '',
    })
  })

  it('reads an existing weekly rule back into the form', () => {
    const row: AdminWorkingHours = {
      id: 'w1',
      weekday: 6,
      effectiveDate: null,
      opensMinute: 600,
      closesMinute: 810,
      isOpen: true,
      note: 'Short Saturdays',
    }

    expect(workingHoursFormValues(row)).toMatchObject({
      kind: 'weekday',
      weekday: '6',
      opens: '10:00',
      closes: '13:30',
      note: 'Short Saturdays',
    })
  })

  it('reads a closed dated override back as a date with the default window', () => {
    const row: AdminWorkingHours = {
      id: 'w2',
      weekday: null,
      effectiveDate: '2026-12-25',
      opensMinute: null,
      closesMinute: null,
      isOpen: false,
      note: null,
    }

    expect(workingHoursFormValues(row)).toMatchObject({
      kind: 'date',
      effectiveDate: '2026-12-25',
      isOpen: false,
      opens: '09:00',
      closes: '17:00',
    })
  })
})

describe('the block form schema', () => {
  it('sends whole days as inclusive Kigali dates, leaving the instants to the API', () => {
    const result = blockFormSchema.safeParse({ ...blockInput, reason: 'Away' })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      isAllDay: true,
      startDate: '2026-10-07',
      endDate: '2026-10-09',
      reason: 'Away',
      confirm: false,
    })
  })

  it('accepts a single whole day', () => {
    const result = blockFormSchema.safeParse({ ...blockInput, endDate: '2026-10-07' })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ startDate: '2026-10-07', endDate: '2026-10-07' })
  })

  it('sends part of a day as instants carrying the Kigali offset, never a bare local time', () => {
    const result = blockFormSchema.safeParse({ ...blockInput, mode: 'time-range' })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      isAllDay: false,
      startsAt: '2026-10-07T14:00:00+02:00',
      endsAt: '2026-10-07T16:00:00+02:00',
      reason: null,
      confirm: false,
    })
    // The offset is the point: read in any zone, these name the same instants.
    expect(Date.parse('2026-10-07T14:00:00+02:00')).toBe(Date.UTC(2026, 9, 7, 12, 0, 0))
  })

  it('never asks to save over bookings on the first attempt', () => {
    const allDay = blockFormSchema.safeParse(blockInput)
    const timed = blockFormSchema.safeParse({ ...blockInput, mode: 'time-range' })

    expect(allDay.data).toMatchObject({ confirm: false })
    expect(timed.data).toMatchObject({ confirm: false })
  })

  it.each<[string, Partial<typeof blockInput>, string[]]>([
    ['a last day before the first', { endDate: '2026-10-06' }, ['endDate']],
    ['a malformed first day', { startDate: '7 Oct' }, ['startDate']],
    ['a date the calendar does not have', { endDate: '2026-11-31' }, ['endDate']],
    ['an unparseable start time', { mode: 'time-range', startTime: '2pm' }, ['startTime']],
    ['an end time before the start', { mode: 'time-range', startTime: '16:00', endTime: '14:00' }, ['endTime']],
    ['an end time equal to the start', { mode: 'time-range', startTime: '14:00', endTime: '14:00' }, ['endTime']],
    ['a reason over 500 characters', { reason: 'x'.repeat(501) }, ['reason']],
  ])('refuses %s and blames that field', (_label, patch, expected) => {
    const result = blockFormSchema.safeParse({ ...blockInput, ...patch })

    expect(result.success).toBe(false)
    expect(badFields(result)).toEqual(expected)
  })

  it('ignores the fields the other shape uses, so a half-filled form still saves', () => {
    const result = blockFormSchema.safeParse({ ...blockInput, mode: 'time-range', startDate: '', endDate: 'rubbish' })

    expect(result.success).toBe(true)
  })
})

describe('block form values', () => {
  it('reads a multi-day block back as its inclusive first and last days', () => {
    // Stored half-open: Kigali midnight on the 7th to Kigali midnight on the 10th.
    const block: AdminBlock = {
      id: 'b1',
      startsAt: '2026-10-06T22:00:00.000Z',
      endsAt: '2026-10-09T22:00:00.000Z',
      isAllDay: true,
      reason: 'Away',
    }

    expect(blockFormValues(block)).toMatchObject({
      mode: 'all-day',
      startDate: '2026-10-07',
      endDate: '2026-10-09',
      reason: 'Away',
    })
  })

  it('reads a part-day block back as its Kigali date and clock times', () => {
    const block: AdminBlock = {
      id: 'b2',
      startsAt: '2026-10-07T12:00:00.000Z',
      endsAt: '2026-10-07T14:30:00.000Z',
      isAllDay: false,
      reason: null,
    }

    expect(blockFormValues(block)).toMatchObject({
      mode: 'time-range',
      date: '2026-10-07',
      startTime: '14:00',
      endTime: '16:30',
      reason: '',
    })
  })

  it('round-trips a block through the form without moving it', () => {
    const block: AdminBlock = {
      id: 'b3',
      startsAt: '2026-10-07T12:00:00.000Z',
      endsAt: '2026-10-07T14:30:00.000Z',
      isAllDay: false,
      reason: null,
    }

    const parsed = blockFormSchema.safeParse(blockFormValues(block))

    expect(parsed.success).toBe(true)
    expect(Date.parse((parsed.data as { startsAt: string }).startsAt)).toBe(Date.parse(block.startsAt))
    expect(Date.parse((parsed.data as { endsAt: string }).endsAt)).toBe(Date.parse(block.endsAt))
  })

  it('prefills a new block with the day it was opened on', () => {
    expect(blockFormValues(undefined, '2026-10-07')).toMatchObject({
      mode: 'all-day',
      startDate: '2026-10-07',
      endDate: '2026-10-07',
      date: '2026-10-07',
    })
  })
})

describe('the Kigali helpers', () => {
  it('names an instant from a wall-clock date and time', () => {
    expect(kigaliInstant('2026-10-07', '09:30')).toBe('2026-10-07T09:30:00+02:00')
  })

  it('reads an instant back as Kigali wall time, not the runner’s zone', () => {
    expect(kigaliWallTime('2026-10-06T22:00:00.000Z')).toEqual({ date: '2026-10-07', time: '00:00' })
  })

  it('turns a clock time into a minute of the day', () => {
    expect(minuteOfDayOf('00:00')).toBe(0)
    expect(minuteOfDayOf('09:30')).toBe(570)
    expect(minuteOfDayOf('23:59')).toBe(1439)
  })

  it.each([
    ['2026-10-07', true],
    ['2026-02-30', false],
    ['2026-13-01', false],
    ['0050-01-01', false],
    ['7 Oct 2026', false],
    ['', false],
  ])('judges %s as a calendar date: %s', (value, expected) => {
    expect(isCalendarDate(value)).toBe(expected)
  })
})

describe('reading the overlap refusal', () => {
  const bookings = [
    {
      id: 'bk1',
      reference: 'BKY-2610-7K3QX',
      contactName: 'Aline Uwase',
      startsAt: '2026-10-07T07:30:00.000Z',
      endsAt: '2026-10-07T09:00:00.000Z',
    },
  ]

  it('names the confirmed bookings a 409 refused to cover', () => {
    const error = new ApiError(409, 'block_overlaps_confirmed_bookings', [], {
      error: 'block_overlaps_confirmed_bookings',
      bookings,
    })

    expect(overlappingBookingsOf(error)).toEqual(bookings)
  })

  it.each<[string, unknown]>([
    ['a 409 that is some other conflict', new ApiError(409, 'working_hours_exists', [], { error: 'working_hours_exists' })],
    ['a 422', new ApiError(422, 'validation_failed', ['endDate'], { error: 'validation_failed' })],
    ['a 500', new ApiError(500, 'http_500')],
    ['something that is not an ApiError', new TypeError('Failed to fetch')],
  ])('returns null for %s', (_label, error) => {
    expect(overlappingBookingsOf(error)).toBeNull()
  })
})
