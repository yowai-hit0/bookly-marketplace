import { type Page, expect, test } from '@playwright/test'
import { LENS_REF, LIGHT_REF, NOW, OTHER_REF, PASSWORD, SESSION_FEE_REF, TOKEN, mockApi, recordRequests } from './account-api'

/**
 * The client dashboard in Chromium (marketplace spec Phase 8: R8.1-R8.4,
 * T8.1-T8.3). `/api/*` is answered here with `page.route`, behaving like the
 * API over one client with bookings at two photographers: the bookings list,
 * one booking, its session-fee payment and cancellation, the payments and
 * their receipts, the profile, the export and the deletion, all behind the
 * account's bearer token -- after deletion every account call is a 401.
 *
 * What is proven: signing in lands on the dashboard listing bookings across
 * both photographers; a booking opens; its session fee is paid and followed
 * to "confirmed"; the payment then has a receipt. Cancelling states that
 * photographer's terms (the fee refunded) before anything is sent. The profile
 * saves, and the header follows. The export downloads a file and the token
 * travels in no URL. Deleting signs the tab out for good. Another client's
 * reference is "not found", naming nothing.
 *
 * The clock is Thursday 1 October 2026, 08:00 Kigali.
 */

async function signIn(page: Page) {
  await page.goto('/account/login')
  await page.getByLabel('Email').fill('aline@example.com')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL('/account')
  await expect(page.getByRole('heading', { level: 1, name: 'Hello, Aline Uwase' })).toBeVisible()
}

const main = (page: Page) => page.locator('main')
const accountNav = (page: Page) => page.getByRole('navigation', { name: 'Your account' })

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: NOW })
})

test('signs in, sees bookings across two photographers, pays a session fee and sees its receipt', async ({ page }) => {
  const mock = await mockApi(page)
  await signIn(page)

  const list = main(page).getByRole('list', { name: 'Bookings' })
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await expect(list.getByRole('link', { name: 'Kigali Lens' })).toBeVisible()
  await expect(list.getByRole('link', { name: 'Light House Studio' })).toBeVisible()
  await expect(list.getByText('Wednesday, 7 October 2026, 09:30 to 11:00, Kigali time')).toBeVisible()

  await list.getByRole('link', { name: 'Portraits, Standard' }).click()
  await expect(page).toHaveURL(`/account/bookings/${LENS_REF}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Your booking' })).toBeVisible()
  await expect(main(page).getByText(LENS_REF)).toBeVisible()

  await page.getByRole('textbox', { name: 'Mobile Money number' }).fill('078 812 3456')
  await page.getByRole('button', { name: 'Pay 30,000 RWF' }).click()
  await expect(page).toHaveURL(`/account/bookings/${LENS_REF}/payments/${SESSION_FEE_REF}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Your booking is confirmed' })).toBeVisible()
  expect(mock.posts).toContainEqual({ url: `/api/account/bookings/${LENS_REF}/payments`, body: { method: 'momo_mtn', phone: '078 812 3456' } })

  await accountNav(page).getByRole('link', { name: 'Payments' }).click()
  const payments = main(page).getByRole('list', { name: 'Payments' })
  await expect(payments.getByRole('listitem')).toHaveCount(2)
  await payments.getByRole('listitem').first().getByRole('link', { name: /View receipt/ }).click()

  await expect(page).toHaveURL(`/account/payments/${SESSION_FEE_REF}/receipt`)
  await expect(page.getByRole('heading', { level: 1, name: 'Payment receipt' })).toBeVisible()
  const sheet = page.locator('[data-receipt]')
  await expect(sheet.getByText(SESSION_FEE_REF)).toBeVisible()
  await expect(sheet.getByText('Session fee')).toBeVisible()
  await expect(sheet.getByText('30,000 RWF')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible()

  // Every account call carried the bearer token, and nothing else named the user.
  expect(mock.authHeaders.every((header) => header === `Bearer ${TOKEN}`)).toBe(true)
})

test('cancels under that photographer’s policy: the refundable fee is said before anything is sent', async ({ page }) => {
  const mock = await mockApi(page)
  await signIn(page)
  await main(page).getByRole('link', { name: 'Family, Two hours' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Your booking' })).toBeVisible()

  await page.getByRole('button', { name: 'Cancel this booking' }).click()
  await expect(
    page.getByText('If you cancel, your booking fee of 32,000 RWF is refunded to you, and the time is released for someone else to book.'),
  ).toBeVisible()
  expect(mock.posts.filter((post) => post.url.endsWith('/cancel'))).toEqual([])

  await page.getByRole('button', { name: 'Yes, cancel my booking' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'This booking is cancelled' })).toBeVisible()
  expect(mock.posts.filter((post) => post.url.endsWith('/cancel')).map((post) => post.url)).toEqual([`/api/account/bookings/${LIGHT_REF}/cancel`])

  // It has moved to Past.
  await accountNav(page).getByRole('link', { name: 'Bookings' }).click()
  await main(page).getByRole('link', { name: 'Past' }).click()
  await expect(page).toHaveURL('/account?scope=past')
  await expect(main(page).getByText('Cancelled by you')).toBeVisible()
})

test('edits the profile, and the header follows', async ({ page }) => {
  const mock = await mockApi(page)
  await signIn(page)
  await accountNav(page).getByRole('link', { name: 'Profile' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()

  const name = page.getByRole('textbox', { name: 'Full name' })
  await expect(name).toHaveValue('Aline Uwase')
  await name.fill('Aline M. Uwase')
  await page.getByRole('textbox', { name: 'Phone number' }).fill('0788 999 000')
  await page.getByRole('button', { name: 'Save details' }).click()

  await expect(page.getByText('Your details are saved.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Phone number' })).toHaveValue('+250788999000')
  await expect(page.getByRole('banner').getByRole('link', { name: 'Aline M. Uwase' })).toBeVisible()
  expect(mock.posts).toContainEqual({ url: '/api/account/profile', body: { fullName: 'Aline M. Uwase', phone: '0788 999 000' } })
})

test('the export downloads a file, and the token travels in no URL', async ({ page }) => {
  const seen = recordRequests(page)
  await mockApi(page)
  await signIn(page)
  await accountNav(page).getByRole('link', { name: 'Profile' }).click()

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download my data' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('bookly-account-2026-10-01.json')
  await expect(page.getByText('Your download has started.')).toBeVisible()

  expect(seen.some((url) => url.endsWith('/api/account/export'))).toBe(true)
  for (const url of seen) expect(url, url).not.toContain(TOKEN)
})

test('deleting the account warns that upcoming bookings carry on, then the session is gone', async ({ page }) => {
  const mock = await mockApi(page)
  await signIn(page)
  await accountNav(page).getByRole('link', { name: 'Profile' }).click()
  await page.getByRole('button', { name: 'Delete my account' }).click()

  const dialog = page.getByRole('dialog', { name: 'Delete your account?' })
  await expect(dialog.getByText(/Upcoming bookings carry on\./)).toBeVisible()
  await dialog.getByLabel('Enter your password to confirm').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Yes, delete my account' }).click()

  await expect(page).toHaveURL('/account/deleted')
  await expect(page.getByRole('heading', { level: 1, name: 'Your account is deleted' })).toBeVisible()
  await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('bookly.account.session'))).toBeNull()
  expect(mock.posts).toContainEqual({ url: '/api/account/delete', body: { password: PASSWORD } })

  // The dashboard now asks for a sign-in, and the old password no longer works.
  await page.goto('/account')
  await expect(page).toHaveURL('/account/login')
  await page.getByLabel('Email').fill('aline@example.com')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('That email and password did not work.')).toBeVisible()
})

test('another client’s reference is not found, and names nothing', async ({ page }) => {
  await mockApi(page)
  await signIn(page)
  await page.goto(`/account/bookings/${OTHER_REF}`)

  await expect(page.getByRole('heading', { level: 1, name: 'Booking not found' })).toBeVisible()
  await expect(main(page).getByRole('button')).toHaveCount(0)
  expect(await main(page).innerText()).not.toMatch(/RWF|Portraits|Family|Kigali Lens|Light House/)

  await page.goto(`/account/payments/${'33333333-3333-4333-8333-333333333333'}/receipt`)
  await expect(page.getByRole('heading', { level: 1, name: 'Receipt not found' })).toBeVisible()
})
