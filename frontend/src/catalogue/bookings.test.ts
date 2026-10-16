import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type BookingPayload,
  DETAIL_FIELDS,
  type HeldBooking,
  bookingDetailsSchema,
  parseBookingDetails,
  submitBooking,
} from './bookings'

/**
 * The booking form's schema and the booking client (plan.md Task 13, spec §3.1
 * steps 6-8).
 *
 * The schema is a convenience: it mirrors the API's limits so a mistake is
 * marked before a round trip, reports the wrong fields in form order, and turns
 * blanks into nulls. `submitBooking` maps the API's answers -- 201, 422 with
 * fields, 409 -- and reads everything else, a body it cannot act on, or an
 * unreachable API as `failed`.
 */

const VALID = {
  fullName: 'Aline Uwase',
  email: 'aline@example.com',
  phone: '078 812 3456',
  location: 'Kigali Heights',
  partySize: '3',
  specialRequests: 'Golden hour if possible.',
  consent: 'on',
}

/** A FormData as the browser builds it: every text field present, the checkbox only when ticked. */
function formData(overrides: Partial<Record<keyof typeof VALID, string | null>> = {}): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries({ ...VALID, ...overrides })) {
    if (value !== null) data.set(key, value)
  }
  return data
}

function fieldsOf(result: ReturnType<typeof parseBookingDetails>): string[] {
  if (result.ok) throw new Error(`Expected the form to be refused, got ${JSON.stringify(result.details)}`)
  return result.fields
}

function detailsOf(result: ReturnType<typeof parseBookingDetails>) {
  if (!result.ok) throw new Error(`Expected the form to parse, got ${JSON.stringify(result.fields)}`)
  return result.details
}

// --- parseBookingDetails ------------------------------------------------------

describe('parseBookingDetails', () => {
  it('parses a filled form: trimmed text, a number of people, consent true', () => {
    const details = detailsOf(
      parseBookingDetails(
        formData({ fullName: '  Aline Uwase ', email: ' aline@example.com ', phone: ' 078 812 3456 ', location: ' Kigali Heights ', partySize: ' 3 ', specialRequests: '  Golden hour if possible.  ' }),
      ),
    )

    expect(details).toStrictEqual({
      fullName: 'Aline Uwase',
      email: 'aline@example.com',
      phone: '078 812 3456',
      location: 'Kigali Heights',
      partySize: 3,
      specialRequests: 'Golden hour if possible.',
      consent: true,
    })
  })

  it('reads a blank number of people and blank special requests as null', () => {
    const details = detailsOf(parseBookingDetails(formData({ partySize: '   ', specialRequests: ' \n ' })))

    expect(details.partySize).toBeNull()
    expect(details.specialRequests).toBeNull()
  })

  it('reads missing optional fields as null', () => {
    const details = detailsOf(parseBookingDetails(formData({ partySize: null, specialRequests: null })))

    expect(details.partySize).toBeNull()
    expect(details.specialRequests).toBeNull()
  })

  it('reports every wrong field of an empty form, in form order', () => {
    expect(fieldsOf(parseBookingDetails(new FormData()))).toEqual(['fullName', 'email', 'phone', 'location', 'consent'])
  })

  it('reports all seven in DETAIL_FIELDS order, whatever order the issues arise in', () => {
    const fields = fieldsOf(
      parseBookingDetails(
        formData({ fullName: ' ', email: 'nope', phone: 'call me', location: '', partySize: '0', specialRequests: 'x'.repeat(2001), consent: null }),
      ),
    )

    expect(fields).toEqual([...DETAIL_FIELDS])
    expect(DETAIL_FIELDS).toEqual(['fullName', 'email', 'phone', 'location', 'partySize', 'specialRequests', 'consent'])
  })

  it('reports each field once, however many of its rules it breaks', () => {
    expect(fieldsOf(parseBookingDetails(formData({ email: ` ${'a'.repeat(330)} ` })))).toEqual(['email'])
  })

  describe('consent', () => {
    it('is given only by a ticked box, which the browser sends as "on"', () => {
      expect(detailsOf(parseBookingDetails(formData({ consent: 'on' }))).consent).toBe(true)
    })

    it.each([[null], [''], ['true'], ['yes'], ['off'], ['ON']])('is refused for %j', (consent) => {
      expect(fieldsOf(parseBookingDetails(formData({ consent })))).toEqual(['consent'])
    })

    it('is read off a real form’s checkbox', () => {
      document.body.innerHTML = '<form><input name="fullName" value="Aline"><input name="email" value="a@example.com"><input name="phone" value="0788123456"><input name="location" value="Kigali"><input name="partySize" value=""><textarea name="specialRequests"></textarea><input type="checkbox" name="consent"></form>'
      const form = document.querySelector('form') as HTMLFormElement
      const box = form.querySelector('input[type="checkbox"]') as HTMLInputElement

      expect(fieldsOf(parseBookingDetails(new FormData(form)))).toEqual(['consent'])

      box.checked = true
      expect(detailsOf(parseBookingDetails(new FormData(form))).consent).toBe(true)
      document.body.innerHTML = ''
    })
  })

  describe('limits mirroring the API', () => {
    it.each<[string, Partial<Record<keyof typeof VALID, string>>, string]>([
      ['a blank name', { fullName: '   ' }, 'fullName'],
      ['a 201-character name', { fullName: 'a'.repeat(201) }, 'fullName'],
      ['an unreadable email', { email: 'aline@' }, 'email'],
      ['a 321-character email', { email: `${'a'.repeat(309)}@example.com` }, 'email'],
      ['a phone with letters', { phone: '0788 abc 456' }, 'phone'],
      ['a phone with 6 digits', { phone: '123 456' }, 'phone'],
      ['a phone with 16 digits', { phone: '+1234567890123456' }, 'phone'],
      ['a phone longer than 40 characters', { phone: `07881234${'-'.repeat(33)}56` }, 'phone'],
      ['a blank location', { location: ' ' }, 'location'],
      ['a 501-character location', { location: 'x'.repeat(501) }, 'location'],
      ['no people', { partySize: '0' }, 'partySize'],
      ['1001 people', { partySize: '1001' }, 'partySize'],
      ['a fraction of a person', { partySize: '2.5' }, 'partySize'],
      ['a negative party', { partySize: '-1' }, 'partySize'],
      ['a party in words', { partySize: 'three' }, 'partySize'],
      ['a party with an exponent', { partySize: '1e3' }, 'partySize'],
      ['2001 characters of requests', { specialRequests: 'x'.repeat(2001) }, 'specialRequests'],
    ])('refuses %s', (_label, overrides, field) => {
      expect(fieldsOf(parseBookingDetails(formData(overrides)))).toEqual([field])
    })

    it('accepts the limits themselves', () => {
      const details = detailsOf(
        parseBookingDetails(
          formData({
            fullName: 'a'.repeat(200),
            email: `${'a'.repeat(308)}@example.com`,
            phone: '+123456789012345',
            location: 'x'.repeat(500),
            partySize: '1000',
            specialRequests: 'x'.repeat(2000),
          }),
        ),
      )

      expect(details.partySize).toBe(1000)
      expect(parseBookingDetails(formData({ partySize: '1', phone: '1234567' })).ok).toBe(true)
    })

    it.each(['0788123456', '+250 788 123 456', '250788123456', '+1 (415) 555-0100', '078.812.3456'])('accepts the phone %j', (phone) => {
      expect(parseBookingDetails(formData({ phone })).ok).toBe(true)
    })

    it('measures limits after trimming', () => {
      expect(parseBookingDetails(formData({ fullName: `   ${'a'.repeat(200)}   `, specialRequests: ` ${'x'.repeat(2000)} ` })).ok).toBe(true)
    })
  })

  it('is backed by an exported schema that refuses consent other than true', () => {
    const base = { fullName: 'A', email: 'a@example.com', phone: '0788123456', location: 'K', partySize: '', specialRequests: '' }

    expect(bookingDetailsSchema.safeParse({ ...base, consent: true }).success).toBe(true)
    expect(bookingDetailsSchema.safeParse({ ...base, consent: false }).success).toBe(false)
    expect(bookingDetailsSchema.safeParse({ ...base, consent: 'on' }).success).toBe(false)
  })
})

// --- submitBooking ------------------------------------------------------------

const PAYLOAD: BookingPayload = {
  packageId: 'p2',
  addonIds: ['a1', 'a2'],
  startsAt: '2026-10-07T07:30:00.000Z',
  fullName: 'Aline Uwase',
  email: 'aline@example.com',
  phone: '078 812 3456',
  location: 'Kigali Heights',
  partySize: 3,
  specialRequests: null,
  consent: true,
}

const HELD: HeldBooking = {
  reference: 'BKY-2610-7K3QX',
  status: 'pending_payment',
  startsAt: '2026-10-07T07:30:00.000Z',
  endsAt: '2026-10-07T09:00:00.000Z',
  holdExpiresAt: '2026-10-01T06:30:00.000Z',
  serviceName: 'Portraits',
  packageName: 'Standard',
  packagePriceRwf: 40_000,
  addons: [{ name: 'Extra hour', priceRwf: 10_000 }],
  totalRwf: 50_000,
  bookingFeeRate: 0.4,
  bookingFeeRwf: 20_000,
  sessionFeeRwf: 30_000,
}

type FetchArgs = [input: string | URL | Request, init?: RequestInit]

function stubFetch(respond: () => Response | Promise<Response>) {
  const mock = vi.fn(async (..._args: FetchArgs) => respond())
  vi.stubGlobal('fetch', mock)
  return mock
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('submitBooking: the request', () => {
  it('POSTs the payload as JSON to /api/bookings, anonymously', async () => {
    const mock = stubFetch(() => json({ booking: HELD }, 201))

    await submitBooking(PAYLOAD)

    expect(mock).toHaveBeenCalledTimes(1)
    const [input, init = {}] = mock.mock.calls[0] ?? []
    expect(String(input)).toBe('/api/bookings')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.has('Authorization')).toBe(false)
    expect(init.credentials ?? 'same-origin').not.toBe('include')
    expect(JSON.parse(String(init.body))).toStrictEqual(PAYLOAD)
  })

  it('sends exactly the payload’s keys, and no amounts', async () => {
    const mock = stubFetch(() => json({ booking: HELD }, 201))

    await submitBooking(PAYLOAD)

    const body = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(Object.keys(PAYLOAD).sort())
    expect(String(mock.mock.calls[0]?.[1]?.body)).not.toMatch(/Rwf|total|fee/i)
  })
})

describe('submitBooking: the answers', () => {
  it('reads a 201 as created, with the booking the API sent', async () => {
    stubFetch(() => json({ booking: HELD }, 201))

    await expect(submitBooking(PAYLOAD)).resolves.toStrictEqual({ status: 'created', booking: HELD })
  })

  it('reads a 409 as slot_taken, whatever its body', async () => {
    stubFetch(() => json({ error: 'slot_taken' }, 409))
    await expect(submitBooking(PAYLOAD)).resolves.toStrictEqual({ status: 'slot_taken' })

    stubFetch(() => text('<h1>Conflict</h1>', 409))
    await expect(submitBooking(PAYLOAD)).resolves.toStrictEqual({ status: 'slot_taken' })
  })

  it('reads a 422 as invalid, with the fields it names', async () => {
    stubFetch(() => json({ error: 'validation_failed', fields: ['email', 'startsAt', 'consent'] }, 422))

    await expect(submitBooking(PAYLOAD)).resolves.toStrictEqual({ status: 'invalid', fields: ['email', 'startsAt', 'consent'] })
  })

  it('reads a 422 with an empty field list as invalid with none', async () => {
    stubFetch(() => json({ error: 'validation_failed', fields: [] }, 422))

    await expect(submitBooking(PAYLOAD)).resolves.toStrictEqual({ status: 'invalid', fields: [] })
  })

  it.each<[string, () => Response]>([
    ['a 422 without fields', () => json({ error: 'validation_failed' }, 422)],
    ['a 422 whose fields is not a list', () => json({ error: 'validation_failed', fields: 'email' }, 422)],
    ['a 422 that is not JSON', () => text('Unprocessable', 422)],
    ['a 422 with a JSON null body', () => json(null, 422)],
    ['a 201 that is not JSON', () => text('Created', 201)],
    ['a 201 with a JSON null body', () => json(null, 201)],
    ['a 201 without a booking', () => json({}, 201)],
    ['a 200', () => json({ booking: HELD }, 200)],
    ['a 400', () => json({ error: 'invalid_request' }, 400)],
    ['a 404', () => json({ error: 'not_found' }, 404)],
    ['a 429', () => json({ error: 'too_many_requests' }, 429)],
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a 502 gateway page', () => text('<html>Bad gateway</html>', 502)],
  ])('reads %s as failed', async (_label, respond) => {
    stubFetch(respond)

    await expect(submitBooking(PAYLOAD)).resolves.toStrictEqual({ status: 'failed' })
  })

  it('reads a network failure as failed, without throwing', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))

    await expect(submitBooking(PAYLOAD)).resolves.toStrictEqual({ status: 'failed' })
  })
})
