import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { readSession, saveSession } from '@/auth/session'
import { cardConfig } from '@/test/card-fixtures'
import { json, stubApi } from '@/test/fetch'
import { OUR_REF, paidPeriod, paymentProgress, subscriptionPage, trialPeriod } from '@/test/subscription-fixtures'
import { isSubscriptionStatus, lastPaidPeriod, paymentOutcome, subscriptionApi, yearlySaving } from './subscription'

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
    // A card is offered last since 2026-10-30; a method this app cannot label is dropped, not drawn blank.
    [['card', 'momo_mtn', 'paypal'], ['momo_mtn', 'card']],
    [['card'], ['card']],
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
      { status: 'in_progress', ourRef: OUR_REF, method: null },
    ],
    [
      '409 payment_in_progress of a card',
      json({ error: 'payment_in_progress', payment: { ourRef: OUR_REF, method: 'card' } }, 409),
      { status: 'in_progress', ourRef: OUR_REF, method: 'card' },
    ],
    [
      '409 payment_in_progress of a MoMo prompt',
      json({ error: 'payment_in_progress', payment: { ourRef: OUR_REF, method: 'momo_mtn' } }, 409),
      { status: 'in_progress', ourRef: OUR_REF, method: 'momo_mtn' },
    ],
    [
      '409 payment_in_progress of an unknown method',
      json({ error: 'payment_in_progress', payment: { ourRef: OUR_REF, method: 'cheque' } }, 409),
      { status: 'in_progress', ourRef: OUR_REF, method: null },
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

describe('subscriptionApi.pay by card (Flutterwave v3 Inline)', () => {
  const CARD_PAY = { planInterval: 'monthly', method: 'card', phone: '0788123456' } as const
  const payment = { ourRef: OUR_REF, status: 'pending', planInterval: 'monthly', amountRwf: 10_000 }

  it('posts the plan and the method only: no phone, never an amount', async () => {
    const api = stubApi(() => json({ payment, card: cardConfig(OUR_REF, { amount: 10_000 }) }, 201))

    await subscriptionApi.pay(CARD_PAY)
    expect(api.sent[0]?.body).toStrictEqual({ planInterval: 'monthly', method: 'card' })
  })

  it.each([201, 200])('answers a %i with the Inline config, unchanged, as a card payment to open', async (status) => {
    const card = cardConfig(OUR_REF, { amount: 10_000 })
    stubApi(() => json({ payment, card }, status))

    await expect(subscriptionApi.pay(CARD_PAY)).resolves.toStrictEqual({
      status: 'card',
      ourRef: OUR_REF,
      planInterval: 'monthly',
      amountRwf: 10_000,
      card,
    })
  })

  it.each<[string, unknown]>([
    ['no config at all', undefined],
    ['a config for another payment', cardConfig('another-ref')],
    ['another currency', cardConfig(OUR_REF, { currency: 'USD' })],
    ['no amount', { ...cardConfig(OUR_REF), amount: undefined }],
    ['a zero amount', cardConfig(OUR_REF, { amount: 0 })],
    ['another payment type', { ...cardConfig(OUR_REF), payment_options: 'card,ussd' }],
    ['no public key', cardConfig(OUR_REF, { public_key: '' })],
    ['a return URL that is no web address', cardConfig(OUR_REF, { redirect_url: 'javascript:alert(1)' })],
    ['no customer', { ...cardConfig(OUR_REF), customer: null }],
    ['a string', 'FLWPUBK'],
  ])('is a failure when the card answer carries %s', async (_label, card) => {
    stubApi(() => json({ payment, ...(card === undefined ? {} : { card }) }, 201))

    await expect(subscriptionApi.pay(CARD_PAY)).resolves.toStrictEqual({ status: 'failed' })
  })

  it('still reads a MoMo 201 without a config as started', async () => {
    stubApi(() => json({ payment }, 201))

    await expect(subscriptionApi.pay(PAY)).resolves.toMatchObject({ status: 'started', ourRef: OUR_REF })
  })

  it('answers a card 409 payment_in_progress by the existing rules', async () => {
    stubApi(() => json({ error: 'payment_in_progress', payment: { ourRef: OUR_REF } }, 409))

    await expect(subscriptionApi.pay(CARD_PAY)).resolves.toStrictEqual({ status: 'in_progress', ourRef: OUR_REF, method: null })
  })

  it('names the waiting payment as a card when the 409 does', async () => {
    stubApi(() => json({ error: 'payment_in_progress', payment: { ourRef: OUR_REF, method: 'card' } }, 409))

    await expect(subscriptionApi.pay(CARD_PAY)).resolves.toStrictEqual({ status: 'in_progress', ourRef: OUR_REF, method: 'card' })
  })
})

describe('subscriptionApi.payment', () => {
  it("passes a card try's transaction id when it is digits, and nothing otherwise", async () => {
    const api = stubApi(() => json(paymentProgress()))
    const base = `/api/studio/subscription/payments/${OUR_REF}`

    await subscriptionApi.payment(OUR_REF, '4100000123')
    await subscriptionApi.payment(OUR_REF, '41x')
    await subscriptionApi.payment(OUR_REF, '1'.repeat(21))
    await subscriptionApi.payment(OUR_REF, '4100000123&status=successful')
    await subscriptionApi.payment(OUR_REF, null)
    expect(api.sent.map((sent) => sent.url)).toEqual([`${base}?transactionId=4100000123`, base, base, base, base])
  })


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
