import { type Page, expect, test } from '@playwright/test'

/**
 * The public marketplace in Chromium (marketplace spec T6.2; R6.1-R6.3):
 * filter the directory by district and category, open a profile, open a
 * service, book photographer A at 10:00 -- and photographer B's 10:00 that
 * same day is still offered, because each photographer's calendar is their
 * own.
 *
 * `/api/*` is answered here with `page.route`, behaving like the API: the
 * directory filters by category and district (and answers a 422 for an
 * unknown category), each photographer has a profile and one service, the
 * availability of a package is its own photographer's, and a booking takes
 * only that photographer's start. The browser clock is fixed.
 *
 * The clock is Thursday 1 October 2026, 06:00 UTC -- 08:00 in Kigali.
 */

const NOW = new Date('2026-10-01T06:00:00.000Z')

const WEDNESDAY = 'Wednesday, 7 October 2026'
const STARTS = ['09:00', '10:00', '11:00']
const TEN = '2026-10-07T08:00:00.000Z'
const CONSENT = 'I agree that Bookly may use these details to arrange and deliver my booking.'

type Photographer = {
  handle: string
  displayName: string
  district: { code: string; name: string }
  category: { slug: string; name: string }
  fromPriceRwf: number
  service: { id: string; slug: string; nameEn: string; packageId: string }
}

/** A and B work in Gasabo and shoot portraits; C is elsewhere and is filtered out. */
const A: Photographer = {
  handle: 'kigali-lens',
  displayName: 'Kigali Lens',
  district: { code: 'gasabo', name: 'Gasabo' },
  category: { slug: 'portrait', name: 'Portrait' },
  fromPriceRwf: 35_000,
  service: { id: 'sa', slug: 'portraits', nameEn: 'Portraits', packageId: 'pa' },
}
const B: Photographer = {
  handle: 'nyamirambo-light',
  displayName: 'Nyamirambo Light',
  district: { code: 'gasabo', name: 'Gasabo' },
  category: { slug: 'portrait', name: 'Portrait' },
  fromPriceRwf: 40_000,
  service: { id: 'sb', slug: 'studio-portraits', nameEn: 'Studio portraits', packageId: 'pb' },
}
const C: Photographer = {
  handle: 'lake-kivu-frames',
  displayName: 'Lake Kivu Frames',
  district: { code: 'rubavu', name: 'Rubavu' },
  category: { slug: 'wedding', name: 'Wedding' },
  fromPriceRwf: 50_000,
  service: { id: 'sc', slug: 'weddings', nameEn: 'Weddings', packageId: 'pc' },
}
const ALL = [A, B, C]

const CATEGORIES = [
  { slug: 'portrait', name: 'Portrait' },
  { slug: 'wedding', name: 'Wedding' },
]
const PROVINCES = [
  { code: 'kigali', name: 'Kigali City', districts: [{ code: 'gasabo', name: 'Gasabo' }, { code: 'kicukiro', name: 'Kicukiro' }] },
  { code: 'western', name: 'Western Province', districts: [{ code: 'rubavu', name: 'Rubavu' }] },
]

function card(p: Photographer) {
  return {
    handle: p.handle,
    displayName: p.displayName,
    coverImageUrl: null,
    fromPriceRwf: p.fromPriceRwf,
    districts: [p.district],
    categories: [p.category],
    takingBookings: true,
  }
}

function profile(p: Photographer) {
  return {
    ...card(p),
    bio: `${p.displayName} photographs people in natural light.`,
    contactPhone: null,
    whatsappPhone: '+250 788 111 222',
    email: null,
    cancellationPolicy: { cutoffHours: 0, bookingFeeRefundable: false },
    portfolio: [],
    services: [{ slug: p.service.slug, nameEn: p.service.nameEn, descriptionEn: null, coverImageUrl: null, fromPriceRwf: p.fromPriceRwf }],
  }
}

function service(p: Photographer) {
  return {
    id: p.service.id,
    slug: p.service.slug,
    nameEn: p.service.nameEn,
    descriptionEn: null,
    coverImageUrl: null,
    packages: [{ id: p.service.packageId, nameEn: 'Standard', descriptionEn: null, priceRwf: p.fromPriceRwf, photoCount: 20, durationMinutes: 60 }],
    addons: [],
    bookingFeeRate: 0.4,
    takingBookings: true,
  }
}

/** The API's answer for a created booking. */
function held(p: Photographer, startsAt: string) {
  return {
    reference: 'BKY-2610-7K3QX',
    status: 'pending_payment',
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    holdExpiresAt: '2026-10-01T06:30:00.000Z',
    serviceName: p.service.nameEn,
    packageName: 'Standard',
    packagePriceRwf: p.fromPriceRwf,
    addons: [],
    totalRwf: p.fromPriceRwf,
    bookingFeeRate: 0.4,
    bookingFeeRwf: p.fromPriceRwf * 0.4,
    sessionFeeRwf: p.fromPriceRwf * 0.6,
  }
}

/** Answers `/api/*`; `taken` holds each photographer's booked starts, by handle. */
async function mockApi(page: Page) {
  const taken = new Map<string, Set<string>>(ALL.map((p) => [p.handle, new Set()]))
  const searches: string[] = []
  const bookings: Record<string, unknown>[] = []
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const path = url.pathname
      if (request.method() === 'GET' && path === '/api/categories') return route.fulfill({ json: { categories: CATEGORIES } })
      if (request.method() === 'GET' && path === '/api/districts') return route.fulfill({ json: { provinces: PROVINCES } })
      if (request.method() === 'GET' && path === '/api/photographers') {
        searches.push(url.search)
        const category = url.searchParams.get('category')
        const district = url.searchParams.get('district')
        if (category !== null && !CATEGORIES.some((entry) => entry.slug === category)) {
          return route.fulfill({ status: 422, json: { error: 'validation_failed', fields: ['category'] } })
        }
        const matches = ALL.filter(
          (p) => (category === null || p.category.slug === category) && (district === null || p.district.code === district),
        )
        return route.fulfill({ json: { photographers: matches.map(card), page: 1, pageSize: 24, hasMore: false, total: matches.length } })
      }
      for (const p of ALL) {
        if (request.method() === 'GET' && path === `/api/photographers/${p.handle}`) return route.fulfill({ json: { photographer: profile(p) } })
        if (request.method() === 'GET' && path === `/api/photographers/${p.handle}/services/${p.service.slug}`) {
          return route.fulfill({ json: { service: service(p) } })
        }
      }
      if (request.method() === 'GET' && path === '/api/availability') {
        const owner = ALL.find((p) => p.service.packageId === url.searchParams.get('packageId'))
        const month = url.searchParams.get('month') ?? ''
        if (owner === undefined) return route.fulfill({ status: 422, json: { error: 'validation_failed', fields: ['packageId'] } })
        return route.fulfill({ json: { days: monthDays(month, taken.get(owner.handle) ?? new Set()) } })
      }
      if (request.method() === 'POST' && path === '/api/bookings') {
        const body = request.postDataJSON() as { packageId: string; startsAt: string }
        bookings.push(body)
        const owner = ALL.find((p) => p.service.packageId === body.packageId)
        if (owner === undefined) return route.fulfill({ status: 422, json: { error: 'validation_failed', fields: ['packageId'] } })
        const own = taken.get(owner.handle) ?? new Set()
        if (own.has(body.startsAt)) return route.fulfill({ status: 409, json: { error: 'slot_taken' } })
        own.add(body.startsAt)
        return route.fulfill({ status: 201, json: { booking: held(owner, body.startsAt) } })
      }
      return route.fulfill({ status: 404, json: { error: 'not_found' } })
    },
  )
  return { taken, searches, bookings }
}

/** Every date of `month`; Wednesday 7 October has three starts, less what that photographer has had booked. */
function monthDays(month: string, taken: ReadonlySet<string>) {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number]
  const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return Array.from({ length }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`
    const starts = (date === '2026-10-07' ? STARTS : [])
      .map((time) => new Date(`${date}T${time}:00+02:00`).toISOString())
      .filter((start) => !taken.has(start))
    return { date, starts }
  })
}

function picker(page: Page) {
  return page.getByRole('region', { name: 'Choose a date and time' })
}

function startTimes(page: Page) {
  return picker(page).getByRole('list').getByRole('button')
}

function filterBar(page: Page) {
  return page.getByRole('form', { name: 'Filters' })
}

function results(page: Page) {
  return page.getByRole('region', { name: 'Results' })
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW)
})

test('T6.2: filter by district and category, open a profile and a service, book A at 10:00; B’s 10:00 is still offered', async ({ page }) => {
  const { taken, searches, bookings } = await mockApi(page)
  await page.setViewportSize({ width: 1280, height: 900 })

  // The directory, unfiltered: all three.
  await page.goto('/photographers')
  await expect(page.getByRole('heading', { level: 1, name: 'Photographers' })).toBeVisible()
  await expect(results(page).getByRole('status')).toHaveText('3 photographers')

  // Filter by district, then by category: the URL follows, and only A and B are left.
  const district = filterBar(page).getByRole('combobox', { name: 'District' })
  await expect(district.locator('optgroup')).toHaveCount(2)
  await district.selectOption('gasabo')
  await expect(page).toHaveURL(/\/photographers\?district=gasabo$/)
  await filterBar(page).getByRole('combobox', { name: 'Category' }).selectOption('portrait')
  await expect(page).toHaveURL(/\/photographers\?category=portrait&district=gasabo$/)
  await expect(results(page).getByRole('status')).toHaveText('2 photographers')
  await expect(results(page).getByRole('link', { name: 'Lake Kivu Frames' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove filter: Portrait' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove filter: Gasabo' })).toBeVisible()
  await expect(page).toHaveTitle('Portrait photographers in Gasabo · Bookly')
  // No empty value ever reached the API.
  expect(searches.every((search) => !/=(&|$)/.test(search))).toBe(true)

  // Back undoes the last filter, forward redoes it.
  await page.goBack()
  await expect(page).toHaveURL(/\/photographers\?district=gasabo$/)
  await expect(filterBar(page).getByRole('combobox', { name: 'Category' })).toHaveValue('')
  await page.goForward()
  await expect(results(page).getByRole('status')).toHaveText('2 photographers')

  // Open A's profile, then its service.
  await results(page).getByRole('link', { name: 'Kigali Lens' }).click()
  await expect(page).toHaveURL(/\/p\/kigali-lens$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Kigali Lens' })).toBeVisible()
  await expect(page.getByText('Kigali Lens photographs people in natural light.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Contact' }).getByRole('link', { name: '+250 788 111 222' })).toHaveAttribute(
    'href',
    'https://wa.me/250788111222',
  )
  await page.getByRole('link', { name: 'Portraits' }).click()
  await expect(page).toHaveURL(/\/p\/kigali-lens\/portraits$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Portraits' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Your photographer' }).getByRole('link', { name: /^Kigali Lens/ })).toHaveAttribute(
    'href',
    '/p/kigali-lens',
  )

  // Book A at 10:00 on Wednesday.
  await page.getByRole('radio', { name: /^Standard/ }).check()
  await picker(page).getByRole('button', { name: `${WEDNESDAY}, 3 times available`, exact: true }).click()
  await expect(startTimes(page)).toHaveText(STARTS)
  await startTimes(page).filter({ hasText: '10:00' }).click()
  await page.getByRole('textbox', { name: 'Full name' }).fill('Aline Uwase')
  await page.getByRole('textbox', { name: 'Email' }).fill('aline@example.com')
  await page.getByRole('textbox', { name: 'Phone number' }).fill('078 812 3456')
  await page.getByRole('textbox', { name: 'Shoot location' }).fill('Kigali Heights')
  await page.getByRole('checkbox', { name: CONSENT }).check()
  await page.getByRole('region', { name: 'Price summary' }).getByRole('button', { name: 'Confirm booking' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Your time is held' })).toBeFocused()
  expect(bookings).toEqual([expect.objectContaining({ packageId: 'pa', startsAt: TEN })])
  expect([...(taken.get('kigali-lens') ?? [])]).toEqual([TEN])

  // A's own 10:00 is gone: the calendar says so.
  await page.goto('/p/kigali-lens/portraits')
  await page.getByRole('radio', { name: /^Standard/ }).check()
  await picker(page).getByRole('button', { name: `${WEDNESDAY}, 2 times available`, exact: true }).click()
  await expect(startTimes(page)).toHaveText(['09:00', '11:00'])

  // B, found the same way, still offers 10:00 that day.
  await page.goto('/photographers?category=portrait&district=gasabo')
  await results(page).getByRole('link', { name: 'Nyamirambo Light' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Nyamirambo Light' })).toBeVisible()
  await page.getByRole('link', { name: 'Studio portraits' }).click()
  await expect(page).toHaveURL(/\/p\/nyamirambo-light\/studio-portraits$/)
  await page.getByRole('radio', { name: /^Standard/ }).check()
  await picker(page).getByRole('button', { name: `${WEDNESDAY}, 3 times available`, exact: true }).click()
  await expect(startTimes(page)).toHaveText(STARTS)
  await expect(startTimes(page).filter({ hasText: '10:00' })).toBeEnabled()
})

test('words an unknown category from a shared link by its field, and recovers with Clear filters', async ({ page }) => {
  await mockApi(page)
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.goto('/photographers?category=retired&district=gasabo')

  await expect(page.getByRole('alert')).toContainText("Some filters can't be used.")
  const category = filterBar(page).getByRole('combobox', { name: 'Category' })
  await expect(category).toHaveAttribute('aria-invalid', 'true')
  await expect(filterBar(page).getByText("That category isn't offered any more. Choose another.")).toBeVisible()

  await page.getByRole('alert').getByRole('button', { name: 'Clear filters' }).click()
  await expect(page).toHaveURL(/\/photographers$/)
  await expect(results(page).getByRole('status')).toHaveText('3 photographers')
})

test('on a phone, filters live in a sheet: nothing applies until “Show photographers”', async ({ page }) => {
  const { searches } = await mockApi(page)
  await page.setViewportSize({ width: 375, height: 812 })

  await page.goto('/photographers')
  await expect(results(page).getByRole('status')).toHaveText('3 photographers')
  await expect(filterBar(page)).toBeHidden()

  const trigger = page.getByRole('button', { name: 'Filters', exact: true })
  await trigger.click()
  const sheet = page.getByRole('dialog', { name: 'Filters' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('combobox', { name: 'District' }).selectOption('rubavu')
  const before = searches.length
  await expect(page).toHaveURL(/\/photographers$/)

  await sheet.getByRole('button', { name: 'Show photographers' }).click()

  await expect(sheet).toBeHidden()
  await expect(page).toHaveURL(/\/photographers\?district=rubavu$/)
  await expect(results(page).getByRole('status')).toHaveText('1 photographer')
  expect(searches.length).toBeGreaterThan(before)
  await expect(page.getByRole('button', { name: 'Filters, 1 active' })).toBeFocused()

  // Escape discards a draft.
  await page.getByRole('button', { name: 'Filters, 1 active' }).click()
  await sheet.getByRole('combobox', { name: 'District' }).selectOption('gasabo')
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(page).toHaveURL(/\/photographers\?district=rubavu$/)
})
