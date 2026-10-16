import { type Page, expect, test } from '@playwright/test'

/**
 * The public slot picker in Chromium (plan.md Task 12; spec §3.1 steps 4-5,
 * §6.1, §6.5, §7). `/api/*` is answered here with `page.route`: one service,
 * and an availability month that a test can take a start out of mid-visit, the
 * way another visitor's confirmed booking would. The browser clock is fixed;
 * the browser zone is emulated with `timezoneId`, since Chromium ignores the
 * `TZ` variable on Windows.
 *
 * The clock is 2026-09-30 22:30 UTC: already Thursday 1 October, 00:30, in
 * Kigali -- but still Wednesday 30 September, 18:30, in New York, and Thursday
 * 1 October, 07:30, in Tokyo.
 */

const NOW = new Date('2026-09-30T22:30:00.000Z')

const PORTRAITS = {
  id: 's1',
  slug: 'portraits',
  nameEn: 'Portraits',
  descriptionEn: null,
  coverImageUrl: null,
  packages: [
    { id: 'p1', nameEn: 'Mini', descriptionEn: null, priceRwf: 25_000, photoCount: 1, durationMinutes: 45 },
    { id: 'p2', nameEn: 'Standard', descriptionEn: null, priceRwf: 40_000, photoCount: 20, durationMinutes: 90 },
  ],
  addons: [{ id: 'a1', nameEn: 'Extra hour', priceRwf: 10_000 }],
  bookingFeeRate: 0.4,
}

/**
 * October's starts, in Kigali wall time. Friday 30th is an evening opened by
 * a dated override: 18:00 Kigali is already 01:00 on Saturday 31st in Tokyo.
 */
const OCTOBER_STARTS: Record<string, string[]> = {
  '2026-10-01': ['09:00'],
  '2026-10-07': ['09:00', '09:30', '10:00'],
  '2026-10-30': ['18:00', '18:30'],
}

const JUST_TAKEN = 'Sorry, that time was just taken. The calendar has been refreshed, so please choose another time.'

type AvailabilityRequest = { packageId: string | null; month: string | null; authorization: string | null }

/**
 * Answers `/api/*` in the page. `taken` holds instants another visitor has
 * since booked: every availability answer after they are added leaves them out.
 */
async function mockApi(page: Page) {
  const requests: AvailabilityRequest[] = []
  const taken = new Set<string>()
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === 'GET' && url.pathname === `/api/services/${PORTRAITS.slug}`) {
        await route.fulfill({ json: { service: PORTRAITS } })
        return
      }
      if (request.method() === 'GET' && url.pathname === '/api/availability') {
        const month = url.searchParams.get('month')
        requests.push({
          packageId: url.searchParams.get('packageId'),
          month,
          authorization: await request.headerValue('authorization'),
        })
        await route.fulfill({ json: { days: monthDays(month ?? '', taken) } })
        return
      }
      await route.fulfill({ status: 404, json: { error: 'not_found' } })
    },
  )
  return { requests, taken }
}

/** Every date of `month`, with October's starts as ISO instants, less any taken. */
function monthDays(month: string, taken: ReadonlySet<string>) {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number]
  const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return Array.from({ length }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`
    const starts = (OCTOBER_STARTS[date] ?? [])
      .map((time) => new Date(`${date}T${time}:00+02:00`).toISOString())
      .filter((start) => !taken.has(start))
    return { date, starts }
  })
}

function picker(page: Page) {
  return page.getByRole('region', { name: 'Choose a date and time' })
}

function day(page: Page, label: string) {
  return picker(page).getByRole('button', { name: label, exact: true })
}

function startTimes(page: Page) {
  return picker(page).getByRole('list').getByRole('button')
}

/** Distinct `packageId|month` pairs in order: the dev server's StrictMode may send each load twice. */
function distinctRequests(requests: AvailabilityRequest[]): string[] {
  const keys = requests.map(({ packageId, month }) => `${packageId}|${month}`)
  return keys.filter((key, index) => key !== keys[index - 1])
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW)
})

test('chooses a package, a date and a start by keyboard alone', async ({ page }) => {
  const { requests } = await mockApi(page)
  await page.goto('/services/portraits')
  await expect(page.getByRole('heading', { level: 1, name: 'Portraits' })).toBeVisible()
  await expect(page.getByText('Choose a package to see available times.')).toBeVisible()

  // The client shell (2026-09-21) puts a header above every page, so the first
  // Tab from load is the skip link. Taking it is the journey: it jumps the
  // chrome and hands focus to the page, and the tab order below is unchanged.
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  await page.keyboard.press('Enter')

  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'All services' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('radio', { name: /^Mini/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('radio', { name: /^Standard/ })).toBeChecked()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('checkbox', { name: /^Extra hour/ })).toBeFocused()

  // Into the picker. Previous month is disabled at the current month, so Tab skips it.
  await expect(picker(page).getByRole('button', { name: 'Previous month' })).toBeDisabled()
  await page.keyboard.press('Tab')
  await expect(picker(page).getByRole('button', { name: 'Next month' })).toBeFocused()
  await expect(day(page, 'Wednesday, 7 October 2026, 3 times available')).toBeEnabled()

  // Only the bookable dates take focus: the 1st, then straight to the 7th.
  await page.keyboard.press('Tab')
  await expect(day(page, 'Thursday, 1 October 2026, 1 time available')).toBeFocused()
  await page.keyboard.press('Tab')
  const wednesday = day(page, 'Wednesday, 7 October 2026, 3 times available')
  await expect(wednesday).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(wednesday).toHaveAttribute('aria-pressed', 'true')
  await expect(startTimes(page)).toHaveText(['09:00', '09:30', '10:00'])

  // Past the 30th, into the starts.
  await page.keyboard.press('Tab')
  await expect(day(page, 'Friday, 30 October 2026, 2 times available')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(startTimes(page).nth(0)).toBeFocused()
  await page.keyboard.press('Tab')
  const nineThirty = picker(page).getByRole('button', { name: '09:30', exact: true })
  await expect(nineThirty).toBeFocused()
  await page.keyboard.press('Space')

  await expect(picker(page).getByText('Selected: Wednesday, 7 October 2026, 09:30 to 11:00, Kigali time')).toBeVisible()
  await expect(nineThirty).toHaveAttribute('aria-pressed', 'true')
  await expect(nineThirty).toBeFocused()

  // The start was checked against the API before it was accepted, anonymously.
  expect(distinctRequests(requests)).toEqual(['p2|2026-10'])
  expect(requests.length).toBeGreaterThanOrEqual(2)
  expect(requests.every(({ authorization }) => authorization === null)).toBe(true)
})

test('says a start was just taken, refreshes the calendar and selects nothing', async ({ page }) => {
  const { requests, taken } = await mockApi(page)
  await page.goto('/services/portraits')
  await page.getByRole('radio', { name: /^Standard/ }).check()
  await day(page, 'Wednesday, 7 October 2026, 3 times available').click()
  await expect(startTimes(page)).toHaveText(['09:00', '09:30', '10:00'])
  const loads = requests.length

  // Another visitor confirms 09:30 between page load and click.
  taken.add('2026-10-07T07:30:00.000Z')
  await picker(page).getByRole('button', { name: '09:30', exact: true }).click()

  const alert = page.getByRole('alert')
  await expect(alert).toHaveText(JUST_TAKEN)
  await expect(alert).toBeFocused()
  await expect(startTimes(page)).toHaveText(['09:00', '10:00'])
  await expect(day(page, 'Wednesday, 7 October 2026, 2 times available')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(/^Selected:/)).toHaveCount(0)
  await expect(picker(page).locator('[aria-pressed="true"]')).toHaveCount(1)
  expect(requests.length).toBeGreaterThan(loads)

  // The refreshed times can be chosen at once.
  await picker(page).getByRole('button', { name: '10:00', exact: true }).click()
  await expect(picker(page).getByText('Selected: Wednesday, 7 October 2026, 10:00 to 11:30, Kigali time')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('says no times are left when the only start on a day is taken', async ({ page }) => {
  const { taken } = await mockApi(page)
  await page.goto('/services/portraits')
  await page.getByRole('radio', { name: /^Mini/ }).check()
  await day(page, 'Thursday, 1 October 2026, 1 time available').click()

  taken.add('2026-10-01T07:00:00.000Z')
  await picker(page).getByRole('button', { name: '09:00', exact: true }).click()

  await expect(page.getByRole('alert')).toBeFocused()
  await expect(picker(page).getByText('No times are left on this day. Choose another date.')).toBeVisible()
  await expect(day(page, 'Thursday, 1 October 2026, no times available')).toBeDisabled()
  await expect(page.getByText(/^Selected:/)).toHaveCount(0)
})

for (const [timezoneId, localMonthAtNow, localHourAtNow] of [
  ['America/New_York', 8, 18],
  ['Asia/Tokyo', 9, 7],
] as const) {
  test.describe(`with the browser in ${timezoneId}`, () => {
    test.use({ timezoneId })

    test('opens on the Kigali month and shows Kigali times on Kigali dates', async ({ page }) => {
      const { requests } = await mockApi(page)
      await page.goto('/services/portraits')
      await page.getByRole('radio', { name: /^Standard/ }).check()

      // The emulation is real: the browser's own clock reads another month or hour.
      expect(
        await page.evaluate(() => [Intl.DateTimeFormat().resolvedOptions().timeZone, new Date().getMonth(), new Date().getHours()]),
      ).toEqual([timezoneId, localMonthAtNow, localHourAtNow])

      await expect(picker(page).getByRole('heading', { level: 3 })).toHaveText('October 2026')
      await expect(picker(page).getByText('All times are Kigali time (UTC+2).')).toBeVisible()

      // 09:00 Kigali is 03:00 in New York and 16:00 in Tokyo; the page says 09:00.
      await day(page, 'Thursday, 1 October 2026, 1 time available').click()
      await expect(startTimes(page)).toHaveText(['09:00'])
      await day(page, 'Wednesday, 7 October 2026, 3 times available').click()
      await expect(startTimes(page)).toHaveText(['09:00', '09:30', '10:00'])

      // 18:00 Kigali on Friday 30th is Saturday 31st in Tokyo: Friday is the day enabled.
      await expect(day(page, 'Saturday, 31 October 2026, no times available')).toBeDisabled()
      await expect(day(page, 'Tuesday, 6 October 2026, no times available')).toBeDisabled()
      await expect(day(page, 'Thursday, 8 October 2026, no times available')).toBeDisabled()
      await day(page, 'Friday, 30 October 2026, 2 times available').click()
      await expect(startTimes(page)).toHaveText(['18:00', '18:30'])

      await picker(page).getByRole('button', { name: '18:30', exact: true }).click()
      await expect(picker(page).getByText('Selected: Friday, 30 October 2026, 18:30 to 20:00, Kigali time')).toBeVisible()

      expect(distinctRequests(requests)).toEqual(['p2|2026-10'])
    })
  })
}
