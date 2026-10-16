import type { EventInput } from '@fullcalendar/core'
import { type KigaliDate, addDays, kigaliDateOf } from './calendar-dates'

/**
 * `GET /api/admin/calendar` as FullCalendar events (plan.md Task 9).
 *
 * The API response is turned into events here and nowhere else, so the page
 * only wires FullCalendar up. Each event carries its source row as
 * `extendedProps.entry`, which the page's renderer reads for the status label
 * and the conflict marker.
 */

export type BookingStatus = 'pending_payment' | 'confirmed' | 'completed' | 'no_show'

export type CalendarBooking = {
  id: string
  reference: string
  status: BookingStatus
  startsAt: string
  endsAt: string
  contactName: string
  serviceName: string
  packageName: string
  conflictsWithBlock: boolean
}

export type CalendarBlock = {
  id: string
  startsAt: string
  endsAt: string
  isAllDay: boolean
  reason: string | null
}

export type CalendarData = {
  bookings: CalendarBooking[]
  blocks: CalendarBlock[]
}

export type CalendarEntry = { kind: 'booking'; booking: CalendarBooking } | { kind: 'block'; block: CalendarBlock }

export type EntryStatus = BookingStatus | 'block'

/** Theme tokens, so events follow the app's palette rather than FullCalendar's blue. */
const COLOURS: Record<EntryStatus, Pick<EventInput, 'backgroundColor' | 'borderColor' | 'textColor'>> = {
  confirmed: { backgroundColor: 'var(--primary)', borderColor: 'var(--primary)', textColor: 'var(--primary-foreground)' },
  pending_payment: { backgroundColor: 'var(--background)', borderColor: 'var(--muted-foreground)', textColor: 'var(--foreground)' },
  completed: { backgroundColor: 'var(--muted)', borderColor: 'var(--border)', textColor: 'var(--foreground)' },
  no_show: { backgroundColor: 'var(--muted)', borderColor: 'var(--destructive)', textColor: 'var(--foreground)' },
  block: { backgroundColor: 'var(--secondary)', borderColor: 'var(--border)', textColor: 'var(--muted-foreground)' },
}

export function toEventInputs(data: CalendarData): EventInput[] {
  const blocks = data.blocks.map((block): EventInput => {
    const entry: CalendarEntry = { kind: 'block', block }
    return {
      id: `block:${block.id}`,
      // An all-day block is stored as Kigali midnight to Kigali midnight, which
      // as dates is the exclusive end FullCalendar expects for an all-day event.
      ...(block.isAllDay
        ? { start: kigaliDateOf(block.startsAt), end: kigaliDateOf(block.endsAt), allDay: true }
        : { start: block.startsAt, end: block.endsAt, allDay: false }),
      classNames: ['bookly-event', 'bookly-event--block'],
      ...COLOURS.block,
      extendedProps: { entry },
    }
  })

  const bookings = data.bookings.map((booking): EventInput => {
    const entry: CalendarEntry = { kind: 'booking', booking }
    return {
      id: `booking:${booking.id}`,
      start: booking.startsAt,
      end: booking.endsAt,
      allDay: false,
      title: booking.contactName,
      // The conflict class outlines the event, so the §6.4 marker still shows when
      // an overlap squeezes the event too narrow for its label.
      classNames: ['bookly-event', `bookly-event--${booking.status}`, ...(booking.conflictsWithBlock ? ['bookly-event--conflict'] : [])],
      ...COLOURS[booking.status],
      extendedProps: { entry },
    }
  })

  return [...blocks, ...bookings]
}

/**
 * FullCalendar's fetch range as the API's inclusive Kigali dates. The calendar
 * runs in Africa/Kigali, so both strings are Kigali wall time
 * (`2026-09-28T00:00:00+02:00`) and the end is exclusive.
 */
export function kigaliRangeOf(startStr: string, endStr: string): { from: KigaliDate; to: KigaliDate } {
  return { from: startStr.slice(0, 10), to: addDays(endStr.slice(0, 10), -1) }
}
