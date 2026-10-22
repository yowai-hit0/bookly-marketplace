import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnauthenticatedError } from '@/auth/api'
import { readSession, saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import { platformSubscription } from '@/test/subscription-fixtures'
import { platformSubscriptionsApi, soonestEndFirst } from './subscriptions'

/**
 * The platform's subscriptions list (marketplace spec Phase 5: R5.4, R9.3):
 * every status or one, with the platform token, the soonest end first.
 */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

beforeEach(() => {
  saveSession('platform', SESSION)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('platformSubscriptionsApi.list', () => {
  it('lists every subscription with the platform token, never from the cache', async () => {
    const subscriptions = [platformSubscription()]
    const api = stubApi(() => json({ subscriptions }))

    await expect(platformSubscriptionsApi.list()).resolves.toEqual(subscriptions)
    expect(api.sent).toEqual([expect.objectContaining({ method: 'GET', url: '/api/platform/subscriptions' })])
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
    expect(api.mock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' })
  })

  it('asks for one status at a time', async () => {
    const api = stubApi(() => json({ subscriptions: [] }))

    for (const status of ['trialing', 'active', 'past_due', 'expired'] as const) await platformSubscriptionsApi.list(status)
    expect(api.sent.map((call) => call.url)).toEqual([
      '/api/platform/subscriptions?status=trialing',
      '/api/platform/subscriptions?status=active',
      '/api/platform/subscriptions?status=past_due',
      '/api/platform/subscriptions?status=expired',
    ])
  })

  it('throws the API error on a 400', async () => {
    stubApi(() => json({ error: 'invalid_request' }, 400))

    await expect(platformSubscriptionsApi.list()).rejects.toMatchObject({ status: 400 })
  })

  it('on a 401 drops the platform session', async () => {
    stubApi(() => json({ error: 'invalid_token' }, 401))

    await expect(platformSubscriptionsApi.list()).rejects.toBeInstanceOf(UnauthenticatedError)
    expect(readSession('platform')).toBeNull()
  })
})

describe('soonestEndFirst', () => {
  it('orders by the period end, soonest first, without changing what it was given', () => {
    const later = platformSubscription({ id: 'later', currentPeriodEndsAt: '2026-12-01T00:00:00.000Z' })
    const sooner = platformSubscription({ id: 'sooner', currentPeriodEndsAt: '2026-10-20T00:00:00.000Z' })
    const middle = platformSubscription({ id: 'middle', currentPeriodEndsAt: '2026-11-01T00:00:00.000Z' })
    const given = [later, sooner, middle]

    expect(soonestEndFirst(given).map((row) => row.id)).toEqual(['sooner', 'middle', 'later'])
    expect(given.map((row) => row.id)).toEqual(['later', 'sooner', 'middle'])
  })
})
