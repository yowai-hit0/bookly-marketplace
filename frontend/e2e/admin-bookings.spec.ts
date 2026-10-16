import { type Page, expect, test } from '@playwright/test'

/**
 * The bookings list and one booking's lifecycle in Chromium (plan.md Task 19;
 * spec §3.6, §6.11, §6.16, §6.21). `/api/*` is answered here by a small
 * in-memory API that behaves like the real one: it filters the list by status,
 * moves a booking to the instant it is sent, and on a cancellation flags what
 * was collected for refund.
 *
 * The browser is in America/New_York, five hours behind Kigali. Every time on
 * screen -- the list, the detail page and the reschedule field -- must still be
 * Kigali wall time (spec §6.5), and the time the page sends back must still
 * carry `+02:00`.
 */

const NOW = new Date('2026-10-07T08:00:00.000Z')
const TOKEN = 'e2e.header.signature'
const EXPIRES_AT = '2026-10-07T16:00:00.000Z'
const MINUTE_MS = 60_000

/** 09:00 to 10:30 Kigali on Wednesday 6 January 2027. */
const STARTS_AT = '2027-01-06T07:00:00.000Z'

/** The external host's link, and the date NOW plus ninety days lands on (plan.md Task 21, spec A-7, A-8). */
const DELIVERY_LINK = 'https://photos.example-host.com/s/abc123'
const DEFAULT_EXPIRY = '2027-01-05'

test.use({ timezoneId: 'America/New_York' })

type Booking = Record<string, unknown> & { id: string; reference: string; status: string }
type Write = { method: string; path: string; body: unknown; authorization: string | null }

function booking(id: string, reference: string, status: string, startsAt: string, contactName: string): Booking {
  const starts = Date.parse(startsAt)
  return {
    id,
    reference,
    status,
    // Every fixture shoot is ahead of NOW, so the stage is the status's own (booking/stage.ts).
    stage: status === 'pending_payment' ? 'awaiting_payment' : status,
    locale: 'en',
    client: { id: 'cl1', fullName: contactName, email: 'aline@example.com', phone: '+250788000000', anonymized: false },
    contact: { name: contactName, email: 'aline@example.com', phone: '+250788000000' },
    service: { id: 's1', name: 'Portraits' },
    package: { id: 'p1', name: 'Standard', priceRwf: 40_000, durationMinutes: 90, photoCount: 25 },
    schedule: {
      startsAt,
      endsAt: new Date(starts + 90 * MINUTE_MS).toISOString(),
      bufferEndsAt: new Date(starts + 120 * MINUTE_MS).toISOString(),
      holdExpiresAt: null,
      originalStartsAt: null,
      rescheduledAt: null,
    },
    details: { locationText: 'Kigali Heights, KG 7 Ave', partySize: 3, specialRequests: null, consentAt: '2026-10-01T06:00:00.000Z' },
    addons: [],
    money: {
      bookingFeeRate: 0.4,
      bookingFeeRwf: 16_000,
      totals: { quotedTotalRwf: 40_000, grandTotalRwf: 40_000, collectedRwf: 20_000, refundDueRwf: 0, outstandingRwf: 20_000 },
    },
    payments: [
      {
        id: 'pay1',
        kind: 'booking_fee',
        provider: 'mtn_momo_direct',
        ourRef: 'a1b2c3d4',
        providerRef: '4100000123',
        method: 'momo_mtn',
        amountRwf: 20_000,
        status: 'succeeded',
        failureReason: null,
        initiatedAt: '2026-10-01T06:00:00.000Z',
        settledAt: '2026-10-01T06:05:00.000Z',
        refundedAt: null,
        refundReference: null,
        note: null,
        canRecordRefund: false,
      },
    ],
    lifecycle: { confirmedAt: '2026-10-01T06:05:00.000Z', completedAt: null, cancelledAt: null, cancellationReason: null },
    access: { hasLink: true, expiresAt: '2027-10-01T06:05:00.000Z', lastUsedAt: null },
    delivery: { url: null, expiresOn: null, sentAt: null, note: null },
    notes: [],
    messages: [],
    actions: { canReschedule: true, canCancel: true, canComplete: false, canMarkNoShow: false, canResendLink: true, canEditAddons: false, canRequestSessionFee: false, canEditDelivery: false, canSendDelivery: false },
  }
}

/** The list row the API derives from a booking. */
function row(entry: Booking) {
  const schedule = entry.schedule as { startsAt: string; endsAt: string }
  const totals = (entry.money as { totals: Record<string, number> }).totals
  return {
    id: entry.id,
    reference: entry.reference,
    status: entry.status,
    stage: entry.stage,
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    contactName: (entry.contact as { name: string }).name,
    contactEmail: (entry.contact as { email: string }).email,
    contactPhone: (entry.contact as { phone: string }).phone,
    serviceName: 'Portraits',
    packageName: 'Standard',
    grandTotalRwf: totals.grandTotalRwf,
    collectedRwf: totals.collectedRwf,
    outstandingRwf: totals.outstandingRwf,
    refundDueRwf: totals.refundDueRwf,
    hasRefundDue: totals.refundDueRwf > 0,
  }
}

/** The add-on Portraits sells after a shoot (plan.md Task 20). */
const PRINTS_ID = 'ad000001-0000-4000-8000-000000000001'

const CATALOGUE = {
  services: [
    {
      id: 's1',
      slug: 'portraits',
      nameEn: 'Portraits',
      nameFr: null,
      descriptionEn: null,
      descriptionFr: null,
      coverImageUrl: null,
      bookingFeeRateOverride: null,
      isActive: true,
      sortOrder: 0,
      packages: [],
      addons: [{ id: PRINTS_ID, serviceId: 's1', nameEn: 'Twenty prints', nameFr: null, priceRwf: 15_000, isActive: true, sortOrder: 0 }],
    },
  ],
  sharedAddons: [],
}

/**
 * Answers `/api/*` in the page; returns the writes as they arrive.
 *
 * `completed` opens the post-shoot half of the screen (plan.md Task 20): the
 * add-on editor and the session-fee request, which only a completed booking has.
 */
async function mockApi(page: Page, options: { completed?: boolean } = {}) {
  const bookings: Booking[] = [
    booking('b1', 'BKY-2701-00042', 'confirmed', STARTS_AT, 'Aline Uwase'),
    booking('b2', 'BKY-2701-00043', 'cancelled_by_client', '2027-01-05T12:00:00.000Z', 'Eric Habimana'),
  ]
  if (options.completed === true) {
    const first = bookings[0] as Booking
    first.status = 'completed'
    first.stage = 'completed'
    first.lifecycle = { confirmedAt: '2026-10-01T06:05:00.000Z', completedAt: NOW.toISOString(), cancelledAt: null, cancellationReason: null }
    first.actions = {
      canReschedule: false,
      canCancel: false,
      canComplete: false,
      canMarkNoShow: false,
      canResendLink: true,
      canEditAddons: true,
      canRequestSessionFee: true,
    canEditDelivery: true,
    canSendDelivery: false,
    }
  }
  const writes: Write[] = []

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const method = request.method()
      const url = new URL(request.url())
      const path = url.pathname
      const find = (id: string) => bookings.find((entry) => entry.id === id)

      if (method === 'POST' && path === '/api/admin/auth/login') {
        await route.fulfill({
          json: { admin: { id: 'a1', email: 'photographer@bookly.example' }, token: TOKEN, tokenType: 'Bearer', expiresAt: EXPIRES_AT },
        })
        return
      }
      if (method === 'GET' && path === '/api/admin/calendar') {
        await route.fulfill({ json: { bookings: [], blocks: [] } })
        return
      }
      if (method === 'GET' && path === '/api/admin/catalogue') {
        await route.fulfill({ json: CATALOGUE })
        return
      }
      if (method === 'GET' && path === '/api/admin/bookings') {
        // The list filters by display stage since 2026-09-25.
        const stages = url.searchParams.getAll('stage')
        const search = url.searchParams.get('search') ?? ''
        const matching = bookings
          .filter((entry) => stages.length === 0 || stages.includes(String(entry.stage)))
          .filter((entry) => search === '' || entry.reference.toLowerCase().includes(search.toLowerCase()))
        await route.fulfill({ json: { bookings: matching.map(row), total: matching.length, page: 1, pageSize: 25, pageCount: 1 } })
        return
      }

      const detail = /^\/api\/admin\/bookings\/([^/]+)$/.exec(path)?.[1]
      if (method === 'GET' && detail !== undefined) {
        const entry = find(detail)
        await route.fulfill(entry === undefined ? { status: 404, json: { error: 'not_found' } } : { json: { booking: entry } })
        return
      }

      const action = /^\/api\/admin\/bookings\/([^/]+)\/([a-z-]+)$/.exec(path)
      const body = request.postDataJSON() as Record<string, unknown> | null
      writes.push({ method, path, body, authorization: await request.headerValue('authorization') })
      const entry = action === null ? undefined : find(action[1] ?? '')

      if (entry !== undefined && action?.[2] === 'reschedule') {
        const starts = Date.parse(String(body?.startsAt))
        const previous = (entry.schedule as { startsAt: string }).startsAt
        entry.schedule = {
          startsAt: new Date(starts).toISOString(),
          endsAt: new Date(starts + 90 * MINUTE_MS).toISOString(),
          bufferEndsAt: new Date(starts + 120 * MINUTE_MS).toISOString(),
          holdExpiresAt: null,
          originalStartsAt: previous,
          rescheduledAt: NOW.toISOString(),
        }
        await route.fulfill({ json: { booking: entry } })
        return
      }
      if (entry !== undefined && action?.[2] === 'cancel') {
        entry.status = 'cancelled_by_admin'
        entry.stage = 'cancelled_by_admin'
        entry.lifecycle = { confirmedAt: '2026-10-01T06:05:00.000Z', completedAt: null, cancelledAt: NOW.toISOString(), cancellationReason: String(body?.reason ?? '') }
        entry.payments = [{ ...(entry.payments as Record<string, unknown>[])[0], status: 'refund_due', canRecordRefund: true }]
        entry.money = {
          bookingFeeRate: 0.4,
          bookingFeeRwf: 16_000,
          totals: { quotedTotalRwf: 40_000, grandTotalRwf: 40_000, collectedRwf: 0, refundDueRwf: 20_000, outstandingRwf: 0 },
        }
        entry.actions = { canReschedule: false, canCancel: false, canComplete: false, canMarkNoShow: false, canResendLink: true, canEditAddons: false, canRequestSessionFee: false, canEditDelivery: false, canSendDelivery: false }
        await route.fulfill({ json: { booking: entry } })
        return
      }

      // Task 20: a post-shoot add-on, priced from the catalogue by the API.
      if (entry !== undefined && action?.[2] === 'addons') {
        const chosen = CATALOGUE.services[0]?.addons.find((candidate) => candidate.id === String(body?.addonId))
        const quantity = Number(body?.quantity ?? 1)
        const amountRwf = (chosen?.priceRwf ?? 0) * quantity
        const totals = (entry.money as { totals: Record<string, number> }).totals
        entry.addons = [
          ...(entry.addons as Record<string, unknown>[]),
          {
            id: `ba${(entry.addons as unknown[]).length + 1}`,
            name: chosen?.nameEn ?? 'Unknown',
            unitPriceRwf: chosen?.priceRwf ?? 0,
            quantity,
            amountRwf,
            stage: 'post_shoot',
            canRemove: true,
          },
        ]
        entry.money = {
          bookingFeeRate: 0.4,
          bookingFeeRwf: 16_000,
          totals: { ...totals, grandTotalRwf: totals.grandTotalRwf + amountRwf, outstandingRwf: totals.outstandingRwf + amountRwf },
        }
        await route.fulfill({ json: { booking: entry } })
        return
      }
      // Task 20: the request is the payment row, frozen at what is outstanding now.
      if (entry !== undefined && action?.[2] === 'session-fee') {
        const totals = (entry.money as { totals: Record<string, number> }).totals
        entry.payments = [
          ...(entry.payments as Record<string, unknown>[]),
          {
            id: 'pay2',
            kind: 'session_fee',
            provider: 'mtn_momo_direct',
            ourRef: 'f00dcafe-0000-4000-8000-000000000002',
            providerRef: null,
            method: null,
            amountRwf: totals.outstandingRwf,
            status: 'initiated',
            failureReason: null,
            initiatedAt: NOW.toISOString(),
            settledAt: null,
            refundedAt: null,
            refundReference: null,
            note: null,
            canRecordRefund: false,
          },
        ]
        await route.fulfill({ json: { booking: entry } })
        return
      }

      // Task 21: the link on his own host, and the email that hands it over.
      // `/delivery/send` has a slash in it, so it is matched on its own.
      const delivery = /^\/api\/admin\/bookings\/([^/]+)\/delivery(\/send)?$/.exec(path)
      const deliverable = delivery === null ? undefined : find(delivery[1] ?? '')
      if (deliverable !== undefined && method === 'PUT') {
        const current = deliverable.delivery as { sentAt: string | null }
        deliverable.delivery = {
          url: String(body?.url ?? ''),
          // Omitted, the API dates it: NOW plus ninety days (spec A-8).
          expiresOn: body?.expiresOn === undefined ? DEFAULT_EXPIRY : String(body.expiresOn),
          sentAt: current.sentAt,
          note: body?.note === undefined ? null : (body.note as string | null),
        }
        deliverable.actions = { ...(deliverable.actions as Record<string, unknown>), canSendDelivery: true }
        await route.fulfill({ json: { booking: deliverable } })
        return
      }
      if (deliverable !== undefined && method === 'POST' && delivery?.[2] !== undefined) {
        deliverable.delivery = { ...(deliverable.delivery as Record<string, unknown>), sentAt: NOW.toISOString() }
        await route.fulfill({ json: { booking: deliverable } })
        return
      }

      await route.fulfill({ status: 404, json: { error: 'not_found' } })
    },
  )
  return writes
}

/** Signs in and lands on the admin area, session in sessionStorage. */
async function signIn(page: Page) {
  await page.goto('/admin/login')
  await page.getByLabel('Email').fill('photographer@bookly.example')
  await page.getByLabel('Password').fill('dev-only-change-me-123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('navigation', { name: 'Admin' }).waitFor()
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW)
})

test('signs in, filters the list, moves a booking and then cancels it', async ({ page }) => {
  const writes = await mockApi(page)

  // The browser really is five hours behind Kigali, or this proves nothing.
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('America/New_York')

  await page.goto('/admin/login')
  await page.getByLabel('Email').fill('photographer@bookly.example')
  await page.getByLabel('Password').fill('dev-only-change-me-123')
  await page.getByRole('button', { name: 'Sign in' }).click()

  const nav = page.getByRole('navigation', { name: 'Admin' })
  await nav.getByRole('link', { name: 'Bookings' }).click()
  await expect(page).toHaveURL(/\/admin\/bookings$/)

  // Both bookings, each in Kigali wall time rather than the browser's own.
  const rows = page.getByRole('table').getByRole('row')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(1)).toContainText('Wednesday, 6 January 2027')
  await expect(rows.nth(1)).toContainText('09:00 – 10:30')

  // The status filter is a dropdown of checkboxes (2026-09-27).
  await page.getByRole('button', { name: 'Status: All' }).click()
  await page.getByRole('checkbox', { name: 'Confirmed' }).click()
  await page.keyboard.press('Escape')

  await expect(page).toHaveURL(/\?stage=confirmed$/)
  await expect(page.getByRole('button', { name: 'Status: 1 selected' })).toBeVisible()
  await expect(rows).toHaveCount(2)
  await expect(page.getByRole('link', { name: 'BKY-2701-00042' })).toBeVisible()

  await page.getByRole('link', { name: 'BKY-2701-00042' }).click()

  await expect(page).toHaveURL(/\/admin\/bookings\/b1$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('BKY-2701-00042')
  const shoot = page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'The shoot' }) })
  await expect(shoot).toContainText('Wednesday, 6 January 2027, 09:00 – 10:30')

  // The field opens on Kigali wall time, not on the browser's 02:00.
  // Each form opens in a dialog from its button (2026-09-27); inside it, the submit has the same name.
  await page.getByRole('button', { name: 'Move booking' }).click()
  const newStart = page.getByLabel('New start (Kigali time)')
  await expect(newStart).toHaveValue('2027-01-06T09:00')
  await newStart.fill('2027-01-07T14:30')
  await page.getByRole('button', { name: 'Move booking' }).click()

  await expect(shoot).toContainText('Thursday, 7 January 2027, 14:30 – 16:00')
  await expect(shoot).toContainText('Originally booked for')
  expect(writes[0]).toEqual({
    method: 'POST',
    path: '/api/admin/bookings/b1/reschedule',
    body: { startsAt: '2027-01-07T14:30:00+02:00' },
    authorization: `Bearer ${TOKEN}`,
  })

  await page.getByRole('button', { name: 'Cancel this booking' }).click()
  await expect(page.getByText(/Cancelling releases the time and tells the client/)).toBeVisible()
  await page.getByLabel('Reason (shown to the client)').fill('Studio flooded.')
  await page.getByRole('button', { name: 'Cancel and refund' }).click()

  await expect(page.getByText('Cancelled by you')).toBeVisible()
  const money = page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'Money' }) })
  await expect(money).toContainText('To refund20,000 RWF')
  await expect(page.getByLabel('Refund reference')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Move booking' })).toHaveCount(0)
  expect(writes[1]).toMatchObject({ method: 'POST', path: '/api/admin/bookings/b1/cancel', body: { reason: 'Studio flooded.' } })

  // And the list shows the money owed back.
  await page.getByRole('link', { name: 'All bookings' }).click()
  await expect(page.getByText('20,000 RWF to refund')).toBeVisible()
})

/**
 * The post-shoot sequence (plan.md Task 20; spec §3.5 steps 2-3): the shoot is
 * done, an add-on goes on, the total and what is outstanding both rise by it,
 * and the session fee is requested for that new figure.
 */
test('adds a post-shoot add-on to a completed booking and requests the session fee', async ({ page }) => {
  const writes = await mockApi(page, { completed: true })
  await signIn(page)

  await page.goto('/admin/bookings/b1')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('BKY-2701-00042')

  const money = page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'Money' }) })
  await expect(money).toContainText('Total40,000 RWF')
  await expect(money).toContainText('Still to pay20,000 RWF')

  // The picker offers what the catalogue sells for this service.
  await page.getByRole('button', { name: 'Add an add-on' }).click()
  const picker = page.getByLabel('Add-on', { exact: true })
  await expect(picker).toBeVisible()
  await picker.selectOption(PRINTS_ID)
  await page.getByRole('button', { name: 'Add to the booking' }).click()

  await expect(money).toContainText('Twenty prints (added after the shoot)15,000 RWF')
  await expect(money).toContainText('Total55,000 RWF')
  await expect(money).toContainText('Still to pay35,000 RWF')
  expect(writes.at(-1)).toMatchObject({
    method: 'POST',
    path: '/api/admin/bookings/b1/addons',
    body: { addonId: PRINTS_ID, quantity: 1 },
  })

  // And the request is made for the figure the add-on left behind.
  await page.getByRole('button', { name: 'Request 35,000 RWF session fee' }).click()

  const payments = page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'Payments' }) })
  await expect(payments).toContainText('Session fee')
  await expect(payments).toContainText('35,000 RWF')
  await expect(payments).toContainText('Started')
  expect(writes.at(-1)).toMatchObject({ method: 'POST', path: '/api/admin/bookings/b1/session-fee', body: {} })
})

/**
 * The delivery (plan.md Task 21; spec §3.5 steps 5-6, §6.20): the link on his
 * own host goes on the booking, and sending it is a second, separate act --
 * which the screen then offers again, for the email that never arrived.
 */
test('saves the delivery link on a completed booking and sends the photos', async ({ page }) => {
  const writes = await mockApi(page, { completed: true })
  await signIn(page)

  await page.goto('/admin/bookings/b1')
  const photos = page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'The photos' }) })
  await expect(photos).toContainText('Nothing has been sent to the client yet.')
  // Nothing to send until a link is saved.
  await expect(page.getByRole('button', { name: 'Send the photos' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Add the photo link' }).click()
  await page.getByLabel('Link to the photos').fill(DELIVERY_LINK)
  await page.getByLabel('A line for the client (optional)').fill('The raw files are in the second folder.')
  await page.getByRole('button', { name: 'Save the link' }).click()

  await expect(page.getByRole('button', { name: 'Send the photos' })).toBeVisible()
  expect(writes.at(-1)).toMatchObject({
    method: 'PUT',
    path: '/api/admin/bookings/b1/delivery',
    body: { url: DELIVERY_LINK, note: 'The raw files are in the second folder.' },
    authorization: `Bearer ${TOKEN}`,
  })
  // The date was left blank, so the API dated it rather than the browser.
  expect(writes.at(-1)?.body).not.toHaveProperty('expiresOn')

  await page.getByRole('button', { name: 'Send the photos' }).click()
  // The confirm step (2026-09-25): the address is the booking's, and unchanged it sends no recipient.
  await expect(page.getByLabel('Email address')).toHaveValue('aline@example.com')
  await page.getByRole('button', { name: 'Send now' }).click()

  // NOW is 08:00Z, which is 10:00 in Kigali, though the browser is in New York.
  await expect(photos).toContainText('Last sent')
  await expect(photos).toContainText('7 Oct 2026, 10:00')
  await expect(page.getByRole('button', { name: 'Send again' })).toBeVisible()
  expect(writes.at(-1)).toMatchObject({ method: 'POST', path: '/api/admin/bookings/b1/delivery/send', body: {} })

  // And nothing anywhere claims to know how often the photos were fetched.
  await expect(photos).not.toContainText(/downloaded|downloads/i)
})
