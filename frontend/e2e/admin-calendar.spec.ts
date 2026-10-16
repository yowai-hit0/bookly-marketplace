import { type Page, expect, test } from '@playwright/test'

/**
 * The admin calendar in Chromium (plan.md Task 9; spec §3.3 step 1, §6.4,
 * §6.5), drawn by FullCalendar. The API is answered here with `page.route`;
 * the browser clock is fixed; the browser zone is emulated with `timezoneId`,
 * since Chromium ignores the `TZ` variable on Windows.
 *
 * The clock is 2026-10-06 22:30 UTC: 00:30 on Wednesday 7 October in Kigali,
 * but still Tuesday 6 October, 18:30, in New York.
 */

const NOW = new Date('2026-10-06T22:30:00.000Z')
const SESSION = { token: 'e2e.header.signature', expiresAt: '2026-10-07T06:30:00.000Z' }
const SESSION_KEY = 'bookly.admin.session'

/** Three confirmed bookings, one live hold and one block, in October 2026. */
const OCTOBER = {
  bookings: [
    {
      id: 'b1',
      reference: 'BKY-2610-00001',
      status: 'confirmed',
      startsAt: '2026-10-07T07:00:00.000Z',
      endsAt: '2026-10-07T08:00:00.000Z',
      contactName: 'Grace Mukamana',
      serviceName: 'Wedding',
      packageName: 'Full day',
      conflictsWithBlock: true,
    },
    // 01:00 Kigali on Thursday 8th: still Wednesday 7th, 19:00, in New York.
    {
      id: 'b2',
      reference: 'BKY-2610-00002',
      status: 'pending_payment',
      startsAt: '2026-10-07T23:00:00.000Z',
      endsAt: '2026-10-08T00:00:00.000Z',
      contactName: 'Claudine Ingabire',
      serviceName: 'Portrait',
      packageName: 'Standard',
      conflictsWithBlock: false,
    },
    {
      id: 'b3',
      reference: 'BKY-2610-00003',
      status: 'confirmed',
      startsAt: '2026-10-15T12:00:00.000Z',
      endsAt: '2026-10-15T13:00:00.000Z',
      contactName: 'Eric Habimana',
      serviceName: 'Portrait',
      packageName: 'Standard',
      conflictsWithBlock: false,
    },
    // 23:30 Kigali on Friday 23rd: already Saturday 24th, 11:30, in Kiritimati.
    {
      id: 'b4',
      reference: 'BKY-2610-00004',
      status: 'confirmed',
      startsAt: '2026-10-23T21:30:00.000Z',
      endsAt: '2026-10-23T22:00:00.000Z',
      contactName: 'Divine Uwera',
      serviceName: 'Event',
      packageName: 'Evening',
      conflictsWithBlock: false,
    },
  ],
  blocks: [
    {
      id: 'k1',
      startsAt: '2026-10-07T07:30:00.000Z',
      endsAt: '2026-10-07T09:00:00.000Z',
      isAllDay: false,
      reason: 'Clinic',
    },
  ],
}

/** What the October month grid must show, identically in every browser zone. */
const MONTH_ENTRIES: [date: string, status: string, texts: string[]][] = [
  ['2026-10-07', 'confirmed', ['09:00', 'Grace Mukamana', 'Confirmed', 'Conflicts with a block']],
  ['2026-10-07', 'block', ['09:30', 'Blocked']],
  ['2026-10-08', 'pending_payment', ['01:00', 'Claudine Ingabire', 'Hold']],
  ['2026-10-15', 'confirmed', ['14:00', 'Eric Habimana', 'Confirmed']],
  ['2026-10-23', 'confirmed', ['23:30', 'Divine Uwera', 'Confirmed']],
]

type CalendarRequest = { from: string | null; to: string | null; authorization: string | null }

type LoginAnswer = { status: number; body: unknown }

/** Answers `/api/*` in the page; returns the calendar requests as they arrive. */
async function mockApi(page: Page, login: LoginAnswer = { status: 401, body: { error: 'invalid_credentials' } }) {
  const calendarRequests: CalendarRequest[] = []
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === 'GET' && url.pathname === '/api/admin/calendar') {
        calendarRequests.push({
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          authorization: await request.headerValue('authorization'),
        })
        await route.fulfill({ json: OCTOBER })
        return
      }
      if (request.method() === 'POST' && url.pathname === '/api/admin/auth/login') {
        await route.fulfill({ status: login.status, json: login.body })
        return
      }
      await route.fulfill({ status: 404, json: { error: 'not_found' } })
    },
  )
  return calendarRequests
}

async function seedSession(page: Page) {
  await page.addInitScript(
    ([key, value]) => {
      window.sessionStorage.setItem(key, value)
    },
    [SESSION_KEY, JSON.stringify(SESSION)] as const,
  )
}

/** Every rendered booking or block as the Kigali date of its cell, its status and its text. */
function renderedEntries(page: Page) {
  return page.locator('[data-kind]').evaluateAll((elements) =>
    elements.map((element) => ({
      date: element.closest('[data-date]')?.getAttribute('data-date') ?? '',
      status: element.getAttribute('data-status') ?? '',
      text: (element as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
    })),
  )
}

function toolbarButton(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true })
}

/** Distinct consecutive ranges: the dev server's StrictMode mounts the calendar twice. */
function distinctRanges(requests: CalendarRequest[]): string[] {
  const ranges = requests.map(({ from, to }) => `${from}/${to}`)
  return ranges.filter((range, index) => range !== ranges[index - 1])
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW)
})

for (const [timezoneId, localHourAtNow] of [
  ['Africa/Kigali', 0],
  ['America/New_York', 18],
  ['Pacific/Kiritimati', 12],
] as const) {
  test.describe(`with the browser in ${timezoneId}`, () => {
    // Below the 1280x720 fit-to-screen size (2026-09-27), month shows every
    // event in full; these tests are about Kigali times and days, not layout.
    test.use({ timezoneId, viewport: { width: 1200, height: 900 } })

    test('shows the same Kigali times on the same Kigali days', async ({ page }) => {
      await seedSession(page)
      await mockApi(page)

      await page.goto('/admin/calendar?view=month&date=2026-10-07')

      // The emulation is real: the browser's own clock reads a different hour.
      expect(
        await page.evaluate(() => [Intl.DateTimeFormat().resolvedOptions().timeZone, new Date().getHours()]),
      ).toEqual([timezoneId, localHourAtNow])

      await expect(page.locator('.fc-toolbar-title')).toHaveText('October 2026')
      await expect(page.locator('[data-kind]')).toHaveCount(5)
      const entries = await renderedEntries(page)
      expect(entries.map(({ date, status }) => [date, status])).toEqual(MONTH_ENTRIES.map(([date, status]) => [date, status]))
      for (const [index, [, , texts]] of MONTH_ENTRIES.entries()) {
        for (const text of texts) expect(entries[index]?.text).toContain(text)
      }
      // "Today" is Kigali's today, whatever date the browser's zone is on.
      await expect(page.locator('.fc-daygrid-day.fc-day-today')).toHaveAttribute('data-date', '2026-10-07')

      await page.goto('/admin/calendar?view=week&date=2026-10-07')

      const thursday = page.locator('.fc-timegrid-col[data-date="2026-10-08"] [data-kind]')
      await expect(thursday).toHaveCount(1)
      await expect(thursday).toContainText('01:00 - 02:00')
      await expect(thursday).toContainText('Claudine Ingabire')
      await expect(page.locator('.fc-timegrid-col[data-date="2026-10-07"] [data-kind="booking"]')).toContainText('09:00 - 10:00')

      await page.goto('/admin/calendar?view=week&date=2026-10-23')

      await expect(page.locator('.fc-timegrid-col[data-date="2026-10-23"] [data-kind]')).toContainText('23:30 - 00:00')
      await expect(page.locator('.fc-timegrid-col[data-date="2026-10-24"] [data-kind]')).toHaveCount(0)
    })
  })
}

/**
 * At 1280x720 and up the calendar fits the screen (admin console fixes, item
 * 4, 2026-09-27): the page itself never scrolls, month shows every week with
 * busy days folded into "+N more", and week scrolls only inside its time grid.
 */
test.describe('fitted to a 1280x720 screen', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('never scrolls the page, and folds a busy month day into "+N more"', async ({ page }) => {
    await seedSession(page)
    await mockApi(page)

    await page.goto('/admin/calendar?view=month&date=2026-10-07')
    await expect(page.locator('.fc-toolbar-title')).toHaveText('October 2026')
    await expect(page.locator('.fc-daygrid-day[data-date="2026-10-07"] .fc-daygrid-more-link')).toBeVisible()
    const scroll = () => page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)
    expect(await scroll()).toBe(0)
    // Every week of the month is on screen, with nothing to scroll inside it either.
    const lastWeek = page.locator('.fc-daygrid-day[data-date="2026-10-31"]')
    await expect(lastWeek).toBeInViewport({ ratio: 1 })

    // A one-line event keeps the conflict in its accessible name.
    await page.locator('.fc-daygrid-day[data-date="2026-10-07"] .fc-daygrid-more-link').click()
    await expect(page.locator('.fc-popover .bookly-event--conflict')).toContainText('Conflicts with a block')

    await page.goto('/admin/calendar?view=week&date=2026-10-07')
    await expect(page.locator('.fc-timegrid-slot').first()).toBeAttached()
    expect(await scroll()).toBe(0)
  })
})

test.describe('with every month event in full (below 1280x720)', () => {
  test.use({ viewport: { width: 1200, height: 900 } })

  test('marks the booking that overlaps a block with a visible conflict marker', async ({ page }) => {
    await seedSession(page)
    await mockApi(page)

    await page.goto('/admin/calendar?view=month&date=2026-10-07')

    const marker = page.getByText('Conflicts with a block')
    await expect(marker).toHaveCount(1)
    await expect(marker).toBeVisible()
    await expect(page.locator('[data-kind]').filter({ has: marker })).toContainText('Grace Mukamana')
    await expect(page.locator('.bookly-event--conflict')).toHaveCount(1)
  })
})

test('switches views and dates with the toolbar, fetching only ranges it does not hold', async ({ page }) => {
  await seedSession(page)
  const requests = await mockApi(page)

  await page.goto('/admin/calendar?view=month&date=2026-10-07')
  await expect(page.locator('[data-kind]')).toHaveCount(5)
  await expect(page).toHaveURL(/\?view=month&date=2026-10-01$/)

  await toolbarButton(page, 'Week').click()

  await expect(page).toHaveURL(/\?view=week&date=2026-10-05$/)
  await expect(page.locator('.fc-toolbar-title')).toHaveText('5 – 11 Oct 2026')
  await expect(page.getByText('Wedding · Full day · BKY-2610-00001')).toBeVisible()
  await expect(page.getByText('Clinic')).toBeVisible()
  // The hourly grid opens scrolled to the working day.
  await expect
    .poll(() => page.locator('.fc-timegrid-body').evaluate((body) => body.closest('.fc-scroller')?.scrollTop ?? 0))
    .toBeGreaterThan(0)

  await toolbarButton(page, 'Day').click()

  // The day view keeps the date the calendar was opened on, not the week's Monday.
  await expect(page).toHaveURL(/\?view=day&date=2026-10-07$/)
  await expect(page.locator('[data-kind]')).toHaveCount(2)

  await toolbarButton(page, 'Month').click()
  await page.locator('.fc-daygrid-day[data-date="2026-10-15"] .fc-daygrid-day-number').click()

  await expect(page).toHaveURL(/\?view=day&date=2026-10-15$/)
  await expect(page.locator('[data-kind]')).toHaveCount(1)
  await expect(page.locator('[data-kind]')).toContainText('Eric Habimana')

  await toolbarButton(page, 'Month').click()
  await toolbarButton(page, 'Next').click()

  await expect(page).toHaveURL(/\?view=month&date=2026-11-01$/)
  await expect(page.locator('.fc-toolbar-title')).toHaveText('November 2026')

  // Week and day views sat inside the month already fetched; only November is new.
  await expect.poll(() => distinctRanges(requests)).toEqual(['2026-09-28/2026-11-01', '2026-10-26/2026-12-06'])
  expect(new Set(requests.map(({ authorization }) => authorization))).toEqual(new Set([`Bearer ${SESSION.token}`]))
})

test.describe('signing in', () => {
  test('sends a signed-out visitor to sign in, then to the calendar with the issued token', async ({ page }) => {
    const requests = await mockApi(page, {
      status: 200,
      body: { admin: { id: 'a1', email: 'photographer@bookly.example' }, ...SESSION, tokenType: 'Bearer' },
    })

    await page.goto('/admin/calendar?view=month&date=2026-10-07')

    await expect(page).toHaveURL(/\/admin\/login$/)
    expect(requests).toEqual([])

    const loginRequest = page.waitForRequest((request) => request.url().endsWith('/api/admin/auth/login'))
    await page.getByLabel('Email').fill('photographer@bookly.example')
    await page.getByLabel('Password').fill('correct horse battery staple')
    await page.getByRole('button', { name: 'Sign in' }).click()

    expect((await loginRequest).postDataJSON()).toEqual({
      email: 'photographer@bookly.example',
      password: 'correct horse battery staple',
    })
    await expect(page).toHaveURL(/\/admin\/calendar\?view=month&date=2026-10-01$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible()
    await expect(page.locator('.fc-toolbar-title')).toHaveText('October 2026')
    await expect(page.locator('[data-kind]')).toHaveCount(5)
    expect(requests.at(-1)).toEqual({ from: '2026-09-28', to: '2026-11-01', authorization: `Bearer ${SESSION.token}` })
    expect(
      await page.evaluate((key) => [window.sessionStorage.getItem(key), window.localStorage.length], SESSION_KEY),
    ).toEqual([JSON.stringify(SESSION), 0])

    // sessionStorage survives a reload, so he stays signed in.
    await page.reload()
    await expect(page.locator('[data-kind]')).toHaveCount(5)

    await page.getByRole('button', { name: 'Sign out' }).click()

    await expect(page).toHaveURL(/\/admin\/login$/)
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), SESSION_KEY)).toBeNull()
  })

  test('shows one message for refused credentials and stays on the form', async ({ page }) => {
    await mockApi(page, { status: 401, body: { error: 'invalid_credentials' } })

    await page.goto('/admin/login')
    await page.getByLabel('Email').fill('photographer@bookly.example')
    await page.getByLabel('Password').fill('wrong password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('alert')).toHaveText('That email and password did not work.')
    await expect(page).toHaveURL(/\/admin\/login$/)
  })
})
