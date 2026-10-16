import { type Page, expect, test } from '@playwright/test'

/**
 * Booking a shoot in Chromium (plan.md Task 13; spec §3.1 steps 5-8, §6.1,
 * §6.5, §7). `/api/*` is answered here with `page.route`: one service, an
 * October calendar a test can take a start out of mid-visit, and a booking
 * endpoint that answers what each test scripts and records what it was sent.
 * The browser clock is fixed; the browser zone is emulated with `timezoneId`.
 *
 * The clock is Thursday 1 October 2026, 06:00 UTC -- 08:00 in Kigali, and
 * still 02:00 in New York.
 */

const NOW = new Date('2026-10-01T06:00:00.000Z')

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

/** Wednesday 7 October's starts, Kigali wall time. No other day has any. */
const WEDNESDAY_STARTS = ['09:00', '09:30', '10:00']
const WEDNESDAY = 'Wednesday, 7 October 2026'

const NINE_THIRTY = '2026-10-07T07:30:00.000Z'
const TEN = '2026-10-07T08:00:00.000Z'

const JUST_TAKEN = 'Sorry, that time was just taken. The calendar has been refreshed, so please choose another time.'
const CONSENT = 'I agree that Bookly may use these details to arrange and deliver my booking.'

/** The API's answer for a created booking. Amounts deliberately differ from the browser's own quote. */
function held(startsAt: string, endsAt: string) {
  return {
    reference: 'BKY-2610-7K3QX',
    status: 'pending_payment',
    startsAt,
    endsAt,
    holdExpiresAt: '2026-10-01T06:30:00.000Z',
    serviceName: 'Portraits',
    packageName: 'Standard',
    packagePriceRwf: 42_000,
    addons: [{ name: 'Extra hour', priceRwf: 10_000 }],
    totalRwf: 52_000,
    bookingFeeRate: 0.375,
    bookingFeeRwf: 19_500,
    sessionFeeRwf: 32_500,
  }
}

type BookingReply = { status: number; json: unknown }

/**
 * Answers `/api/*`. `replies` answers each booking POST in turn (repeating the
 * last) and may take starts, as a rival booking would; `log` records every API
 * call in order, so a test can tell what was asked after what.
 */
async function mockApi(page: Page, replies: ((taken: Set<string>) => BookingReply)[]) {
  const posts: Record<string, unknown>[] = []
  const log: string[] = []
  const taken = new Set<string>()
  const authorizations: (string | null)[] = []
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      authorizations.push(await request.headerValue('authorization'))
      if (request.method() === 'GET' && url.pathname === `/api/services/${PORTRAITS.slug}`) {
        log.push('service')
        await route.fulfill({ json: { service: PORTRAITS } })
        return
      }
      if (request.method() === 'GET' && url.pathname === '/api/availability') {
        const month = url.searchParams.get('month') ?? ''
        log.push(`availability ${url.searchParams.get('packageId')} ${month}`)
        await route.fulfill({ json: { days: monthDays(month, taken) } })
        return
      }
      if (request.method() === 'POST' && url.pathname === '/api/bookings') {
        log.push('booking')
        posts.push(request.postDataJSON() as Record<string, unknown>)
        const reply = replies[Math.min(posts.length - 1, replies.length - 1)]
        if (reply === undefined) throw new Error('No booking reply scripted')
        const { status, json } = reply(taken)
        await route.fulfill({ status, json })
        return
      }
      await route.fulfill({ status: 404, json: { error: 'not_found' } })
    },
  )
  return { posts, log, taken, authorizations }
}

function monthDays(month: string, taken: ReadonlySet<string>) {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number]
  const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return Array.from({ length }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`
    const starts = (date === '2026-10-07' ? WEDNESDAY_STARTS : [])
      .map((time) => new Date(`${date}T${time}:00+02:00`).toISOString())
      .filter((start) => !taken.has(start))
    return { date, starts }
  })
}

function picker(page: Page) {
  return page.getByRole('region', { name: 'Choose a date and time' })
}

function summary(page: Page) {
  return page.getByRole('region', { name: 'Price summary' })
}

function startButton(page: Page, time: string) {
  return picker(page).getByRole('list').getByRole('button', { name: time, exact: true })
}

function confirm(page: Page) {
  return summary(page).getByRole('button', { name: 'Confirm booking' })
}

const field = {
  fullName: (page: Page) => page.getByRole('textbox', { name: 'Full name' }),
  email: (page: Page) => page.getByRole('textbox', { name: 'Email' }),
  phone: (page: Page) => page.getByRole('textbox', { name: 'Phone number' }),
  location: (page: Page) => page.getByRole('textbox', { name: 'Shoot location' }),
  partySize: (page: Page) => page.getByRole('textbox', { name: 'Number of people' }),
  specialRequests: (page: Page) => page.getByRole('textbox', { name: 'Special requests' }),
  consent: (page: Page) => page.getByRole('checkbox', { name: CONSENT }),
}

/** Standard + Extra hour, Wednesday at `time`, with the mouse. */
async function chooseByMouse(page: Page, time = '09:30') {
  await page.goto('/services/portraits')
  await page.getByRole('radio', { name: /^Standard/ }).check()
  await page.getByRole('checkbox', { name: /^Extra hour/ }).check()
  await picker(page).getByRole('button', { name: `${WEDNESDAY}, 3 times available`, exact: true }).click()
  await startButton(page, time).click()
  await expect(picker(page).getByText(new RegExp(`^Selected: ${WEDNESDAY}, ${time} to`))).toBeVisible()
}

async function fillByMouse(page: Page) {
  await field.fullName(page).fill('Aline Uwase')
  await field.email(page).fill('aline@example.com')
  await field.phone(page).fill('078 812 3456')
  await field.location(page).fill('Kigali Heights')
  await field.partySize(page).fill('3')
  await field.specialRequests(page).fill('Golden hour')
  await field.consent(page).check()
}

/** The held page's terms and values, in order. */
async function heldLines(page: Page): Promise<[string, string][]> {
  return page.locator('dl dt').evaluateAll((terms) =>
    terms.map((term) => [term.textContent ?? '', term.nextElementSibling?.textContent ?? ''] as [string, string]),
  )
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW)
})

test('books by keyboard alone: package, add-on, date, start, form, consent, Confirm, held page', async ({ page }) => {
  const { posts, authorizations } = await mockApi(page, [() => ({ status: 201, json: { booking: held(NINE_THIRTY, '2026-10-07T09:00:00.000Z') } })])
  await page.goto('/services/portraits')
  await expect(page.getByRole('heading', { level: 1, name: 'Portraits' })).toBeVisible()

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
  await page.keyboard.press('Space')
  await expect(page.getByRole('checkbox', { name: /^Extra hour/ })).toBeChecked()

  // No Confirm before a start: only the hint.
  await expect(summary(page).getByText('Choose a date and time to continue.')).toBeVisible()
  await expect(summary(page).getByRole('button')).toHaveCount(0)

  // The picker: Next month, then the only bookable date.
  await page.keyboard.press('Tab')
  await expect(picker(page).getByRole('button', { name: 'Next month' })).toBeFocused()
  const wednesday = picker(page).getByRole('button', { name: `${WEDNESDAY}, 3 times available`, exact: true })
  // Dates are disabled, and so skipped by Tab, until the month has loaded.
  await expect(wednesday).toBeEnabled()
  await page.keyboard.press('Tab')
  await expect(wednesday).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(picker(page).getByRole('list').getByRole('button')).toHaveText(WEDNESDAY_STARTS)
  await page.keyboard.press('Tab')
  await expect(startButton(page, '09:00')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(startButton(page, '09:30')).toBeFocused()
  await page.keyboard.press('Space')
  await expect(picker(page).getByText(`Selected: ${WEDNESDAY}, 09:30 to 11:00, Kigali time`)).toBeVisible()
  await expect(startButton(page, '09:30')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(startButton(page, '10:00')).toBeFocused()

  // The form, in reading order, typed into.
  const typed: [keyof typeof field, string][] = [
    ['fullName', 'Aline Uwase'],
    ['email', 'aline@example.com'],
    ['phone', '078 812 3456'],
    ['location', 'Kigali Heights'],
    ['partySize', '3'],
    ['specialRequests', 'Golden hour, please'],
  ]
  for (const [name, value] of typed) {
    await page.keyboard.press('Tab')
    await expect(field[name](page)).toBeFocused()
    await page.keyboard.type(value)
  }
  await page.keyboard.press('Tab')
  await expect(field.consent(page)).toBeFocused()
  await page.keyboard.press('Space')
  await expect(field.consent(page)).toBeChecked()

  // Past the notice, to Confirm.
  await page.keyboard.press('Tab')
  await expect(confirm(page)).toBeFocused()
  await page.keyboard.press('Enter')

  const heading = page.getByRole('heading', { level: 1, name: 'Your time is held' })
  await expect(heading).toBeVisible()
  await expect(heading).toBeFocused()
  expect(await heldLines(page)).toEqual([
    ['Booking reference', 'BKY-2610-7K3QX'],
    ['Service', 'Portraits, Standard'],
    ['When', `${WEDNESDAY}, 09:30 to 11:00, Kigali time`],
    ['Standard', '42,000 RWF'],
    ['Extra hour', '10,000 RWF'],
    ['Total', '52,000 RWF'],
    ['Booking fee (37.5%), paid now to secure your date', '19,500 RWF'],
    ['Session fee, due after the shoot', '32,500 RWF'],
  ])
  await expect(page.getByText(/^We are holding this time for you until 08:30, Kigali time\./)).toBeVisible()
  await expect(page.getByText('The booking fee is non-refundable if you cancel.')).toBeVisible()

  expect(posts).toEqual([
    {
      packageId: 'p2',
      addonIds: ['a1'],
      startsAt: NINE_THIRTY,
      fullName: 'Aline Uwase',
      email: 'aline@example.com',
      phone: '078 812 3456',
      location: 'Kigali Heights',
      partySize: 3,
      specialRequests: 'Golden hour, please',
      consent: true,
    },
  ])
  expect(authorizations.every((authorization) => authorization === null)).toBe(true)
})

test('marks what is wrong before sending anything, and focuses the first', async ({ page }) => {
  const { posts } = await mockApi(page, [() => ({ status: 201, json: { booking: held(NINE_THIRTY, '2026-10-07T09:00:00.000Z') } })])
  await chooseByMouse(page)
  await field.location(page).fill('Kigali Heights')

  await confirm(page).click()

  await expect(field.fullName(page)).toBeFocused()
  for (const name of ['fullName', 'email', 'phone', 'consent'] as const) {
    await expect(field[name](page)).toHaveAttribute('aria-invalid', 'true')
  }
  await expect(field.location(page)).not.toHaveAttribute('aria-invalid')
  await expect(page.getByText('Tick the box to agree before you book.')).toBeVisible()
  expect(posts).toHaveLength(0)
})

test('a slot taken at submit: focused alert, refreshed calendar, form kept, then booked at another time', async ({ page }) => {
  const { posts, log } = await mockApi(page, [
    (taken) => {
      taken.add(NINE_THIRTY)
      return { status: 409, json: { error: 'slot_taken' } }
    },
    () => ({ status: 201, json: { booking: held(TEN, '2026-10-07T09:30:00.000Z') } }),
  ])
  await chooseByMouse(page)
  await fillByMouse(page)

  await confirm(page).click()

  const alert = page.getByRole('alert')
  await expect(alert).toHaveText(JUST_TAKEN)
  await expect(alert).toBeFocused()
  // Refreshed: the calendar was asked again after the refusal, and 09:30 is gone.
  await expect(picker(page).getByRole('list').getByRole('button')).toHaveText(['09:00', '10:00'])
  await expect(picker(page).getByRole('button', { name: `${WEDNESDAY}, 2 times available`, exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(log.slice(log.indexOf('booking') + 1)).toContain('availability p2 2026-10')
  // Nothing selected, so nothing to confirm.
  await expect(page.getByText(/^Selected:/)).toHaveCount(0)
  await expect(summary(page).getByRole('button', { name: 'Confirm booking' })).toHaveCount(0)
  await expect(summary(page).getByText('Choose a date and time to continue.')).toBeVisible()
  // What was typed is still there.
  await expect(field.fullName(page)).toHaveValue('Aline Uwase')
  await expect(field.email(page)).toHaveValue('aline@example.com')
  await expect(field.phone(page)).toHaveValue('078 812 3456')
  await expect(field.location(page)).toHaveValue('Kigali Heights')
  await expect(field.partySize(page)).toHaveValue('3')
  await expect(field.specialRequests(page)).toHaveValue('Golden hour')
  await expect(field.consent(page)).toBeChecked()

  await startButton(page, '10:00').click()
  await expect(picker(page).getByText(`Selected: ${WEDNESDAY}, 10:00 to 11:30, Kigali time`)).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await confirm(page).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Your time is held' })).toBeFocused()
  await expect(page.getByText(`${WEDNESDAY}, 10:00 to 11:30, Kigali time`)).toBeVisible()
  expect(posts.map((body) => body.startsAt)).toEqual([NINE_THIRTY, TEN])
  expect(posts[1]).toMatchObject({ fullName: 'Aline Uwase', specialRequests: 'Golden hour', consent: true })
})

test('a failed submit says so and can be retried', async ({ page }) => {
  const { posts } = await mockApi(page, [
    () => ({ status: 500, json: { error: 'internal_error' } }),
    () => ({ status: 201, json: { booking: held(NINE_THIRTY, '2026-10-07T09:00:00.000Z') } }),
  ])
  await chooseByMouse(page)
  await fillByMouse(page)

  await confirm(page).click()

  await expect(summary(page).getByRole('alert')).toHaveText('Your booking did not go through. Check your connection and try again.')
  await confirm(page).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Your time is held' })).toBeVisible()
  expect(posts).toHaveLength(2)
})

for (const [timezoneId, localHourAtNow] of [
  ['America/New_York', 2],
  ['Asia/Tokyo', 15],
] as const) {
  test.describe(`with the browser in ${timezoneId}`, () => {
    test.use({ timezoneId })

    test('shows the held booking in Kigali time', async ({ page }) => {
      await mockApi(page, [() => ({ status: 201, json: { booking: held(NINE_THIRTY, '2026-10-07T09:00:00.000Z') } })])
      await chooseByMouse(page)

      // The emulation is real: the browser's own clock reads another hour.
      expect(await page.evaluate(() => [Intl.DateTimeFormat().resolvedOptions().timeZone, new Date().getHours()])).toEqual([
        timezoneId,
        localHourAtNow,
      ])

      await fillByMouse(page)
      await confirm(page).click()

      await expect(page.getByRole('heading', { level: 1, name: 'Your time is held' })).toBeVisible()
      // 09:30 Kigali is 03:30 in New York and 16:30 in Tokyo; the page says 09:30.
      expect((await heldLines(page))[2]).toEqual(['When', `${WEDNESDAY}, 09:30 to 11:00, Kigali time`])
      await expect(page.getByText(/until 08:30, Kigali time\./)).toBeVisible()
    })
  })
}
