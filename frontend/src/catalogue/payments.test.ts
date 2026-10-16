import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KNOWN_METHODS,
  PaymentApiError,
  checkoutPath,
  fetchCheckout,
  fetchPaymentMethods,
  fetchPaymentProgress,
  paymentPath,
  startPayment,
} from './payments'

/**
 * The payment client (plan.md Task 16, spec §3.1 steps 9-10, §6.19).
 *
 * What is proven: the methods come from `GET /api/payment-methods`, and only
 * those this client can label survive, so the page renders nothing it cannot
 * name; the checkout and a payment's progress are anonymous no-store GETs
 * whose 404 is "no such link" rather than an error; every other refusal, an
 * unusable body and an unreachable API is a `PaymentApiError` carrying the
 * status (null for the network), while an abort the caller asked for comes back
 * as it was; and `startPayment` maps each answer of the contract -- 201, 404,
 * 409 in its four kinds, 422, 502 in its two -- and reads anything else, a body
 * it cannot act on, or no answer at all as `failed`. Paths are built with each
 * segment encoded.
 */

type FetchArgs = [input: string | URL | Request, init?: RequestInit]

function stubFetch(respond: (...args: FetchArgs) => Response | Promise<Response>) {
  const mock = vi.fn(async (...args: FetchArgs) => respond(...args))
  vi.stubGlobal('fetch', mock)
  return mock
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

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

async function apiError(promise: Promise<unknown>): Promise<PaymentApiError> {
  const error = await rejectionOf(promise)
  expect(error).toBeInstanceOf(PaymentApiError)
  return error as PaymentApiError
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const REFERENCE = 'BKY-2610-7K3QX'
const TOKEN = 'aB3_x-9QzT7vL4pR8sK1nB6yH3cF5dG0wJeLmNoPqRs'
const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'

const CHECKOUT = {
  reference: REFERENCE,
  serviceName: 'Portraits',
  packageName: 'Standard',
  startsAt: '2026-10-07T07:30:00.000Z',
  endsAt: '2026-10-07T09:00:00.000Z',
  holdExpiresAt: '2026-10-01T06:30:00.000Z',
  bookingFeeRwf: 20_000,
  state: 'payable',
  waitingPayment: null,
}

const PROGRESS = {
  payment: { status: 'pending', amountRwf: 20_000, failure: null },
  booking: { reference: REFERENCE, status: 'pending_payment', serviceName: 'Portraits', packageName: 'Standard', startsAt: CHECKOUT.startsAt, endsAt: CHECKOUT.endsAt },
}

// --- Paths ---------------------------------------------------------------------------------

describe('checkoutPath and paymentPath', () => {
  it('build the site paths the routes serve', () => {
    expect(checkoutPath(REFERENCE, TOKEN)).toBe(`/checkout/${REFERENCE}/${TOKEN}`)
    expect(paymentPath(REFERENCE, TOKEN, OUR_REF)).toBe(`/checkout/${REFERENCE}/${TOKEN}/payments/${OUR_REF}`)
  })

  it('encode each segment, so nothing typed can climb out of its place', () => {
    expect(checkoutPath('a/b', '../x?y#z')).toBe('/checkout/a%2Fb/..%2Fx%3Fy%23z')
    expect(paymentPath('r', 't', 'o/../p')).toBe('/checkout/r/t/payments/o%2F..%2Fp')
  })
})

// --- Methods ---------------------------------------------------------------------------------

describe('fetchPaymentMethods', () => {
  it('GETs /api/payment-methods, no-store, asking for JSON', async () => {
    const mock = stubFetch(() => json({ provider: 'mtn_momo_direct', methods: ['momo_mtn'] }))

    await expect(fetchPaymentMethods()).resolves.toEqual(['momo_mtn'])

    const { url, init, headers } = sentRequest(mock)
    expect(url).toBe('/api/payment-methods')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.cache).toBe('no-store')
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('Authorization')).toBeNull()
  })

  it('answers MTN MoMo alone when the API lists MTN MoMo alone', async () => {
    stubFetch(() => json({ methods: ['momo_mtn'] }))
    expect(await fetchPaymentMethods()).toEqual(['momo_mtn'])
  })

  it('answers all three, in a fixed order, when the API lists them in any order', async () => {
    stubFetch(() => json({ methods: ['card', 'momo_airtel', 'momo_mtn'] }))
    expect(await fetchPaymentMethods()).toEqual([...KNOWN_METHODS])
  })

  it('drops a method it has no label for, and answers none for an empty list', async () => {
    stubFetch(() => json({ methods: ['paypal', 'momo_airtel', 'MOMO_MTN', 42, null] }))
    expect(await fetchPaymentMethods()).toEqual(['momo_airtel'])

    stubFetch(() => json({ methods: [] }))
    expect(await fetchPaymentMethods()).toEqual([])
  })

  it.each([
    ['no methods key', { provider: 'mtn_momo_direct' }],
    ['methods that are not a list', { methods: 'momo_mtn' }],
    ['a null body', null],
  ])('is a PaymentApiError(200) for %s', async (_case, body) => {
    stubFetch(() => json(body))
    expect((await apiError(fetchPaymentMethods())).status).toBe(200)
  })

  it.each([404, 500, 503])('is a PaymentApiError carrying %s', async (status) => {
    stubFetch(() => json({ error: 'x' }, status))
    const error = await apiError(fetchPaymentMethods())
    expect(error.status).toBe(status)
    expect(error.message).toBe(`http_${status}`)
  })

  it('is a PaymentApiError(200) for a body that is not JSON', async () => {
    stubFetch(() => new Response('<html>', { status: 200 }))
    expect((await apiError(fetchPaymentMethods())).status).toBe(200)
  })

  it('is a PaymentApiError with no status when the network fails', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    const error = await apiError(fetchPaymentMethods())
    expect(error.status).toBeNull()
    expect(error.message).toBe('network_error')
  })

  it('rethrows an abort as it was, passing the signal on', async () => {
    const controller = new AbortController()
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const mock = stubFetch(() => {
      controller.abort()
      return Promise.reject(abort)
    })

    expect(await rejectionOf(fetchPaymentMethods(controller.signal))).toBe(abort)
    expect(sentRequest(mock).init.signal).toBe(controller.signal)
  })
})

// --- Checkout --------------------------------------------------------------------------------

describe('fetchCheckout', () => {
  it('GETs the checkout by reference and token, no-store, and answers it', async () => {
    const mock = stubFetch(() => json({ checkout: CHECKOUT }))

    await expect(fetchCheckout(REFERENCE, TOKEN)).resolves.toEqual(CHECKOUT)

    const { url, init } = sentRequest(mock)
    expect(url).toBe(`/api/checkout/${REFERENCE}/${TOKEN}`)
    expect(init.cache).toBe('no-store')
  })

  it('encodes the reference and token into the path', async () => {
    const mock = stubFetch(() => json({ checkout: CHECKOUT }))
    await fetchCheckout('a/b', 't?x=1')
    expect(sentRequest(mock).url).toBe('/api/checkout/a%2Fb/t%3Fx%3D1')
  })

  it('answers null for a 404: the link is not valid', async () => {
    stubFetch(() => json({ error: 'not_found' }, 404))
    await expect(fetchCheckout(REFERENCE, TOKEN)).resolves.toBeNull()
  })

  it.each([
    ['no checkout', {}],
    ['a checkout without a reference', { checkout: { ...CHECKOUT, reference: undefined } }],
    ['a checkout without a state', { checkout: { ...CHECKOUT, state: 7 } }],
    ['a null checkout', { checkout: null }],
  ])('is a PaymentApiError(200) for %s', async (_case, body) => {
    stubFetch(() => json(body))
    expect((await apiError(fetchCheckout(REFERENCE, TOKEN))).status).toBe(200)
  })

  it.each([400, 409, 500])('is a PaymentApiError carrying %s', async (status) => {
    stubFetch(() => json({ error: 'x' }, status))
    expect((await apiError(fetchCheckout(REFERENCE, TOKEN))).status).toBe(status)
  })

  it('is a PaymentApiError with no status when the network fails', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    expect((await apiError(fetchCheckout(REFERENCE, TOKEN))).status).toBeNull()
  })
})

// --- Progress --------------------------------------------------------------------------------

describe('fetchPaymentProgress', () => {
  it('GETs the payment by our_ref, no-store, and answers it', async () => {
    const mock = stubFetch(() => json(PROGRESS))

    await expect(fetchPaymentProgress(OUR_REF)).resolves.toEqual(PROGRESS)

    const { url, init } = sentRequest(mock)
    expect(url).toBe(`/api/payments/${OUR_REF}`)
    expect(init.cache).toBe('no-store')
  })

  it('answers null for a 404', async () => {
    stubFetch(() => json({ error: 'not_found' }, 404))
    await expect(fetchPaymentProgress(OUR_REF)).resolves.toBeNull()
  })

  it.each([
    ['no payment', { booking: PROGRESS.booking }],
    ['no booking', { payment: PROGRESS.payment }],
    ['a payment without a status', { ...PROGRESS, payment: { amountRwf: 1 } }],
    ['a booking without a reference', { ...PROGRESS, booking: { status: 'confirmed' } }],
  ])('is a PaymentApiError(200) for %s', async (_case, body) => {
    stubFetch(() => json(body))
    expect((await apiError(fetchPaymentProgress(OUR_REF))).status).toBe(200)
  })

  it('is a PaymentApiError for a 503, and for the network', async () => {
    stubFetch(() => json({}, 503))
    expect((await apiError(fetchPaymentProgress(OUR_REF))).status).toBe(503)

    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    expect((await apiError(fetchPaymentProgress(OUR_REF))).status).toBeNull()
  })

  it('encodes our_ref into the path', async () => {
    const mock = stubFetch(() => json(PROGRESS))
    await fetchPaymentProgress('../admin')
    expect(sentRequest(mock).url).toBe('/api/payments/..%2Fadmin')
  })
})

// --- Starting a payment ---------------------------------------------------------------------------

describe('startPayment', () => {
  const REQUEST = { method: 'momo_mtn' as const, phone: '078 812 3456' }

  it('POSTs the method and phone as JSON to the checkout’s payments', async () => {
    const mock = stubFetch(() => json({ payment: { ourRef: OUR_REF, status: 'pending' } }, 201))

    await expect(startPayment(REFERENCE, TOKEN, REQUEST)).resolves.toEqual({ status: 'started', ourRef: OUR_REF })

    const { url, init, headers } = sentRequest(mock)
    expect(url).toBe(`/api/checkout/${REFERENCE}/${TOKEN}/payments`)
    expect(init.method).toBe('POST')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Accept')).toBe('application/json')
    expect(JSON.parse(String(init.body))).toStrictEqual({ method: 'momo_mtn', phone: '078 812 3456' })
  })

  it('sends no amount: the API decides what is charged', async () => {
    const mock = stubFetch(() => json({ payment: { ourRef: OUR_REF } }, 201))
    await startPayment(REFERENCE, TOKEN, REQUEST)
    expect(String(sentRequest(mock).init.body)).not.toMatch(/amount|rwf|fee/i)
  })

  it.each([
    ['201 with an our_ref', 201, { payment: { ourRef: OUR_REF, status: 'pending' } }, { status: 'started', ourRef: OUR_REF }],
    ['201 without an our_ref', 201, { payment: {} }, { status: 'failed' }],
    ['201 with a numeric our_ref', 201, { payment: { ourRef: 7 } }, { status: 'failed' }],
    ['404', 404, { error: 'not_found' }, { status: 'not_found' }],
    ['409 payment_in_progress', 409, { error: 'payment_in_progress', payment: { ourRef: OUR_REF } }, { status: 'in_progress', ourRef: OUR_REF }],
    ['409 payment_in_progress without an our_ref', 409, { error: 'payment_in_progress' }, { status: 'failed' }],
    ['409 already_paid', 409, { error: 'already_paid' }, { status: 'already_paid' }],
    ['409 hold_expired', 409, { error: 'hold_expired' }, { status: 'closed' }],
    ['409 nothing_to_pay', 409, { error: 'nothing_to_pay' }, { status: 'closed' }],
    ['409 of an unknown kind', 409, { error: 'slot_taken' }, { status: 'failed' }],
    ['422 naming the phone', 422, { error: 'validation_failed', fields: ['phone'] }, { status: 'invalid', fields: ['phone'] }],
    ['422 naming both', 422, { error: 'validation_failed', fields: ['method', 'phone'] }, { status: 'invalid', fields: ['method', 'phone'] }],
    ['422 without fields', 422, { error: 'validation_failed' }, { status: 'failed' }],
    ['502 rejected', 502, { error: 'payment_not_started', reason: 'rejected', payment: { ourRef: OUR_REF, status: 'failed' } }, { status: 'not_started', reason: 'rejected' }],
    ['502 unavailable', 502, { error: 'payment_not_started', reason: 'unavailable', payment: { ourRef: OUR_REF, status: 'failed' } }, { status: 'not_started', reason: 'unavailable' }],
    ['502 with another reason', 502, { error: 'payment_not_started', reason: 'weather' }, { status: 'failed' }],
    ['400', 400, { error: 'invalid_request' }, { status: 'failed' }],
    ['500', 500, { error: 'internal_error' }, { status: 'failed' }],
    ['200', 200, { payment: { ourRef: OUR_REF } }, { status: 'failed' }],
    ['a null body', 201, null, { status: 'failed' }],
  ])('reads %s', async (_case, status, body, expected) => {
    stubFetch(() => json(body, status))
    await expect(startPayment(REFERENCE, TOKEN, REQUEST)).resolves.toStrictEqual(expected)
  })

  it('reads a 422 field list of odd values as strings', async () => {
    stubFetch(() => json({ fields: ['phone', 3] }, 422))
    await expect(startPayment(REFERENCE, TOKEN, REQUEST)).resolves.toStrictEqual({ status: 'invalid', fields: ['phone', '3'] })
  })

  it('reads a body that is not JSON as failed', async () => {
    stubFetch(() => new Response('Bad Gateway', { status: 502 }))
    await expect(startPayment(REFERENCE, TOKEN, REQUEST)).resolves.toStrictEqual({ status: 'failed' })
  })

  it('reads an unreachable API as failed, without throwing', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    await expect(startPayment(REFERENCE, TOKEN, REQUEST)).resolves.toStrictEqual({ status: 'failed' })
  })

  it('encodes the reference and token into the path', async () => {
    const mock = stubFetch(() => json({ error: 'not_found' }, 404))
    await startPayment('a/b', 'c d', REQUEST)
    expect(sentRequest(mock).url).toBe('/api/checkout/a%2Fb/c%20d/payments')
  })
})
