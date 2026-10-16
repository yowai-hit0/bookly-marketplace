import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UnauthenticatedError, adminFetch, apiUrl } from './api'
import { readSession, saveSession } from './session'

/**
 * The admin API client (plan.md Task 7 and Task 9 Assumptions): the token
 * travels only in `Authorization: Bearer`, a 401 signs him out, and any other
 * failure surfaces the API's own error code -- plus, since Task 10, the fields
 * a 422 names, and nothing to parse on a 204.
 */

const NOW = new Date('2026-10-07T08:00:00.000Z')
const SESSION = { token: 'header.payload.signature', expiresAt: '2026-10-07T16:00:00.000Z' }

type FetchArgs = [input: string | URL | Request, init?: RequestInit]

function stubFetch(respond: () => Response | Promise<Response>) {
  const mock = vi.fn(async (..._args: FetchArgs) => respond())
  vi.stubGlobal('fetch', mock)
  return mock
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** The one call's URL and headers. */
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('apiUrl', () => {
  it('prefixes the configured base, /api by default', () => {
    expect(apiUrl('/admin/calendar?from=2026-10-01&to=2026-10-31')).toBe('/api/admin/calendar?from=2026-10-01&to=2026-10-31')
  })
})

describe('adminFetch', () => {
  it('sends the bearer token in the Authorization header and returns the parsed body', async () => {
    saveSession(SESSION)
    const mock = stubFetch(() => json({ bookings: [], blocks: [] }))

    const body = await adminFetch<{ bookings: unknown[] }>('/admin/calendar?from=2026-10-07&to=2026-10-07')

    expect(body).toEqual({ bookings: [], blocks: [] })
    const { url, headers } = sentRequest(mock)
    expect(url).toBe('/api/admin/calendar?from=2026-10-07&to=2026-10-07')
    expect(headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
    expect(headers.get('Accept')).toBe('application/json')
    expect(url).not.toContain(SESSION.token)
  })

  it('keeps the caller’s method, body, signal and headers, but never its Authorization', async () => {
    saveSession(SESSION)
    const mock = stubFetch(() => json({ ok: true }))
    const controller = new AbortController()

    await adminFetch('/admin/blocks', {
      method: 'POST',
      body: '{"isAllDay":true}',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer forged' },
    })

    const { init, headers } = sentRequest(mock)
    expect(init).toMatchObject({ method: 'POST', body: '{"isAllDay":true}', signal: controller.signal })
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
  })

  it.each<[string, () => void]>([
    ['no session', () => {}],
    ['an expired session', () => saveSession({ ...SESSION, expiresAt: NOW.toISOString() })],
  ])('with %s throws UnauthenticatedError without calling the API', async (_label, arrange) => {
    arrange()
    const mock = stubFetch(() => json({}))

    const error = await rejectionOf(adminFetch('/admin/calendar'))

    expect(error).toBeInstanceOf(UnauthenticatedError)
    expect(mock).not.toHaveBeenCalled()
  })

  it('on a 401 forgets the session and throws UnauthenticatedError', async () => {
    saveSession(SESSION)
    stubFetch(() => json({ error: 'unauthenticated' }, 401))

    const error = await rejectionOf(adminFetch('/admin/calendar'))

    expect(error).toBeInstanceOf(UnauthenticatedError)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 401, message: 'unauthenticated', name: 'UnauthenticatedError' })
    expect(readSession()).toBeNull()
  })

  it.each<[string, () => Response, number, string]>([
    ['a 422 with the API’s code', () => json({ error: 'validation_failed', fields: ['to'] }, 422), 422, 'validation_failed'],
    ['a 400 with the API’s code', () => json({ error: 'invalid_request' }, 400), 400, 'invalid_request'],
    ['a 500 with an HTML body', () => new Response('<h1>Bad gateway</h1>', { status: 500 }), 500, 'http_500'],
    ['a 404 with no body', () => new Response(null, { status: 404 }), 404, 'http_404'],
    ['a 403 whose error is not a string', () => json({ error: { code: 'nope' } }, 403), 403, 'http_403'],
  ])('on %s throws ApiError carrying it, keeping the session', async (_label, respond, status, code) => {
    saveSession(SESSION)
    stubFetch(respond)

    const error = await rejectionOf(adminFetch('/admin/calendar'))

    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(UnauthenticatedError)
    expect(error).toMatchObject({ status, message: code, name: 'ApiError' })
    expect(readSession()).toEqual(SESSION)
  })

  it('resolves a 204 to undefined without reading a body', async () => {
    saveSession(SESSION)
    stubFetch(() => new Response(null, { status: 204 }))

    await expect(adminFetch('/admin/services/s1', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it.each<[string, () => Response, string[]]>([
    ['a 422 naming fields', () => json({ error: 'validation_failed', fields: ['nameEn', 'bookingFeeRateOverride'] }, 422), ['nameEn', 'bookingFeeRateOverride']],
    ['a 422 whose fields hold non-strings', () => json({ error: 'validation_failed', fields: ['slug', 3, null, { f: 1 }] }, 422), ['slug']],
    ['a 422 whose fields is not an array', () => json({ error: 'validation_failed', fields: 'slug' }, 422), []],
    ['a 409 with no fields', () => json({ error: 'slug_taken' }, 409), []],
    ['a 500 with an HTML body', () => new Response('<h1>Bad gateway</h1>', { status: 500 }), []],
  ])('on %s carries the fields the API named', async (_label, respond, fields) => {
    saveSession(SESSION)
    stubFetch(respond)

    const error = await rejectionOf(adminFetch('/admin/services', { method: 'POST' }))

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).fields).toEqual(fields)
  })

  it('gives an unauthenticated error no fields', async () => {
    saveSession(SESSION)
    stubFetch(() => json({ error: 'unauthenticated', fields: ['token'] }, 401))

    const error = await rejectionOf(adminFetch('/admin/catalogue'))

    expect(error).toBeInstanceOf(UnauthenticatedError)
    expect((error as ApiError).fields).toEqual([])
  })

  it('lets a network failure propagate as it is', async () => {
    saveSession(SESSION)
    const failure = new TypeError('Failed to fetch')
    stubFetch(() => Promise.reject(failure))

    await expect(adminFetch('/admin/calendar')).rejects.toBe(failure)
    expect(readSession()).toEqual(SESSION)
  })
})
