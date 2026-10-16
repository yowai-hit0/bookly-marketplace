import { type Page, type Request, expect, test } from '@playwright/test'

/**
 * A client's own booking in Chromium (plan.md Task 18; spec §3.9, §6.10,
 * §6.20). `/api/*` is answered here with `page.route`: the booking behind its
 * access token, the capability endpoint, a cancellation, a session-fee payment
 * and a payment status that stays pending.
 *
 * What is proven: opening the link renders that booking and its amounts;
 * cancelling shows the non-refundable warning first and only then, on
 * confirming, the cancelled booking with the refund owed; paying the session fee
 * moves to the payment's progress page; a link the API does not know shows one
 * generic "not valid" page that names no booking; and the access token appears
 * in nothing the browser sends except the path of the page itself and of
 * `/api/booking/<token>` -- never in a query string, never in a body.
 */

const NOW = new Date('2026-10-01T06:05:00.000Z')
const TOKEN = 'aB3_x-9QzT7vL4pR8sK1nB6yH3cF5dG0wJeLmNoPqRs'
const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'
const REFERENCE = 'BKY-2610-7K3QX'
const BOOKING_PATH = `/booking/${TOKEN}`
const PROGRESS_PATH = `${BOOKING_PATH}/payments/${OUR_REF}`

const WHEN = { startsAt: '2026-10-07T07:30:00.000Z', endsAt: '2026-10-07T09:00:00.000Z' }

type Mock = {
  /** True once the client has cancelled, which is how the API would then answer. */
  cancelled: boolean
  posts: { url: string; body: unknown }[]
  loads: number
}

function bookingBody(mock: Mock) {
  return {
    booking: {
      reference: REFERENCE,
      status: mock.cancelled ? 'cancelled_by_client' : 'confirmed',
      // The pill shows the display stage (2026-09-25); the shoot is still ahead.
      stage: mock.cancelled ? 'cancelled_by_client' : 'confirmed',
      clientName: 'Aline Uwase',
      maskedEmail: 'a•••••@example.com',
      pendingMaskedEmail: null,
      notices: [],
      ...WHEN,
      serviceName: 'Portraits',
      packageName: 'Standard',
      packagePriceRwf: 40_000,
      packagePhotoCount: 25,
      packageDurationMinutes: 90,
      locationText: 'Kigali Heights, KG 7 Ave',
      partySize: 3,
      specialRequests: null,
      addons: [{ name: 'Extra hour', priceRwf: 10_000, stage: 'at_booking' }],
      totals: {
        quotedTotalRwf: 50_000,
        grandTotalRwf: 50_000,
        collectedRwf: 20_000,
        refundDueRwf: mock.cancelled ? 30_000 : 0,
        outstandingRwf: mock.cancelled ? 0 : 30_000,
      },
      bookingFeeRwf: 20_000,
      payments: [{ kind: 'booking_fee', status: 'succeeded', amountRwf: 20_000, settledAt: '2026-10-01T06:05:00.000Z' }],
      canCancel: !mock.cancelled,
      cancellationReason: null,
      cancelledAt: mock.cancelled ? '2026-10-01T06:05:00.000Z' : null,
      sessionFee: mock.cancelled ? null : { outstandingRwf: 30_000, waitingPayment: null },
      delivery: null,
    },
  }
}

async function mockApi(page: Page, options: { known?: boolean } = {}): Promise<Mock> {
  const mock: Mock = { cancelled: false, posts: [], loads: 0 }
  const known = options.known ?? true
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const headers = { 'Cache-Control': 'no-store' }

      if (request.method() === 'GET' && url.pathname === '/api/payment-methods') {
        await route.fulfill({ headers, json: { provider: 'mtn_momo_direct', methods: ['momo_mtn'] } })
        return
      }
      if (request.method() === 'GET' && url.pathname === `/api/booking/${TOKEN}` && known) {
        mock.loads += 1
        await route.fulfill({ headers, json: bookingBody(mock) })
        return
      }
      if (request.method() === 'POST' && url.pathname === `/api/booking/${TOKEN}/cancel` && known) {
        mock.posts.push({ url: url.pathname, body: request.postData() })
        mock.cancelled = true
        await route.fulfill({ headers, json: bookingBody(mock) })
        return
      }
      if (request.method() === 'POST' && url.pathname === `/api/booking/${TOKEN}/payments` && known) {
        mock.posts.push({ url: url.pathname, body: request.postDataJSON() as unknown })
        await route.fulfill({ status: 201, headers, json: { payment: { ourRef: OUR_REF, status: 'pending' } } })
        return
      }
      if (request.method() === 'GET' && url.pathname === `/api/payments/${OUR_REF}`) {
        await route.fulfill({
          headers,
          json: {
            payment: { status: 'pending', amountRwf: 30_000, failure: null },
            booking: { reference: REFERENCE, status: 'confirmed', serviceName: 'Portraits', packageName: 'Standard', ...WHEN },
          },
        })
        return
      }
      await route.fulfill({ status: 404, headers, json: { error: 'not_found' } })
    },
  )
  return mock
}

/** Every request the page makes, so the token can be hunted for in all of them. */
function recordRequests(page: Page): { url: string; postData: string | null }[] {
  const seen: { url: string; postData: string | null }[] = []
  page.on('request', (request: Request) => seen.push({ url: request.url(), postData: request.postData() }))
  return seen
}

/**
 * The token may travel in the path of the page itself and of its own API route,
 * and nowhere else: not in a query string, not in a fragment, not in a body.
 */
function expectTokenOnlyInItsOwnPath(seen: { url: string; postData: string | null }[]): void {
  expect(seen.length).toBeGreaterThan(0)
  for (const { url, postData } of seen) {
    expect(postData ?? '', url).not.toContain(TOKEN)
    if (!url.includes(TOKEN)) continue
    const parsed = new URL(url)
    expect(parsed.search, url).toBe('')
    expect(parsed.hash, url).toBe('')
    expect(
      parsed.pathname === `/api/booking/${TOKEN}` ||
        parsed.pathname.startsWith(`/api/booking/${TOKEN}/`) ||
        parsed.pathname === BOOKING_PATH ||
        parsed.pathname.startsWith(`${BOOKING_PATH}/`),
      `the token appeared in ${url}`,
    ).toBe(true)
  }
}

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: NOW })
})

test('opening the link renders that booking and its amounts', async ({ page }) => {
  await mockApi(page)
  await page.goto(BOOKING_PATH)

  await expect(page.getByRole('heading', { level: 1, name: 'Your booking' })).toBeVisible()
  await expect(page.getByText(REFERENCE)).toBeVisible()
  await expect(page.getByText('Portraits, Standard')).toBeVisible()
  await expect(page.getByText('Wednesday, 7 October 2026, 09:30 to 11:00, Kigali time')).toBeVisible()
  await expect(page.getByText('Kigali Heights, KG 7 Ave')).toBeVisible()
  await expect(page.getByText('Confirmed')).toBeVisible()
  await expect(page.getByText('50,000 RWF', { exact: true })).toBeVisible()
  await expect(page.getByText('30,000 RWF', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pay 30,000 RWF' })).toBeVisible()
})

test('a link the API does not know shows one generic page that names no booking', async ({ page }) => {
  await mockApi(page, { known: false })
  await page.goto(BOOKING_PATH)

  await expect(page.getByRole('heading', { level: 1, name: 'This link is not valid' })).toBeVisible()
  await expect(page.getByText(REFERENCE)).toHaveCount(0)
  // Scoped to the page: the client shell's header and footer are not what this asserts about (2026-09-21).
  await expect(page.locator('main').getByRole('button')).toHaveCount(0)
  expect(await page.locator('main').innerText()).not.toMatch(/Portraits|Kigali Heights|RWF|Cancel/)
})

test('cancelling shows the non-refundable warning first, and the cancelled booking only after confirming', async ({ page }) => {
  const mock = await mockApi(page)
  await page.goto(BOOKING_PATH)
  await expect(page.getByRole('heading', { level: 1, name: 'Your booking' })).toBeVisible()

  await page.getByRole('button', { name: 'Cancel this booking' }).click()

  await expect(
    page.getByText('If you cancel, your booking fee of 20,000 RWF is not refunded, and the time is released for someone else to book.'),
  ).toBeVisible()
  expect(mock.posts).toEqual([])

  // Backing out sends nothing.
  await page.getByRole('button', { name: 'Keep my booking' }).click()
  await expect(page.getByText('is not refunded')).toHaveCount(0)
  expect(mock.posts).toEqual([])

  await page.getByRole('button', { name: 'Cancel this booking' }).click()
  await page.getByRole('button', { name: 'Yes, cancel my booking' }).click()

  await expect(page.getByRole('heading', { level: 2, name: 'This booking is cancelled' })).toBeVisible()
  await expect(page.getByText('You are owed 30,000 RWF back. The photographer will contact you to arrange it.')).toBeVisible()
  await expect(page.getByText('Cancelled by you')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel this booking' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Pay / })).toHaveCount(0)
  expect(mock.posts.map((post) => post.url)).toEqual([`/api/booking/${TOKEN}/cancel`])
})

test('paying the session fee moves to the payment’s progress page', async ({ page }) => {
  const mock = await mockApi(page)
  await page.goto(BOOKING_PATH)

  await page.getByRole('textbox', { name: 'Mobile Money number' }).fill('078 812 3456')
  await page.getByRole('button', { name: 'Pay 30,000 RWF' }).click()

  await expect(page).toHaveURL(PROGRESS_PATH)
  await expect(page.getByRole('heading', { level: 1, name: 'Approve the payment on your phone' })).toBeVisible()
  await expect(page.getByText('We have sent a request for 30,000 RWF to your phone. Enter your Mobile Money PIN to approve it.')).toBeVisible()
  await expect(page.getByText('Your booking is confirmed')).toHaveCount(0)
  expect(mock.posts).toEqual([{ url: `/api/booking/${TOKEN}/payments`, body: { method: 'momo_mtn', phone: '078 812 3456' } }])
})

test('the access token is in no request but the path of the page and of its own API route', async ({ page }) => {
  const seen = recordRequests(page)
  const mock = await mockApi(page)

  await page.goto(BOOKING_PATH)
  await expect(page.getByRole('heading', { level: 1, name: 'Your booking' })).toBeVisible()

  // Everything the page can send: a payment, then a reload, then a cancellation.
  await page.getByRole('textbox', { name: 'Mobile Money number' }).fill('0788123456')
  await page.getByRole('button', { name: 'Pay 30,000 RWF' }).click()
  await expect(page).toHaveURL(PROGRESS_PATH)

  await page.goto(BOOKING_PATH)
  await expect(page.getByRole('heading', { level: 1, name: 'Your booking' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel this booking' }).click()
  await page.getByRole('button', { name: 'Yes, cancel my booking' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'This booking is cancelled' })).toBeVisible()

  expect(mock.posts.length).toBeGreaterThan(0)
  expectTokenOnlyInItsOwnPath(seen)
  // And the requests that did carry it are only the ones that had to.
  const carrying = seen.filter((request) => request.url.includes(TOKEN)).map((request) => new URL(request.url).pathname)
  expect([...new Set(carrying)].sort()).toEqual(
    [BOOKING_PATH, `/api/booking/${TOKEN}`, `/api/booking/${TOKEN}/cancel`, `/api/booking/${TOKEN}/payments`].sort(),
  )
})

test('reloading the booking URL lands on the same page', async ({ page }) => {
  const mock = await mockApi(page)
  await page.goto(BOOKING_PATH)
  await expect(page.getByRole('heading', { level: 1, name: 'Your booking' })).toBeVisible()
  const before = mock.loads

  await page.reload()

  await expect(page.getByRole('heading', { level: 1, name: 'Your booking' })).toBeVisible()
  await expect(page.getByText(REFERENCE)).toBeVisible()
  expect(mock.loads).toBeGreaterThan(before)
})
