import { describe, expect, it } from 'vitest'
import {
  type CalendarBlock,
  type CalendarBooking,
  type CalendarEntry,
  kigaliRangeOf,
  toEventInputs,
} from './calendar-events'

/**
 * The API response as FullCalendar events (plan.md Task 9). FullCalendar's own
 * rendering is exercised by the page and browser tests; this pins the mapping.
 */

function booking(fields: Partial<CalendarBooking> = {}): CalendarBooking {
  return {
    id: 'b1',
    reference: 'BKY-2610-00001',
    status: 'confirmed',
    startsAt: '2026-10-07T07:00:00.000Z',
    endsAt: '2026-10-07T08:00:00.000Z',
    contactName: 'Grace Mukamana',
    serviceName: 'Wedding',
    packageName: 'Full day',
    conflictsWithBlock: false,
    ...fields,
  }
}

function block(fields: Partial<CalendarBlock> = {}): CalendarBlock {
  return {
    id: 'k1',
    startsAt: '2026-10-07T12:00:00.000Z',
    endsAt: '2026-10-07T14:00:00.000Z',
    isAllDay: false,
    reason: 'Clinic',
    ...fields,
  }
}

describe('toEventInputs', () => {
  it('turns a booking into a timed event carrying its row', () => {
    const row = booking()

    expect(toEventInputs({ bookings: [row], blocks: [] })).toEqual([
      {
        id: 'booking:b1',
        start: '2026-10-07T07:00:00.000Z',
        end: '2026-10-07T08:00:00.000Z',
        allDay: false,
        title: 'Grace Mukamana',
        classNames: ['bookly-event', 'bookly-event--confirmed'],
        backgroundColor: 'var(--primary)',
        borderColor: 'var(--primary)',
        textColor: 'var(--primary-foreground)',
        extendedProps: { entry: { kind: 'booking', booking: row } satisfies CalendarEntry },
      },
    ])
  })

  it.each(['confirmed', 'pending_payment', 'completed', 'no_show'] as const)(
    'gives a %s booking its own status class and theme colours',
    (status) => {
      const [event] = toEventInputs({ bookings: [booking({ status })], blocks: [] })

      expect(event?.classNames).toEqual(['bookly-event', `bookly-event--${status}`])
      expect(String(event?.backgroundColor)).toMatch(/^var\(--/)
    },
  )

  it('marks only a booking that overlaps a block with the conflict class', () => {
    const events = toEventInputs({
      bookings: [booking({ id: 'b1', conflictsWithBlock: true }), booking({ id: 'b2' })],
      blocks: [],
    })

    expect(events.map((event) => event.classNames)).toEqual([
      ['bookly-event', 'bookly-event--confirmed', 'bookly-event--conflict'],
      ['bookly-event', 'bookly-event--confirmed'],
    ])
  })

  it('keeps a partial block as a timed event at its own instants', () => {
    const row = block()

    expect(toEventInputs({ bookings: [], blocks: [row] })).toEqual([
      expect.objectContaining({
        id: 'block:k1',
        start: '2026-10-07T12:00:00.000Z',
        end: '2026-10-07T14:00:00.000Z',
        allDay: false,
        classNames: ['bookly-event', 'bookly-event--block'],
        extendedProps: { entry: { kind: 'block', block: row } },
      }),
    ])
  })

  it('turns an all-day block into Kigali dates with an exclusive end', () => {
    // Stored as Kigali midnight on the 12th to Kigali midnight after the 13th.
    const row = block({ isAllDay: true, startsAt: '2026-10-11T22:00:00.000Z', endsAt: '2026-10-13T22:00:00.000Z' })

    const [event] = toEventInputs({ bookings: [], blocks: [row] })

    expect(event).toMatchObject({ start: '2026-10-12', end: '2026-10-14', allDay: true })
  })

  it('lists blocks before bookings, and nothing for an empty response', () => {
    expect(toEventInputs({ bookings: [booking()], blocks: [block()] }).map((event) => event.id)).toEqual([
      'block:k1',
      'booking:b1',
    ])
    expect(toEventInputs({ bookings: [], blocks: [] })).toEqual([])
  })
})

describe('kigaliRangeOf', () => {
  it.each<[string, string, string, { from: string; to: string }]>([
    ['a month grid', '2026-09-28T00:00:00+02:00', '2026-11-02T00:00:00+02:00', { from: '2026-09-28', to: '2026-11-01' }],
    ['a week', '2026-10-05T00:00:00+02:00', '2026-10-12T00:00:00+02:00', { from: '2026-10-05', to: '2026-10-11' }],
    ['a day', '2026-10-07T00:00:00+02:00', '2026-10-08T00:00:00+02:00', { from: '2026-10-07', to: '2026-10-07' }],
    ['a week across a year end', '2026-12-28T00:00:00+02:00', '2027-01-04T00:00:00+02:00', { from: '2026-12-28', to: '2027-01-03' }],
  ])('turns %s into inclusive API dates', (_label, start, end, expected) => {
    expect(kigaliRangeOf(start, end)).toEqual(expected)
  })
})
