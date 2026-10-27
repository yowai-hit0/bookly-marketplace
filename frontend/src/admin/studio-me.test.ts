import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnauthenticatedError } from '@/auth/api'
import { readSession, saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import { studioMeBody } from '@/test/studio-me'
import { type StudioMe, isSubscriptionBanner, parseStudioMe, studioBanner, studioMeApi } from './studio-me'

/**
 * `/api/studio/me` as the layout reads it (R7.4): what it trusts of the
 * answer, and the one banner it draws from it, by priority.
 */

const SESSION = { token: 'studio.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

beforeEach(() => saveSession('studio', SESSION))
afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

function me(status: StudioMe['photographer']['status'], photographer: Partial<StudioMe['photographer']> = {}, subscription: StudioMe['subscription'] = null): StudioMe {
  return {
    photographer: { id: 'p1', handle: 'h', displayName: 'H', status, submittedAt: null, suspensionReason: null, ...photographer },
    subscription,
  }
}

const SUB = { status: 'active', currentPeriodEndsAt: '2026-11-01T00:00:00.000Z', graceEndsAt: '2026-11-08T00:00:00.000Z', takingBookings: true, endingSoon: false } as const

describe('parseStudioMe', () => {
  it('reads the Phase 7 answer', () => {
    expect(parseStudioMe(studioMeBody('pending', { submittedAt: '2026-10-20T08:00:00.000Z' }))).toEqual({
      photographer: { id: 'p1', handle: 'kigali-lens', displayName: 'Kigali Lens', status: 'pending', submittedAt: '2026-10-20T08:00:00.000Z', suspensionReason: null },
      subscription: null,
    })
  })

  it('reads a pre-Phase 7 answer (no submittedAt, no subscription) as not submitted and no subscription', () => {
    const parsed = parseStudioMe({ user: {}, photographer: { id: 'p1', handle: 'h', displayName: 'H', status: 'approved' } })
    expect(parsed?.photographer.submittedAt).toBeNull()
    expect(parsed?.photographer.suspensionReason).toBeNull()
    expect(parsed?.subscription).toBeNull()
  })

  it.each([null, undefined, 'text', 42, {}, { photographer: null }, { photographer: { status: 'mystery' } }, { photographer: { status: 3 } }])(
    'refuses %j',
    (body) => {
      expect(parseStudioMe(body)).toBeNull()
    },
  )

  it.each([
    { status: 'mystery' },
    { status: 'active' },
    { status: 'active', currentPeriodEndsAt: 1, graceEndsAt: 'x' },
    'nope',
  ])('drops an unreadable subscription %j but keeps the photographer', (subscription) => {
    const parsed = parseStudioMe({ photographer: { status: 'suspended' }, subscription })
    expect(parsed?.photographer.status).toBe('suspended')
    expect(parsed?.subscription).toBeNull()
  })

  it('reads endingSoon and takingBookings only when they are true', () => {
    const parsed = parseStudioMe({ photographer: { status: 'approved' }, subscription: { ...SUB, endingSoon: 'yes', takingBookings: 1 } })
    expect(parsed?.subscription).toMatchObject({ endingSoon: false, takingBookings: false })
  })
})

describe('studioBanner', () => {
  it('is null without an answer', () => {
    expect(studioBanner(null)).toBeNull()
  })

  it('puts suspended first, with its reason, whatever the subscription says', () => {
    expect(studioBanner(me('suspended', { suspensionReason: 'Copied work.' }, { ...SUB, status: 'past_due' }))).toEqual({ kind: 'suspended', reason: 'Copied work.' })
  })

  it.each([null, '', '  \n '])('gives a suspended studio no reason for %j', (reason) => {
    expect(studioBanner(me('suspended', { suspensionReason: reason }))).toEqual({ kind: 'suspended', reason: null })
  })

  it('asks a pending studio that has not submitted to finish its setup', () => {
    expect(studioBanner(me('pending'))).toEqual({ kind: 'setup' })
  })

  it('tells a submitted studio it is awaiting review, before any subscription', () => {
    expect(studioBanner(me('pending', { submittedAt: '2026-10-20T08:00:00.000Z' }, { ...SUB, status: 'trialing', endingSoon: true }))).toEqual({ kind: 'awaiting_review' })
  })

  it.each([
    ['past_due', false, 'past_due'],
    ['past_due', true, 'past_due'],
    ['expired', false, 'expired'],
    ['trialing', true, 'trial_ending'],
    ['active', true, 'period_ending'],
  ] as const)('for an approved studio, a %s subscription (endingSoon %s) is %s', (status, endingSoon, kind) => {
    const banner = studioBanner(me('approved', {}, { ...SUB, status, endingSoon }))
    expect(banner?.kind).toBe(kind)
    expect(banner !== null && isSubscriptionBanner(banner)).toBe(true)
  })

  it.each(['trialing', 'active'] as const)('says nothing for a %s subscription not ending soon', (status) => {
    expect(studioBanner(me('approved', {}, { ...SUB, status, endingSoon: false }))).toBeNull()
  })

  it('says nothing for an approved studio without a subscription', () => {
    expect(studioBanner(me('approved'))).toBeNull()
  })

  it('counts only the subscription kinds as subscription banners', () => {
    expect(isSubscriptionBanner({ kind: 'setup' })).toBe(false)
    expect(isSubscriptionBanner({ kind: 'awaiting_review' })).toBe(false)
    expect(isSubscriptionBanner({ kind: 'suspended', reason: null })).toBe(false)
  })
})

describe('studioMeApi.load', () => {
  it('asks with the studio token and no cache', async () => {
    const api = stubApi(() => json(studioMeBody()))
    await studioMeApi.load()
    expect(api.sent[0]?.url).toBe('/api/studio/me')
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer studio.jwt')
    expect(api.mock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' })
  })

  it('answers null for a body it cannot use', async () => {
    stubApi(() => json({ user: {} }))
    await expect(studioMeApi.load()).resolves.toBeNull()
  })

  it('throws on a 401 and drops the studio session', async () => {
    stubApi(() => json({ error: 'invalid_token' }, 401))
    await expect(studioMeApi.load()).rejects.toBeInstanceOf(UnauthenticatedError)
    expect(readSession('studio')).toBeNull()
  })
})
