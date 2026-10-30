import { mkdirSync } from 'node:fs'
import { type Page, type Route, expect, test } from '@playwright/test'
import { LENS_REF, NOW as ACCOUNT_NOW, PASSWORD, SESSION_FEE_REF, mockApi as mockAccountApi } from './account-api'

/**
 * Card payments in Chromium (marketplace-spec.md Phase 3 "Cards as built":
 * Flutterwave v3 Inline on our own pay pages). Nothing here talks to
 * Flutterwave: `https://checkout.flutterwave.com/v3.js` is answered with a
 * stand-in that defines `window.FlutterwaveCheckout` and draws a test dialog
 * with "Pay" (calls `callback` with a `transaction_id`) and "Close" (calls
 * `onclose`). `/api/*` is mocked as the other specs do.
 *
 * What is proven: the booking fee by card opens the modal with the API's
 * config unchanged and, on its callback, follows the payment on the progress
 * page with the transaction id until the API says confirmed; Flutterwave's
 * redirect query is read once and taken off the URL, and a forged
 * `status=successful` changes nothing; closing the modal unpaid stays on the
 * pay page and says nothing was charged; the account's session fee and the
 * studio subscription do the same. Touch targets are measured on a phone
 * before any full-page screenshot (a fullPage capture turns touch emulation off).
 */

const SHOTS = process.env.CARD_SHOTS_DIR ?? ''
const NOW = new Date('2026-10-01T06:05:00.000Z')
const REFERENCE = 'BKY-2610-7K3QX'
const TOKEN = 'aB3_x-9QzT7vL4pR8sK1nB6yH3cF5dG0wJeLmNoPqRs'
const OUR_REF = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'
const CHECKOUT_PATH = `/checkout/${REFERENCE}/${TOKEN}`
const PROGRESS_PATH = `${CHECKOUT_PATH}/payments/${OUR_REF}`
const WHEN = { startsAt: '2026-10-07T07:30:00.000Z', endsAt: '2026-10-07T09:00:00.000Z' }
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 900 }

function cardConfig(ourRef: string, amount: number, returnPath: string) {
  return {
    public_key: 'FLWPUBK_TEST-0123456789abcdef-X',
    tx_ref: ourRef,
    amount,
    currency: 'RWF',
    payment_options: 'card',
    redirect_url: `http://localhost:5174${returnPath}`,
    customer: { email: 'aline@example.com', name: 'Aline Uwase' },
    customizations: { title: 'Bookly booking fee' },
    configurations: { session_duration: 15 },
  }
}

/** The stand-in for Flutterwave's v3.js: a dialog with Pay and Close, recording every config it is opened with. */
const FAKE_V3 = `
window.__flwOpened = []
window.__flwClosed = 0
window.FlutterwaveCheckout = function (config) {
  window.__flwOpened.push(JSON.parse(JSON.stringify(config)))
  var box = document.createElement('div')
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-label', 'Flutterwave test checkout')
  box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center'
  var pay = document.createElement('button')
  pay.textContent = 'Pay'
  var close = document.createElement('button')
  close.textContent = 'Close'
  box.appendChild(pay)
  box.appendChild(close)
  document.body.appendChild(box)
  var gone = false
  function remove() { if (!gone) { gone = true; box.remove() } }
  pay.onclick = function () { config.callback({ status: 'successful', tx_ref: config.tx_ref, transaction_id: 4100000123 }) }
  close.onclick = function () { remove(); config.onclose(true) }
  return { close: function () { window.__flwClosed += 1; remove() } }
}
`

async function fakeFlutterwave(page: Page, mode: 'ok' | 'fail' = 'ok') {
  const loads = { count: 0 }
  await page.route('https://checkout.flutterwave.com/v3.js', async (route) => {
    loads.count += 1
    if (mode === 'fail') await route.abort('connectionfailed')
    else await route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_V3 })
  })
  // Anything else at Flutterwave is a test bug: no real call is ever made.
  await page.route(/flutterwave\.com|ravepay\.co/, (route) => (route.request().url().endsWith('/v3.js') ? route.fallback() : route.abort()))
  return loads
}

type CheckoutMock = { posts: unknown[]; polls: string[]; settled: boolean }

async function mockCheckoutApi(page: Page): Promise<CheckoutMock> {
  const mock: CheckoutMock = { posts: [], polls: [], settled: false }
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const headers = { 'Cache-Control': 'no-store' }
      if (url.pathname === '/api/payment-methods') return route.fulfill({ headers, json: { methods: ['momo_mtn', 'momo_airtel', 'card'] } })
      if (url.pathname === `/api/checkout/${REFERENCE}/${TOKEN}`) {
        return route.fulfill({
          headers,
          json: {
            checkout: {
              reference: REFERENCE,
              serviceName: 'Portraits',
              packageName: 'Standard',
              ...WHEN,
              holdExpiresAt: '2026-10-01T06:30:00.000Z',
              bookingFeeRwf: 20_000,
              state: 'payable',
              waitingPayment: null,
              cancellation: { deadline: WHEN.startsAt, bookingFeeRefundable: false },
            },
          },
        })
      }
      if (request.method() === 'POST' && url.pathname === `/api/checkout/${REFERENCE}/${TOKEN}/payments`) {
        mock.posts.push(request.postDataJSON())
        return route.fulfill({
          status: mock.posts.length === 1 ? 201 : 200,
          headers,
          json: { payment: { ourRef: OUR_REF, status: 'pending' }, card: cardConfig(OUR_REF, 20_000, PROGRESS_PATH) },
        })
      }
      if (url.pathname === `/api/payments/${OUR_REF}`) {
        mock.polls.push(url.search)
        return route.fulfill({
          headers,
          json: {
            payment: { status: mock.settled ? 'succeeded' : 'pending', amountRwf: 20_000, failure: null },
            booking: { reference: REFERENCE, status: mock.settled ? 'confirmed' : 'pending_payment', serviceName: 'Portraits', packageName: 'Standard', ...WHEN },
          },
        })
      }
      return route.fulfill({ status: 404, json: { error: 'not_found' } })
    },
  )
  return mock
}

/** Every visible control in `main` is at least 44px tall on a coarse pointer. */
async function expectTouchTargets(page: Page) {
  const small = await page.locator('main').evaluate((main) =>
    Array.from(main.querySelectorAll<HTMLElement>('button, a, label'))
      .filter((element) => element.offsetParent !== null)
      .map((element) => ({ text: (element.textContent ?? '').trim().slice(0, 40), height: element.getBoundingClientRect().height }))
      .filter((target) => target.height < 44),
  )
  expect(small).toEqual([])
}

async function shot(page: Page, name: string) {
  if (SHOTS === '') return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
}

test.describe('the booking fee by card', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: NOW })
  })

  test('opens the modal with the config unchanged and, on its callback, follows the payment to confirmed', async ({ page }) => {
    const loads = await fakeFlutterwave(page)
    const mock = await mockCheckoutApi(page)
    await page.goto(CHECKOUT_PATH)

    await page.getByRole('radio', { name: 'Card' }).check({ force: true })
    await expect(page.getByRole('textbox', { name: 'Mobile Money number' })).toHaveCount(0)
    await expect(page.getByText('You will enter your card details in a secure Flutterwave window.')).toBeVisible()
    // Nothing from Flutterwave is fetched until a card payment starts.
    expect(loads.count).toBe(0)

    await page.getByRole('button', { name: 'Pay 20,000 RWF' }).click()
    const dialog = page.getByRole('dialog', { name: 'Flutterwave test checkout' })
    await expect(dialog).toBeVisible()
    expect(mock.posts).toEqual([{ method: 'card' }])
    const opened = (await page.evaluate(() => (window as unknown as { __flwOpened: Record<string, unknown>[] }).__flwOpened)) ?? []
    expect(opened).toHaveLength(1)
    expect(opened[0]).toEqual(cardConfig(OUR_REF, 20_000, PROGRESS_PATH))
    expect(loads.count).toBe(1)

    await dialog.getByRole('button', { name: 'Pay' }).click()
    await expect(page).toHaveURL(PROGRESS_PATH)
    await expect(dialog).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __flwClosed: number }).__flwClosed)).toBe(1)
    await expect(page.getByRole('heading', { level: 1, name: 'Confirming your card payment' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to payment' })).toHaveAttribute('href', CHECKOUT_PATH)
    await expect.poll(() => mock.polls.at(0)).toBe('?transactionId=4100000123')

    mock.settled = true
    await expect
      .poll(async () => {
        await page.clock.runFor(1_000)
        return page.getByRole('heading', { level: 1, name: 'Your booking is confirmed' }).count()
      }, { timeout: 15_000 })
      .toBe(1)
  })

  test("Flutterwave's redirect: transaction_id is read once and stripped, and a forged status=successful stays pending", async ({ page }) => {
    await fakeFlutterwave(page)
    const mock = await mockCheckoutApi(page)
    await page.goto(`${PROGRESS_PATH}?status=successful&tx_ref=${OUR_REF}&transaction_id=4100000999`)

    await expect(page.getByRole('heading', { level: 1, name: 'Confirming your card payment' })).toBeVisible()
    await expect(page).toHaveURL(PROGRESS_PATH)
    await expect.poll(() => mock.polls.at(0)).toBe('?transactionId=4100000999')
    for (let i = 0; i < 4; i += 1) await page.clock.runFor(3_000)
    await expect(page.getByText('Your booking is confirmed')).toHaveCount(0)

    // A reload keeps what it learned (history state), not the query.
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Confirming your card payment' })).toBeVisible()
    await expect(page).toHaveURL(PROGRESS_PATH)
  })

  test('closing the modal unpaid stays on the pay page, says nothing was charged, and can reopen it', async ({ page }) => {
    await fakeFlutterwave(page)
    const mock = await mockCheckoutApi(page)
    await page.goto(CHECKOUT_PATH)
    await page.getByRole('radio', { name: 'Card' }).check({ force: true })
    await page.getByRole('button', { name: 'Pay 20,000 RWF' }).click()

    const dialog = page.getByRole('dialog', { name: 'Flutterwave test checkout' })
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(CHECKOUT_PATH)
    const notice = page.getByRole('status').filter({ hasText: 'The card window was closed.' })
    await expect(notice).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pay 20,000 RWF' })).toBeFocused()

    // The API answers the same checkout (200), and the modal opens again.
    await page.getByRole('button', { name: 'Pay 20,000 RWF' }).click()
    await expect(dialog).toBeVisible()
    expect(mock.posts).toEqual([{ method: 'card' }, { method: 'card' }])
  })

  test('a script that will not load is said inline, and the payer can still pay by MoMo', async ({ page }) => {
    await fakeFlutterwave(page, 'fail')
    await mockCheckoutApi(page)
    await page.goto(CHECKOUT_PATH)
    await page.getByRole('radio', { name: 'Card' }).check({ force: true })
    await page.getByRole('button', { name: 'Pay 20,000 RWF' }).click()

    await expect(page.getByRole('alert')).toHaveText("Card payment couldn't load. Check your connection and try again, or pay with mobile money.")
    await page.getByRole('radio', { name: 'MTN MoMo' }).check({ force: true })
    await expect(page.getByRole('textbox', { name: 'Mobile Money number' })).toBeVisible()
  })
})

test.describe('screenshots and touch targets', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: NOW })
  })

  for (const [name, viewport, touch] of [['phone', PHONE, true], ['desktop', DESKTOP, false]] as const) {
    test(`checkout with card chosen, and the closed notice, on a ${name}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch })
      const page = await context.newPage()
      await page.clock.install({ time: NOW })
      await fakeFlutterwave(page)
      await mockCheckoutApi(page)
      await page.goto(CHECKOUT_PATH)
      // A real tap on the method's card, as a payer would.
      await page.locator('label').filter({ has: page.getByRole('radio', { name: 'Card' }) }).click()
      await expect(page.getByText('You will enter your card details in a secure Flutterwave window.')).toBeVisible()
      if (touch) await expectTouchTargets(page)
      // Focus is visible on the chosen method's card.
      await page.getByRole('radio', { name: 'Card' }).focus()
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('ArrowRight')
      await shot(page, `checkout-card-${name}`)

      await page.getByRole('button', { name: 'Pay 20,000 RWF' }).click()
      await page.getByRole('dialog', { name: 'Flutterwave test checkout' }).getByRole('button', { name: 'Close' }).click()
      await expect(page.getByText('The card window was closed.', { exact: false })).toBeVisible()
      if (touch) await expectTouchTargets(page)
      await shot(page, `checkout-card-closed-${name}`)

      await page.goto(`${PROGRESS_PATH}?status=successful&tx_ref=${OUR_REF}&transaction_id=1`)
      await expect(page.getByRole('heading', { level: 1, name: 'Confirming your card payment' })).toBeVisible()
      if (touch) await expectTouchTargets(page)
      await shot(page, `progress-card-${name}`)
      await context.close()
    })
  }
})

test.describe('the session fee by card from the account', () => {
  test('opens the modal, follows the payment on the account progress page, and offers Back to payment', async ({ page }) => {
    await page.clock.install({ time: ACCOUNT_NOW })
    await fakeFlutterwave(page)
    const mock = await mockAccountApi(page)
    const polls: string[] = []
    // Registered after the shared mock, so these answers win; everything else falls through to it.
    await page.route(
      (url) => url.pathname === '/api/payment-methods' || url.pathname.endsWith(`/bookings/${LENS_REF}/payments`) || url.pathname === `/api/payments/${SESSION_FEE_REF}`,
      async (route: Route) => {
        const url = new URL(route.request().url())
        if (url.pathname === '/api/payment-methods') return route.fulfill({ json: { methods: ['momo_mtn', 'card'] } })
        if (url.pathname === `/api/payments/${SESSION_FEE_REF}`) {
          polls.push(url.search)
          return route.fulfill({
            json: {
              payment: { status: 'pending', amountRwf: 30_000, failure: null },
              booking: { reference: LENS_REF, status: 'confirmed', serviceName: 'Portraits', packageName: 'Standard', startsAt: '2026-10-07T07:30:00.000Z', endsAt: '2026-10-07T09:00:00.000Z' },
            },
          })
        }
        if (route.request().method() !== 'POST') return route.fallback()
        mock.posts.push({ url: url.pathname, body: route.request().postDataJSON() as unknown })
        const back = `/account/bookings/${LENS_REF}/payments/${SESSION_FEE_REF}`
        return route.fulfill({ status: 201, json: { payment: { ourRef: SESSION_FEE_REF, status: 'pending' }, card: cardConfig(SESSION_FEE_REF, 30_000, back) } })
      },
    )

    await page.goto('/account/login')
    await page.getByLabel('Email').fill('aline@example.com')
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL('/account')
    await page.goto(`/account/bookings/${LENS_REF}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Your booking' })).toBeVisible()

    await page.getByRole('radio', { name: 'Card' }).check({ force: true })
    await page.getByRole('button', { name: 'Pay 30,000 RWF' }).click()
    await page.getByRole('dialog', { name: 'Flutterwave test checkout' }).getByRole('button', { name: 'Pay' }).click()

    await expect(page).toHaveURL(`/account/bookings/${LENS_REF}/payments/${SESSION_FEE_REF}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Confirming your card payment' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to payment' })).toHaveAttribute('href', `/account/bookings/${LENS_REF}`)
    expect(mock.posts).toContainEqual({ url: `/api/account/bookings/${LENS_REF}/payments`, body: { method: 'card' } })
    await expect.poll(() => polls.at(0)).toBe('?transactionId=4100000123')
  })
})

test.describe('the studio subscription by card', () => {
  const STUDIO_TOKEN = 'e2e.studio.token'
  const STUDIO_ME = {
    user: { id: 'a1', email: 'photographer@bookly.example', lastLoginAt: null },
    photographer: { id: 'p1', handle: 'kigali-lens', displayName: 'Kigali Lens', status: 'approved', submittedAt: null, suspensionReason: null },
    subscription: { status: 'trialing', currentPeriodEndsAt: '2026-10-31T08:00:00.000Z', graceEndsAt: '2026-11-07T08:00:00.000Z', takingBookings: true, endingSoon: false },
  }
  const TRIAL = { id: 'per-trial', kind: 'trial', planInterval: null, priceRwf: 0, startsAt: '2026-10-01T08:00:00.000Z', endsAt: '2026-10-31T08:00:00.000Z', paidAt: null }

  async function mockStudio(page: Page) {
    const mock = { posts: [] as unknown[], polls: [] as string[], settled: false }
    await page.addInitScript((token) => {
      sessionStorage.setItem('bookly.studio.session', JSON.stringify({ token, expiresAt: '2099-01-01T00:00:00.000Z' }))
    }, STUDIO_TOKEN)
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        if (url.pathname === '/api/studio/me') return route.fulfill({ json: STUDIO_ME })
        if (url.pathname === '/api/studio/subscription') {
          return route.fulfill({
            json: {
              subscription: {
                id: 's1',
                status: mock.settled ? 'active' : 'trialing',
                currentPeriodEndsAt: mock.settled ? '2026-11-30T08:00:00.000Z' : TRIAL.endsAt,
                graceEndsAt: '2026-11-07T08:00:00.000Z',
                takingBookings: true,
                currentPeriod: TRIAL,
                periods: [TRIAL],
                paymentInProgress: null,
              },
              prices: { monthly: 10_000, yearly: 100_000 },
              methods: ['momo_mtn', 'momo_airtel', 'card'],
              graceDays: 7,
            },
          })
        }
        if (request.method() === 'POST' && url.pathname === '/api/studio/subscription/payments') {
          mock.posts.push(request.postDataJSON())
          return route.fulfill({
            status: 201,
            json: {
              payment: { ourRef: OUR_REF, status: 'pending', planInterval: 'monthly', amountRwf: 10_000 },
              card: cardConfig(OUR_REF, 10_000, `/studio/subscription/payments/${OUR_REF}`),
            },
          })
        }
        if (url.pathname === `/api/studio/subscription/payments/${OUR_REF}`) {
          mock.polls.push(url.search)
          return route.fulfill({
            json: {
              payment: {
                ourRef: OUR_REF,
                status: mock.settled ? 'succeeded' : 'pending',
                planInterval: 'monthly',
                amountRwf: 10_000,
                method: 'card',
                failure: null,
                initiatedAt: '2026-10-01T06:00:00.000Z',
                settledAt: mock.settled ? '2026-10-01T06:06:00.000Z' : null,
              },
              subscription: { status: mock.settled ? 'active' : 'trialing', currentPeriodEndsAt: mock.settled ? '2026-11-30T08:00:00.000Z' : TRIAL.endsAt, takingBookings: true },
            },
          })
        }
        return route.fulfill({ status: 404, json: { error: 'not_found' } })
      },
    )
    return mock
  }

  test('pays a month by card: the modal opens, its callback follows the payment in place until received', async ({ page }) => {
    await page.clock.install({ time: NOW })
    await fakeFlutterwave(page)
    const mock = await mockStudio(page)
    await page.goto('/studio/subscription')

    await page.getByRole('radio', { name: 'Card' }).check()
    await expect(page.getByLabel('Mobile Money number')).toHaveCount(0)
    await page.getByRole('button', { name: 'Pay 10,000 RWF' }).click()
    await page.getByRole('dialog', { name: 'Flutterwave test checkout' }).getByRole('button', { name: 'Pay' }).click()

    await expect(page.getByText('Confirming your card payment')).toBeVisible()
    expect(mock.posts).toEqual([{ planInterval: 'monthly', method: 'card' }])
    await expect.poll(() => mock.polls.at(0)).toBe('?transactionId=4100000123')

    mock.settled = true
    await expect
      .poll(async () => {
        await page.clock.runFor(1_000)
        return page.getByText('Payment received').count()
      }, { timeout: 15_000 })
      .toBe(1)
  })

  test('closing the modal unpaid keeps the form and says nothing was charged; the redirect page follows the payment', async ({ page }) => {
    await page.clock.install({ time: NOW })
    await fakeFlutterwave(page)
    const mock = await mockStudio(page)
    await page.goto('/studio/subscription')

    await page.getByRole('radio', { name: 'Card' }).check()
    await page.getByRole('button', { name: 'Pay 10,000 RWF' }).click()
    await page.getByRole('dialog', { name: 'Flutterwave test checkout' }).getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'The card window was closed.' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pay 10,000 RWF' })).toBeFocused()
    expect(mock.polls).toEqual([])

    await page.goto(`/studio/subscription/payments/${OUR_REF}?status=successful&tx_ref=${OUR_REF}&transaction_id=77`)
    await expect(page.getByText('Confirming your card payment')).toBeVisible()
    await expect(page).toHaveURL(`/studio/subscription/payments/${OUR_REF}`)
    await expect.poll(() => mock.polls.at(0)).toBe('?transactionId=77')
    await expect(page.getByText('Payment received')).toHaveCount(0)

    await page.getByRole('button', { name: 'Back to payment' }).click()
    await expect(page.getByRole('button', { name: 'Pay 10,000 RWF' })).toBeVisible()
  })

  for (const [name, viewport, touch] of [['phone', PHONE, true], ['desktop', DESKTOP, false]] as const) {
    test(`the subscription form with card chosen, and the closed notice, on a ${name}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch })
      const page = await context.newPage()
      await page.clock.install({ time: NOW })
      await fakeFlutterwave(page)
      await mockStudio(page)
      await page.goto('/studio/subscription')
      await page.getByRole('radio', { name: 'Card' }).check()
      await expect(page.getByText('You will enter your card details in a secure Flutterwave window.')).toBeVisible()
      if (touch) await expectTouchTargets(page)
      await shot(page, `studio-card-${name}`)

      await page.getByRole('button', { name: 'Pay 10,000 RWF' }).click()
      await page.getByRole('dialog', { name: 'Flutterwave test checkout' }).getByRole('button', { name: 'Close' }).click()
      await expect(page.getByText('The card window was closed.', { exact: false })).toBeVisible()
      if (touch) await expectTouchTargets(page)
      await shot(page, `studio-card-closed-${name}`)
      await context.close()
    })
  }
})
