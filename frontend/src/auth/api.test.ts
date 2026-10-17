import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { json, stubApi } from '@/test/fetch'
import { ApiError, UnauthenticatedError, apiFetch, publicPost } from './api'
import { AREAS, readSession, saveSession } from './session'

/**
 * `apiFetch(area)` (marketplace spec R2.6): each area's token travels only in
 * its own `Authorization: Bearer`, and a 401 signs out that area alone.
 * `publicPost` is the signed-out auth endpoints' client.
 */

const NOW = new Date('2026-10-07T08:00:00.000Z')
const EXPIRES = '2026-10-07T16:00:00.000Z'

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

describe('apiFetch', () => {
  it.each(AREAS)('sends the %s token, and only it, to that area', async (area) => {
    for (const each of AREAS) saveSession(each, { token: `${each}.token`, expiresAt: EXPIRES })
    const api = stubApi(() => json({ user: {} }))

    await apiFetch(area, `/${area}/me`)

    expect(api.sent).toHaveLength(1)
    expect(api.sent[0]?.url).toBe(`/api/${area}/me`)
    expect(api.sent[0]?.headers.get('Authorization')).toBe(`Bearer ${area}.token`)
  })

  it('with no session for the area throws UnauthenticatedError without calling the API, even when another area is signed in', async () => {
    saveSession('studio', { token: 'studio.token', expiresAt: EXPIRES })
    const api = stubApi(() => json({}))

    const error = await rejectionOf(apiFetch('platform', '/platform/photographers'))

    expect(error).toBeInstanceOf(UnauthenticatedError)
    expect(api.sent).toHaveLength(0)
  })

  it('on a 401 forgets that area’s session and no other', async () => {
    for (const each of AREAS) saveSession(each, { token: `${each}.token`, expiresAt: EXPIRES })
    stubApi(() => json({ error: 'invalid_token' }, 401))

    const error = await rejectionOf(apiFetch('account', '/account/me'))

    expect(error).toBeInstanceOf(UnauthenticatedError)
    expect(readSession('account')).toBeNull()
    expect(readSession('studio')?.token).toBe('studio.token')
    expect(readSession('platform')?.token).toBe('platform.token')
  })

  it('surfaces any other refusal as the API’s code, keeping the session', async () => {
    saveSession('platform', { token: 'platform.token', expiresAt: EXPIRES })
    stubApi(() => json({ error: 'invalid_transition', photographer: { id: 'p1' } }, 409))

    const error = await rejectionOf(apiFetch('platform', '/platform/photographers/p1/approve', { method: 'POST' }))

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, message: 'invalid_transition', body: { photographer: { id: 'p1' } } })
    expect(readSession('platform')).not.toBeNull()
  })
})

describe('publicPost', () => {
  it('posts JSON with no token, and returns the parsed body', async () => {
    saveSession('studio', { token: 'studio.token', expiresAt: EXPIRES })
    const api = stubApi(() => json({ ok: true }, 202))

    await expect(publicPost('/studio/auth/signup', { email: 'a@b.example' })).resolves.toEqual({ ok: true })

    const [call] = api.sent
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe('/api/studio/auth/signup')
    expect(call?.headers.get('Content-Type')).toBe('application/json')
    expect(call?.headers.get('Authorization')).toBeNull()
    expect(call?.body).toEqual({ email: 'a@b.example' })
  })

  it('resolves a 204 to undefined', async () => {
    stubApi(() => new Response(null, { status: 204 }))

    await expect(publicPost('/account/auth/password-reset/confirm', {})).resolves.toBeUndefined()
  })

  it('sends no body when given none', async () => {
    const api = stubApi(() => json({ authorizationUrl: 'https://accounts.google.com/o', state: 's' }))

    await publicPost('/account/auth/google/start')

    expect(api.sent[0]?.body).toBeUndefined()
  })

  it.each<[number, unknown, string, string[]]>([
    [409, { error: 'handle_taken' }, 'handle_taken', []],
    [422, { error: 'validation_failed', fields: ['handle', 3] }, 'validation_failed', ['handle']],
    [429, { error: 'rate_limited' }, 'rate_limited', []],
    [400, { error: 'invalid_verification' }, 'invalid_verification', []],
  ])('surfaces a %i as an ApiError with its code and fields', async (status, body, code, fields) => {
    stubApi(() => json(body, status))

    const error = await rejectionOf(publicPost('/studio/auth/signup', {}))

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status, message: code, fields })
  })

  it('does not sign anyone out on a 401: it carries no session', async () => {
    saveSession('studio', { token: 'studio.token', expiresAt: EXPIRES })
    stubApi(() => json({ error: 'invalid_credentials' }, 401))

    const error = await rejectionOf(publicPost('/studio/auth/login', {}))

    expect(error).not.toBeInstanceOf(UnauthenticatedError)
    expect(readSession('studio')).not.toBeNull()
  })
})
