/**
 * `GET /api/studio/me`, which the studio layout asks for on every visit to
 * draw the pending or suspended banner (Phase 2). Page tests answer it with
 * this and leave it out of the calls they count, so each one still counts
 * only the requests its own page makes.
 */

export const STUDIO_ME_URL = '/api/studio/me'

export type StudioStatus = 'pending' | 'approved' | 'suspended'

export function studioMeBody(status: StudioStatus = 'approved') {
  return {
    user: { id: 'a1', email: 'photographer@bookly.example', lastLoginAt: null },
    photographer: { id: 'p1', handle: 'kigali-lens', displayName: 'Kigali Lens', status },
  }
}

export function studioMe(status: StudioStatus = 'approved'): Response {
  return new Response(JSON.stringify(studioMeBody(status)), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** True for the layout's own request, which a page test leaves out of its counts. */
export function isStudioMe(input: string | URL | Request): boolean {
  return String(input instanceof Request ? input.url : input) === STUDIO_ME_URL
}

/**
 * `GET /api/studio/subscription`, which the layout asks for once `/me` says
 * approved, for the subscription banner (Phase 5). Its default answer is a
 * subscription paid far ahead, so no banner shows and nothing else on the
 * page moves.
 */
export const STUDIO_SUBSCRIPTION_URL = '/api/studio/subscription'

export function studioSubscriptionBody() {
  const far = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString()
  return {
    subscription: {
      id: 'sub1',
      status: 'active',
      currentPeriodEndsAt: far,
      graceEndsAt: far,
      takingBookings: true,
      currentPeriod: null,
      periods: [],
      paymentInProgress: null,
    },
    prices: { monthly: 10_000, yearly: 100_000 },
    methods: ['momo_mtn'],
    graceDays: 7,
  }
}

/** True for either of the layout's own requests, which a page test leaves out of its counts. */
export function isStudioLayout(input: string | URL | Request): boolean {
  const url = String(input instanceof Request ? input.url : input)
  return url === STUDIO_ME_URL || url === STUDIO_SUBSCRIPTION_URL
}

/** The layout's answer for `input`: `/me` approved, or a subscription that needs no banner. */
export function studioLayout(input: string | URL | Request): Response {
  const url = String(input instanceof Request ? input.url : input)
  const body = url === STUDIO_SUBSCRIPTION_URL ? studioSubscriptionBody() : studioMeBody()
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
