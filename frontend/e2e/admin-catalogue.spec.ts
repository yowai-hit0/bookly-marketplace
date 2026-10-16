import { type Page, expect, test } from '@playwright/test'

/**
 * The catalogue CMS in Chromium (plan.md Task 10; spec §3.4, §6.8, §6.14).
 * `/api/*` is answered here by a small in-memory catalogue that behaves like
 * the API: it stores what is POSTed, merges what is PATCHed, and warns when a
 * package is longer than the one open window, Mon–Fri 09:00–17:00.
 */

const NOW = new Date('2026-10-07T08:00:00.000Z')
const SESSION = { token: 'e2e.header.signature', expiresAt: '2026-10-07T16:00:00.000Z' }
const SESSION_KEY = 'bookly.admin.session'
const LONGEST_WINDOW = { opensMinute: 540, closesMinute: 1020 }

type Row = Record<string, unknown> & { id: string }
type Write = { method: string; path: string; body: unknown; authorization: string | null }

/** Answers `/api/*` in the page; returns the writes as they arrive. */
async function mockApi(page: Page) {
  const services: (Row & { packages: Row[]; addons: Row[] })[] = []
  const writes: Write[] = []
  let nextId = 1

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const method = request.method()
      const path = new URL(request.url()).pathname

      if (method === 'GET' && path === '/api/admin/catalogue') {
        await route.fulfill({ json: { services, sharedAddons: [] } })
        return
      }
      if (method === 'GET' && path === '/api/admin/calendar') {
        await route.fulfill({ json: { bookings: [], blocks: [] } })
        return
      }

      const body = request.postDataJSON() as Record<string, unknown> | null
      writes.push({ method, path, body, authorization: await request.headerValue('authorization') })

      if (method === 'POST' && path === '/api/admin/services') {
        const service = { nameFr: null, descriptionFr: null, ...body, id: `s${nextId++}`, packages: [], addons: [] }
        services.push(service)
        await route.fulfill({ status: 201, json: { service } })
        return
      }
      if (method === 'POST' && path === '/api/admin/packages') {
        const pkg: Row = { nameFr: null, descriptionFr: null, ...body, id: `p${nextId++}` }
        services.find((service) => service.id === pkg.serviceId)?.packages.push(pkg)
        const tooLong = Number(pkg.durationMinutes) > LONGEST_WINDOW.closesMinute - LONGEST_WINDOW.opensMinute
        const warning = tooLong ? { code: 'duration_exceeds_longest_window', longestWindow: LONGEST_WINDOW } : null
        await route.fulfill({ status: 201, json: { package: pkg, warning } })
        return
      }
      const serviceId = /^\/api\/admin\/services\/([^/]+)$/.exec(path)?.[1]
      const service = services.find((row) => row.id === serviceId)
      if (method === 'PATCH' && service !== undefined) {
        Object.assign(service, body)
        await route.fulfill({ json: { service } })
        return
      }
      await route.fulfill({ status: 404, json: { error: 'not_found' } })
    },
  )
  return writes
}

async function seedSession(page: Page) {
  await page.addInitScript(
    ([key, value]) => {
      window.sessionStorage.setItem(key, value)
    },
    [SESSION_KEY, JSON.stringify(SESSION)] as const,
  )
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW)
  await seedSession(page)
})

test('creates a service, adds a package that earns the §6.8 warning, then deactivates the service', async ({ page }) => {
  const writes = await mockApi(page)
  await page.goto('/admin/catalogue')

  await expect(page.getByText('No services yet. Add the first one.')).toBeVisible()

  await page.getByRole('button', { name: 'Add service' }).click()
  const newService = page.getByRole('form', { name: 'New service' })
  // French is stored by the API but never offered as an input (plan.md Task 10).
  await expect(newService.locator('[name$="Fr"]')).toHaveCount(0)
  await newService.getByLabel('Name').fill('Weddings')
  await newService.getByLabel('URL slug').fill('weddings')
  await newService.getByLabel('Booking fee override (%)').fill('37.5')
  await newService.getByRole('button', { name: 'Create' }).click()

  const card = page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { level: 2, name: /^Weddings/ }) })
  await expect(card.getByRole('heading', { level: 2 })).toHaveText('Weddings Active')
  await expect(card).toContainText('/weddings · Booking fee 37.5% · Order 0')
  await expect(page.getByRole('form')).toHaveCount(0)

  await card.getByRole('button', { name: 'Add package' }).click()
  const newPackage = page.getByRole('form', { name: 'New package' })
  await newPackage.getByLabel('Name').fill('Full day')
  await newPackage.getByLabel('Price (RWF)').fill('600000')
  await newPackage.getByLabel('Photos').fill('300')
  await newPackage.getByLabel('Duration (minutes)').fill('600')
  await newPackage.getByRole('button', { name: 'Create' }).click()

  const fullDay = card.getByRole('listitem').filter({ hasText: 'Full day' })
  await expect(fullDay).toContainText('600,000 RWF · 300 photos · 600 min · Order 0')
  await expect(fullDay.getByRole('alert')).toHaveText(
    'Full day lasts 600 min, longer than the longest open day (09:00–17:00, 480 min). Clients will never find a slot for it.',
  )

  await page.getByRole('button', { name: 'Deactivate Weddings' }).click()

  await expect(card.getByRole('heading', { level: 2 })).toHaveText('Weddings Inactive')
  await expect(page.getByRole('button', { name: 'Activate Weddings' })).toBeVisible()

  expect(writes).toEqual([
    {
      method: 'POST',
      path: '/api/admin/services',
      body: {
        nameEn: 'Weddings',
        slug: 'weddings',
        descriptionEn: null,
        coverImageUrl: null,
        bookingFeeRateOverride: 0.375,
        sortOrder: 0,
        isActive: true,
      },
      authorization: `Bearer ${SESSION.token}`,
    },
    {
      method: 'POST',
      path: '/api/admin/packages',
      body: {
        nameEn: 'Full day',
        descriptionEn: null,
        priceRwf: 600_000,
        photoCount: 300,
        durationMinutes: 600,
        sortOrder: 0,
        isActive: true,
        serviceId: 's1',
      },
      authorization: `Bearer ${SESSION.token}`,
    },
    { method: 'PATCH', path: '/api/admin/services/s1', body: { isActive: false }, authorization: `Bearer ${SESSION.token}` },
  ])
})

test('moves between Calendar and Catalogue from the admin header', async ({ page }) => {
  await mockApi(page)
  await page.goto('/admin/calendar')

  const nav = page.getByRole('navigation', { name: 'Admin' })
  await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible()
  await expect(page.locator('.fc-toolbar-title')).toHaveText('October 2026')
  await expect(nav.getByRole('link', { name: 'Calendar' })).toHaveAttribute('aria-current', 'page')

  await nav.getByRole('link', { name: 'Catalogue' }).click()

  await expect(page).toHaveURL(/\/admin\/catalogue$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Catalogue' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Catalogue' })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('link', { name: 'Calendar' })).not.toHaveAttribute('aria-current', 'page')

  await nav.getByRole('link', { name: 'Calendar' }).click()

  // The calendar records its view and date in the URL once it has drawn.
  await expect(page).toHaveURL(/\/admin\/calendar\?view=month&date=2026-10-01$/)
  await expect(page.locator('.fc-toolbar-title')).toHaveText('October 2026')
})
