import type { Page, Request } from '@playwright/test'

/**
 * The client dashboard's API as `page.route` answers it (marketplace spec
 * Phase 8): one client, bookings at two photographers, their payments and
 * receipts, the profile, the export and the deletion, behind the account's
 * bearer token. Shared by `account-dashboard.spec.ts` and any other browser
 * run over the account pages; a spec registering its own route afterwards
 * overrides one answer.
 */

export const NOW = new Date('2026-10-01T06:00:00.000Z')
export const TOKEN = 'account.header.payload'
export const EXPIRES_AT = '2099-01-01T00:00:00.000Z'
export const PASSWORD = 'a long sentence I remember'
export const LENS_REF = 'BKY-2610-7K3QX'
export const LIGHT_REF = 'BKY-2610-9QW2E'
export const OTHER_REF = 'BKY-2610-ZZZZZ'
export const BOOKING_FEE_REF = '11111111-1111-4111-8111-111111111111'
export const SESSION_FEE_REF = '22222222-2222-4222-8222-222222222222'

export const LENS = { handle: 'kigali-lens', displayName: 'Kigali Lens' }
export const LIGHT = { handle: 'light-house', displayName: 'Light House Studio' }

export type Mock = {
  signedIn: boolean
  deleted: boolean
  sessionFeePaid: boolean
  lightCancelled: boolean
  fullName: string
  phone: string | null
  posts: { url: string; body: unknown }[]
  authHeaders: (string | null)[]
}

export function user(mock: Mock) {
  return {
    id: 'c1',
    email: 'aline@example.com',
    lastLoginAt: null,
    fullName: mock.fullName,
    phone: mock.phone,
    hasPassword: true,
    hasGoogle: false,
    pendingEmail: null,
  }
}

export function clientBooking(mock: Mock, which: 'lens' | 'light') {
  const lens = which === 'lens'
  const cancelled = !lens && mock.lightCancelled
  const paid = lens && mock.sessionFeePaid
  const total = lens ? 50_000 : 80_000
  const fee = lens ? 20_000 : 32_000
  const collected = paid ? total : fee
  return {
    reference: lens ? LENS_REF : LIGHT_REF,
    status: cancelled ? 'cancelled_by_client' : 'confirmed',
    stage: cancelled ? 'cancelled_by_client' : 'confirmed',
    clientName: 'Aline Uwase',
    maskedEmail: 'a•••••@example.com',
    pendingMaskedEmail: null,
    startsAt: lens ? '2026-10-07T07:30:00.000Z' : '2026-10-20T12:00:00.000Z',
    endsAt: lens ? '2026-10-07T09:00:00.000Z' : '2026-10-20T14:00:00.000Z',
    serviceName: lens ? 'Portraits' : 'Family',
    packageName: lens ? 'Standard' : 'Two hours',
    packagePriceRwf: lens ? 40_000 : 80_000,
    packagePhotoCount: lens ? 25 : 60,
    packageDurationMinutes: lens ? 90 : 120,
    locationText: lens ? 'Kigali Heights, KG 7 Ave' : 'Nyamirambo Stadium',
    partySize: lens ? 3 : 6,
    specialRequests: null,
    addons: lens ? [{ name: 'Extra hour', priceRwf: 10_000, stage: 'at_booking' }] : [],
    totals: {
      quotedTotalRwf: total,
      grandTotalRwf: total,
      collectedRwf: collected,
      refundDueRwf: cancelled ? fee : 0,
      outstandingRwf: cancelled ? 0 : total - collected,
    },
    bookingFeeRwf: fee,
    payments: [],
    canCancel: !cancelled,
    // Kigali Lens keeps the fee; Light House refunds it, until 24 hours before.
    cancellation: cancelled
      ? { deadline: null, bookingFeeRefundable: true }
      : { deadline: lens ? '2026-10-07T07:30:00.000Z' : '2026-10-19T12:00:00.000Z', bookingFeeRefundable: !lens },
    cancellationReason: null,
    cancelledAt: cancelled ? NOW.toISOString() : null,
    sessionFee: cancelled || paid || !lens ? null : { outstandingRwf: total - collected, waitingPayment: null },
    delivery: null,
    notices: [],
  }
}

export function row(mock: Mock, which: 'lens' | 'light') {
  const booking = clientBooking(mock, which)
  return {
    reference: booking.reference,
    photographer: which === 'lens' ? LENS : LIGHT,
    serviceName: booking.serviceName,
    packageName: booking.packageName,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    status: booking.status,
    stage: booking.stage,
    amounts: {
      totalRwf: booking.totals.grandTotalRwf,
      paidRwf: booking.totals.collectedRwf,
      dueRwf: booking.totals.outstandingRwf,
      refundDueRwf: booking.totals.refundDueRwf,
    },
    holdExpiresAt: null,
    checkoutPath: null,
  }
}

export function detail(mock: Mock, which: 'lens' | 'light') {
  return {
    booking: clientBooking(mock, which),
    photographer: { ...(which === 'lens' ? LENS : LIGHT), contactPhone: '+250788000111', whatsappPhone: null, email: null },
    checkoutPath: null,
  }
}

export function payment(ourRef: string, kind: 'booking_fee' | 'session_fee', amountRwf: number) {
  return {
    ourRef,
    kind,
    method: 'momo_mtn',
    amountRwf,
    status: 'succeeded',
    failure: null,
    createdAt: NOW.toISOString(),
    settledAt: NOW.toISOString(),
    refund: { state: 'none' },
    overpayment: null,
    hasReceipt: true,
    booking: { reference: LENS_REF, startsAt: '2026-10-07T07:30:00.000Z', serviceName: 'Portraits', packageName: 'Standard', photographer: LENS },
  }
}

export function receipt(ourRef: string, kind: 'booking_fee' | 'session_fee', amountRwf: number) {
  return {
    receipt: {
      ...payment(ourRef, kind, amountRwf),
      billedTo: 'Aline Uwase',
      booking: {
        reference: LENS_REF,
        startsAt: '2026-10-07T07:30:00.000Z',
        endsAt: '2026-10-07T09:00:00.000Z',
        serviceName: 'Portraits',
        packageName: 'Standard',
        packagePriceRwf: 40_000,
        bookingFeeRwf: 20_000,
        addons: [{ name: 'Extra hour', quantity: 1, unitPriceRwf: 10_000, amountRwf: 10_000, stage: 'at_booking' }],
      },
      photographer: LENS,
    },
  }
}

export async function mockApi(page: Page): Promise<Mock> {
  const mock: Mock = {
    signedIn: false,
    deleted: false,
    sessionFeePaid: false,
    lightCancelled: false,
    fullName: 'Aline Uwase',
    phone: '+250788123456',
    posts: [],
    authHeaders: [],
  }
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const path = url.pathname
      const method = request.method()
      const headers = { 'Cache-Control': 'no-store' }
      const reply = (json: unknown, status = 200) => route.fulfill({ status, headers, json })
      if (method !== 'GET') mock.posts.push({ url: path + url.search, body: request.postDataJSON() as unknown })

      if (path === '/api/account/auth/providers') return reply({ google: false })
      if (path === '/api/account/auth/login' && method === 'POST') {
        const body = request.postDataJSON() as { email: string; password: string }
        if (mock.deleted || body.email !== 'aline@example.com' || body.password !== PASSWORD) return reply({ error: 'invalid_credentials' }, 401)
        mock.signedIn = true
        return reply({ user: user(mock), token: TOKEN, tokenType: 'Bearer', expiresAt: EXPIRES_AT })
      }
      if (path === '/api/payment-methods') return reply({ methods: ['momo_mtn'] })
      if (path === `/api/payments/${SESSION_FEE_REF}`) {
        return reply({
          payment: { status: 'succeeded', amountRwf: 30_000, failure: null },
          booking: { reference: LENS_REF, status: 'confirmed', serviceName: 'Portraits', packageName: 'Standard', startsAt: '2026-10-07T07:30:00.000Z', endsAt: '2026-10-07T09:00:00.000Z' },
        })
      }

      if (path.startsWith('/api/account/')) {
        const auth = request.headers()['authorization'] ?? null
        mock.authHeaders.push(auth)
        if (auth !== `Bearer ${TOKEN}` || mock.deleted) return reply({ error: 'invalid_token' }, 401)
        const sub = path.slice('/api/account'.length)

        if (sub === '/me') return reply({ user: user(mock) })
        if (sub === '/bookings' && method === 'GET') {
          const scope = url.searchParams.get('scope') ?? 'upcoming'
          const bookings = scope === 'past' ? (mock.lightCancelled ? [row(mock, 'light')] : []) : [row(mock, 'lens'), ...(mock.lightCancelled ? [] : [row(mock, 'light')])]
          return reply({ scope, bookings, total: bookings.length, page: 1, pageSize: 20, pageCount: 1 })
        }
        if (sub === `/bookings/${LENS_REF}`) return reply(detail(mock, 'lens'))
        if (sub === `/bookings/${LIGHT_REF}`) return reply(detail(mock, 'light'))
        if (sub === `/bookings/${LENS_REF}/payments` && method === 'POST') {
          mock.sessionFeePaid = true
          return reply({ payment: { ourRef: SESSION_FEE_REF, status: 'pending' } }, 201)
        }
        if (sub === `/bookings/${LIGHT_REF}/cancel` && method === 'POST') {
          mock.lightCancelled = true
          return reply(detail(mock, 'light'))
        }
        if (sub === '/payments') {
          const payments = [
            ...(mock.sessionFeePaid ? [payment(SESSION_FEE_REF, 'session_fee', 30_000)] : []),
            payment(BOOKING_FEE_REF, 'booking_fee', 20_000),
          ]
          return reply({ payments, total: payments.length, page: 1, pageSize: 20, pageCount: 1 })
        }
        if (sub === `/payments/${BOOKING_FEE_REF}`) return reply(receipt(BOOKING_FEE_REF, 'booking_fee', 20_000))
        if (sub === `/payments/${SESSION_FEE_REF}` && mock.sessionFeePaid) return reply(receipt(SESSION_FEE_REF, 'session_fee', 30_000))
        if (sub === '/profile' && method === 'GET') return reply({ profile: { fullName: mock.fullName, phone: mock.phone } })
        if (sub === '/profile' && method === 'PATCH') {
          const body = request.postDataJSON() as { fullName?: string; phone?: string | null }
          if (body.fullName !== undefined) mock.fullName = body.fullName
          if (body.phone !== undefined) mock.phone = body.phone === null ? null : body.phone.replace(/^0/, '+250').replace(/\s/g, '')
          return reply({ profile: { fullName: mock.fullName, phone: mock.phone } })
        }
        if (sub === '/export') {
          return route.fulfill({
            status: 200,
            headers: { ...headers, 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="bookly-account-2026-10-01.json"' },
            body: JSON.stringify({ format: 'bookly-account-export', version: 1, account: { email: 'aline@example.com' } }),
          })
        }
        if (sub === '/delete' && method === 'POST') {
          const body = request.postDataJSON() as { password?: string }
          if (body.password !== PASSWORD) return reply({ error: 'invalid_password' }, 403)
          mock.deleted = true
          return route.fulfill({ status: 204, headers })
        }
        // Another client's reference, a receipt that is not theirs: the one 404.
        return reply({ error: 'not_found' }, 404)
      }
      return reply({ error: 'not_found' }, 404)
    },
  )
  return mock
}

export function recordRequests(page: Page): string[] {
  const urls: string[] = []
  page.on('request', (request: Request) => urls.push(request.url()))
  return urls
}
