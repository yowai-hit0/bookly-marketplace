import { type Page, expect, test } from '@playwright/test'

/**
 * Public service browsing in Chromium (plan.md Task 11; spec §3.1 steps 1-3
 * and 7, §6.14). `/api/*` is answered here by a small catalogue that behaves
 * like the API: the list, each active service by slug with its booking-fee
 * rate, and a 404 for anything else -- a deactivated service included.
 *
 * The selection is completed with the keyboard alone: Tab to move between
 * controls, arrow keys within the package group, Space to tick an add-on.
 */

const PORTRAITS = {
  id: 's1',
  slug: 'portraits',
  nameEn: 'Portraits',
  descriptionEn: 'Studio portraits.',
  coverImageUrl: null,
  packages: [
    { id: 'p1', nameEn: 'Mini', descriptionEn: null, priceRwf: 25_000, photoCount: 1, durationMinutes: 45 },
    { id: 'p2', nameEn: 'Standard', descriptionEn: 'One look, one location.', priceRwf: 40_000, photoCount: 20, durationMinutes: 90 },
  ],
  addons: [
    { id: 'a1', nameEn: 'Extra hour', priceRwf: 10_000 },
    { id: 'a2', nameEn: 'Rush edit', priceRwf: 5_000 },
  ],
  bookingFeeRate: 0.4,
}

const WEDDINGS = {
  id: 's2',
  slug: 'weddings',
  nameEn: 'Weddings',
  descriptionEn: null,
  coverImageUrl: null,
  packages: [{ id: 'p3', nameEn: 'Standard', descriptionEn: null, priceRwf: 40_000, photoCount: 150, durationMinutes: 240 }],
  addons: [{ id: 'a3', nameEn: 'Second shooter', priceRwf: 10_000 }],
  bookingFeeRate: 0.3,
}

/** Deactivated: the API leaves it off the list and 404s its slug. */
const INACTIVE_SLUG = 'events'

const NOTICE = 'The booking fee is non-refundable if you cancel.'

type Sent = { method: string; path: string; authorization: string | null }

/** Answers `/api/*` in the page; returns the requests as they arrive. */
async function mockApi(page: Page) {
  const sent: Sent[] = []
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      sent.push({ method: request.method(), path, authorization: await request.headerValue('authorization') })

      if (request.method() === 'GET' && path === '/api/services') {
        const services = [PORTRAITS, WEDDINGS].map(({ bookingFeeRate: _rate, ...service }) => service)
        await route.fulfill({ json: { services } })
        return
      }
      const service = [PORTRAITS, WEDDINGS].find((candidate) => path === `/api/services/${candidate.slug}`)
      if (request.method() === 'GET' && service !== undefined) {
        await route.fulfill({ json: { service } })
        return
      }
      await route.fulfill({ status: 404, json: { error: 'not_found' } })
    },
  )
  return sent
}

function summary(page: Page) {
  return page.getByRole('region', { name: 'Price summary' })
}

/** The amount on the summary line whose term matches `label`. */
function amount(page: Page, label: string | RegExp) {
  return summary(page).locator('dl > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd')
}

async function expectTotals(page: Page, totals: { total: string; bookingFee: string; percent: string; sessionFee: string }) {
  await expect(amount(page, /^Total$/)).toHaveText(totals.total)
  await expect(summary(page).locator('dt', { hasText: /^Booking fee/ })).toHaveText(
    `Booking fee (${totals.percent}), paid now to secure your date`,
  )
  await expect(amount(page, /^Booking fee/)).toHaveText(totals.bookingFee)
  await expect(amount(page, /^Session fee/)).toHaveText(totals.sessionFee)
}

test('lists the active services and opens one from the keyboard', async ({ page }) => {
  const sent = await mockApi(page)
  await page.goto('/services')

  await expect(page.getByRole('heading', { level: 1, name: 'Services' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Portraits' })).toHaveAttribute('href', '/services/portraits')
  await expect(page.getByRole('link', { name: 'Weddings' })).toHaveAttribute('href', '/services/weddings')
  await expect(page.getByText('From 25,000 RWF')).toBeVisible()
  await expect(page.getByText('From 40,000 RWF')).toBeVisible()

  // The client shell (2026-09-21) puts a header above every page, so the first
  // Tab from load is the skip link. Taking it is the journey: it jumps the
  // chrome and hands focus to the page, and the tab order below is unchanged.
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  await page.keyboard.press('Enter')

  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Portraits' })).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page).toHaveURL(/\/services\/portraits$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Portraits' })).toBeVisible()
  // Anonymous: nothing sent a credential. (StrictMode in the dev server runs
  // each effect twice, so each GET may arrive twice; the paths are what count.)
  expect([...new Set(sent.map(({ method, path }) => `${method} ${path}`))]).toEqual([
    'GET /api/services',
    'GET /api/services/portraits',
  ])
  expect(sent.every(({ authorization }) => authorization === null)).toBe(true)
})

test('chooses a package and an add-on by keyboard alone, and the summary follows', async ({ page }) => {
  await mockApi(page)
  await page.goto('/services/portraits')
  await expect(page.getByRole('heading', { level: 1, name: 'Portraits' })).toBeVisible()

  const mini = page.getByRole('radio', { name: /^Mini/ })
  const standard = page.getByRole('radio', { name: /^Standard/ })
  const extraHour = page.getByRole('checkbox', { name: /^Extra hour/ })
  const rushEdit = page.getByRole('checkbox', { name: /^Rush edit/ })

  // Nothing is chosen yet, and the notice is already there.
  await expect(summary(page)).toContainText('Choose a package to see your total.')
  await expect(summary(page).getByText(NOTICE)).toBeVisible()
  await expect(mini).not.toBeChecked()
  await expect(standard).not.toBeChecked()

  // The client shell (2026-09-21) puts a header above every page, so the first
  // Tab from load is the skip link. Taking it is the journey: it jumps the
  // chrome and hands focus to the page, and the tab order below is unchanged.
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  await page.keyboard.press('Enter')

  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'All services' })).toBeFocused()

  // Into the package group: with nothing checked, Tab lands on the first radio.
  await page.keyboard.press('Tab')
  await expect(mini).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(standard).toBeFocused()
  await expect(standard).toBeChecked()
  await expect(mini).not.toBeChecked()
  await expectTotals(page, { total: '40,000 RWF', bookingFee: '16,000 RWF', percent: '40%', sessionFee: '24,000 RWF' })

  // Out of the group to the first add-on.
  await page.keyboard.press('Tab')
  await expect(extraHour).toBeFocused()
  await page.keyboard.press('Space')
  await expect(extraHour).toBeChecked()

  await expectTotals(page, { total: '50,000 RWF', bookingFee: '20,000 RWF', percent: '40%', sessionFee: '30,000 RWF' })
  await expect(summary(page).getByText(NOTICE)).toBeVisible()

  // A second add-on, then take it off again.
  await page.keyboard.press('Tab')
  await expect(rushEdit).toBeFocused()
  await page.keyboard.press('Space')
  await expectTotals(page, { total: '55,000 RWF', bookingFee: '22,000 RWF', percent: '40%', sessionFee: '33,000 RWF' })
  await page.keyboard.press('Space')
  await expect(rushEdit).not.toBeChecked()
  await expectTotals(page, { total: '50,000 RWF', bookingFee: '20,000 RWF', percent: '40%', sessionFee: '30,000 RWF' })

  // Back into the group with Shift+Tab: focus returns to the checked radio.
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(standard).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(mini).toBeChecked()
  await expectTotals(page, { total: '35,000 RWF', bookingFee: '14,000 RWF', percent: '40%', sessionFee: '21,000 RWF' })

  // The amounts come before the notice, and nothing mentions a processing fee.
  const noticeBelowTotal = await summary(page).evaluate((section, notice) => {
    const total = Array.from(section.querySelectorAll('dt')).find((term) => term.textContent === 'Total')
    const paragraph = Array.from(section.querySelectorAll('p')).find((p) => p.textContent === notice)
    return total !== undefined && paragraph !== undefined && (total.compareDocumentPosition(paragraph) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  }, NOTICE)
  expect(noticeBelowTotal).toBe(true)
  // Scoped to the page: the client shell's header and footer are not what this asserts about (2026-09-21).
  await expect(page.locator('main').getByText(/processing/i)).toHaveCount(0)
})

test('charges a service’s own rate: 15,000 now at 30% on a 50,000 basket', async ({ page }) => {
  await mockApi(page)
  await page.goto('/services/weddings')
  await expect(page.getByRole('heading', { level: 1, name: 'Weddings' })).toBeVisible()

  // The client shell (2026-09-21) puts a header above every page, so the first
  // Tab from load is the skip link. Taking it is the journey: it jumps the
  // chrome and hands focus to the page, and the tab order below is unchanged.
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  await page.keyboard.press('Enter')

  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('radio', { name: /^Standard/ })).toBeFocused()
  await page.keyboard.press('Space')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('checkbox', { name: /^Second shooter/ })).toBeFocused()
  await page.keyboard.press('Space')

  await expectTotals(page, { total: '50,000 RWF', bookingFee: '15,000 RWF', percent: '30%', sessionFee: '35,000 RWF' })
  await expect(summary(page).getByText(NOTICE)).toBeVisible()
})

test('shows not-found for a deactivated service and for an unknown slug', async ({ page }) => {
  await mockApi(page)

  for (const slug of [INACTIVE_SLUG, 'nothing-here']) {
    await page.goto(`/services/${slug}`)
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await expect(page.locator('main').getByText(NOTICE)).toHaveCount(0)
    await expect(page.locator('main').getByRole('radio')).toHaveCount(0)
  }
})
