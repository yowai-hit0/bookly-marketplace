import { type Page, expect, test } from '@playwright/test'

/**
 * The platform console's Phase 9 pages in Chromium (marketplace spec R9.1,
 * R9.2, R9.4): one photographer's detail page, the categories and the
 * activity trail. `/api/*` is answered here with `page.route`, behaving like
 * the API: the detail is one read, a suspension needs a reason and changes
 * the status, the categories keep their order and counts (a category in use
 * cannot be deleted, 409 `category_in_use`), and every change writes an audit
 * entry the Activity page lists and filters by action.
 *
 * What is proven: a photographer opens from the list, shows their detail,
 * is suspended with a reason and shows the change; a category is created,
 * renamed, moved, deactivated while in use (confirmed, saying photographers
 * keep the tag), and an unused one deleted, while a delete refused by a race
 * says so; Activity lists the entries and filters them; an unknown
 * photographer is "not found". The token travels in the header only.
 *
 * The clock is Tuesday 27 October 2026, 08:00 UTC.
 */

const NOW = new Date('2026-10-27T08:00:00.000Z')
const TOKEN = 'platform.header.payload'
const LENS_ID = '0b7d6f4e-1c2a-4e3b-9a8f-5d6c7b8a9e0f'
const UNKNOWN_ID = '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e'
const ADMIN = { id: 'u1', email: 'admin@bookly.example' }

type Category = { id: string; slug: string; nameEn: string; isActive: boolean; sortOrder: number; photographerCount: number; createdAt: string; updatedAt: string }
type Entry = { id: string; action: string; actor: typeof ADMIN; target: { type: string | null; id: string | null }; photographer: null | { id: string; handle: string; displayName: string }; details: Record<string, unknown>; createdAt: string }

type Mock = {
  status: 'approved' | 'suspended'
  suspensionReason: string | null
  categories: Category[]
  audit: Entry[]
  /** Answer the next delete with a race: someone tagged it meanwhile. */
  deleteRace: boolean
  writes: { method: string; path: string; body: unknown }[]
  badAuth: number
}

function category(id: string, slug: string, nameEn: string, sortOrder: number, photographerCount: number, isActive = true): Category {
  return { id, slug, nameEn, isActive, sortOrder, photographerCount, createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' }
}

const LENS = { id: LENS_ID, handle: 'kigali-lens', displayName: 'Kigali Lens' }

function row(mock: Mock) {
  return {
    ...LENS,
    email: 'lens@kigali.example',
    status: mock.status,
    createdAt: '2026-10-01T08:00:00.000Z',
    approvedAt: '2026-10-03T08:00:00.000Z',
    approvedByUserId: ADMIN.id,
    suspendedAt: mock.status === 'suspended' ? NOW.toISOString() : null,
    suspensionReason: mock.suspensionReason,
    submittedAt: '2026-10-02T08:00:00.000Z',
    handleChangedAt: null,
  }
}

function detail(mock: Mock) {
  return {
    photographer: { ...row(mock), approvedBy: ADMIN },
    profile: {
      bio: 'Portraits and weddings around Kigali.',
      contactPhone: '+250788123456',
      whatsappPhone: null,
      contactEmail: 'hello@kigali-lens.example',
      coverImageUrl: null,
      districts: [{ code: 'gasabo', name: 'Gasabo' }],
      categories: [{ slug: 'portrait', name: 'Portrait', isActive: true }],
    },
    setup: {
      items: ['profile', 'categories', 'districts', 'payoutMethod', 'services', 'workingHours'].map((key) => ({ key, done: true })),
      missing: [],
      canSubmit: false,
    },
    subscription: {
      id: 's1',
      status: 'trialing',
      currentPeriodEndsAt: '2026-11-02T08:00:00.000Z',
      graceEndsAt: '2026-11-09T08:00:00.000Z',
      createdAt: '2026-10-03T08:00:00.000Z',
      takingBookings: mock.status === 'approved',
      periods: [{ id: 'per1', kind: 'trial', planInterval: null, priceRwf: 0, startsAt: '2026-10-03T08:00:00.000Z', endsAt: '2026-11-02T08:00:00.000Z', paidAt: null }],
    },
    payoutMethod: { id: 'm1', kind: 'momo', provider: 'mtn', accountName: 'Jean Mugabo', last4: '3456', createdAt: '2026-09-01T08:00:00.000Z' },
    methodChangedRecently: false,
    counts: {
      bookings: { pending_payment: 0, confirmed: 2, completed: 5, no_show: 0, expired: 1, cancelled_by_client: 0, cancelled_by_photographer: 0, cancelled_by_platform: 0 },
      services: { total: 2, active: 2 },
    },
    earnings: { payableRwf: 60_000, inDraftRwf: 0, paidOutRwf: 150_000 },
    activity: mock.audit.filter((entry) => entry.photographer?.id === LENS_ID).slice(0, 20),
  }
}

function record(mock: Mock, action: string, details: Record<string, unknown>, photographer: Entry['photographer'] = null, targetType = 'category') {
  mock.audit.unshift({ id: `e${mock.audit.length + 1}`, action, actor: ADMIN, target: { type: targetType, id: null }, photographer, details, createdAt: NOW.toISOString() })
}

async function mockApi(page: Page): Promise<Mock> {
  const mock: Mock = {
    status: 'approved',
    suspensionReason: null,
    categories: [category('c1', 'portrait', 'Portrait', 0, 4), category('c2', 'wedding', 'Wedding', 1, 3), category('c3', 'drone', 'Drone', 2, 0)],
    audit: [
      {
        id: 'e1',
        action: 'payout_paid',
        actor: ADMIN,
        target: { type: 'payout', id: 'po1' },
        photographer: LENS,
        details: { amountRwf: 45_000, itemCount: 3, transferReference: 'TX-123' },
        createdAt: '2026-10-20T08:00:00.000Z',
      },
      {
        id: 'e0',
        action: 'settings_updated',
        actor: ADMIN,
        target: { type: 'platform_setting', id: null },
        photographer: null,
        details: { changed: { subscriptionMonthlyPriceRwf: { before: 10_000, after: 12_000 } } },
        createdAt: '2026-10-19T08:00:00.000Z',
      },
    ],
    deleteRace: false,
    writes: [],
    badAuth: 0,
  }

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const method = request.method()
      const url = new URL(request.url())
      const path = url.pathname
      if (!path.startsWith('/api/platform/')) return route.fulfill({ status: 404, json: { error: 'not_found' } })
      if ((await request.headerValue('authorization')) !== `Bearer ${TOKEN}`) {
        mock.badAuth += 1
        return route.fulfill({ status: 401, json: { error: 'unauthenticated' } })
      }
      const body = method === 'GET' || method === 'DELETE' ? null : (request.postDataJSON() as Record<string, unknown> | null)
      if (method !== 'GET') mock.writes.push({ method, path, body })

      if (method === 'GET' && path === '/api/platform/photographers') return route.fulfill({ json: { photographers: [row(mock)] } })
      if (method === 'GET' && path === `/api/platform/photographers/${LENS_ID}`) return route.fulfill({ json: detail(mock) })
      if (method === 'GET' && path.startsWith('/api/platform/photographers/')) {
        // A uuid naming nobody is a 404; anything else is the 400 of a malformed id.
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path.split('/').pop() ?? '')
        return route.fulfill(uuid ? { status: 404, json: { error: 'not_found' } } : { status: 400, json: { error: 'invalid_request' } })
      }
      if (method === 'POST' && path === `/api/platform/photographers/${LENS_ID}/suspend`) {
        const reason = String(body?.reason ?? '').trim()
        if (reason === '') return route.fulfill({ status: 422, json: { error: 'validation_failed', fields: ['reason'] } })
        mock.status = 'suspended'
        mock.suspensionReason = reason
        record(mock, 'photographer_suspended', { status: 'suspended', reason }, LENS, 'photographer')
        return route.fulfill({ json: { photographer: row(mock) } })
      }

      if (method === 'GET' && path === '/api/platform/categories') return route.fulfill({ json: { categories: mock.categories } })
      if (method === 'POST' && path === '/api/platform/categories') {
        const slug = String(body?.slug)
        const nameEn = String(body?.nameEn)
        if (mock.categories.some((each) => each.slug === slug)) return route.fulfill({ status: 409, json: { error: 'slug_taken' } })
        const created = category(`c${mock.categories.length + 10}`, slug, nameEn, mock.categories.length, 0)
        mock.categories.push(created)
        record(mock, 'category_created', { slug, nameEn, sortOrder: created.sortOrder })
        return route.fulfill({ status: 201, json: { category: created } })
      }
      if (method === 'PUT' && path === '/api/platform/categories/order') {
        const ids = (body?.ids ?? []) as string[]
        if (ids.length !== mock.categories.length) return route.fulfill({ status: 422, json: { error: 'validation_failed', fields: ['ids'] } })
        const before = mock.categories.map((each) => each.id)
        mock.categories = ids.map((id, index) => ({ ...(mock.categories.find((each) => each.id === id) as Category), sortOrder: index }))
        record(mock, 'category_reordered', { before, after: ids })
        return route.fulfill({ json: { categories: mock.categories } })
      }
      const one = /^\/api\/platform\/categories\/([^/]+)$/.exec(path)
      if (one !== null) {
        const found = mock.categories.find((each) => each.id === one[1])
        if (found === undefined) return route.fulfill({ status: 404, json: { error: 'not_found' } })
        if (method === 'PATCH') {
          if (typeof body?.nameEn === 'string' && body.nameEn !== found.nameEn) {
            record(mock, 'category_updated', { slug: found.slug, nameEn: { before: found.nameEn, after: body.nameEn } })
            found.nameEn = body.nameEn
          }
          if (typeof body?.isActive === 'boolean' && body.isActive !== found.isActive) {
            found.isActive = body.isActive
            record(mock, body.isActive ? 'category_reactivated' : 'category_deactivated', { slug: found.slug, photographerCount: found.photographerCount })
          }
          return route.fulfill({ json: { category: found } })
        }
        if (method === 'DELETE') {
          if (mock.deleteRace) {
            mock.deleteRace = false
            found.photographerCount = 1
          }
          if (found.photographerCount > 0) return route.fulfill({ status: 409, json: { error: 'category_in_use', photographerCount: found.photographerCount } })
          mock.categories = mock.categories.filter((each) => each.id !== found.id)
          record(mock, 'category_deleted', { slug: found.slug, nameEn: found.nameEn })
          return route.fulfill({ status: 204, body: '' })
        }
      }

      if (method === 'GET' && path === '/api/platform/audit') {
        const action = url.searchParams.get('action')
        const photographerId = url.searchParams.get('photographerId')
        const entries = mock.audit.filter((entry) => (action === null || entry.action === action) && (photographerId === null || entry.photographer?.id === photographerId))
        return route.fulfill({ json: { entries, total: entries.length, page: 1, pageSize: 50, pageCount: entries.length === 0 ? 0 : 1 } })
      }

      return route.fulfill({ status: 404, json: { error: 'not_found' } })
    },
  )
  return mock
}

async function signedIn(page: Page) {
  await page.addInitScript((token) => {
    sessionStorage.setItem('bookly.platform.session', JSON.stringify({ token, expiresAt: '2099-01-01T00:00:00.000Z' }))
  }, TOKEN)
}

const main = (page: Page) => page.locator('main')
const platformNav = (page: Page) => page.getByRole('navigation', { name: 'Platform' })

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW)
  await signedIn(page)
})

test('opens a photographer from the list, sees the detail, suspends them with a reason and sees the status change', async ({ page }) => {
  const mock = await mockApi(page)
  await page.goto('/platform/photographers')
  await main(page).getByRole('link', { name: 'Kigali Lens' }).click()

  await expect(page).toHaveURL(`/platform/photographers/${LENS_ID}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Kigali Lens' })).toBeVisible()
  await expect(page.locator('[data-photographer-status="approved"]')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Timeline' })).toContainText('Approved by admin@bookly.example')
  await expect(page.getByRole('region', { name: 'Payout method' })).toContainText('•••• 3456')
  await expect(page.getByRole('region', { name: 'Earnings' })).toContainText('60,000 RWF')
  await expect(page.getByRole('region', { name: 'Recent activity' })).toContainText('Marked a 45,000 RWF payout to Kigali Lens paid (ref TX-123)')

  await page.getByRole('button', { name: 'Suspend Kigali Lens' }).click()
  const dialog = page.getByRole('dialog', { name: 'Suspend Kigali Lens?' })
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Portfolio photos are not their own.')
  await dialog.getByRole('button', { name: 'Suspend' }).click()

  await expect(page.getByRole('status').filter({ hasText: 'Kigali Lens is suspended.' })).toBeVisible()
  await expect(page.locator('[data-photographer-status="suspended"]')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Timeline' })).toContainText('Reason: Portfolio photos are not their own.')
  await expect(page.getByRole('button', { name: 'Reactivate Kigali Lens' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Recent activity' })).toContainText('Suspended Kigali Lens')
  expect(mock.writes).toEqual([{ method: 'POST', path: `/api/platform/photographers/${LENS_ID}/suspend`, body: { reason: 'Portfolio photos are not their own.' } }])

  // Back to the list, which shows the change too.
  await page.getByRole('link', { name: 'Back to photographers' }).click()
  await expect(page).toHaveURL('/platform/photographers')
  await expect(main(page).getByText('Reason: Portfolio photos are not their own.')).toBeVisible()
  expect(mock.badAuth).toBe(0)
})

test('categories: create, rename, reorder, deactivate one in use, delete an unused one; a delete race says so', async ({ page }) => {
  const mock = await mockApi(page)
  await page.goto('/platform/photographers')
  await platformNav(page).getByRole('link', { name: 'Categories' }).click()
  await expect(page).toHaveURL('/platform/categories')
  await expect(page.getByRole('heading', { level: 1, name: 'Categories' })).toBeVisible()
  const list = page.getByRole('list', { name: 'Categories' })
  const slugs = () => list.locator('[data-category]').evaluateAll((items) => items.map((item) => item.getAttribute('data-category')))
  await expect.poll(slugs).toEqual(['portrait', 'wedding', 'drone'])

  // Create: the slug follows the name, and a malformed one is refused before sending.
  await page.getByRole('button', { name: 'New category' }).click()
  let dialog = page.getByRole('dialog', { name: 'New category' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Real estate')
  await expect(dialog.getByRole('textbox', { name: 'Slug' })).toHaveValue('real-estate')
  await dialog.getByRole('textbox', { name: 'Slug' }).fill('Real Estate')
  await dialog.getByRole('button', { name: 'Create category' }).click()
  await expect(dialog.getByText('Use lowercase letters and numbers, with single hyphens between words, such as real-estate.')).toBeVisible()
  expect(mock.writes).toEqual([])
  await dialog.getByRole('textbox', { name: 'Slug' }).fill('real-estate')
  await dialog.getByRole('button', { name: 'Create category' }).click()
  await expect(page.getByText('Real estate is created.')).toBeVisible()
  await expect.poll(slugs).toEqual(['portrait', 'wedding', 'drone', 'real-estate'])

  // Rename: the slug is shown, never editable.
  await list.locator('[data-category="real-estate"]').getByRole('button', { name: 'Rename Real estate' }).click()
  dialog = page.getByRole('dialog', { name: 'Rename Real estate' })
  await expect(dialog.getByText("The slug can't change: it's in every shared directory link.")).toBeVisible()
  await expect(dialog.getByRole('textbox')).toHaveCount(1)
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Property')
  await dialog.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByText('Renamed to Property.')).toBeVisible()

  // Reorder: saved at once, focus kept on the moved row's button.
  const up = list.locator('[data-category="real-estate"]').getByRole('button', { name: 'Move Property up' })
  await up.click()
  await expect.poll(slugs).toEqual(['portrait', 'wedding', 'real-estate', 'drone'])
  await expect(up).toBeFocused()

  // Deactivate one in use: confirmed, saying its photographers keep the tag.
  await list.locator('[data-category="wedding"]').getByRole('button', { name: 'Deactivate Wedding' }).click()
  dialog = page.getByRole('dialog', { name: 'Deactivate Wedding?' })
  await expect(dialog).toContainText('The 3 photographers who have it keep the tag')
  await dialog.getByRole('button', { name: 'Deactivate' }).click()
  await expect(list.locator('[data-category="wedding"]')).toContainText('Inactive')
  await expect(list.locator('[data-category="wedding"]')).toContainText('3 photographers')

  // Delete an unused one.
  await list.locator('[data-category="drone"]').getByRole('button', { name: 'Delete Drone' }).click()
  await page.getByRole('dialog', { name: 'Delete Drone?' }).getByRole('button', { name: 'Delete category' }).click()
  await expect(page.getByText('Drone is deleted.')).toBeVisible()
  await expect.poll(slugs).toEqual(['portrait', 'wedding', 'real-estate'])

  // A delete refused by a race says how many have it now, and Delete leaves the row.
  mock.deleteRace = true
  await list.locator('[data-category="real-estate"]').getByRole('button', { name: 'Delete Property' }).click()
  dialog = page.getByRole('dialog', { name: 'Delete Property?' })
  await dialog.getByRole('button', { name: 'Delete category' }).click()
  await expect(dialog.getByRole('alert')).toContainText("1 photographer now has this category, so it can't be deleted. Deactivate it instead to hide it.")
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(list.locator('[data-category="real-estate"]').getByRole('button', { name: 'Delete Property' })).toHaveCount(0)
  await expect.poll(slugs).toEqual(['portrait', 'wedding', 'real-estate'])

  expect(mock.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
    'POST /api/platform/categories',
    'PATCH /api/platform/categories/c13',
    'PUT /api/platform/categories/order',
    'PATCH /api/platform/categories/c2',
    'DELETE /api/platform/categories/c3',
    'DELETE /api/platform/categories/c13',
  ])
})

test('activity lists the entries as sentences and filters by action', async ({ page }) => {
  const mock = await mockApi(page)
  record(mock, 'category_created', { slug: 'real-estate', nameEn: 'Real estate', sortOrder: 3 })
  await page.goto('/platform/photographers')
  await platformNav(page).getByRole('link', { name: 'Activity' }).click()
  await expect(page).toHaveURL('/platform/activity')

  const list = page.getByRole('list', { name: 'Activity' })
  await expect(list.locator('[data-audit-entry]')).toHaveCount(3)
  await expect(list).toContainText('Created the category Real estate (real-estate)')
  await expect(list).toContainText('Marked a 45,000 RWF payout to Kigali Lens paid (ref TX-123)')
  await expect(list).toContainText('Changed the monthly price from 10,000 to 12,000 RWF')
  await expect(list.getByText('By admin@bookly.example').first()).toBeVisible()
  await expect(page.getByText('3 entries')).toBeVisible()

  await page.getByRole('combobox', { name: 'Action' }).selectOption('payout_paid')
  await expect(page).toHaveURL('/platform/activity?action=payout_paid')
  await expect(list.locator('[data-audit-entry]')).toHaveCount(1)
  await expect(list).toContainText('Marked a 45,000 RWF payout to Kigali Lens paid (ref TX-123)')

  // The entry links to the photographer, whose page links back filtered to them.
  await list.getByRole('link', { name: 'Kigali Lens' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Kigali Lens' })).toBeVisible()
  await page.getByRole('link', { name: 'See all activity for this photographer' }).click()
  await expect(page).toHaveURL(`/platform/activity?photographerId=${LENS_ID}`)
  await expect(page.getByText('Filtered to Kigali Lens')).toBeVisible()
  await expect(list.locator('[data-audit-entry]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Clear the photographer filter' }).click()
  await expect(page).toHaveURL('/platform/activity')
  await expect(list.locator('[data-audit-entry]')).toHaveCount(3)
})

test('an unknown photographer id shows not-found', async ({ page }) => {
  await mockApi(page)
  await page.goto(`/platform/photographers/${UNKNOWN_ID}`)
  await expect(page.getByRole('heading', { level: 1, name: "This photographer doesn't exist" })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to photographers' })).toHaveAttribute('href', '/platform/photographers')

  // A malformed id is the API's 400: not found as well.
  await page.goto('/platform/photographers/not-a-uuid')
  await expect(page.getByRole('heading', { level: 1, name: "This photographer doesn't exist" })).toBeVisible()
})
