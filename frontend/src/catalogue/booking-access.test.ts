import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ClientBooking,
  bookingPath,
  bookingPaymentPath,
  cancelBooking,
  confirmEmailChange,
  emailConfirmPath,
  fetchClientBooking,
  requestEmailChange,
  startSessionFeePayment,
} from './booking-access'
import { PaymentApiError } from './payments'

/**
 * The client-booking API client (plan.md Task 18; spec §3.9, §6.10).
 *
 * What is proven: all three calls address the booking by the token in the path
 * and send nothing else -- no id, no reference, no email -- and each maps every
 * answer of the route's contract. `fetchClientBooking` is an anonymous
 * `no-store` GET whose 404 is "this link is not valid" rather than an error,
 * while any other refusal, an unusable body or an unreachable API is a
 * `PaymentApiError`; an abort the caller asked for comes back as it was.
 * `cancelBooking` reads 200, 404 and 409 apart and carries the booking each one
 * returns. `startSessionFeePayment` maps 201, 404, 409 in both its kinds, 422
 * and 502 in both of its, and reads anything else as `failed`. Paths encode
 * every segment they are given.
 */

const TOKEN = 'aB3_x-9QzT7vL4pR8sK1nB6yH3cF5dG0wJeLmNoPqRs'
const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'

const BOOKING: ClientBooking = {
  reference: 'BKY-2610-7K3QX',
  status: 'confirmed',
  stage: 'confirmed',
  clientName: 'Aline Uwase',
  maskedEmail: 'a•••••@example.com',
  pendingMaskedEmail: null,
  startsAt: '2026-10-07T07:30:00.000Z',
  endsAt: '2026-10-07T09:00:00.000Z',
  serviceName: 'Portraits',
  packageName: 'Standard',
  packagePriceRwf: 40_000,
  packagePhotoCount: 25,
  packageDurationMinutes: 90,
  locationText: 'Kigali Heights, KG 7 Ave',
  partySize: 3,
  specialRequests: null,
  addons: [{ name: 'Extra hour', priceRwf: 10_000, stage: 'at_booking' }],
  totals: { quotedTotalRwf: 50_000, grandTotalRwf: 50_000, collectedRwf: 20_000, refundDueRwf: 0, outstandingRwf: 30_000 },
  bookingFeeRwf: 20_000,
  payments: [{ kind: 'booking_fee', status: 'succeeded', amountRwf: 20_000, settledAt: '2026-10-01T06:05:00.000Z' }],
  canCancel: true,
  cancellationReason: null,
  cancelledAt: null,
  sessionFee: { outstandingRwf: 30_000, waitingPayment: null },
  delivery: null,
  notices: [],
}

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

afterEach(() => {
  vi.unstubAllGlobals()
})

// --- Paths -----------------------------------------------------------------------------------

describe('the paths', () => {
  it('put the token in the path of the booking page, and nothing in a query string', () => {
    expect(bookingPath(TOKEN)).toBe(`/booking/${TOKEN}`)
    expect(bookingPath(TOKEN)).not.toContain('?')
  })

  it('put a payment below its own booking', () => {
    expect(bookingPaymentPath(TOKEN, OUR_REF)).toBe(`/booking/${TOKEN}/payments/${OUR_REF}`)
  })

  it('encode every segment, so a hostile token cannot climb out of its path', () => {
    expect(bookingPath('a/../b?c#d')).toBe('/booking/a%2F..%2Fb%3Fc%23d')
    expect(bookingPaymentPath('t', 'a?b')).toBe('/booking/t/payments/a%3Fb')
  })
})

// --- Reading the booking -----------------------------------------------------------------------

describe('fetchClientBooking', () => {
  it('GETs the token’s booking, no-store, asking for JSON and sending no credentials or body', async () => {
    const mock = stubFetch(() => json({ booking: BOOKING }))

    await expect(fetchClientBooking(TOKEN)).resolves.toStrictEqual(BOOKING)

    const { url, init, headers } = sentRequest(mock)
    expect(url).toBe(`/api/booking/${TOKEN}`)
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.cache).toBe('no-store')
    expect(init.body).toBeUndefined()
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('Authorization')).toBeNull()
  })

  it('encodes the token into the request', async () => {
    const mock = stubFetch(() => json({ booking: BOOKING }))

    await fetchClientBooking('a/b?c')

    expect(sentRequest(mock).url).toBe('/api/booking/a%2Fb%3Fc')
  })

  it('answers null for 404: the link is not valid, which is not an error', async () => {
    stubFetch(() => json({ error: 'not_found' }, 404))

    await expect(fetchClientBooking(TOKEN)).resolves.toBeNull()
  })

  it('answers null when a 200 carries no booking this client can read', async () => {
    for (const body of [{}, { booking: null }, { booking: { reference: 1 } }, { booking: { reference: 'x', status: 'y' } }, null]) {
      stubFetch(() => json(body))
      await expect(fetchClientBooking(TOKEN)).resolves.toBeNull()
      vi.unstubAllGlobals()
    }
  })

  it.each([400, 401, 403, 409, 422, 500, 502, 503])('throws a PaymentApiError carrying the status for %i', async (status) => {
    stubFetch(() => json({ error: 'nope' }, status))

    const error = await rejectionOf(fetchClientBooking(TOKEN))

    expect(error).toBeInstanceOf(PaymentApiError)
    expect((error as PaymentApiError).status).toBe(status)
  })

  it('throws a PaymentApiError with a null status when the API cannot be reached', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))

    const error = await rejectionOf(fetchClientBooking(TOKEN))

    expect(error).toBeInstanceOf(PaymentApiError)
    expect((error as PaymentApiError).status).toBeNull()
  })

  it('throws a PaymentApiError when a 200 body is not JSON', async () => {
    stubFetch(() => new Response('<html>down</html>', { status: 200 }))

    expect(await rejectionOf(fetchClientBooking(TOKEN))).toBeInstanceOf(PaymentApiError)
  })

  it('passes the abort signal on, and rethrows an abort as it was', async () => {
    const controller = new AbortController()
    const mock = stubFetch(() => {
      controller.abort()
      return Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
    })

    const error = await rejectionOf(fetchClientBooking(TOKEN, controller.signal))

    expect((error as Error).name).toBe('AbortError')
    expect(sentRequest(mock).init.signal).toBe(controller.signal)
  })
})

// --- Cancelling ---------------------------------------------------------------------------------

describe('cancelBooking', () => {
  const cancelled = { ...BOOKING, status: 'cancelled_by_client', stage: 'cancelled_by_client', canCancel: false, cancelledAt: '2026-10-01T06:00:00.000Z' }

  it('POSTs to the token’s cancel route with no body at all', async () => {
    const mock = stubFetch(() => json({ booking: cancelled }))

    await expect(cancelBooking(TOKEN)).resolves.toStrictEqual({ status: 'cancelled', booking: cancelled })

    const { url, init, headers } = sentRequest(mock)
    expect(url).toBe(`/api/booking/${TOKEN}/cancel`)
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
    expect(headers.get('Accept')).toBe('application/json')
  })

  it('encodes the token into the request', async () => {
    const mock = stubFetch(() => json({ booking: cancelled }))

    await cancelBooking('a/b')

    expect(sentRequest(mock).url).toBe('/api/booking/a%2Fb/cancel')
  })

  it('reads 404 as a link that is no longer valid', async () => {
    stubFetch(() => json({ error: 'not_found' }, 404))

    await expect(cancelBooking(TOKEN)).resolves.toStrictEqual({ status: 'not_found' })
  })

  it('reads 409 as not_cancellable, carrying the booking as it now stands', async () => {
    stubFetch(() => json({ error: 'not_cancellable', booking: cancelled }, 409))

    await expect(cancelBooking(TOKEN)).resolves.toStrictEqual({ status: 'not_cancellable', booking: cancelled })
  })

  it('reads a 409 with no booking as not_cancellable with none', async () => {
    stubFetch(() => json({ error: 'not_cancellable' }, 409))

    await expect(cancelBooking(TOKEN)).resolves.toStrictEqual({ status: 'not_cancellable', booking: null })
  })

  it('reads a 200 with no usable booking as failed, rather than claiming a cancellation', async () => {
    stubFetch(() => json({ ok: true }))

    await expect(cancelBooking(TOKEN)).resolves.toStrictEqual({ status: 'failed' })
  })

  it.each([400, 401, 500, 502])('reads %i as failed', async (status) => {
    stubFetch(() => json({ error: 'internal_error' }, status))

    await expect(cancelBooking(TOKEN)).resolves.toStrictEqual({ status: 'failed' })
  })

  it('reads an unreachable API as failed rather than throwing', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))

    await expect(cancelBooking(TOKEN)).resolves.toStrictEqual({ status: 'failed' })
  })

  it('reads a body that is not JSON as failed', async () => {
    stubFetch(() => new Response('<html>down</html>', { status: 200 }))

    await expect(cancelBooking(TOKEN)).resolves.toStrictEqual({ status: 'failed' })
  })
})

// --- Paying the session fee -------------------------------------------------------------------

describe('startSessionFeePayment', () => {
  const request = { method: 'momo_mtn', phone: '078 812 3456' } as const

  it('POSTs the method and the phone as JSON, and nothing else', async () => {
    const mock = stubFetch(() => json({ payment: { ourRef: OUR_REF, status: 'pending' } }, 201))

    await expect(startSessionFeePayment(TOKEN, request)).resolves.toStrictEqual({ status: 'started', ourRef: OUR_REF })

    const { url, init, headers } = sentRequest(mock)
    expect(url).toBe(`/api/booking/${TOKEN}/payments`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toStrictEqual({ method: 'momo_mtn', phone: '078 812 3456' })
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('sends no booking id, reference or email, however the caller is holding one', async () => {
    const mock = stubFetch(() => json({ payment: { ourRef: OUR_REF } }, 201))

    await startSessionFeePayment(TOKEN, request)

    const body = String(sentRequest(mock).init.body)
    for (const key of ['reference', 'bookingId', 'id', 'email', 'amount', 'token']) expect(body).not.toContain(key)
    expect(sentRequest(mock).url).not.toContain('?')
  })

  it('reads a 201 with no our_ref as failed rather than navigating nowhere', async () => {
    stubFetch(() => json({ payment: {} }, 201))

    await expect(startSessionFeePayment(TOKEN, request)).resolves.toStrictEqual({ status: 'failed' })
  })

  it('reads 404 as a link that is no longer valid', async () => {
    stubFetch(() => json({ error: 'not_found' }, 404))

    await expect(startSessionFeePayment(TOKEN, request)).resolves.toStrictEqual({ status: 'not_found' })
  })

  it('reads 409 payment_in_progress as the attempt already waiting', async () => {
    stubFetch(() => json({ error: 'payment_in_progress', payment: { ourRef: OUR_REF } }, 409))

    await expect(startSessionFeePayment(TOKEN, request)).resolves.toStrictEqual({ status: 'in_progress', ourRef: OUR_REF })
  })

  it.each([
    ['nothing_to_pay', { error: 'nothing_to_pay', booking: BOOKING }],
    ['a 409 with no error name', {}],
    ['payment_in_progress with no our_ref', { error: 'payment_in_progress' }],
  ])('reads %s as closed: the page reloads to show why', async (_case, body) => {
    stubFetch(() => json(body, 409))

    await expect(startSessionFeePayment(TOKEN, request)).resolves.toStrictEqual({ status: 'closed' })
  })

  it('reads 422 as the fields the API named', async () => {
    stubFetch(() => json({ error: 'validation_failed', fields: ['phone'] }, 422))

    await expect(startSessionFeePayment(TOKEN, request)).resolves.toStrictEqual({ status: 'invalid', fields: ['phone'] })
  })

  it('reads 422 with both fields named', async () => {
    stubFetch(() => json({ error: 'validation_failed', fields: ['method', 'phone'] }, 422))

    await expect(startSessionFeePayment(TOKEN, request)).resolves.toStrictEqual({ status: 'invalid', fields: ['method', 'phone'] })
  })

  it('reads a 422 with no fields as failed', async () => {
    stubFetch(() => json({ error: 'validation_failed' }, 422))

    await expect(startSessionFeePayment(TOKEN, request)).resolves.toStrictEqual({ status: 'failed' })
  })

  it.each(['rejected', 'unavailable'] as const)('reads a 502 with reason %s as not_started', async (reason) => {
    stubFetch(() => json({ error: 'payment_not_started', reason, payment: { ourRef: OUR_REF, status: 'failed' } }, 502))

    await expect(startSessionFeePayment(TOKEN, request)).resolves.toStrictEqual({ status: 'not_started', reason })
  })

  it('reads a 502 with an unknown reason as failed', async () => {
    stubFetch(() => json({ error: 'payment_not_started', reason: 'gremlins' }, 502))

    await expect(startSessionFeePayment(TOKEN, request)).resolves.toStrictEqual({ status: 'failed' })
  })

  it.each([400, 401, 403, 500, 503])('reads %i as failed', async (status) => {
    stubFetch(() => json({ error: 'invalid_request' }, status))

    await expect(startSessionFeePayment(TOKEN, request)).resolves.toStrictEqual({ status: 'failed' })
  })

  it('reads an unreachable API as failed rather than throwing', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))

    await expect(startSessionFeePayment(TOKEN, request)).resolves.toStrictEqual({ status: 'failed' })
  })

  it('reads a body that is not JSON as failed', async () => {
    stubFetch(() => new Response('<html>502</html>', { status: 502 }))

    await expect(startSessionFeePayment(TOKEN, request)).resolves.toStrictEqual({ status: 'failed' })
  })

  it('encodes the token into the request', async () => {
    const mock = stubFetch(() => json({ payment: { ourRef: OUR_REF } }, 201))

    await startSessionFeePayment('a/b', request)

    expect(sentRequest(mock).url).toBe('/api/booking/a%2Fb/payments')
  })
})

describe('requestEmailChange (2026-09-25)', () => {
  function stubOnce(status: number, body: unknown) {
    const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }))
    vi.stubGlobal('fetch', mock)
    return mock
  }

  it('posts only the email, to the token\u2019s own path', async () => {
    const mock = stubOnce(202, { booking: BOOKING })

    await expect(requestEmailChange(TOKEN, 'aline.new@example.com')).resolves.toEqual({ status: 'requested', booking: BOOKING })

    const [url, init] = mock.mock.calls[0] ?? []
    expect([url, init?.method]).toEqual([`/api/booking/${TOKEN}/email`, 'POST'])
    expect(JSON.parse(String(init?.body))).toStrictEqual({ email: 'aline.new@example.com' })
  })

  it.each([
    [200, { booking: BOOKING }, { status: 'unchanged', booking: BOOKING }],
    [409, { error: 'not_allowed', booking: BOOKING }, { status: 'not_allowed', booking: BOOKING }],
    [404, { error: 'not_found' }, { status: 'not_found' }],
    [422, { error: 'validation_failed', fields: ['email'] }, { status: 'invalid' }],
    [429, { error: 'too_many_requests' }, { status: 'rate_limited' }],
    [500, {}, { status: 'failed' }],
  ])('reads %i', async (status, body, expected) => {
    stubOnce(status, body)
    await expect(requestEmailChange(TOKEN, 'aline.new@example.com')).resolves.toEqual(expected)
  })
})

describe('confirmEmailChange (2026-09-25)', () => {
  it.each([
    [200, 'confirmed'],
    [404, 'invalid'],
    [500, 'failed'],
  ] as const)('reads %i as %s', async (status, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })))
    await expect(confirmEmailChange('Cf7mN2bV9cX4zL1kJ8hG5fD3sA6pO0iU')).resolves.toBe(expected)
  })

  it('is failed when the API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network'))))
    await expect(confirmEmailChange('Cf7mN2bV9cX4zL1kJ8hG5fD3sA6pO0iU')).resolves.toBe('failed')
  })

  it('builds the page path the email links to', () => {
    expect(emailConfirmPath('a/b')).toBe('/email-confirm/a%2Fb')
  })
})
