import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CatalogueLoadError,
  type PublicPhotographerProfile,
  type PublicServiceDetail,
  fetchPhotographer,
  fetchPhotographers,
  fetchService,
  fetchServices,
  photographerPath,
  servicePath,
} from './api'

/**
 * The public catalogue client (plan.md Task 11; brief decision 4): anonymous
 * GETs under the configured base, addressed by the photographer's handle; a
 * 404 on a per-photographer read is "no such photographer or service" rather
 * than a failure, and every other non-OK answer is a `CatalogueLoadError`.
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
  takingBookings: true,
}

const KIGALI_LENS: PublicPhotographerProfile = {
  handle: 'kigali-lens',
  displayName: 'Kigali Lens',
  coverImageUrl: null,
  bio: null,
  contactPhone: null,
  whatsappPhone: null,
  email: null,
  takingBookings: true,
  cancellationPolicy: { cutoffHours: 24, bookingFeeRefundable: true },
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

describe('fetchPhotographers', () => {
  it('GETs /api/photographers anonymously and returns the list', async () => {
    const summary = { handle: 'kigali-lens', displayName: 'Kigali Lens', coverImageUrl: null }
    const mock = stubFetch(() => json({ photographers: [summary] }))
    const controller = new AbortController()

    await expect(fetchPhotographers(controller.signal)).resolves.toEqual([summary])

    const { url, init, headers } = sentRequest(mock)
    expect(url).toBe('/api/photographers')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.signal).toBe(controller.signal)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.has('Authorization')).toBe(false)
  })

  it.each([404, 500, 503])('throws a CatalogueLoadError on a %s', async (status) => {
    stubFetch(() => json({ error: 'nope' }, status))

    const error = await rejectionOf(fetchPhotographers())

    expect(error).toBeInstanceOf(CatalogueLoadError)
    expect((error as Error).message).toBe(`http_${status}`)
  })
})

describe('fetchPhotographer', () => {
  it('GETs /api/photographers/<handle> and returns the profile with its cancellation policy', async () => {
    const mock = stubFetch(() => json({ photographer: KIGALI_LENS }))

    await expect(fetchPhotographer('kigali-lens')).resolves.toEqual(KIGALI_LENS)

    const { url, headers } = sentRequest(mock)
    expect(url).toBe('/api/photographers/kigali-lens')
    expect(headers.has('Authorization')).toBe(false)
  })

  it('resolves null on a 404 -- an unknown photographer, or one who cannot be booked', async () => {
    stubFetch(() => json({ error: 'not_found' }, 404))

    await expect(fetchPhotographer('nobody-here')).resolves.toBeNull()
  })

  it('encodes the handle as one path segment', async () => {
    const mock = stubFetch(() => json({ error: 'not_found' }, 404))

    await fetchPhotographer('../admin?x=1')

    expect(sentRequest(mock).url).toBe('/api/photographers/..%2Fadmin%3Fx%3D1')
  })

  it.each([400, 500])('throws a CatalogueLoadError on a %s', async (status) => {
    stubFetch(() => json({ error: 'nope' }, status))

    await expect(fetchPhotographer('kigali-lens')).rejects.toBeInstanceOf(CatalogueLoadError)
  })
})

describe('fetchServices', () => {
  it('GETs /api/photographers/<handle>/services anonymously and returns the list', async () => {
    const mock = stubFetch(() => json({ services: [PORTRAITS] }))
    const controller = new AbortController()

    await expect(fetchServices('kigali-lens', controller.signal)).resolves.toEqual([PORTRAITS])

    const { url, init, headers } = sentRequest(mock)
    expect(url).toBe('/api/photographers/kigali-lens/services')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.signal).toBe(controller.signal)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.has('Authorization')).toBe(false)
  })

  it('resolves null on a 404 -- the handle names nobody who can be booked', async () => {
    stubFetch(() => json({ error: 'not_found' }, 404))

    await expect(fetchServices('nobody-here')).resolves.toBeNull()
  })

  it.each([500, 503])('throws a CatalogueLoadError on a %s', async (status) => {
    stubFetch(() => json({ error: 'nope' }, status))

    const error = await rejectionOf(fetchServices('kigali-lens'))

    expect(error).toBeInstanceOf(CatalogueLoadError)
    expect((error as Error).message).toBe(`http_${status}`)
  })
})

describe('fetchService', () => {
  it('GETs /api/photographers/<handle>/services/<slug> and returns the service', async () => {
    const mock = stubFetch(() => json({ service: PORTRAITS }))

    await expect(fetchService('kigali-lens', 'portraits')).resolves.toEqual(PORTRAITS)

    const { url, headers } = sentRequest(mock)
    expect(url).toBe('/api/photographers/kigali-lens/services/portraits')
    expect(headers.has('Authorization')).toBe(false)
  })

  it('encodes the handle and the slug as one path segment each', async () => {
    const mock = stubFetch(() => json({ error: 'not_found' }, 404))

    await fetchService('a/b', '../admin/catalogue?x=1#y')

    expect(sentRequest(mock).url).toBe('/api/photographers/a%2Fb/services/..%2Fadmin%2Fcatalogue%3Fx%3D1%23y')
  })

  it('resolves null on a 404 -- an unknown or deactivated service, or an unknown photographer', async () => {
    stubFetch(() => json({ error: 'not_found' }, 404))

    await expect(fetchService('kigali-lens', 'events')).resolves.toBeNull()
  })

  it.each([400, 401, 500, 502])('throws a CatalogueLoadError on a %s', async (status) => {
    stubFetch(() => json({ error: 'nope' }, status))

    const error = await rejectionOf(fetchService('kigali-lens', 'portraits'))

    expect(error).toBeInstanceOf(CatalogueLoadError)
    expect((error as Error).name).toBe('CatalogueLoadError')
  })

  it('lets a network failure through as a rejection', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))

    await expect(fetchService('kigali-lens', 'portraits')).rejects.toThrow(TypeError)
  })
})

describe('the public paths', () => {
  it('addresses a photographer under /p and a service under its photographer', () => {
    expect(photographerPath('kigali-lens')).toBe('/p/kigali-lens')
    expect(servicePath('kigali-lens', 'portraits')).toBe('/p/kigali-lens/portraits')
    expect(servicePath('a/b', 'c?d')).toBe('/p/a%2Fb/c%3Fd')
  })
})
