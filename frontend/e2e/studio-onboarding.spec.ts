import { type Page, expect, test } from '@playwright/test'

/**
 * Studio onboarding in Chromium (marketplace spec T7.2, T7.1; R7.2-R7.4): a
 * photographer signs up, confirms the address, finds the setup checklist from
 * the banner, completes the profile items on the profile page, submits for
 * review; a platform admin approves the studio from "Awaiting review"; the
 * photographer then appears in the public directory and the studio shows its
 * free trial. And the negative path: a submission the API finds incomplete
 * lists what is missing.
 *
 * `/api/*` is answered here with `page.route`, behaving like the API over one
 * studio: the checklist is derived from the studio as it is, approval needs a
 * submission (409 `not_submitted` otherwise) and starts the trial, and only an
 * approved studio is in the directory. The payout method, a service and
 * working hours are marked done in the mock rather than driven through their
 * pages here: those forms have their own specs (admin-catalogue, the unit
 * suites), and this spec is about the onboarding path between them.
 *
 * The clock is Sunday 25 October 2026, 08:00 UTC.
 */

const NOW = new Date('2026-10-25T08:00:00.000Z')
const STUDIO_TOKEN = 'studio.header.payload'
const PLATFORM_TOKEN = 'platform.header.payload'
const EXPIRES_AT = '2099-01-01T00:00:00.000Z'
const PASSWORD = 'a long sentence I remember'
const TRIAL_ENDS = '2026-11-24T08:00:00.000Z'

const CATEGORIES = [
  { slug: 'portrait', name: 'Portrait' },
  { slug: 'wedding', name: 'Wedding' },
]
const PROVINCES = [
  { code: 'kigali', name: 'Kigali City', districts: [{ code: 'gasabo', name: 'Gasabo' }, { code: 'kicukiro', name: 'Kicukiro' }] },
  { code: 'western', name: 'Western Province', districts: [{ code: 'rubavu', name: 'Rubavu' }] },
]
const ITEMS = ['profile', 'categories', 'districts', 'payoutMethod', 'services', 'workingHours'] as const

type Studio = {
  handle: string
  displayName: string
  bio: string | null
  status: 'pending' | 'approved' | 'suspended'
  submittedAt: string | null
  districts: string[]
  categories: string[]
  payoutMethod: boolean
  services: boolean
  workingHours: boolean
  subscription: null | { status: 'trialing'; currentPeriodEndsAt: string; graceEndsAt: string; takingBookings: boolean; endingSoon: boolean }
}

function setupOf(studio: Studio) {
  const done: Record<(typeof ITEMS)[number], boolean> = {
    profile: studio.displayName.trim() !== '' && (studio.bio ?? '').trim() !== '',
    categories: studio.categories.length > 0,
    districts: studio.districts.length > 0,
    payoutMethod: studio.payoutMethod,
    services: studio.services,
    workingHours: studio.workingHours,
  }
  const items = ITEMS.map((key) => ({ key, done: done[key] }))
  const missing = items.filter((item) => !item.done).map((item) => item.key)
  return {
    items,
    missing,
    status: studio.status,
    submittedAt: studio.submittedAt,
    canSubmit: studio.status === 'pending' && studio.submittedAt === null && missing.length === 0,
  }
}

function profileOf(studio: Studio) {
  const districts = PROVINCES.flatMap((province) => province.districts)
  return {
    handle: studio.handle,
    handleEditable: studio.status === 'pending',
    displayName: studio.displayName,
    bio: studio.bio,
    contactPhone: null,
    whatsappPhone: null,
    contactEmail: null,
    coverImageUrl: null,
    districts: districts.filter((district) => studio.districts.includes(district.code)),
    categories: CATEGORIES.filter((category) => studio.categories.includes(category.slug)),
    status: studio.status,
  }
}

function platformRow(studio: Studio) {
  return {
    id: 'p1',
    handle: studio.handle,
    displayName: studio.displayName,
    email: 'lens@kigali.example',
    status: studio.status,
    createdAt: '2026-10-25T07:00:00.000Z',
    approvedAt: studio.status === 'approved' ? NOW.toISOString() : null,
    approvedByUserId: null,
    suspendedAt: null,
    suspensionReason: null,
    submittedAt: studio.submittedAt,
  }
}

/** Answers `/api/*` over one studio; `submitRefusal` makes the submission answer 422 with these items missing. */
async function mockApi(page: Page, options: { studio?: Partial<Studio>; submitRefusal?: string[] } = {}) {
  const studio: Studio = {
    handle: 'kigali-lens',
    displayName: 'Kigali Lens',
    bio: null,
    status: 'pending',
    submittedAt: null,
    districts: [],
    categories: [],
    payoutMethod: false,
    services: false,
    workingHours: false,
    subscription: null,
    ...options.studio,
  }
  const sent: { method: string; path: string; body: unknown }[] = []

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const method = request.method()
      const url = new URL(request.url())
      const path = url.pathname
      const body = method === 'GET' ? null : (request.postDataJSON() as Record<string, unknown> | null)
      sent.push({ method, path, body })

      // Signing up and confirming the address.
      if (method === 'POST' && path === '/api/studio/auth/signup') return route.fulfill({ status: 202, json: {} })
      if (method === 'POST' && path === '/api/studio/auth/verify') {
        return route.fulfill({ json: { user: { id: 'a1', email: 'lens@kigali.example', lastLoginAt: null }, token: STUDIO_TOKEN, tokenType: 'Bearer', expiresAt: EXPIRES_AT } })
      }
      if (method === 'POST' && path === '/api/platform/auth/login') {
        return route.fulfill({ json: { user: { id: 'u1', email: 'admin@bookly.example', lastLoginAt: null }, token: PLATFORM_TOKEN, tokenType: 'Bearer', expiresAt: EXPIRES_AT } })
      }

      // The public lists and the directory: an approved studio only.
      if (method === 'GET' && path === '/api/categories') return route.fulfill({ json: { categories: CATEGORIES } })
      if (method === 'GET' && path === '/api/districts') return route.fulfill({ json: { provinces: PROVINCES } })
      if (method === 'GET' && path === '/api/photographers') {
        const listed =
          studio.status === 'approved'
            ? [
                {
                  handle: studio.handle,
                  displayName: studio.displayName,
                  coverImageUrl: null,
                  fromPriceRwf: 30_000,
                  districts: profileOf(studio).districts,
                  categories: profileOf(studio).categories,
                  takingBookings: true,
                },
              ]
            : []
        return route.fulfill({ json: { photographers: listed, page: 1, pageSize: 24, hasMore: false, total: listed.length } })
      }

      // The studio, with its own token.
      if (path.startsWith('/api/studio/')) {
        if ((await request.headerValue('authorization')) !== `Bearer ${STUDIO_TOKEN}`) return route.fulfill({ status: 401, json: { error: 'invalid_token' } })
        if (method === 'GET' && path === '/api/studio/me') {
          return route.fulfill({
            json: {
              user: { id: 'a1', email: 'lens@kigali.example', lastLoginAt: null },
              photographer: { id: 'p1', handle: studio.handle, displayName: studio.displayName, status: studio.status, submittedAt: studio.submittedAt, suspensionReason: null },
              subscription: studio.subscription,
            },
          })
        }
        if (method === 'GET' && path === '/api/studio/calendar') return route.fulfill({ json: { bookings: [], blocks: [] } })
        if (method === 'GET' && path === '/api/studio/setup') return route.fulfill({ json: { setup: setupOf(studio) } })
        if (method === 'POST' && path === '/api/studio/setup/submit') {
          if (studio.status !== 'pending') return route.fulfill({ status: 409, json: { error: 'not_pending' } })
          if (options.submitRefusal !== undefined) return route.fulfill({ status: 422, json: { error: 'setup_incomplete', missing: options.submitRefusal } })
          const setup = setupOf(studio)
          if (studio.submittedAt === null && setup.missing.length > 0) return route.fulfill({ status: 422, json: { error: 'setup_incomplete', missing: setup.missing } })
          studio.submittedAt ??= NOW.toISOString()
          return route.fulfill({ json: { setup: setupOf(studio) } })
        }
        if (method === 'GET' && path === '/api/studio/profile') return route.fulfill({ json: { profile: profileOf(studio) } })
        if (method === 'PATCH' && path === '/api/studio/profile') {
          const patch = body as Partial<{ displayName: string; bio: string | null; districts: string[]; categories: string[] }>
          if (patch.displayName !== undefined) studio.displayName = patch.displayName
          if (patch.bio !== undefined) studio.bio = patch.bio
          if (patch.districts !== undefined) studio.districts = patch.districts
          if (patch.categories !== undefined) studio.categories = patch.categories
          return route.fulfill({ json: { profile: profileOf(studio) } })
        }
        if (method === 'GET' && path === '/api/studio/subscription') {
          const period = { id: 't1', kind: 'trial', planInterval: null, priceRwf: 0, startsAt: NOW.toISOString(), endsAt: TRIAL_ENDS, paidAt: null }
          return route.fulfill({
            json: {
              subscription:
                studio.subscription === null
                  ? null
                  : { id: 's1', ...studio.subscription, currentPeriod: period, periods: [period], paymentInProgress: null },
              prices: { monthly: 10_000, yearly: 100_000 },
              methods: ['momo_mtn'],
              graceDays: 7,
            },
          })
        }
      }

      // The platform console, with its own token.
      if (path.startsWith('/api/platform/')) {
        if ((await request.headerValue('authorization')) !== `Bearer ${PLATFORM_TOKEN}`) return route.fulfill({ status: 401, json: { error: 'invalid_token' } })
        if (method === 'GET' && path === '/api/platform/photographers') {
          const review = url.searchParams.get('review')
          const row = platformRow(studio)
          const pending = row.status === 'pending'
          const shown = review === null || (review === 'awaiting' && pending && row.submittedAt !== null) || (review === 'setting_up' && pending && row.submittedAt === null)
          return route.fulfill({ json: { photographers: shown ? [row] : [] } })
        }
        if (method === 'POST' && path === '/api/platform/photographers/p1/approve') {
          if (studio.submittedAt === null) return route.fulfill({ status: 409, json: { error: 'not_submitted', photographer: platformRow(studio) } })
          studio.status = 'approved'
          studio.subscription = { status: 'trialing', currentPeriodEndsAt: TRIAL_ENDS, graceEndsAt: '2026-12-01T08:00:00.000Z', takingBookings: true, endingSoon: false }
          return route.fulfill({ json: { photographer: platformRow(studio) } })
        }
      }

      return route.fulfill({ status: 404, json: { error: 'not_found' } })
    },
  )
  return { studio, sent }
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Studio' })

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW)
})

test('a photographer signs up, sets up, submits; the platform approves; the studio is listed and on its trial (T7.2)', async ({ page }) => {
  const api = await mockApi(page)

  // Sign up.
  await page.goto('/studio/signup')
  await page.getByLabel('Email').fill('lens@kigali.example')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByLabel('Display name').fill('Kigali Lens')
  await page.getByLabel('Handle').fill('kigali-lens')
  await page.getByRole('button', { name: 'Create studio' }).click()
  await expect(page.getByRole('status').getByText('Check your inbox')).toBeVisible()

  // Confirm the address from the emailed link: signed in, into the studio.
  await page.goto('/studio/verify/emailed-token')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Confirm and sign in' }).click()
  await expect(page).toHaveURL(/\/studio\/calendar$/)

  // The banner says what to do next; Setup is first in the nav while pending.
  const banner = page.locator('[data-studio-banner="setup"]')
  await expect(banner).toContainText('Finish setting up your studio and submit it for review.')
  await expect(sidebar(page).getByRole('link').first()).toHaveText('Setup')
  await banner.getByRole('link', { name: 'Go to setup' }).click()

  await expect(page).toHaveURL(/\/studio\/setup$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Set up your studio' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: '0 of 6 done' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Submit for review' })).toBeDisabled()

  // The profile items, on the profile page.
  await page.getByRole('link', { name: 'Edit your profile' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
  await page.getByLabel('Bio').fill('Portraits and weddings in natural light, across Kigali.')
  await page.getByLabel('Find a district').fill('gas')
  await page.getByRole('checkbox', { name: 'Gasabo' }).check()
  await page.getByRole('checkbox', { name: 'Portrait' }).check()
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByText('Your profile is saved.')).toBeVisible()
  expect(api.sent.filter((call) => call.method === 'PATCH').map((call) => call.body)).toEqual([
    { bio: 'Portraits and weddings in natural light, across Kigali.', districts: ['gasabo'], categories: ['portrait'] },
  ])

  // The payout method, a service and working hours, done on their own pages (see the header).
  api.studio.payoutMethod = true
  api.studio.services = true
  api.studio.workingHours = true

  // Back to the checklist: everything done, submit.
  await sidebar(page).getByRole('link', { name: 'Setup' }).click()
  await expect(page.getByRole('heading', { level: 2, name: '6 of 6 done' })).toBeVisible()
  await page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(page.getByText('Your studio is submitted for review.')).toBeVisible()
  await expect(page.locator('[data-setup-state="awaiting_review"]')).toContainText('You submitted your studio for review on')
  await expect(page.getByRole('button', { name: 'Submit for review' })).toHaveCount(0)

  // Elsewhere in the studio the banner now says it is waiting for review.
  await sidebar(page).getByRole('link', { name: 'Profile' }).click()
  await expect(page.locator('[data-studio-banner="awaiting_review"]')).toContainText('Your studio is waiting for review')

  // Not in the directory yet.
  await page.goto('/photographers')
  await expect(page.getByText('Kigali Lens')).toHaveCount(0)

  // The platform admin approves it from the queue the email links to.
  await page.goto('/platform/login')
  await page.getByLabel('Email').fill('admin@bookly.example')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/platform\/photographers/)
  await page.getByRole('navigation', { name: 'Review' }).getByRole('link', { name: 'Awaiting review' }).click()
  await expect(page).toHaveURL(/\?review=awaiting$/)
  await page.getByRole('button', { name: 'Approve Kigali Lens' }).click()
  await page.getByRole('dialog', { name: 'Approve Kigali Lens?' }).getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByRole('status')).toContainText('Kigali Lens is approved.')
  await expect(page.getByText('No studios are waiting for review.')).toBeVisible()

  // The photographer is in the directory.
  await page.goto('/photographers')
  await expect(page.getByText('Kigali Lens').first()).toBeVisible()

  // And the studio is on its free trial, with Setup gone from the nav and no banner.
  await page.goto('/studio/subscription')
  await expect(page.locator('[data-subscription-card="trialing"]')).toContainText('Free trial')
  await expect(sidebar(page).getByRole('link', { name: 'Setup' })).toHaveCount(0)
  await expect(page.locator('[data-studio-banner]')).toHaveCount(0)
})

test('approval is held back, with the reason, until the studio submits', async ({ page }) => {
  await mockApi(page, { studio: { bio: 'Portraits.', districts: ['gasabo'], categories: ['portrait'] } })
  await page.addInitScript((token) => {
    sessionStorage.setItem('bookly.platform.session', JSON.stringify({ token, expiresAt: '2099-01-01T00:00:00.000Z' }))
  }, PLATFORM_TOKEN)

  await page.goto('/platform/photographers?review=setting_up')
  const approve = page.getByRole('button', { name: 'Approve Kigali Lens' })
  await expect(approve).toBeDisabled()
  await expect(page.getByText('Not submitted for review yet')).toBeVisible()
})

test('a submission the API finds incomplete lists the missing items, each linking to its page (T7.1)', async ({ page }) => {
  // The checklist read says done; between the read and the press a service was deactivated.
  await mockApi(page, {
    studio: { bio: 'Portraits.', districts: ['gasabo'], categories: ['portrait'], payoutMethod: true, services: true, workingHours: true },
    submitRefusal: ['services', 'workingHours'],
  })
  await page.addInitScript((token) => {
    sessionStorage.setItem('bookly.studio.session', JSON.stringify({ token, expiresAt: '2099-01-01T00:00:00.000Z' }))
  }, STUDIO_TOKEN)

  await page.goto('/studio/setup')
  await expect(page.getByRole('heading', { level: 2, name: '6 of 6 done' })).toBeVisible()
  await page.getByRole('button', { name: 'Submit for review' }).click()

  const missing = page.locator('[data-setup-missing]')
  await expect(missing).toContainText('These steps still need finishing before you can submit:')
  await expect(missing.getByRole('link', { name: 'Services' })).toHaveAttribute('href', '/studio/catalogue')
  await expect(missing.getByRole('link', { name: 'Working hours' })).toHaveAttribute('href', '/studio/availability')
  await expect(page.locator('[data-setup-state]')).toHaveCount(0)
})
