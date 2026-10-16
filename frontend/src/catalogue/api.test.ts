import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogueLoadError, type PublicServiceDetail, fetchService, fetchServices } from './api'

/**
 * The public catalogue client (plan.md Task 11): anonymous GETs under the
 * configured base, a 404 on a service read as "no such service" rather than a
 * failure, and every other non-OK answer as a `CatalogueLoadError`.
 */

const PORTRAITS: PublicServiceDetail = {
  id: 's1',
  slug: 'portraits',
  nameEn: 'Portraits',
  descriptionEn: null,
  coverImageUrl: null,
  packages: [],
  addons: [],
  bookingFeeRate: 0.4,
}

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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchServices', () => {
  it('GETs /api/services anonymously and returns the list', async () => {
    const mock = stubFetch(() => json({ services: [PORTRAITS] }))
    const controller = new AbortController()

    await expect(fetchServices(controller.signal)).resolves.toEqual([PORTRAITS])

    const { url, init, headers } = sentRequest(mock)
    expect(url).toBe('/api/services')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.signal).toBe(controller.signal)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.has('Authorization')).toBe(false)
  })

  it.each([404, 500, 503])('throws a CatalogueLoadError on a %s', async (status) => {
    stubFetch(() => json({ error: 'nope' }, status))

    const error = await rejectionOf(fetchServices())

    expect(error).toBeInstanceOf(CatalogueLoadError)
    expect((error as Error).message).toBe(`http_${status}`)
  })
})

describe('fetchService', () => {
  it('GETs /api/services/<slug> and returns the service', async () => {
    const mock = stubFetch(() => json({ service: PORTRAITS }))

    await expect(fetchService('portraits')).resolves.toEqual(PORTRAITS)

    const { url, headers } = sentRequest(mock)
    expect(url).toBe('/api/services/portraits')
    expect(headers.has('Authorization')).toBe(false)
  })

  it('encodes the slug as one path segment', async () => {
    const mock = stubFetch(() => json({ error: 'not_found' }, 404))

    await fetchService('../admin/catalogue?x=1#y')

    expect(sentRequest(mock).url).toBe('/api/services/..%2Fadmin%2Fcatalogue%3Fx%3D1%23y')
  })

  it('resolves null on a 404 -- an unknown or deactivated service', async () => {
    stubFetch(() => json({ error: 'not_found' }, 404))

    await expect(fetchService('events')).resolves.toBeNull()
  })

  it.each([400, 401, 500, 502])('throws a CatalogueLoadError on a %s', async (status) => {
    stubFetch(() => json({ error: 'nope' }, status))

    const error = await rejectionOf(fetchService('portraits'))

    expect(error).toBeInstanceOf(CatalogueLoadError)
    expect((error as Error).name).toBe('CatalogueLoadError')
  })

  it('lets a network failure through as a rejection', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))

    await expect(fetchService('portraits')).rejects.toThrow(TypeError)
  })
})
