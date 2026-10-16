import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestBookingLinks } from './booking-links'

/**
 * The "Email me my links" client (docs/prompts/client-access-and-admin-polish.md, item 4).
 *
 * What is proven: it posts the email, and nothing else, as JSON to
 * `/api/booking-links`; 202 is `sent` (the API says nothing more, so neither
 * can this), 422 is `invalid`, and any other status or an unreachable API is
 * `failed`.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

function stub(respond: () => Response | Promise<Response>) {
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => respond())
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('requestBookingLinks', () => {
  it('posts only the email, as JSON', async () => {
    const mock = stub(() => new Response(JSON.stringify({ sent: true }), { status: 202 }))

    await expect(requestBookingLinks('aline@example.com')).resolves.toBe('sent')

    const [url, init] = mock.mock.calls[0] ?? []
    expect(url).toBe('/api/booking-links')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toStrictEqual({ email: 'aline@example.com' })
  })

  it.each([
    [422, 'invalid'],
    [400, 'failed'],
    [500, 'failed'],
    [200, 'failed'],
  ] as const)('reads %i as %s', async (status, expected) => {
    stub(() => new Response('{}', { status }))
    await expect(requestBookingLinks('aline@example.com')).resolves.toBe(expected)
  })

  it('is failed when the API cannot be reached', async () => {
    stub(() => Promise.reject(new TypeError('network')))
    await expect(requestBookingLinks('aline@example.com')).resolves.toBe('failed')
  })
})
