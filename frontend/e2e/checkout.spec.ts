import { type Page, expect, test } from '@playwright/test'

/**
 * Paying the booking fee in Chromium (plan.md Task 16; spec §3.1 steps 9-10,
 * §6.19). `/api/*` is answered here with `page.route`: the capability endpoint,
 * a held booking's checkout, starting a payment, and a payment status that
 * stays pending -- the webhook held back -- until a test lets it succeed. The
 * browser clock is installed, so each poll happens when the test moves time on.
 *
 * What is proven: with MTN MoMo direct the pay page shows MTN MoMo and no Airtel
 * Money or card element anywhere in the DOM, and it renders what the API lists
 * rather than a list of its own; entering a number and paying moves to the
 * payment's progress page; while the API answers pending the page stays pending
 * over many polls and never says the booking is confirmed; once the API answers
 * succeeded it says so and stops polling; and reloading the checkout URL, or the
 * progress URL, lands on the same page.
 */

const NOW = new Date('2026-10-01T06:05:00.000Z')
const REFERENCE = 'BKY-2610-7K3QX'
const TOKEN = 'aB3_x-9QzT7vL4pR8sK1nB6yH3cF5dG0wJeLmNoPqRs'
const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'
const CHECKOUT_PATH = `/checkout/${REFERENCE}/${TOKEN}`
const PROGRESS_PATH = `${CHECKOUT_PATH}/payments/${OUR_REF}`

const CONFIRMED = 'Your booking is confirmed'

const WHEN = { startsAt: '2026-10-07T07:30:00.000Z', endsAt: '2026-10-07T09:00:00.000Z' }

type Mock = {
  methods: string[]
  /** False until the test lets the payment settle. */
  settled: boolean
  paid: boolean
  posts: Record<string, unknown>[]
  checkoutLoads: number
  polls: number
}

async function mockApi(page: Page, methods: string[] = ['momo_mtn']): Promise<Mock> {
  const mock: Mock = { methods, settled: false, paid: false, posts: [], checkoutLoads: 0, polls: 0 }
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const headers = { 'Cache-Control': 'no-store' }
      if (request.method() === 'GET' && url.pathname === '/api/payment-methods') {
        await route.fulfill({ headers, json: { provider: 'mtn_momo_direct', methods: mock.methods } })
        return
      }
      if (request.method() === 'GET' && url.pathname === `/api/checkout/${REFERENCE}/${TOKEN}`) {
        mock.checkoutLoads += 1
        await route.fulfill({
          headers,
          json: {
            checkout: {
              reference: REFERENCE,
              serviceName: 'Portraits',
              packageName: 'Standard',
              ...WHEN,
              holdExpiresAt: mock.paid ? null : '2026-10-01T06:30:00.000Z',
              bookingFeeRwf: 20_000,
              state: mock.paid ? 'paid' : 'payable',
              waitingPayment: null,
            },
          },
        })
        return
      }
      if (request.method() === 'POST' && url.pathname === `/api/checkout/${REFERENCE}/${TOKEN}/payments`) {
        mock.posts.push(request.postDataJSON() as Record<string, unknown>)
        await route.fulfill({ status: 201, headers, json: { payment: { ourRef: OUR_REF, status: 'pending' } } })
        return
      }
      if (request.method() === 'GET' && url.pathname === `/api/payments/${OUR_REF}`) {
        mock.polls += 1
        if (mock.settled) mock.paid = true
        await route.fulfill({
          headers,
          json: {
            payment: { status: mock.settled ? 'succeeded' : 'pending', amountRwf: 20_000, failure: null },
            booking: { reference: REFERENCE, status: mock.settled ? 'confirmed' : 'pending_payment', serviceName: 'Portraits', packageName: 'Standard', ...WHEN },
          },
        })
        return
      }
      await route.fulfill({ status: 404, json: { error: 'not_found' } })
    },
  )
  return mock
}

/** Moves the browser clock on until the page has polled once more; answers the new count. */
async function nextPoll(page: Page, mock: Mock): Promise<number> {
  const before = mock.polls
  await expect
    .poll(async () => {
      await page.clock.runFor(500)
      return mock.polls
    }, { timeout: 15_000 })
    .toBeGreaterThan(before)
  return mock.polls
}

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: NOW })
})

test('the pay page offers MTN MoMo only: no Airtel Money or card element exists in the DOM', async ({ page }) => {
  await mockApi(page)
  await page.goto(CHECKOUT_PATH)

  await expect(page.getByRole('heading', { level: 1, name: 'Pay the booking fee' })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'MTN MoMo' })).toBeChecked()
  await expect(page.getByRole('radio')).toHaveCount(1)

  await expect(page.getByRole('radio', { name: 'Airtel Money' })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: 'Card' })).toHaveCount(0)
  // Scoped to the page: the client shell's header and footer are not what this asserts about (2026-09-21).
  await expect(page.locator('main').getByText(/airtel/i)).toHaveCount(0)
  await expect(page.locator('main').getByText(/^card$/i)).toHaveCount(0)
  await expect(page.locator('input[value="momo_airtel"], input[value="card"]')).toHaveCount(0)
  await expect(page.locator('main').locator('input:disabled, [aria-disabled="true"]')).toHaveCount(0)
  expect(await page.locator('main').innerText()).not.toMatch(/airtel|card/i)

  await expect(page.getByText('20,000 RWF', { exact: true })).toBeVisible()
  await expect(page.getByText('The booking fee is non-refundable if you cancel.')).toBeVisible()
})

test('the pay page renders the methods the API lists, not a list of its own', async ({ page }) => {
  await mockApi(page, ['momo_mtn', 'momo_airtel', 'card'])
  await page.goto(CHECKOUT_PATH)

  await expect(page.getByRole('radio')).toHaveCount(3)
  await expect(page.getByRole('radio', { name: 'Airtel Money' })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Card' })).toBeVisible()
})

test('paying moves to the progress page, which stays pending while the webhook is held back, then shows the booking confirmed', async ({ page }) => {
  const mock = await mockApi(page)
  await page.goto(CHECKOUT_PATH)

  await page.getByRole('textbox', { name: 'Mobile Money number' }).fill('078 812 3456')
  await page.getByRole('button', { name: 'Pay 20,000 RWF' }).click()

  await expect(page).toHaveURL(PROGRESS_PATH)
  await expect(page.getByRole('heading', { level: 1, name: 'Approve the payment on your phone' })).toBeVisible()
  expect(mock.posts).toEqual([{ method: 'momo_mtn', phone: '078 812 3456' }])
  await expect(page.getByText('Mobile Money can take a minute to confirm. This page updates by itself.')).toBeVisible()
  await expect(page.getByText('If you close this page, we will still email your confirmation as soon as the payment arrives.')).toBeVisible()
  // Development runs effects twice (StrictMode), so counts are compared, never fixed.
  await expect.poll(() => mock.polls).toBeGreaterThanOrEqual(1)
  const firstPolls = mock.polls

  // The webhook is held back: the API keeps answering pending.
  for (let i = 0; i < 6; i += 1) {
    await nextPoll(page, mock)
    await expect(page.getByRole('heading', { level: 1, name: 'Approve the payment on your phone' })).toBeVisible()
    await expect(page.getByText(CONFIRMED)).toHaveCount(0)
  }
  expect(mock.polls).toBeGreaterThanOrEqual(firstPolls + 6)

  // The webhook arrives.
  mock.settled = true
  await nextPoll(page, mock)

  await expect(page.getByRole('heading', { level: 1, name: CONFIRMED })).toBeVisible()
  await expect(page.getByText('Approve the payment on your phone')).toHaveCount(0)

  // Settled: no more polling.
  const settledAt = mock.polls
  for (let i = 0; i < 10; i += 1) await page.clock.runFor(3_000)
  await page.waitForTimeout(300)
  expect(mock.polls).toBe(settledAt)
})

test('reloading the checkout URL lands on the same pay page, and after payment on the paid notice', async ({ page }) => {
  const mock = await mockApi(page)
  await page.goto(CHECKOUT_PATH)
  await expect(page.getByRole('heading', { level: 1, name: 'Pay the booking fee' })).toBeVisible()
  const loadsBefore = mock.checkoutLoads

  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Pay the booking fee' })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'MTN MoMo' })).toBeChecked()
  expect(mock.checkoutLoads).toBeGreaterThan(loadsBefore)

  await page.getByRole('textbox', { name: 'Mobile Money number' }).fill('0788123456')
  await page.getByRole('button', { name: 'Pay 20,000 RWF' }).click()
  await expect(page).toHaveURL(PROGRESS_PATH)

  // Reloading the progress page while pending: still pending, never confirmed.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Approve the payment on your phone' })).toBeVisible()
  await expect(page.getByText(CONFIRMED)).toHaveCount(0)

  mock.settled = true
  await nextPoll(page, mock)
  await expect(page.getByRole('heading', { level: 1, name: CONFIRMED })).toBeVisible()

  await page.goto(CHECKOUT_PATH)
  await expect(page.getByRole('heading', { level: 1, name: 'This booking is already paid' })).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(0)
})

test('an unreadable number is marked and focused, and nothing is sent', async ({ page }) => {
  const mock = await mockApi(page)
  await page.goto(CHECKOUT_PATH)

  await page.getByRole('textbox', { name: 'Mobile Money number' }).fill('call me')
  await page.getByRole('button', { name: 'Pay 20,000 RWF' }).click()

  const phone = page.getByRole('textbox', { name: 'Mobile Money number' })
  await expect(phone).toHaveAttribute('aria-invalid', 'true')
  await expect(phone).toBeFocused()
  await expect(page.getByText('Enter the phone number of your Mobile Money account.')).toBeVisible()
  await expect(page).toHaveURL(CHECKOUT_PATH)
  expect(mock.posts).toEqual([])
})
