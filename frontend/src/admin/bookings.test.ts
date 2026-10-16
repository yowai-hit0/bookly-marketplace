import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UnauthenticatedError } from './api'
import { type AdminBooking, BOOKING_STATUSES, bookingFromRefusal, bookingsApi } from './bookings'
import { readSession, saveSession } from './session'

/**
 * The bookings API client (plan.md Task 19; spec §3.6, §6.11, §6.12, §6.16,
 * §6.21).
 *
 * What is proven: the list's filter becomes the query string the API takes --
 * `status` repeated rather than joined, empty values left out entirely, and no
 * `?` at all when there is nothing to ask for -- every action is a POST with a
 * JSON body and the bearer token, and a 401 surfaces as `UnauthenticatedError`
 * with the stored session dropped, while any other refusal keeps the API's own
 * error code so the screen can map it to words.
 */

const SESSION = { token: 'header.payload.signature', expiresAt: '2999-01-01T00:00:00.000Z' }
const BOOKING_ID = 'b1a7c2d4-0000-4000-8000-000000000001'
const PAYMENT_ID = 'c2b8d3e5-0000-4000-8000-000000000002'
/** A catalogue add-on, and a line already on the booking (plan.md Task 20). */
const ADDON_ID = 'd3c9e4f6-0000-4000-8000-000000000003'
const LINE_ID = 'e4daf507-0000-4000-8000-000000000004'
/** The external host's link (plan.md Task 21, spec A-7). */
const DELIVERY_LINK = 'https://photos.example-host.com/s/abc123'

const BOOKING = {
  id: BOOKING_ID,
  reference: 'BKY-2701-00042',
  status: 'confirmed',
  stage: 'confirmed',
  locale: 'en',
  client: { id: 'cl1', fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000', anonymized: false },
  contact: { name: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000' },
  service: { id: 's1', name: 'Portraits' },
  package: { id: 'p1', name: 'Standard', priceRwf: 40_000, durationMinutes: 90, photoCount: 25 },
  schedule: {
    startsAt: '2027-01-06T07:00:00.000Z',
    endsAt: '2027-01-06T08:30:00.000Z',
    bufferEndsAt: '2027-01-06T09:00:00.000Z',
    holdExpiresAt: null,
    originalStartsAt: null,
    rescheduledAt: null,
  },
  details: { locationText: 'Kigali Heights', partySize: 3, specialRequests: null, consentAt: '2026-10-01T06:00:00.000Z' },
  addons: [],
  money: {
    bookingFeeRate: 0.4,
    bookingFeeRwf: 16_000,
    totals: { quotedTotalRwf: 40_000, grandTotalRwf: 40_000, collectedRwf: 16_000, refundDueRwf: 0, outstandingRwf: 24_000 },
  },
  payments: [],
  lifecycle: { confirmedAt: '2026-10-01T06:05:00.000Z', completedAt: null, cancelledAt: null, cancellationReason: null },
  access: { hasLink: true, expiresAt: '2027-10-01T06:05:00.000Z', lastUsedAt: null },
  delivery: { url: null, expiresOn: null, sentAt: null, note: null },
  notes: [],
  messages: [],
  actions: { canReschedule: true, canCancel: true, canComplete: false, canMarkNoShow: false, canResendLink: true, canEditAddons: false, canRequestSessionFee: false, canEditDelivery: false, canSendDelivery: false },
} satisfies AdminBooking

type FetchArgs = [input: string | URL | Request, init?: RequestInit]

function stubFetch(respond: () => Response | Promise<Response> = () => json({ booking: BOOKING })) {
  const mock = vi.fn(async (..._args: FetchArgs) => respond())
  vi.stubGlobal('fetch', mock)
  return mock
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** The one call's URL, method, headers and parsed body. */
function sent(mock: ReturnType<typeof stubFetch>) {
  expect(mock).toHaveBeenCalledTimes(1)
  const [input, init = {}] = mock.mock.calls[0] ?? []
  return {
    url: String(input),
    method: init.method ?? 'GET',
    headers: new Headers(init.headers),
    body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected the promise to reject')
}

beforeEach(() => {
  saveSession(SESSION)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

// --- The list's query string -----------------------------------------------------

describe('bookingsApi.list', () => {
  it('asks for the bare path when there is nothing to filter by', async () => {
    const mock = stubFetch(() => json({ bookings: [], total: 0, page: 1, pageSize: 25, pageCount: 1 }))

    await bookingsApi.list()

    expect(sent(mock).url).toBe('/api/admin/bookings')
  })

  it('repeats status rather than joining it, in the order given', async () => {
    const mock = stubFetch(() => json({ bookings: [], total: 0, page: 1, pageSize: 25, pageCount: 1 }))

    await bookingsApi.list({ statuses: ['confirmed', 'no_show', 'cancelled_by_admin'] })

    expect(sent(mock).url).toBe('/api/admin/bookings?status=confirmed&status=no_show&status=cancelled_by_admin')
  })

  it('sends every status the API knows, unchanged', async () => {
    const mock = stubFetch(() => json({ bookings: [], total: 0, page: 1, pageSize: 25, pageCount: 1 }))

    await bookingsApi.list({ statuses: BOOKING_STATUSES })

    const url = new URL(sent(mock).url, 'https://admin.example')
    expect(url.searchParams.getAll('status')).toEqual([...BOOKING_STATUSES])
  })

  it('carries the dates, the search, the page and the page size', async () => {
    const mock = stubFetch(() => json({ bookings: [], total: 0, page: 1, pageSize: 25, pageCount: 1 }))

    await bookingsApi.list({ from: '2027-01-01', to: '2027-01-31', search: 'Uwase', page: 3, pageSize: 50 })

    expect(sent(mock).url).toBe('/api/admin/bookings?from=2027-01-01&to=2027-01-31&search=Uwase&page=3&pageSize=50')
  })

  it('leaves out anything empty or absent', async () => {
    const mock = stubFetch(() => json({ bookings: [], total: 0, page: 1, pageSize: 25, pageCount: 1 }))

    await bookingsApi.list({ statuses: [], from: '', to: '', search: '' })

    expect(sent(mock).url).toBe('/api/admin/bookings')
  })

  it('escapes what it is given rather than pasting it into the URL', async () => {
    const mock = stubFetch(() => json({ bookings: [], total: 0, page: 1, pageSize: 25, pageCount: 1 }))

    await bookingsApi.list({ search: 'a&b=c d+e' })

    const url = new URL(sent(mock).url, 'https://admin.example')
    expect(url.searchParams.get('search')).toBe('a&b=c d+e')
    expect(sent(mock).url).not.toContain('a&b=c')
  })

  it('answers the page the API sent, cursor included', async () => {
    const page = { bookings: [{ id: BOOKING_ID, reference: 'BKY-2701-00042' }], nextCursor: 'bmV4dA' }
    stubFetch(() => json(page))

    expect(await bookingsApi.list()).toEqual(page)
  })

  it('sends the bearer token and asks for JSON, with no body to post', async () => {
    const mock = stubFetch(() => json({ bookings: [], total: 0, page: 1, pageSize: 25, pageCount: 1 }))

    await bookingsApi.list()

    const call = sent(mock)
    expect(call.method).toBe('GET')
    expect(call.headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
    expect(call.headers.get('Accept')).toBe('application/json')
    expect(call.headers.has('Content-Type')).toBe(false)
    expect(call.body).toBeUndefined()
  })
})

// --- One booking, and every action ------------------------------------------------

describe('every call’s method, path and body', () => {
  type Call = [label: string, run: () => Promise<unknown>, method: string, url: string, body: unknown]

  it.each<Call>([
    ['get', () => bookingsApi.get(BOOKING_ID), 'GET', `/api/admin/bookings/${BOOKING_ID}`, undefined],
    [
      'reschedule',
      () => bookingsApi.reschedule(BOOKING_ID, '2027-01-07T09:00:00+02:00'),
      'POST',
      `/api/admin/bookings/${BOOKING_ID}/reschedule`,
      { startsAt: '2027-01-07T09:00:00+02:00' },
    ],
    ['cancel with a reason', () => bookingsApi.cancel(BOOKING_ID, 'Studio flooded.'), 'POST', `/api/admin/bookings/${BOOKING_ID}/cancel`, { reason: 'Studio flooded.' }],
    ['cancel with none', () => bookingsApi.cancel(BOOKING_ID, null), 'POST', `/api/admin/bookings/${BOOKING_ID}/cancel`, { reason: null }],
    ['complete', () => bookingsApi.complete(BOOKING_ID), 'POST', `/api/admin/bookings/${BOOKING_ID}/complete`, {}],
    ['markNoShow', () => bookingsApi.markNoShow(BOOKING_ID), 'POST', `/api/admin/bookings/${BOOKING_ID}/no-show`, {}],
    ['resendLink', () => bookingsApi.resendLink(BOOKING_ID), 'POST', `/api/admin/bookings/${BOOKING_ID}/resend-link`, {}],
    [
      'recordRefund',
      () => bookingsApi.recordRefund(PAYMENT_ID, 'MOMO-REF-7781'),
      'POST',
      `/api/admin/payments/${PAYMENT_ID}/refund`,
      { reference: 'MOMO-REF-7781' },
    ],
    // Task 20. No amount travels: the API prices the add-on from the catalogue.
    [
      'addAddon with the quantity left out',
      () => bookingsApi.addAddon(BOOKING_ID, ADDON_ID),
      'POST',
      `/api/admin/bookings/${BOOKING_ID}/addons`,
      { addonId: ADDON_ID, quantity: 1 },
    ],
    [
      'addAddon with a quantity',
      () => bookingsApi.addAddon(BOOKING_ID, ADDON_ID, 3),
      'POST',
      `/api/admin/bookings/${BOOKING_ID}/addons`,
      { addonId: ADDON_ID, quantity: 3 },
    ],
    [
      'removeAddon',
      () => bookingsApi.removeAddon(BOOKING_ID, LINE_ID),
      'DELETE',
      `/api/admin/bookings/${BOOKING_ID}/addons/${LINE_ID}`,
      undefined,
    ],
    [
      'requestSessionFee',
      () => bookingsApi.requestSessionFee(BOOKING_ID),
      'POST',
      `/api/admin/bookings/${BOOKING_ID}/session-fee`,
      {},
    ],
    // Task 21. Saving is a PUT: the delivery is one record replaced, not an
    // event appended.
    [
      'saveDelivery with only the link',
      () => bookingsApi.saveDelivery(BOOKING_ID, { url: DELIVERY_LINK }),
      'PUT',
      `/api/admin/bookings/${BOOKING_ID}/delivery`,
      { url: DELIVERY_LINK },
    ],
    [
      'saveDelivery with a date and a note',
      () => bookingsApi.saveDelivery(BOOKING_ID, { url: DELIVERY_LINK, expiresOn: '2027-03-15', note: 'Thank you!' }),
      'PUT',
      `/api/admin/bookings/${BOOKING_ID}/delivery`,
      { url: DELIVERY_LINK, expiresOn: '2027-03-15', note: 'Thank you!' },
    ],
    [
      'sendDelivery',
      () => bookingsApi.sendDelivery(BOOKING_ID),
      'POST',
      `/api/admin/bookings/${BOOKING_ID}/delivery/send`,
      {},
    ],
    [
      'sendDelivery to another address',
      () => bookingsApi.sendDelivery(BOOKING_ID, 'other@example.com'),
      'POST',
      `/api/admin/bookings/${BOOKING_ID}/delivery/send`,
      { recipient: 'other@example.com' },
    ],
  ])('%s', async (_label, run, method, url, body) => {
    const mock = stubFetch()

    await run()

    const call = sent(mock)
    expect([call.url, call.method]).toEqual([url, method])
    expect(call.headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
    if (body === undefined) {
      expect(call.body).toBeUndefined()
      expect(call.headers.has('Content-Type')).toBe(false)
    } else {
      expect(call.body).toEqual(body)
      expect(call.headers.get('Content-Type')).toBe('application/json')
    }
  })

  it('answers the parsed booking every action returns', async () => {
    stubFetch()

    expect(await bookingsApi.get(BOOKING_ID)).toEqual({ booking: BOOKING })
    vi.unstubAllGlobals()
    stubFetch()
    expect((await bookingsApi.complete(BOOKING_ID)).booking.actions.canResendLink).toBe(true)
  })
})

// --- Refusals ----------------------------------------------------------------------

describe('when the API refuses', () => {
  it.each([
    ['list', () => bookingsApi.list()],
    ['get', () => bookingsApi.get(BOOKING_ID)],
    ['cancel', () => bookingsApi.cancel(BOOKING_ID, null)],
    ['recordRefund', () => bookingsApi.recordRefund(PAYMENT_ID, 'MOMO-1')],
    ['addAddon', () => bookingsApi.addAddon(BOOKING_ID, ADDON_ID)],
    ['removeAddon', () => bookingsApi.removeAddon(BOOKING_ID, LINE_ID)],
    ['requestSessionFee', () => bookingsApi.requestSessionFee(BOOKING_ID)],
    ['saveDelivery', () => bookingsApi.saveDelivery(BOOKING_ID, { url: DELIVERY_LINK })],
    ['sendDelivery', () => bookingsApi.sendDelivery(BOOKING_ID)],
  ])('surfaces a 401 from %s as UnauthenticatedError and forgets the token', async (_label, run) => {
    stubFetch(() => json({ error: 'unauthenticated' }, 401))

    const error = await rejectionOf(run())

    expect(error).toBeInstanceOf(UnauthenticatedError)
    expect(readSession()).toBeNull()
  })

  it('throws UnauthenticatedError without asking the network when there is no session', async () => {
    sessionStorage.clear()
    const mock = stubFetch()

    expect(await rejectionOf(bookingsApi.list())).toBeInstanceOf(UnauthenticatedError)
    expect(mock).not.toHaveBeenCalled()
  })

  it.each([
    ['slot_taken', 409],
    ['unchanged', 409],
    ['not_allowed', 409],
    ['not_refundable', 409],
    ['not_found', 404],
    ['invalid_request', 400],
  ])('keeps the API’s own %s code, with its status', async (code, status) => {
    stubFetch(() => json({ error: code, booking: BOOKING }, status))

    const error = await rejectionOf(bookingsApi.reschedule(BOOKING_ID, '2027-01-07T09:00:00+02:00'))

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ message: code, status })
    expect(readSession()).not.toBeNull()
  })

  it('names the fields a 422 rejects', async () => {
    stubFetch(() => json({ error: 'validation_failed', fields: ['reason'] }, 422))

    const error = await rejectionOf(bookingsApi.cancel(BOOKING_ID, 'x'))

    expect(error).toMatchObject({ message: 'validation_failed', status: 422, fields: ['reason'] })
  })

  it('falls back to the status when the body is not the API’s error shape', async () => {
    stubFetch(() => new Response('<html>gateway</html>', { status: 502 }))

    expect(await rejectionOf(bookingsApi.list())).toMatchObject({ message: 'http_502', status: 502 })
  })
})

// --- Post-shoot add-ons and the session fee (plan.md Task 20) -----------------------

/**
 * The three post-shoot calls (spec §3.5 steps 2-3, §6.15). What travels is an
 * add-on id and a quantity -- never an amount, because nothing typed in the
 * browser may decide what a client owes -- and each answers the booking as the
 * API now renders it, refusals included.
 */
describe('the post-shoot calls', () => {
  const POST_SHOOT: AdminBooking = {
    ...BOOKING,
    status: 'completed',
    stage: 'completed',
    addons: [{ id: LINE_ID, name: 'Extra prints', unitPriceRwf: 15_000, quantity: 1, amountRwf: 15_000, stage: 'post_shoot', canRemove: true }],
    money: {
      ...BOOKING.money,
      totals: { quotedTotalRwf: 40_000, grandTotalRwf: 55_000, collectedRwf: 16_000, refundDueRwf: 0, outstandingRwf: 39_000 },
    },
    actions: { ...BOOKING.actions, canEditAddons: true, canRequestSessionFee: true },
  }

  it('sends no amount of its own when adding: the API prices it from the catalogue', async () => {
    const mock = stubFetch(() => json({ booking: POST_SHOOT }))

    await bookingsApi.addAddon(BOOKING_ID, ADDON_ID, 2)

    expect(sent(mock).body).toEqual({ addonId: ADDON_ID, quantity: 2 })
    expect(JSON.stringify(sent(mock).body)).not.toMatch(/price|amount|Rwf/i)
  })

  it('returns the parsed booking the add answered with', async () => {
    stubFetch(() => json({ booking: POST_SHOOT }))

    const answer = await bookingsApi.addAddon(BOOKING_ID, ADDON_ID)

    expect(answer.booking.addons[0]).toMatchObject({ stage: 'post_shoot', amountRwf: 15_000, canRemove: true })
    expect(answer.booking.money.totals.outstandingRwf).toBe(39_000)
  })

  it('sends no body at all when removing', async () => {
    const mock = stubFetch(() => json({ booking: BOOKING }))

    await bookingsApi.removeAddon(BOOKING_ID, LINE_ID)

    const call = sent(mock)
    expect([call.method, call.url]).toEqual(['DELETE', `/api/admin/bookings/${BOOKING_ID}/addons/${LINE_ID}`])
    expect(call.body).toBeUndefined()
    expect(call.headers.has('Content-Type')).toBe(false)
    expect(call.headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
  })

  it('returns the parsed booking the removal answered with', async () => {
    stubFetch(() => json({ booking: BOOKING }))

    expect((await bookingsApi.removeAddon(BOOKING_ID, LINE_ID)).booking.addons).toEqual([])
  })

  it('asks for the session fee with an empty body and returns the booking', async () => {
    const mock = stubFetch(() => json({ booking: POST_SHOOT }))

    const answer = await bookingsApi.requestSessionFee(BOOKING_ID)

    expect(sent(mock).body).toEqual({})
    expect(sent(mock).url).toBe(`/api/admin/bookings/${BOOKING_ID}/session-fee`)
    expect(answer.booking.actions.canRequestSessionFee).toBe(true)
  })

  it.each([
    ['already_paid', () => bookingsApi.removeAddon(BOOKING_ID, LINE_ID)],
    ['not_allowed', () => bookingsApi.addAddon(BOOKING_ID, ADDON_ID)],
    ['nothing_to_pay', () => bookingsApi.requestSessionFee(BOOKING_ID)],
    ['in_progress', () => bookingsApi.requestSessionFee(BOOKING_ID)],
  ])('keeps the API’s own %s code, with the booking the 409 carried', async (code, run) => {
    stubFetch(() => json({ error: code, booking: POST_SHOOT }, 409))

    const error = await rejectionOf(run())

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ message: code, status: 409 })
    expect(bookingFromRefusal(error)).toMatchObject({ id: BOOKING_ID, status: 'completed' })
    expect(readSession()).not.toBeNull()
  })

  it('answers 404 for an add-on row the screen no longer has', async () => {
    stubFetch(() => json({ error: 'not_found' }, 404))

    expect(await rejectionOf(bookingsApi.removeAddon(BOOKING_ID, LINE_ID))).toMatchObject({ message: 'not_found', status: 404 })
  })
})

// --- Photo delivery (plan.md Task 21) ------------------------------------------------

/**
 * The two delivery calls (spec §3.5 steps 5-6, §6.20, A-7). Saving is a PUT
 * carrying the link, and only the fields the photographer filled in: an
 * omitted date means "date it for me" (spec A-8) and must not travel as
 * `undefined` or an empty string, which the API would refuse. Sending is a POST
 * with nothing to say -- the link is already on the booking.
 */
describe('the delivery calls', () => {
  const DELIVERED: AdminBooking = {
    ...BOOKING,
    status: 'completed',
    stage: 'completed',
    delivery: { url: DELIVERY_LINK, expiresOn: '2027-03-15', sentAt: '2027-01-02T09:15:00.000Z', note: 'Thank you!' },
    actions: { ...BOOKING.actions, canEditAddons: true, canEditDelivery: true, canSendDelivery: true },
  }

  it('sends only the link when that is all it was given', async () => {
    const mock = stubFetch(() => json({ booking: DELIVERED }))

    await bookingsApi.saveDelivery(BOOKING_ID, { url: DELIVERY_LINK })

    const call = sent(mock)
    expect([call.method, call.url]).toEqual(['PUT', `/api/admin/bookings/${BOOKING_ID}/delivery`])
    expect(call.body).toEqual({ url: DELIVERY_LINK })
    // Not merely undefined: the key is absent from the JSON altogether.
    expect(Object.keys(call.body as object)).toEqual(['url'])
    expect(call.headers.get('Content-Type')).toBe('application/json')
    expect(call.headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
  })

  it('carries the date and the note when they were given', async () => {
    const mock = stubFetch(() => json({ booking: DELIVERED }))

    await bookingsApi.saveDelivery(BOOKING_ID, { url: DELIVERY_LINK, expiresOn: '2027-03-15', note: 'Thank you!' })

    expect(sent(mock).body).toEqual({ url: DELIVERY_LINK, expiresOn: '2027-03-15', note: 'Thank you!' })
  })

  it('sends a null note, which is how a note is cleared', async () => {
    const mock = stubFetch(() => json({ booking: DELIVERED }))

    await bookingsApi.saveDelivery(BOOKING_ID, { url: DELIVERY_LINK, note: null })

    expect(sent(mock).body).toEqual({ url: DELIVERY_LINK, note: null })
  })

  it('returns the parsed booking the save answered with', async () => {
    stubFetch(() => json({ booking: DELIVERED }))

    const answer = await bookingsApi.saveDelivery(BOOKING_ID, { url: DELIVERY_LINK })

    expect(answer.booking.delivery).toEqual({
      url: DELIVERY_LINK,
      expiresOn: '2027-03-15',
      sentAt: '2027-01-02T09:15:00.000Z',
      note: 'Thank you!',
    })
    expect(answer.booking.actions).toMatchObject({ canEditDelivery: true, canSendDelivery: true })
  })

  it('sends the photos with an empty body and returns the booking', async () => {
    const mock = stubFetch(() => json({ booking: DELIVERED }))

    const answer = await bookingsApi.sendDelivery(BOOKING_ID)

    const call = sent(mock)
    expect([call.method, call.url]).toEqual(['POST', `/api/admin/bookings/${BOOKING_ID}/delivery/send`])
    expect(call.body).toEqual({})
    expect(answer.booking.delivery.sentAt).toBe('2027-01-02T09:15:00.000Z')
  })

  it.each([
    ['no_link', () => bookingsApi.sendDelivery(BOOKING_ID)],
    ['not_allowed', () => bookingsApi.saveDelivery(BOOKING_ID, { url: DELIVERY_LINK })],
    ['validation_failed', () => bookingsApi.saveDelivery(BOOKING_ID, { url: 'http://photos.example-host.com/s/abc' })],
  ])('keeps the API’s own %s code for the screen to map', async (code, run) => {
    stubFetch(() => json({ error: code, booking: DELIVERED }, code === 'validation_failed' ? 422 : 409))

    const error = await rejectionOf(run())

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ message: code })
    expect(readSession()).not.toBeNull()
  })

  it('reports no download count, because the API has none to report', async () => {
    stubFetch(() => json({ booking: DELIVERED }))

    const answer = await bookingsApi.sendDelivery(BOOKING_ID)

    expect(Object.keys(answer.booking.delivery).sort()).toEqual(['expiresOn', 'note', 'sentAt', 'url'])
  })
})
