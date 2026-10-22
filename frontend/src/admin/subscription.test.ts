import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { readSession, saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import { OUR_REF, paidPeriod, paymentProgress, subscriptionPage, trialPeriod } from '@/test/subscription-fixtures'
import {
  ENDING_SOON_DAYS,
  isSubscriptionStatus,
  lastPaidPeriod,
  paymentOutcome,
  subscriptionApi,
  subscriptionBanner,
  yearlySaving,
} from './subscription'

/**
 * The studio's subscription client (marketplace spec Phase 5: R5.2, R5.3,
 * T5.3): the page's data with only the methods it can label, a payment
 * started with the plan and never an amount, every refusal turned into a
 * worded result, and the payment followed by its reference.
 */

const SESSION = { token: 'studio.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }
const PAY = { planInterval: 'monthly', method: 'momo_mtn', phone: '0788123456' } as const

beforeEach(() => {
  saveSession('studio', SESSION)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('subscriptionApi.load', () => {
  it('asks GET /api/studio/subscription with the studio token, never from the cache', async () => {
    const page = subscriptionPage()
    const api = stubApi(() => json(page))

    await expect(subscriptionApi.load()).resolves.toEqual(page)
    expect(api.sent).toEqual([expect.objectContaining({ method: 'GET', url: '/api/studio/subscription' })])
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer studio.jwt')
    expect(api.mock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' })
  })

  it('keeps a null subscription: a photographer never approved', async () => {
    stubApi(() => json(subscriptionPage({ subscription: null })))

    await expect(subscriptionApi.load()).resolves.toMatchObject({ subscription: null })
  })

  it.each([
    [[], []],
    [['momo_mtn'], ['momo_mtn']],
    [['momo_airtel'], ['momo_airtel']],
    // The checkout's order, whatever order the API lists them in.
    [['momo_airtel', 'momo_mtn'], ['momo_mtn', 'momo_airtel']],
    // A card (deferred) and a method this app cannot label are dropped, not drawn blank.
    [['card', 'momo_mtn', 'paypal'], ['momo_mtn']],
  ])('offers %j as %j', async (methods, offered) => {
    stubApi(() => json({ ...subscriptionPage(), methods }))

    expect((await subscriptionApi.load()).methods).toEqual(offered)
  })

  it('reads a missing methods list as none', async () => {
    const { methods: _, ...page } = subscriptionPage()
    stubApi(() => json(page))

    expect((await subscriptionApi.load()).methods).toEqual([])
  })

  it.each([
    ['null', null],
    ['no subscription key', { prices: { monthly: 1, yearly: 1 }, methods: [] }],
    ['no prices', { subscription: null, methods: [] }],
    ['prices that are not numbers', { subscription: null, prices: { monthly: '10000', yearly: 1 }, methods: [] }],
  ])('throws on a body with %s', async (_label, body) => {
    stubApi(() => json(body))

    await expect(subscriptionApi.load()).rejects.toBeInstanceOf(ApiError)
  })

  it('throws the API error on a 500', async () => {
    stubApi(() => json({ error: 'internal_error' }, 500))

    await expect(subscriptionApi.load()).rejects.toMatchObject({ status: 500, message: 'internal_error' })
  })

  it('on a 401 drops the studio session alone', async () => {
    saveSession('platform', SESSION)
    stubApi(() => json({ error: 'invalid_token' }, 401))

    await expect(subscriptionApi.load()).rejects.toBeInstanceOf(UnauthenticatedError)
    expect(readSession('studio')).toBeNull()
    expect(readSession('platform')).not.toBeNull()
  })
})

describe('subscriptionApi.pay', () => {
  it('posts the plan, the method and the phone, and nothing else: never an amount (T5.3)', async () => {
    const api = stubApi(() => json({ payment: { ourRef: OUR_REF, status: 'pending', planInterval: 'yearly', amountRwf: 100_000 } }, 201))

    await expect(subscriptionApi.pay({ planInterval: 'yearly', method: 'momo_airtel', phone: '+250788123456' })).resolves.toEqual({
      status: 'started',
      ourRef: OUR_REF,
      planInterval: 'yearly',
      amountRwf: 100_000,
    })
    expect(api.sent[0]).toMatchObject({
      method: 'POST',
      url: '/api/studio/subscription/payments',
      body: { planInterval: 'yearly', method: 'momo_airtel', phone: '+250788123456' },
    })
    expect(Object.keys(api.sent[0]?.body as object).sort()).toEqual(['method', 'phone', 'planInterval'])
    expect(api.sent[0]?.headers.get('Content-Type')).toBe('application/json')
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer studio.jwt')
  })

  it('is a failure when a 201 names no payment to follow', async () => {
    stubApi(() => json({ payment: null }, 201))

    await expect(subscriptionApi.pay(PAY)).resolves.toEqual({ status: 'failed' })
  })

  it.each<[string, Response, unknown]>([
    ['a 400', json({ error: 'invalid_request' }, 400), { status: 'bad_request' }],
    ['409 photographer_not_approved', json({ error: 'photographer_not_approved' }, 409), { status: 'not_approved' }],
    ['409 no_subscription', json({ error: 'no_subscription' }, 409), { status: 'no_subscription' }],
    [
      '409 payment_in_progress',
      json({ error: 'payment_in_progress', payment: { ourRef: OUR_REF } }, 409),
      { status: 'in_progress', ourRef: OUR_REF },
    ],
    ['409 payment_in_progress without a reference', json({ error: 'payment_in_progress' }, 409), { status: 'failed' }],
    ['an unknown 409', json({ error: 'something_else' }, 409), { status: 'failed' }],
    ['422 on the method', json({ error: 'validation_failed', fields: ['method'] }, 422), { status: 'invalid', fields: ['method'] }],
    ['422 on the phone', json({ error: 'validation_failed', fields: ['phone'] }, 422), { status: 'invalid', fields: ['phone'] }],
    [
      '422 on both',
      json({ error: 'validation_failed', fields: ['method', 'phone'] }, 422),
      { status: 'invalid', fields: ['method', 'phone'] },
    ],
    ['422 naming no field', json({ error: 'validation_failed' }, 422), { status: 'failed' }],
    ['429', json({ error: 'rate_limited' }, 429), { status: 'rate_limited' }],
    [
      '502 rejected',
      json({ error: 'payment_not_started', reason: 'rejected', payment: { ourRef: OUR_REF, status: 'failed' } }, 502),
      { status: 'not_started', reason: 'rejected' },
    ],
    [
      '502 unavailable',
      json({ error: 'payment_not_started', reason: 'unavailable', payment: { ourRef: OUR_REF, status: 'failed' } }, 502),
      { status: 'not_started', reason: 'unavailable' },
    ],
    ['502 with an unknown reason', json({ error: 'payment_not_started', reason: 'odd' }, 502), { status: 'failed' }],
    ['a 500', json({ error: 'internal_error' }, 500), { status: 'failed' }],
    ['a 503 with no JSON', new Response('down', { status: 503 }), { status: 'failed' }],
  ])('answers %s as a worded result, never a throw', async (_label, response, expected) => {
    stubApi(() => response)

    await expect(subscriptionApi.pay(PAY)).resolves.toEqual(expected)
  })

  it('throws on a network failure, which the page words as a payment that did not start', async () => {
    stubApi(() => Promise.reject(new TypeError('Failed to fetch')))

    await expect(subscriptionApi.pay(PAY)).rejects.toBeInstanceOf(TypeError)
  })

  it('throws UnauthenticatedError on a 401 and drops the session', async () => {
    stubApi(() => json({ error: 'invalid_token' }, 401))

    await expect(subscriptionApi.pay(PAY)).rejects.toBeInstanceOf(UnauthenticatedError)
    expect(readSession('studio')).toBeNull()
  })

  it('asks nothing without a studio session', async () => {
    sessionStorage.clear()
    const api = stubApi(() => json({}))

    await expect(subscriptionApi.pay(PAY)).rejects.toBeInstanceOf(UnauthenticatedError)
    expect(api.sent).toHaveLength(0)
  })
})

describe('subscriptionApi.payment', () => {
  it('reads one payment by its reference, escaped, never from the cache', async () => {
    const progress = paymentProgress({ status: 'succeeded' }, { status: 'active' })
    const api = stubApi(() => json(progress))

    await expect(subscriptionApi.payment('a/b')).resolves.toEqual(progress)
    expect(api.sent[0]?.url).toBe('/api/studio/subscription/payments/a%2Fb')
    expect(api.mock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' })
  })

  it('is null for a 404: unknown, another studio, or not a subscription payment', async () => {
    stubApi(() => json({ error: 'not_found' }, 404))

    await expect(subscriptionApi.payment(OUR_REF)).resolves.toBeNull()
  })

  it.each([
    ['no payment', { subscription: { status: 'active', currentPeriodEndsAt: '2026-11-30T08:00:00.000Z', takingBookings: true } }],
    ['no subscription', { payment: { status: 'pending' } }],
  ])('throws on a body with %s', async (_label, body) => {
    stubApi(() => json(body))

    await expect(subscriptionApi.payment(OUR_REF)).rejects.toBeInstanceOf(ApiError)
  })

  it('throws on a 500, so the page counts a failed check', async () => {
    stubApi(() => json({ error: 'internal_error' }, 500))

    await expect(subscriptionApi.payment(OUR_REF)).rejects.toMatchObject({ status: 500 })
  })
})

describe('paymentOutcome', () => {
  it.each([
    ['initiated', 'waiting'],
    ['pending', 'waiting'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['refund_due', 'other'],
    ['refunded', 'other'],
    ['anything', 'other'],
  ])('reads %s as %s', (status, outcome) => {
    expect(paymentOutcome(status)).toBe(outcome)
  })
})

describe('yearlySaving', () => {
  it.each([
    [{ monthly: 10_000, yearly: 100_000 }, 20_000],
    [{ monthly: 10_000, yearly: 119_999 }, 1],
    [{ monthly: 10_000, yearly: 120_000 }, null],
    [{ monthly: 10_000, yearly: 150_000 }, null],
    [{ monthly: 1, yearly: 1 }, 11],
  ])('for %j is %s', (prices, saving) => {
    expect(yearlySaving(prices)).toBe(saving)
  })
})

describe('subscriptionBanner', () => {
  const NOW = new Date('2026-10-25T08:00:00.000Z')
  const DAY = 24 * 60 * 60 * 1000
  const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString()

  it('is seven days', () => {
    expect(ENDING_SOON_DAYS).toBe(7)
  })

  it('is none for no subscription', () => {
    expect(subscriptionBanner(null, NOW)).toBeNull()
  })

  it.each([
    ['past_due', at(-1), 'past_due'],
    // Past due or expired whatever the end date says: the status is the API's, at its clock.
    ['past_due', at(20), 'past_due'],
    ['expired', at(-30), 'expired'],
    ['expired', at(20), 'expired'],
    ['trialing', at(7), 'trial_ending'],
    ['trialing', at(0.01), 'trial_ending'],
    ['active', at(3), 'period_ending'],
    ['active', at(7), 'period_ending'],
  ] as const)('is %s ending %s: %s', (status, currentPeriodEndsAt, banner) => {
    expect(subscriptionBanner({ status, currentPeriodEndsAt }, NOW)).toBe(banner)
  })

  it.each([
    ['trialing', at(7.001)],
    ['active', at(8)],
    ['active', at(365)],
    // Already over without the status having caught up: not "ending".
    ['trialing', at(0)],
    ['active', at(-1)],
    ['active', 'not a date'],
  ] as const)('is none for %s ending %s', (status, currentPeriodEndsAt) => {
    expect(subscriptionBanner({ status, currentPeriodEndsAt }, NOW)).toBeNull()
  })
})

describe('lastPaidPeriod', () => {
  it('is the newest paid period, skipping the trial', () => {
    const newest = paidPeriod({ id: 'newest', startsAt: '2026-11-30T08:00:00.000Z' })
    expect(lastPaidPeriod([newest, paidPeriod(), trialPeriod()])).toBe(newest)
  })

  it('is null when only the trial was ever had, or nothing', () => {
    expect(lastPaidPeriod([trialPeriod()])).toBeNull()
    expect(lastPaidPeriod([])).toBeNull()
  })
})

describe('isSubscriptionStatus', () => {
  it.each(['trialing', 'active', 'past_due', 'expired'])('accepts %s', (value) => {
    expect(isSubscriptionStatus(value)).toBe(true)
  })

  it.each([null, '', 'pastdue', 'ACTIVE', 'cancelled'])('refuses %s', (value) => {
    expect(isSubscriptionStatus(value)).toBe(false)
  })
})
