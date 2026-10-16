import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AvailabilityLoadError,
  type DayAvailability,
  addMonths,
  fetchAvailability,
  kigaliMonthOf,
  monthGrid,
} from './availability'

/**
 * The public availability client and the month arithmetic behind the slot
 * picker (plan.md Task 12; spec §6.5).
 *
 * What is proven: one anonymous GET per month with `cache: 'no-store'`, so no
 * browser copy stands between the visitor and the engine; every refusal and
 * every network failure is an `AvailabilityLoadError`, except an abort, which
 * the caller asked for and gets back as-is; "this month" is the Kigali month,
 * turning at Kigali midnight rather than UTC or browser midnight; and a month
 * grid is Monday-first, padded before the 1st and never after.
 */

const OCTOBER_DAYS: DayAvailability[] = [
  { date: '2026-10-01', starts: [] },
  { date: '2026-10-02', starts: ['2026-10-02T07:00:00.000Z', '2026-10-02T07:30:00.000Z'] },
]

type FetchArgs = [input: string | URL | Request, init?: RequestInit]

function stubFetch(respond: (...args: FetchArgs) => Response | Promise<Response>) {
  const mock = vi.fn(async (...args: FetchArgs) => respond(...args))
  vi.stubGlobal('fetch', mock)
  return mock
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** The one call's URL and init. */
function sentRequest(mock: ReturnType<typeof stubFetch>) {
  expect(mock).toHaveBeenCalledTimes(1)
  const [input, init] = mock.mock.calls[0] ?? []
  return { url: String(input), init: init ?? {}, headers: new Headers(init?.headers) }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected the promise to reject')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// --- fetchAvailability ------------------------------------------------------------

describe('fetchAvailability', () => {
  it('GETs /api/availability for the package and month, anonymously and never from a cache', async () => {
    const mock = stubFetch(() => json({ days: OCTOBER_DAYS }))
    const controller = new AbortController()

    await expect(fetchAvailability('p1', '2026-10', controller.signal)).resolves.toEqual(OCTOBER_DAYS)

    const { url, init, headers } = sentRequest(mock)
    const sent = new URL(url, 'http://localhost')
    expect(sent.pathname).toBe('/api/availability')
    expect([...sent.searchParams]).toEqual([
      ['packageId', 'p1'],
      ['month', '2026-10'],
    ])
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.cache).toBe('no-store')
    expect(init.signal).toBe(controller.signal)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.has('Authorization')).toBe(false)
  })

  it('encodes the package id as one query value', async () => {
    const mock = stubFetch(() => json({ days: [] }))

    await fetchAvailability('a&month=1999-01#x', '2026-10')

    const sent = new URL(sentRequest(mock).url, 'http://localhost')
    expect(sent.searchParams.getAll('packageId')).toEqual(['a&month=1999-01#x'])
    expect(sent.searchParams.getAll('month')).toEqual(['2026-10'])
  })

  it('works without a signal', async () => {
    const mock = stubFetch(() => json({ days: OCTOBER_DAYS }))

    await expect(fetchAvailability('p1', '2026-10')).resolves.toEqual(OCTOBER_DAYS)
    expect(sentRequest(mock).init.cache).toBe('no-store')
  })

  it('returns the days exactly as the API sent them, filtering and adding nothing', async () => {
    const days: DayAvailability[] = [{ date: '2026-10-03', starts: ['2026-10-03T06:00:00.000Z'] }]
    stubFetch(() => json({ days }))

    await expect(fetchAvailability('p1', '2026-10')).resolves.toStrictEqual(days)
  })

  it.each([400, 404, 422, 500, 503])('throws an AvailabilityLoadError carrying a %s', async (status) => {
    stubFetch(() => json({ error: 'nope' }, status))

    const error = await rejectionOf(fetchAvailability('p1', '2026-10'))

    expect(error).toBeInstanceOf(AvailabilityLoadError)
    expect((error as AvailabilityLoadError).status).toBe(status)
    expect((error as Error).message).toBe(`http_${status}`)
    expect((error as Error).name).toBe('AvailabilityLoadError')
  })

  it('throws an AvailabilityLoadError with a null status when the network is down', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))

    const error = await rejectionOf(fetchAvailability('p1', '2026-10', new AbortController().signal))

    expect(error).toBeInstanceOf(AvailabilityLoadError)
    expect((error as AvailabilityLoadError).status).toBeNull()
    expect((error as Error).message).toBe('network_error')
  })

  it.each<[string, unknown]>([
    ['no days key', {}],
    ['days: null', { days: null }],
    ['days as an object', { days: { '2026-10-01': [] } }],
    ['days as a string', { days: '[]' }],
  ])('throws an AvailabilityLoadError for a 200 with %s', async (_label, body) => {
    stubFetch(() => json(body))

    const error = await rejectionOf(fetchAvailability('p1', '2026-10'))

    expect(error).toBeInstanceOf(AvailabilityLoadError)
  })

  it('rejects a 200 whose body is not JSON at all', async () => {
    stubFetch(() => new Response('<!doctype html><title>SPA fallback</title>', { status: 200 }))

    await expect(fetchAvailability('p1', '2026-10')).rejects.toBeDefined()
  })

  it('lets an abort through as the abort, not as a load failure', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    stubFetch((_input, init) => (init?.signal?.aborted ? Promise.reject(abortError) : json({ days: OCTOBER_DAYS })))
    const controller = new AbortController()
    controller.abort()

    const error = await rejectionOf(fetchAvailability('p1', '2026-10', controller.signal))

    expect(error).toBe(abortError)
    expect(error).not.toBeInstanceOf(AvailabilityLoadError)
  })

  it('lets an abort during the request through as the abort', async () => {
    const controller = new AbortController()
    stubFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )

    const pending = rejectionOf(fetchAvailability('p1', '2026-10', controller.signal))
    controller.abort()
    const error = await pending

    expect(error).toBe(controller.signal.reason)
    expect(error).not.toBeInstanceOf(AvailabilityLoadError)
  })
})

// --- kigaliMonthOf -------------------------------------------------------------------

describe('kigaliMonthOf', () => {
  it.each<[string, string]>([
    ['2026-10-15T12:00:00Z', '2026-10'],
    // Kigali midnight is 22:00 UTC the evening before.
    ['2026-09-30T21:59:59.999Z', '2026-09'],
    ['2026-09-30T22:00:00.000Z', '2026-10'],
    ['2026-10-31T21:59:59.999Z', '2026-10'],
    ['2026-10-31T22:00:00.000Z', '2026-11'],
    ['2026-12-31T21:59:59.999Z', '2026-12'],
    ['2026-12-31T22:00:00.000Z', '2027-01'],
    ['2028-02-29T21:59:59.999Z', '2028-02'],
    ['2028-02-29T22:00:00.000Z', '2028-03'],
    // An explicit offset is the same instant as its UTC twin.
    ['2026-11-01T00:00:00+02:00', '2026-11'],
    ['2026-10-31T23:59:00-05:00', '2026-11'],
  ])('reads %s as the Kigali month %s', (instant, month) => {
    expect(kigaliMonthOf(instant)).toBe(month)
  })

  it('accepts a Date as well as an ISO string', () => {
    expect(kigaliMonthOf(new Date('2026-10-31T22:00:00Z'))).toBe('2026-11')
  })
})

// --- addMonths -------------------------------------------------------------------------

describe('addMonths', () => {
  it.each<[string, number, string]>([
    ['2026-10', 0, '2026-10'],
    ['2026-10', 1, '2026-11'],
    ['2026-10', -1, '2026-09'],
    ['2026-12', 1, '2027-01'],
    ['2027-01', -1, '2026-12'],
    ['2026-01', -1, '2025-12'],
    ['2026-10', 2, '2026-12'],
    ['2026-10', 3, '2027-01'],
    ['2026-10', 12, '2027-10'],
    ['2026-10', -12, '2025-10'],
    ['2026-10', -13, '2025-09'],
    ['2026-10', 27, '2029-01'],
    ['2026-02', 24, '2028-02'],
    ['0100-01', -1, '0099-12'],
  ])('moves %s by %i to %s', (month, months, expected) => {
    expect(addMonths(month, months)).toBe(expected)
  })

  it('walks forwards and back again to where it started', () => {
    let month = '2026-10'
    for (let step = 0; step < 30; step++) month = addMonths(month, 1)
    expect(month).toBe('2029-04')
    for (let step = 0; step < 30; step++) month = addMonths(month, -1)
    expect(month).toBe('2026-10')
  })
})

// --- monthGrid ----------------------------------------------------------------------------

describe('monthGrid', () => {
  function datesOf(month: string, length: number): string[] {
    return Array.from({ length }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`)
  }

  it.each<[string, string, number, number]>([
    ['a month starting on a Monday', '2026-06', 0, 30],
    ['a month starting on a Tuesday (leap February)', '2028-02', 1, 29],
    ['a month starting on a Wednesday', '2026-07', 2, 31],
    ['October 2026, starting on a Thursday', '2026-10', 3, 31],
    ['a month starting on a Sunday', '2026-11', 6, 30],
    ['a non-leap February starting on a Sunday', '2026-02', 6, 28],
    ['a non-leap February starting on a Monday: exactly four weeks', '2027-02', 0, 28],
  ])('pads %s (%s) with %i leading blanks, then every one of its %i dates', (_label, month, blanks, length) => {
    const cells = monthGrid(month)

    expect(cells.slice(0, blanks)).toEqual(Array.from({ length: blanks }, () => null))
    expect(cells.slice(blanks)).toEqual(datesOf(month, length))
    expect(cells).toHaveLength(blanks + length)
  })

  it('puts every date under its own weekday column, Monday first', () => {
    for (const month of ['2026-10', '2026-11', '2027-02', '2028-02', '2026-12']) {
      monthGrid(month).forEach((cell, index) => {
        if (cell === null) return
        const mondayFirstColumn = (new Date(`${cell}T00:00:00Z`).getUTCDay() + 6) % 7
        expect(index % 7, cell).toBe(mondayFirstColumn)
      })
    }
  })

  it('never pads after the last date and never spills into the next month', () => {
    const cells = monthGrid('2026-12')

    expect(cells.at(-1)).toBe('2026-12-31')
    expect(cells.filter((cell) => cell !== null).every((cell) => cell?.startsWith('2026-12-'))).toBe(true)
  })
})
