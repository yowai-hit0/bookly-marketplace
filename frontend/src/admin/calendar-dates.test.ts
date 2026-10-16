import { afterEach, describe, expect, it, vi } from 'vitest'
import { addDays, isKigaliDate, kigaliDateOf } from './calendar-dates'

/**
 * The date arithmetic left around FullCalendar (plan.md Task 9, spec §6.5).
 * Kigali is UTC+2 with no DST, so Kigali midnight is 22:00 UTC the day before.
 */

describe('addDays', () => {
  it.each<[string, number, string]>([
    ['2028-02-28', 1, '2028-02-29'],
    ['2027-02-28', 1, '2027-03-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-01-01', -1, '2025-12-31'],
    ['2026-11-02', -1, '2026-11-01'],
    ['2026-09-28', 34, '2026-11-01'],
  ])('adds to %s %i days: %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected)
  })
})

describe('kigaliDateOf', () => {
  it.each<[string, string]>([
    ['2026-10-06T21:59:59.999Z', '2026-10-06'],
    ['2026-10-06T22:00:00.000Z', '2026-10-07'],
    ['2026-10-07T00:00:00.000Z', '2026-10-07'],
    ['2026-10-07T21:30:00.000Z', '2026-10-07'],
    ['2026-10-07T23:30:00+02:00', '2026-10-07'],
    ['2026-12-31T22:00:00.000Z', '2027-01-01'],
    ['2028-02-28T22:00:00.000Z', '2028-02-29'],
  ])('puts %s on Kigali date %s', (instant, date) => {
    expect(kigaliDateOf(instant)).toBe(date)
    expect(kigaliDateOf(new Date(instant))).toBe(date)
  })
})

describe('isKigaliDate', () => {
  it.each(['2026-10-07', '2028-02-29', '2026-12-31', '2027-01-01', '0100-01-01'])('accepts %j', (value) => {
    expect(isKigaliDate(value)).toBe(true)
  })

  it.each([
    '',
    '2026-02-29',
    '2026-02-30',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-10-00',
    '2026-10-7',
    '26-10-07',
    '20261007',
    '2026/10/07',
    '07-10-2026',
    '2026-10-07T00:00:00Z',
    ' 2026-10-07',
    '2026-10-07 ',
    '2026-10-07\n',
    'not-a-date',
    // The API answers 422 below year 100, so the page must fall back to today
    // rather than request a range that can only fail.
    '0050-06-15',
    '0099-12-31',
  ])('refuses %j', (value) => {
    expect(isKigaliDate(value)).toBe(false)
  })
})

describe('independence from the machine timezone (spec §6.5)', () => {
  const ORIGINAL_TZ = process.env.TZ

  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIGINAL_TZ
    vi.resetModules()
  })

  async function outputsIn(zone: string) {
    process.env.TZ = zone
    vi.resetModules()
    const dates = await import('./calendar-dates')
    return {
      localHour: new Date('2026-10-07T21:30:00Z').getHours(),
      kigaliDates: ['2026-10-06T21:59:59Z', '2026-10-06T22:00:00Z', '2026-10-07T21:30:00Z'].map(dates.kigaliDateOf),
      shifted: [dates.addDays('2026-03-29', 1), dates.addDays('2026-11-02', -1)],
      valid: dates.isKigaliDate('2026-03-29'),
    }
  }

  it('gives identical results in Kigali, New York, Kiritimati (UTC+14) and Honolulu (UTC−10)', async () => {
    const kigali = await outputsIn('Africa/Kigali')
    const others = [
      await outputsIn('America/New_York'),
      await outputsIn('Pacific/Kiritimati'),
      await outputsIn('Pacific/Honolulu'),
    ]

    // The zone really changed underneath: 21:30 UTC is a different local hour in each.
    expect([kigali, ...others].map((result) => result.localHour)).toEqual([23, 17, 11, 11])
    expect(kigali).toMatchObject({
      kigaliDates: ['2026-10-06', '2026-10-07', '2026-10-07'],
      shifted: ['2026-03-30', '2026-11-01'],
      valid: true,
    })
    for (const other of others) {
      expect({ ...other, localHour: kigali.localHour }).toEqual(kigali)
    }
  })
})
