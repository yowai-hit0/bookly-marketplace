import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CURRENCY,
  MoneyPrecisionError,
  TIME_ZONE,
  formatDate,
  formatDateTime,
  formatMoney,
  formatMonth,
  formatTime,
} from './format'

/** The same file the backend suite reads. A divergence fails both projects. */
const fixture = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/fixtures/format.json'),
    'utf8',
  ),
) as {
  timeZone: string
  currency: string
  formatDateTime: { case: string; input: string; expected: string }[]
  formatTime: { case: string; input: string; expected: string }[]
  formatDate: { case: string; input: string; expected: string }[]
  formatDateRejects: { case: string; input: string }[]
  formatMonth: { case: string; input: string; expected: string }[]
  formatMonthRejects: { case: string; input: string }[]
  formatMoney: { case: string; input: number; expected: string }[]
  formatMoneyRejects: { case: string; input: number }[]
}

describe('the shared fixture', () => {
  it('agrees with this copy of the constants', () => {
    expect(TIME_ZONE).toBe(fixture.timeZone)
    expect(CURRENCY).toBe(fixture.currency)
  })
})

describe('formatDateTime', () => {
  it.each(fixture.formatDateTime)('$case: $input', ({ input, expected }) => {
    expect(formatDateTime(input)).toBe(expected)
  })

  it('accepts a Date as well as an ISO string', () => {
    expect(formatDateTime(new Date('2026-07-01T06:00:00Z'))).toBe('1 Jul 2026, 08:00')
  })

  it('throws on an unparseable date rather than rendering "Invalid Date"', () => {
    expect(() => formatDateTime('not a date')).toThrow(RangeError)
  })
})

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

describe('formatTime', () => {
  it.each(fixture.formatTime)('$case: $input', ({ input, expected }) => {
    expect(formatTime(input)).toBe(expected)
  })

  it('renders every half hour of a Kigali day as HH:mm on a 24-hour clock', () => {
    const kigaliMidnight = Date.parse('2026-10-06T22:00:00Z')
    const rendered = Array.from({ length: 48 }, (_, index) => formatTime(new Date(kigaliMidnight + index * 30 * 60_000)))

    expect(rendered).toEqual(
      Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 === 0 ? '00' : '30'}`),
    )
  })

  it('accepts a Date as well as an ISO string', () => {
    expect(formatTime(new Date('2026-07-01T06:00:00Z'))).toBe('08:00')
  })

  it('throws on an unparseable instant rather than rendering "Invalid Date"', () => {
    expect(() => formatTime('not a date')).toThrow(RangeError)
    expect(() => formatTime(new Date(Number.NaN))).toThrow(RangeError)
  })
})

describe('formatDate', () => {
  it.each(fixture.formatDate)('$case: $input', ({ input, expected }) => {
    expect(formatDate(input)).toBe(expected)
  })

  it.each(fixture.formatDateRejects)('$case: rejects $input', ({ input }) => {
    expect(() => formatDate(input)).toThrow(RangeError)
  })

  it.each(['2026-02-29', '2100-02-29', '2026-04-31', '2026-10-00', '2026-10-7', '', '2026-10-07 '])(
    'rejects %j, which is not a calendar date',
    (input) => {
      expect(() => formatDate(input)).toThrow(RangeError)
    },
  )

  it('names the right weekday, day, month and year for every date from 2026 to 2028', () => {
    for (let time = Date.UTC(2026, 0, 1); time <= Date.UTC(2028, 11, 31); time += 86_400_000) {
      const day = new Date(time)
      const date = day.toISOString().slice(0, 10)

      expect(formatDate(date), date).toBe(
        `${WEEKDAYS[day.getUTCDay()]}, ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`,
      )
    }
  })
})

describe('formatMonth', () => {
  it.each(fixture.formatMonth)('$case: $input', ({ input, expected }) => {
    expect(formatMonth(input)).toBe(expected)
  })

  it.each(fixture.formatMonthRejects)('$case: rejects $input', ({ input }) => {
    expect(() => formatMonth(input)).toThrow(RangeError)
  })

  it.each(['', '2026-10-01', '202610', '26-10', '2026-10 '])('rejects %j, which is not a YYYY-MM month', (input) => {
    expect(() => formatMonth(input)).toThrow(RangeError)
  })

  it('names every month of the year', () => {
    expect(MONTHS.map((_, index) => formatMonth(`2026-${String(index + 1).padStart(2, '0')}`))).toEqual(
      MONTHS.map((name) => `${name} 2026`),
    )
  })
})

describe('formatMoney', () => {
  it.each(fixture.formatMoney)('$case: $input', ({ input, expected }) => {
    expect(formatMoney(input)).toBe(expected)
  })

  it.each(fixture.formatMoneyRejects)('$case: rejects $input', ({ input }) => {
    expect(() => formatMoney(input)).toThrow(MoneyPrecisionError)
  })

  it('rejects the non-finite values JSON cannot carry in the fixture', () => {
    expect(() => formatMoney(Number.NaN)).toThrow(MoneyPrecisionError)
    expect(() => formatMoney(Number.POSITIVE_INFINITY)).toThrow(MoneyPrecisionError)
  })
})
