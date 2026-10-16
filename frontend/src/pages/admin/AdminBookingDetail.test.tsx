import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { AdminBooking, AdminPayment } from '@/admin/bookings'
import type { AdminAddon, CatalogueData, CatalogueService } from '@/admin/catalogue'
import { readSession, saveSession } from '@/admin/session'
import { routes } from '@/routes'

/**
 * One booking and everything the photographer does to it (plan.md Task 19;
 * spec §3.6, §6.11, §6.12, §6.16, §6.21), rendered through the real routes
 * with `fetch` stubbed.
 *
 * What is proven: every section renders from what the API sent -- the shoot,
 * the client, the money `bookingTotals()` derived, each payment attempt and
 * every message the booking has sent; the buttons follow the API's own
 * `actions` flags rather than guessing; the reschedule field is Kigali wall
 * time whatever zone the browser is in (spec §6.5) and submits it with the
 * `+02:00` that makes it unambiguous; cancelling asks twice and carries the
 * reason; and every action re-renders from the booking the API answered with.
 *
 * A refusal is the interesting case. A 409 shows the mapped words -- "that time
 * is already taken", not "something went wrong" -- and the screen catches up
 * with whatever changed underneath it instead of staying stale.
 */

const SESSION = { token: 'header.payload.signature', expiresAt: '2999-01-01T00:00:00.000Z' }
const BOOKING_ID = 'b1a7c2d4-0000-4000-8000-000000000001'
const PAYMENT_ID = 'c2b8d3e5-0000-4000-8000-000000000002'
const DETAIL_PATH = `/admin/bookings/${BOOKING_ID}`
const DETAIL_API = `/api/admin/bookings/${BOOKING_ID}`

const BOOKING_FEE: AdminPayment = {
  id: PAYMENT_ID,
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
}

const BOOKING: AdminBooking = {
  id: BOOKING_ID,
  reference: 'BKY-2701-00042',
  status: 'confirmed',
  stage: 'confirmed',
  locale: 'en',
  client: { id: 'cl1', fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000', anonymized: false },
  contact: { name: 'Aline Uwase', email: 'aline@example.com', phone: '+250788000000' },
  service: { id: 's1', name: 'Portraits' },
  package: { id: 'p1', name: 'Standard', priceRwf: 40_000, durationMinutes: 90, photoCount: 25 },
  schedule: {
    // 09:00 to 10:30 Kigali on Wednesday 6 January 2027.
    startsAt: '2027-01-06T07:00:00.000Z',
    endsAt: '2027-01-06T08:30:00.000Z',
    bufferEndsAt: '2027-01-06T09:00:00.000Z',
    holdExpiresAt: null,
    originalStartsAt: null,
    rescheduledAt: null,
  },
  details: {
    locationText: 'Kigali Heights, KG 7 Ave',
    partySize: 3,
    specialRequests: 'Golden hour if possible.',
    consentAt: '2026-10-01T06:00:00.000Z',
  },
  addons: [{ id: 'ba1', name: 'Extra hour', unitPriceRwf: 10_000, quantity: 1, amountRwf: 10_000, stage: 'at_booking', canRemove: false }],
  money: {
    bookingFeeRate: 0.4,
    bookingFeeRwf: 20_000,
    totals: { quotedTotalRwf: 50_000, grandTotalRwf: 50_000, collectedRwf: 20_000, refundDueRwf: 0, outstandingRwf: 30_000 },
  },
  payments: [BOOKING_FEE],
  lifecycle: { confirmedAt: '2026-10-01T06:05:00.000Z', completedAt: null, cancelledAt: null, cancellationReason: null },
  access: { hasLink: true, expiresAt: '2027-10-01T06:05:00.000Z', lastUsedAt: null },
  delivery: { url: null, expiresOn: null, sentAt: null, note: null },
  notes: [],
  messages: [
    {
      id: 'm1',
      kind: 'email',
      template: 'booking_confirmation',
      recipient: 'aline@example.com',
      status: 'done',
      attempts: 1,
      lastError: null,
      createdAt: '2026-10-01T06:05:00.000Z',
      completedAt: '2026-10-01T06:05:30.000Z',
    },
  ],
  actions: { canReschedule: true, canCancel: true, canComplete: false, canMarkNoShow: false, canResendLink: true, canEditAddons: false, canRequestSessionFee: false, canEditDelivery: false, canSendDelivery: false },
}

/**
 * The same booking with a shoot that has begun, paid in full: every action is
 * open. "Completed" means paid (2026-09-27), so `canComplete` needs nothing owed.
 */
const STARTED: AdminBooking = {
  ...BOOKING,
  stage: 'needs_review',
  money: { ...BOOKING.money, totals: { ...BOOKING.money.totals, collectedRwf: 50_000, outstandingRwf: 0 } },
  actions: { canReschedule: true, canCancel: true, canComplete: true, canMarkNoShow: true, canResendLink: true, canEditAddons: true, canRequestSessionFee: false, canEditDelivery: false, canSendDelivery: false },
}

const CANCELLED: AdminBooking = {
  ...BOOKING,
  status: 'cancelled_by_admin',
  stage: 'cancelled_by_admin',
  lifecycle: { ...BOOKING.lifecycle, cancelledAt: '2026-10-02T09:00:00.000Z', cancellationReason: 'Studio flooded.' },
  money: { ...BOOKING.money, totals: { ...BOOKING.money.totals, collectedRwf: 0, refundDueRwf: 20_000, outstandingRwf: 0 } },
  payments: [{ ...BOOKING_FEE, status: 'refund_due', canRecordRefund: true }],
  actions: { canReschedule: false, canCancel: false, canComplete: false, canMarkNoShow: false, canResendLink: true, canEditAddons: false, canRequestSessionFee: false, canEditDelivery: false, canSendDelivery: false },
}

// --- The catalogue the post-shoot picker loads (plan.md Task 20) --------------------

const OWN_ADDON_ID = 'ad000001-0000-4000-8000-000000000001'
const SHARED_ADDON_ID = 'ad000002-0000-4000-8000-000000000002'
const RETIRED_ADDON_ID = 'ad000003-0000-4000-8000-000000000003'
const OTHER_SERVICE_ADDON_ID = 'ad000004-0000-4000-8000-000000000004'
const RETIRED_SHARED_ADDON_ID = 'ad000005-0000-4000-8000-000000000005'

function addon(id: string, serviceId: string | null, nameEn: string, priceRwf: number, isActive = true): AdminAddon {
  return { id, serviceId, nameEn, nameFr: null, priceRwf, isActive, sortOrder: 0 }
}

function service(id: string, slug: string, nameEn: string, addons: AdminAddon[]): CatalogueService {
  return {
    id,
    slug,
    nameEn,
    nameFr: null,
    descriptionEn: null,
    descriptionFr: null,
    coverImageUrl: null,
    bookingFeeRateOverride: null,
    isActive: true,
    sortOrder: 0,
    packages: [],
    addons,
  }
}

/** Portraits sells two add-ons and has retired a third; Weddings sells its own. */
const CATALOGUE: CatalogueData = {
  services: [
    service('s1', 'portraits', 'Portraits', [
      addon(OWN_ADDON_ID, 's1', 'Twenty prints', 15_000),
      addon(RETIRED_ADDON_ID, 's1', 'Polaroid pack', 8_000, false),
    ]),
    service('s2', 'weddings', 'Weddings', [addon(OTHER_SERVICE_ADDON_ID, 's2', 'Second shooter', 20_000)]),
  ],
  sharedAddons: [
    addon(SHARED_ADDON_ID, null, 'Rush edit', 5_000),
    addon(RETIRED_SHARED_ADDON_ID, null, 'Photo book', 30_000, false),
  ],
}

type Sent = { method: string; url: string; body: unknown }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * A `fetch` for the admin API: GET answers whatever `current.value` holds, and
 * every POST goes to `onPost`, which by default answers the same booking back.
 */
function stubApi(
  options: {
    booking?: AdminBooking
    onPost?: (call: Sent, current: { value: AdminBooking }) => Response
    /** The catalogue the add-on picker loads (plan.md Task 20); null makes that load fail. */
    catalogue?: CatalogueData | null
  } = {},
) {
  const current = { value: options.booking ?? BOOKING }
  const sent: Sent[] = []
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Sent = {
      method: init.method ?? 'GET',
      url: String(input),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    }
    sent.push(call)
    if (call.url === '/api/admin/catalogue') {
      const catalogue = options.catalogue === undefined ? CATALOGUE : options.catalogue
      return catalogue === null ? json({ error: 'internal_error' }, 500) : json(catalogue)
    }
    if (call.method === 'GET') return json({ booking: current.value })
    return options.onPost === undefined ? json({ booking: current.value }) : options.onPost(call, current)
  })
  vi.stubGlobal('fetch', mock)
  return { sent, current }
}

function writes(sent: Sent[]): Sent[] {
  return sent.filter((call) => call.method !== 'GET')
}

function gets(sent: Sent[]): Sent[] {
  return sent.filter((call) => call.method === 'GET')
}

function signIn() {
  saveSession(SESSION)
}

function renderAt(path = DETAIL_PATH) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

/** Renders the page and waits for the booking to arrive. */
async function renderLoaded(path = DETAIL_PATH) {
  const router = renderAt(path)
  await screen.findByRole('heading', { level: 1 })
  return router
}

/**
 * Every create and edit form on the page opens in a dialog from its button
 * (admin console fixes, item 1, 2026-09-27). While one is open the page behind
 * it is hidden from assistive tech, so a test reads the page before opening one.
 */
async function openDialog(opener: string): Promise<HTMLElement> {
  await user().click(screen.getByRole('button', { name: opener }))
  return screen.getByRole('dialog')
}

function section(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name: title })
  const element = heading.closest('section')
  if (element === null) throw new Error(`No section titled ${title}`)
  return element
}

beforeEach(() => {
  signIn()
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

// --- Rendering ------------------------------------------------------------------------

describe('the booking', () => {
  it('heads the page with the reference and the status in words', async () => {
    stubApi()
    await renderLoaded()

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('BKY-2701-00042')
    expect(screen.getByRole('link', { name: /All bookings/ })).toHaveAttribute('href', '/admin/bookings')
    expect(document.body).toHaveTextContent('Confirmed')
  })

  it('shows the shoot in Kigali wall time, with the location and what was asked for', async () => {
    stubApi()
    await renderLoaded()

    const shoot = section('The shoot')
    expect(shoot).toHaveTextContent('Wednesday, 6 January 2027, 09:00 – 10:30')
    expect(shoot).toHaveTextContent('Portraits, Standard')
    expect(shoot).toHaveTextContent('Kigali Heights, KG 7 Ave')
    expect(shoot).toHaveTextContent('Number of people3')
    expect(shoot).toHaveTextContent('Golden hour if possible.')
    expect(shoot).not.toHaveTextContent('Originally booked for')
    expect(shoot).not.toHaveTextContent('Reason given')
  })

  it('shows where the booking was moved from once it has been moved', async () => {
    stubApi({
      booking: {
        ...BOOKING,
        schedule: { ...BOOKING.schedule, originalStartsAt: '2027-01-04T06:00:00.000Z', rescheduledAt: '2026-10-02T09:00:00.000Z' },
      },
    })
    await renderLoaded()

    const shoot = section('The shoot')
    expect(shoot).toHaveTextContent('Originally booked for')
    expect(shoot).toHaveTextContent('4 Jan 2027, 08:00')
    expect(shoot).toHaveTextContent('Last moved')
  })

  it('shows the reason when the booking was cancelled', async () => {
    stubApi({ booking: CANCELLED })
    await renderLoaded()

    expect(section('The shoot')).toHaveTextContent('Reason givenStudio flooded.')
  })

  it('shows the client and whether their link is live', async () => {
    stubApi()
    await renderLoaded()

    const client = section('Client')
    expect(client).toHaveTextContent('Aline Uwase')
    expect(client).toHaveTextContent('aline@example.com')
    expect(client).toHaveTextContent('+250788000000')
    expect(client).toHaveTextContent(/Live until/)
  })

  it('says when no link has been issued', async () => {
    stubApi({ booking: { ...BOOKING, access: { hasLink: false, expiresAt: null, lastUsedAt: null } } })
    await renderLoaded()

    expect(section('Client')).toHaveTextContent('Not issued yet')
  })

  it('shows the money the API derived, line by line', async () => {
    stubApi()
    await renderLoaded()

    const money = section('Money')
    expect(money).toHaveTextContent('Standard40,000 RWF')
    expect(money).toHaveTextContent('Extra hour10,000 RWF')
    expect(money).toHaveTextContent('Total50,000 RWF')
    expect(money).toHaveTextContent('Collected20,000 RWF')
    expect(money).toHaveTextContent('Still to pay30,000 RWF')
    expect(money).not.toHaveTextContent('To refund')
  })

  it('shows what is owed back once there is any', async () => {
    stubApi({ booking: CANCELLED })
    await renderLoaded()

    expect(section('Money')).toHaveTextContent('To refund20,000 RWF')
    expect(section('Money')).toHaveTextContent('Still to pay0 RWF')
  })

  it('marks a post-shoot add-on as added after the shoot', async () => {
    stubApi({
      booking: {
        ...BOOKING,
        addons: [
          ...BOOKING.addons,
          { id: 'ba2', name: 'Rush edit', unitPriceRwf: 15_000, quantity: 1, amountRwf: 15_000, stage: 'post_shoot', canRemove: false },
        ],
      },
    })
    await renderLoaded()

    expect(section('Money')).toHaveTextContent('Rush edit (added after the shoot)15,000 RWF')
  })

  it('lists every payment attempt with its references', async () => {
    stubApi()
    await renderLoaded()

    const payments = section('Payments')
    expect(payments).toHaveTextContent('Booking fee')
    expect(payments).toHaveTextContent('20,000 RWF')
    expect(payments).toHaveTextContent('Paid')
    expect(payments).toHaveTextContent('mtn_momo_direct')
    expect(payments).toHaveTextContent('a1b2c3d4')
    expect(payments).toHaveTextContent('4100000123')
    expect(within(payments).queryByLabelText('Refund reference')).not.toBeInTheDocument()
  })

  it('says so when there are no payments and no messages yet', async () => {
    stubApi({ booking: { ...BOOKING, payments: [], messages: [] } })
    await renderLoaded()

    expect(section('Payments')).toHaveTextContent('No payments yet.')
    expect(section('Messages sent')).toHaveTextContent('Nothing sent yet.')
  })

  it('lists the messages the booking has sent, named in words', async () => {
    stubApi()
    await renderLoaded()

    const messages = section('Messages sent')
    expect(messages).toHaveTextContent('Booking confirmation')
    expect(messages).toHaveTextContent('Sent')
    expect(messages).toHaveTextContent('1 Oct 2026, 08:05')
  })

  it('shows a message that failed, with the error', async () => {
    stubApi({
      booking: {
        ...BOOKING,
        messages: [{ ...BOOKING.messages[0], id: 'm2', status: 'failed', attempts: 8, lastError: 'SMTP 550' } as AdminBooking['messages'][number]],
      },
    })
    await renderLoaded()

    expect(section('Messages sent')).toHaveTextContent('Failed · SMTP 550')
  })
})

// --- Loading and failing --------------------------------------------------------------

describe('before the booking arrives', () => {
  it('says it is loading', async () => {
    stubApi()
    renderAt()

    expect(await screen.findByRole('status')).toHaveTextContent(/Loading/)
  })

  it('says the booking no longer exists on a 404', async () => {
    const mock = vi.fn(async () => json({ error: 'not_found' }, 404))
    vi.stubGlobal('fetch', mock)
    renderAt()

    expect(await screen.findByRole('heading', { level: 1, name: 'This booking no longer exists' })).toBeInTheDocument()
  })

  /**
   * FAILING, and left failing deliberately: `AdminBookingDetail.tsx:93` tests
   * `state === 'missing' || booking === null` before `state === 'failed'` at
   * line 100. A load that fails for any reason other than 404 leaves `booking`
   * null, so it takes the first branch and the photographer is told the booking
   * no longer exists -- when the API merely 500ed, or the connection dropped.
   * The `admin:booking.loadFailed` copy is unreachable on a first load.
   */
  it('shows an error on anything else, rather than claiming the booking is gone', async () => {
    const mock = vi.fn(async () => json({ error: 'internal_error' }, 500))
    vi.stubGlobal('fetch', mock)
    renderAt()

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load this booking.')
    expect(screen.queryByRole('heading', { name: 'This booking no longer exists' })).not.toBeInTheDocument()
  })

  it('sends him to sign in on a 401 and forgets the token', async () => {
    const mock = vi.fn(async () => json({ error: 'unauthenticated' }, 401))
    vi.stubGlobal('fetch', mock)
    renderAt()

    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument()
    expect(readSession()).toBeNull()
  })
})

// --- What the actions flags allow ------------------------------------------------------

describe('the buttons follow the API’s actions flags', () => {
  it('offers reschedule, cancel and a new link on a confirmed booking before its shoot', async () => {
    stubApi()
    await renderLoaded()

    expect(screen.getByRole('button', { name: 'Move booking' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel this booking' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send a new booking link' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark completed' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark no-show' })).not.toBeInTheDocument()
  })

  it('offers completed and no-show once the shoot has begun', async () => {
    stubApi({ booking: STARTED })
    await renderLoaded()

    expect(screen.getByRole('button', { name: 'Mark completed' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark no-show' })).toBeInTheDocument()
  })

  it('offers nothing but a new link once the booking is cancelled', async () => {
    stubApi({ booking: CANCELLED })
    await renderLoaded()

    for (const name of ['Move booking', 'Cancel this booking', 'Mark completed', 'Mark no-show']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Send a new booking link' })).toBeInTheDocument()
  })

  it('offers no link at all when the booking never had one', async () => {
    stubApi({ booking: { ...BOOKING, actions: { ...BOOKING.actions, canResendLink: false } } })
    await renderLoaded()

    expect(screen.queryByRole('button', { name: 'Send a new booking link' })).not.toBeInTheDocument()
  })
})

// --- Rescheduling ----------------------------------------------------------------------

describe('the reschedule field', () => {
  it('opens on the booking’s own Kigali wall time', async () => {
    stubApi()
    await renderLoaded()
    await openDialog('Move booking')

    expect(screen.getByLabelText('New start (Kigali time)')).toHaveValue('2027-01-06T09:00')
  })

  it('submits the chosen time with Kigali’s offset, so the API cannot read it as anything else', async () => {
    const { sent } = stubApi()
    await renderLoaded()

    await openDialog('Move booking')
    fireEvent.change(screen.getByLabelText('New start (Kigali time)'), { target: { value: '2027-01-07T14:30' } })
    await user().click(screen.getByRole('button', { name: 'Move booking' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]).toMatchObject({
      method: 'POST',
      url: `${DETAIL_API}/reschedule`,
      body: { startsAt: '2027-01-07T14:30:00+02:00' },
    })
  })

  it('re-renders from the booking the move answered with', async () => {
    const moved: AdminBooking = {
      ...BOOKING,
      schedule: {
        ...BOOKING.schedule,
        startsAt: '2027-01-07T12:30:00.000Z',
        endsAt: '2027-01-07T14:00:00.000Z',
        originalStartsAt: '2027-01-06T07:00:00.000Z',
        rescheduledAt: '2026-10-02T09:00:00.000Z',
      },
    }
    stubApi({ onPost: (_call, current) => ((current.value = moved), json({ booking: moved })) })
    await renderLoaded()

    await openDialog('Move booking')
    fireEvent.change(screen.getByLabelText('New start (Kigali time)'), { target: { value: '2027-01-07T14:30' } })
    await user().click(screen.getByRole('button', { name: 'Move booking' }))

    await waitFor(() => expect(section('The shoot')).toHaveTextContent('Thursday, 7 January 2027, 14:30 – 16:00'))
    expect(section('The shoot')).toHaveTextContent('Originally booked for')
  })

  it('does not submit an empty field', async () => {
    const { sent } = stubApi()
    await renderLoaded()

    await openDialog('Move booking')
    fireEvent.change(screen.getByLabelText('New start (Kigali time)'), { target: { value: '' } })
    await user().click(screen.getByRole('button', { name: 'Move booking' }))

    expect(writes(sent)).toEqual([])
  })
})

/**
 * Kigali is UTC+2 with no DST, and the field is Kigali wall time whatever the
 * browser thinks the time is (spec §6.5). Proven here against a browser five
 * hours behind Kigali; proven in Chromium with a real emulated zone in
 * `e2e/admin-bookings.spec.ts`.
 */
describe('with the browser in America/New_York', () => {
  const originalTimezone = process.env.TZ

  beforeAll(() => {
    process.env.TZ = 'America/New_York'
  })

  afterAll(() => {
    process.env.TZ = originalTimezone
  })

  it('still opens on Kigali wall time and still submits +02:00', async () => {
    // The environment really is five hours behind UTC, or this proves nothing.
    expect(new Date('2027-01-06T12:00:00Z').getTimezoneOffset()).toBe(300)
    const { sent } = stubApi()
    await renderLoaded()

    expect(section('The shoot')).toHaveTextContent('Wednesday, 6 January 2027, 09:00 – 10:30')
    await openDialog('Move booking')
    expect(screen.getByLabelText('New start (Kigali time)')).toHaveValue('2027-01-06T09:00')

    await user().click(screen.getByRole('button', { name: 'Move booking' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]?.body).toEqual({ startsAt: '2027-01-06T09:00:00+02:00' })
  })
})

// --- Cancelling ------------------------------------------------------------------------

describe('cancelling', () => {
  it('asks again before it cancels, and sends nothing until he confirms', async () => {
    const { sent } = stubApi()
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))

    expect(screen.getByText(/Cancelling releases the time and tells the client/)).toBeInTheDocument()
    expect(screen.getByLabelText('Reason (shown to the client)')).toBeInTheDocument()
    expect(writes(sent)).toEqual([])
  })

  it('backs out without sending anything', async () => {
    const { sent } = stubApi()
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))
    await user().click(screen.getByRole('button', { name: 'Keep the booking' }))

    expect(screen.queryByLabelText('Reason (shown to the client)')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel this booking' })).toBeInTheDocument()
    expect(writes(sent)).toEqual([])
  })

  it('carries the reason, trimmed, and re-renders the cancelled booking', async () => {
    const { sent } = stubApi({ onPost: (_call, current) => ((current.value = CANCELLED), json({ booking: CANCELLED })) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))
    await user().type(screen.getByLabelText('Reason (shown to the client)'), '  Studio flooded.  ')
    await user().click(screen.getByRole('button', { name: 'Cancel and refund' }))

    await waitFor(() => expect(section('Money')).toHaveTextContent('To refund20,000 RWF'))
    expect(writes(sent)).toEqual([
      { method: 'POST', url: `${DETAIL_API}/cancel`, body: { reason: 'Studio flooded.' } },
    ])
    expect(screen.queryByRole('button', { name: 'Cancel this booking' })).not.toBeInTheDocument()
  })

  it('sends a null reason when he gives none', async () => {
    const { sent } = stubApi({ onPost: () => json({ booking: CANCELLED }) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Cancel this booking' }))
    await user().click(screen.getByRole('button', { name: 'Cancel and refund' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]?.body).toEqual({ reason: null })
  })
})

// --- Completing, no-show and the link --------------------------------------------------

describe('the one-click actions', () => {
  it.each([
    ['Mark completed', 'complete', { ...STARTED, status: 'completed', stage: 'completed' as const }],
    ['Mark no-show', 'no-show', { ...STARTED, status: 'no_show', stage: 'no_show' as const }],
  ])('%s posts to /%s and re-renders from the answer', async (label, path, answer) => {
    const next = { ...answer, actions: { ...STARTED.actions, canComplete: false, canMarkNoShow: false, canReschedule: false, canCancel: false } }
    const { sent } = stubApi({ booking: STARTED, onPost: (_call, current) => ((current.value = next), json({ booking: next })) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: label }))

    await waitFor(() => expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument())
    expect(writes(sent)).toEqual([{ method: 'POST', url: `${DETAIL_API}/${path}`, body: {} }])
  })

  it('sends a new link and shows the fresh expiry it answered with', async () => {
    const relinked: AdminBooking = { ...BOOKING, access: { hasLink: true, expiresAt: '2028-01-01T06:00:00.000Z', lastUsedAt: null } }
    const { sent } = stubApi({ onPost: (_call, current) => ((current.value = relinked), json({ booking: relinked })) })
    await renderLoaded()
    expect(section('Client')).toHaveTextContent('Live until 1 Oct 2027, 08:05')

    await user().click(screen.getByRole('button', { name: 'Send a new booking link' }))

    await waitFor(() => expect(section('Client')).toHaveTextContent('Live until 1 Jan 2028, 08:00'))
    expect(writes(sent)).toEqual([{ method: 'POST', url: `${DETAIL_API}/resend-link`, body: {} }])
  })
})

// --- Recording a refund ------------------------------------------------------------------

describe('recording a refund (spec §6.16)', () => {
  const REFUNDED: AdminBooking = {
    ...CANCELLED,
    payments: [{ ...BOOKING_FEE, status: 'refunded', refundedAt: '2026-10-03T08:00:00.000Z', refundReference: 'MOMO-REF-7781', canRecordRefund: false }],
    money: { ...CANCELLED.money, totals: { ...CANCELLED.money.totals, refundDueRwf: 0 } },
  }

  it('offers the form only for a payment flagged for refund', async () => {
    stubApi({ booking: CANCELLED })
    await renderLoaded()

    expect(screen.getByLabelText('Refund reference')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Record 20,000 RWF refunded' })).toBeInTheDocument()
    expect(section('Payments')).toHaveTextContent('The system moves no money.')
  })

  it('posts the reference to the payment and shows the refunded state', async () => {
    const { sent } = stubApi({ booking: CANCELLED, onPost: (_call, current) => ((current.value = REFUNDED), json({ booking: REFUNDED })) })
    await renderLoaded()

    await user().type(screen.getByLabelText('Refund reference'), 'MOMO-REF-7781')
    await user().click(screen.getByRole('button', { name: 'Record 20,000 RWF refunded' }))

    await waitFor(() => expect(section('Payments')).toHaveTextContent('Refunded'))
    expect(writes(sent)).toEqual([
      { method: 'POST', url: `/api/admin/payments/${PAYMENT_ID}/refund`, body: { reference: 'MOMO-REF-7781' } },
    ])
    expect(section('Payments')).toHaveTextContent('refund MOMO-REF-7781')
    expect(screen.queryByLabelText('Refund reference')).not.toBeInTheDocument()
    expect(section('Money')).not.toHaveTextContent('To refund')
  })
})

// --- Refusals -----------------------------------------------------------------------------

describe('when the API refuses an action', () => {
  it('maps a 409 slot_taken to words and catches the screen up with what is true', async () => {
    const taken = { ...BOOKING, status: 'confirmed' }
    const { sent } = stubApi({
      onPost: (_call, current) => ((current.value = taken), json({ error: 'slot_taken', booking: taken }, 409)),
    })
    await renderLoaded()
    const before = gets(sent).length

    await openDialog('Move booking')
    fireEvent.change(screen.getByLabelText('New start (Kigali time)'), { target: { value: '2027-01-07T14:30' } })
    await user().click(screen.getByRole('button', { name: 'Move booking' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That time is already taken. Choose another.')
    // The refusal carried the booking, so the screen is already up to date and
    // asks for nothing more.
    expect(gets(sent).length).toBe(before)
  })

  it('maps a 409 not_allowed to words and re-renders the booking as it now is', async () => {
    const { sent } = stubApi({
      onPost: (_call, current) => ((current.value = CANCELLED), json({ error: 'not_allowed', booking: CANCELLED }, 409)),
    })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Send a new booking link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That is not possible for this booking any more.')
    await waitFor(() => expect(section('Money')).toHaveTextContent('To refund20,000 RWF'))
    expect(screen.queryByRole('button', { name: 'Move booking' })).not.toBeInTheDocument()
    expect(gets(sent).length).toBe(1)
  })

  it('reads the booking again when a refusal arrives without one', async () => {
    const { sent } = stubApi({
      onPost: (_call, current) => ((current.value = CANCELLED), json({ error: 'not_allowed' }, 409)),
    })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Send a new booking link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That is not possible for this booking any more.')
    await waitFor(() => expect(section('Money')).toHaveTextContent('To refund20,000 RWF'))
    expect(gets(sent).length).toBe(2)
  })

  it('maps a 409 unchanged to words', async () => {
    stubApi({ onPost: () => json({ error: 'unchanged', booking: BOOKING }, 409) })
    await renderLoaded()

    await openDialog('Move booking')
    await user().click(screen.getByRole('button', { name: 'Move booking' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That is the time the booking already has.')
  })

  it('maps a 409 not_refundable to words', async () => {
    stubApi({ booking: CANCELLED, onPost: () => json({ error: 'not_refundable', booking: CANCELLED }, 409) })
    await renderLoaded()

    await user().type(screen.getByLabelText('Refund reference'), 'MOMO-REF-7781')
    await user().click(screen.getByRole('button', { name: 'Record 20,000 RWF refunded' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('This payment is not flagged for a refund.')
  })

  it('falls back to a generic message for anything it has no words for', async () => {
    stubApi({ onPost: () => json({ error: 'internal_error' }, 500) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Send a new booking link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That did not work. Try again.')
  })

  it('sends him to sign in when an action answers 401', async () => {
    stubApi({ onPost: () => json({ error: 'unauthenticated' }, 401) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Send a new booking link' }))

    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument()
    expect(readSession()).toBeNull()
  })

  it('clears the previous error when the next action succeeds', async () => {
    let fail = true
    stubApi({
      onPost: () => {
        if (fail) {
          fail = false
          return json({ error: 'internal_error' }, 500)
        }
        return json({ booking: BOOKING })
      },
    })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Send a new booking link' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await user().click(screen.getByRole('button', { name: 'Send a new booking link' }))

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})

// --- The post-shoot add-on editor and the session fee (plan.md Task 20) ------------------

/**
 * The post-shoot half of the screen (spec §3.5 steps 2-3, §6.15).
 *
 * The editor appears only when the API says `canEditAddons`, and it offers what
 * the photographer actually sells for this service: its own add-ons and the
 * ones shared with every service, never one he has retired and never another
 * service's. Only an id and a quantity travel -- no price is typed here, so
 * nothing in the browser can decide what a client owes. The remove link follows
 * the API's per-line `canRemove`, and the "Request … session fee" button
 * follows `canRequestSessionFee` and names the amount the API derived.
 *
 * Each of the three new refusals shows its own words. "The client has already
 * paid for this" is a different problem from "something went wrong", and the
 * screen catches up with the booking the 409 carried.
 */

/**
 * A booking completed before 2026-09-27 that still owes 30,000: it keeps the
 * session fee, but its add-ons are locked, and delivery is open.
 */
const COMPLETED: AdminBooking = {
  ...BOOKING,
  status: 'completed',
  stage: 'completed',
  lifecycle: { ...BOOKING.lifecycle, completedAt: '2027-01-06T09:00:00.000Z' },
  actions: {
    canReschedule: false,
    canCancel: false,
    canComplete: false,
    canMarkNoShow: false,
    canResendLink: true,
    canEditAddons: false,
    canRequestSessionFee: true,
    canEditDelivery: true,
    canSendDelivery: false,
  },
}

/**
 * A shoot under way with the add-on editor open (2026-09-27): still
 * `confirmed`, 50,000 owed, 20,000 paid, 30,000 outstanding.
 */
const UNDER_WAY: AdminBooking = {
  ...BOOKING,
  stage: 'needs_review',
  actions: {
    canReschedule: true,
    canCancel: true,
    canComplete: false,
    canMarkNoShow: true,
    canResendLink: true,
    canEditAddons: true,
    canRequestSessionFee: true,
    canEditDelivery: false,
    canSendDelivery: false,
  },
}

/** The same booking once a 15,000 post-shoot line has been added. */
const WITH_POST_SHOOT: AdminBooking = {
  ...UNDER_WAY,
  addons: [
    ...UNDER_WAY.addons,
    { id: 'ba2', name: 'Twenty prints', unitPriceRwf: 15_000, quantity: 1, amountRwf: 15_000, stage: 'post_shoot', canRemove: true },
  ],
  money: {
    ...UNDER_WAY.money,
    totals: { quotedTotalRwf: 50_000, grandTotalRwf: 65_000, collectedRwf: 20_000, refundDueRwf: 0, outstandingRwf: 45_000 },
  },
}

describe('the post-shoot add-on editor', () => {
  it('does not render at all before the shoot has begun', async () => {
    stubApi()
    await renderLoaded()

    expect(screen.queryByText('Add-ons from the shoot')).toBeNull()
    expect(screen.queryByLabelText('Add-on')).toBeNull()
  })

  it('renders once the API says the add-ons may be edited', async () => {
    stubApi({ booking: UNDER_WAY })
    await renderLoaded()

    // The opener sits in the money section; the form opens in a dialog (2026-09-27).
    expect(within(section('Money')).getByRole('button', { name: 'Add an add-on' })).toBeInTheDocument()
    const dialog = await openDialog('Add an add-on')
    expect(dialog).toHaveAccessibleName('Add-ons from the shoot')
    expect(await within(dialog).findByLabelText('Add-on')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Add to the booking' })).toBeInTheDocument()
  })

  it('asks the catalogue for what he sells, once', async () => {
    const { sent } = stubApi({ booking: UNDER_WAY })
    await renderLoaded()
    await openDialog('Add an add-on')
    await screen.findByLabelText('Add-on')

    expect(gets(sent).filter((call) => call.url === '/api/admin/catalogue')).toHaveLength(1)
  })

  it('offers this service’s own add-ons and the shared ones, and nothing else', async () => {
    stubApi({ booking: UNDER_WAY })
    await renderLoaded()
    await openDialog('Add an add-on')

    const select = await screen.findByLabelText('Add-on')
    const options = within(select).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)
    expect(options).toEqual(['', OWN_ADDON_ID, SHARED_ADDON_ID])
    expect(select).toHaveTextContent('Twenty prints · 15,000 RWF')
    expect(select).toHaveTextContent('Rush edit · 5,000 RWF')
  })

  it('never offers an add-on he has retired, nor one belonging to another service', async () => {
    stubApi({ booking: UNDER_WAY })
    await renderLoaded()
    await openDialog('Add an add-on')

    const select = await screen.findByLabelText('Add-on')
    const options = within(select).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)
    expect(options).not.toContain(RETIRED_ADDON_ID)
    expect(options).not.toContain(RETIRED_SHARED_ADDON_ID)
    expect(options).not.toContain(OTHER_SERVICE_ADDON_ID)
    expect(select).not.toHaveTextContent('Polaroid pack')
    expect(select).not.toHaveTextContent('Second shooter')
    expect(select).not.toHaveTextContent('Photo book')
  })

  it('posts the id and the quantity, and re-renders from what the API answered', async () => {
    const { sent, current } = stubApi({
      booking: UNDER_WAY,
      onPost: (_call, state) => {
        state.value = WITH_POST_SHOOT
        return json({ booking: WITH_POST_SHOOT })
      },
    })
    await renderLoaded()
    await openDialog('Add an add-on')
    await screen.findByLabelText('Add-on')

    await user().selectOptions(screen.getByLabelText('Add-on'), OWN_ADDON_ID)
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } })
    await user().click(screen.getByRole('button', { name: 'Add to the booking' }))

    await waitFor(() => expect(section('Money')).toHaveTextContent('Total65,000 RWF'))
    expect(writes(sent)).toEqual([
      { method: 'POST', url: `/api/admin/bookings/${BOOKING_ID}/addons`, body: { addonId: OWN_ADDON_ID, quantity: 2 } },
    ])
    expect(section('Money')).toHaveTextContent('Twenty prints (added after the shoot)')
    expect(section('Money')).toHaveTextContent('Still to pay45,000 RWF')
    expect(current.value).toBe(WITH_POST_SHOOT)
  })

  it('sends a quantity of one when the field is left as it opens', async () => {
    const { sent } = stubApi({ booking: UNDER_WAY })
    await renderLoaded()
    await openDialog('Add an add-on')
    await screen.findByLabelText('Add-on')

    await user().selectOptions(screen.getByLabelText('Add-on'), SHARED_ADDON_ID)
    await user().click(screen.getByRole('button', { name: 'Add to the booking' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]?.body).toEqual({ addonId: SHARED_ADDON_ID, quantity: 1 })
  })

  it('posts nothing at all while no add-on has been chosen', async () => {
    const { sent } = stubApi({ booking: UNDER_WAY })
    await renderLoaded()
    await openDialog('Add an add-on')
    await screen.findByLabelText('Add-on')

    await user().click(screen.getByRole('button', { name: 'Add to the booking' }))

    expect(writes(sent)).toEqual([])
  })

  it('never sends a price: only an id and a quantity decide what is charged', async () => {
    const { sent } = stubApi({ booking: UNDER_WAY })
    await renderLoaded()
    await openDialog('Add an add-on')
    await screen.findByLabelText('Add-on')

    await user().selectOptions(screen.getByLabelText('Add-on'), OWN_ADDON_ID)
    await user().click(screen.getByRole('button', { name: 'Add to the booking' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(Object.keys(writes(sent)[0]?.body as object).sort()).toEqual(['addonId', 'quantity'])
  })

  it('says so when the catalogue has nothing to sell for this service', async () => {
    stubApi({ booking: UNDER_WAY, catalogue: { services: [], sharedAddons: [] } })
    await renderLoaded()
    await openDialog('Add an add-on')

    expect(await screen.findByText('No add-ons are on sale for this service.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Add-on')).toBeNull()
  })

  it('says the add-ons would not load, and leaves the rest of the page usable', async () => {
    const { sent } = stubApi({ booking: UNDER_WAY, catalogue: null })
    await renderLoaded()
    await openDialog('Add an add-on')

    // Not "no add-ons are on sale": he sells them, we could not read them.
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load the add-ons.')
    expect(screen.queryByText('No add-ons are on sale for this service.')).toBeNull()
    await user().keyboard('{Escape}')
    // The money, the payments and the actions are all still there.
    expect(section('Money')).toHaveTextContent('Total50,000 RWF')
    expect(section('Payments')).toHaveTextContent('Booking fee')
    expect(screen.getByRole('button', { name: 'Request 30,000 RWF session fee' })).toBeInTheDocument()

    // And the session fee can still be asked for.
    await user().click(screen.getByRole('button', { name: 'Request 30,000 RWF session fee' }))
    await waitFor(() => expect(writes(sent)).toHaveLength(1))
  })
})

describe('removing a post-shoot add-on', () => {
  it('offers Remove only on the lines the API marked canRemove', async () => {
    stubApi({ booking: WITH_POST_SHOOT })
    await renderLoaded()

    const money = section('Money')
    expect(within(money).getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
    // The at-booking line has no remove link: it is not his to delete.
    expect(money).toHaveTextContent('Extra hour10,000 RWF')
  })

  it('offers none when nothing may be removed', async () => {
    const paid: AdminBooking = {
      ...WITH_POST_SHOOT,
      addons: WITH_POST_SHOOT.addons.map((line) => ({ ...line, canRemove: false })),
    }
    stubApi({ booking: paid })
    await renderLoaded()

    expect(within(section('Money')).queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('posts the DELETE for that line and re-renders from the answer', async () => {
    const { sent } = stubApi({
      booking: WITH_POST_SHOOT,
      onPost: (_call, state) => {
        state.value = UNDER_WAY
        return json({ booking: UNDER_WAY })
      },
    })
    await renderLoaded()

    await user().click(within(section('Money')).getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(section('Money')).toHaveTextContent('Total50,000 RWF'))
    expect(writes(sent)).toEqual([
      { method: 'DELETE', url: `/api/admin/bookings/${BOOKING_ID}/addons/ba2`, body: undefined },
    ])
    // The line is gone with its remove link; only the picker still names it.
    expect(within(section('Money')).queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(section('Money')).toHaveTextContent('Still to pay30,000 RWF')
  })

  it('shows the already_paid refusal in words, and catches up with the booking it carried', async () => {
    stubApi({
      booking: WITH_POST_SHOOT,
      onPost: () =>
        json(
          {
            error: 'already_paid',
            booking: {
              ...WITH_POST_SHOOT,
              addons: WITH_POST_SHOOT.addons.map((line) => ({ ...line, canRemove: false })),
              money: { ...WITH_POST_SHOOT.money, totals: { ...WITH_POST_SHOOT.money.totals, collectedRwf: 65_000, outstandingRwf: 0 } },
            },
          },
          409,
        ),
    })
    await renderLoaded()

    await user().click(within(section('Money')).getByRole('button', { name: 'Remove' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The client has already paid for this. Refund it rather than removing it.')
    // The screen corrected itself: the line stays, and its remove link is gone.
    expect(section('Money')).toHaveTextContent('Twenty prints')
    expect(within(section('Money')).queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(section('Money')).toHaveTextContent('Collected65,000 RWF')
  })
})

describe('requesting the session fee', () => {
  it('names the outstanding amount the API derived', async () => {
    stubApi({ booking: UNDER_WAY })
    await renderLoaded()

    expect(screen.getByRole('button', { name: 'Request 30,000 RWF session fee' })).toBeInTheDocument()
    expect(screen.getByText(/The amount is fixed when you ask/)).toBeInTheDocument()
  })

  it('names whatever the add-ons have made it', async () => {
    stubApi({ booking: WITH_POST_SHOOT })
    await renderLoaded()

    expect(screen.getByRole('button', { name: 'Request 45,000 RWF session fee' })).toBeInTheDocument()
  })

  it('does not appear when the API says there is nothing to ask for', async () => {
    stubApi({ booking: BOOKING })
    await renderLoaded()

    expect(screen.queryByRole('button', { name: /session fee/ })).toBeNull()
  })

  it('posts the request and re-renders from the booking the API answered with', async () => {
    const asked: AdminBooking = {
      ...UNDER_WAY,
      payments: [
        ...UNDER_WAY.payments,
        {
          id: 'pay2',
          kind: 'session_fee',
          provider: 'mtn_momo_direct',
          ourRef: 'f00dcafe',
          providerRef: null,
          method: null,
          amountRwf: 30_000,
          status: 'initiated',
          failureReason: null,
          initiatedAt: '2027-01-06T10:00:00.000Z',
          settledAt: null,
          refundedAt: null,
          refundReference: null,
          note: null,
          canRecordRefund: false,
        },
      ],
      messages: [
        ...UNDER_WAY.messages,
        {
          id: 'm2',
          kind: 'email',
          template: 'session_fee_request',
          recipient: 'aline@example.com',
          status: 'queued',
          attempts: 0,
          lastError: null,
          createdAt: '2027-01-06T10:00:00.000Z',
          completedAt: null,
        },
      ],
    }
    const { sent } = stubApi({
      booking: UNDER_WAY,
      onPost: (_call, state) => {
        state.value = asked
        return json({ booking: asked })
      },
    })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Request 30,000 RWF session fee' }))

    await waitFor(() => expect(section('Payments')).toHaveTextContent('Session fee'))
    expect(writes(sent)).toEqual([{ method: 'POST', url: `/api/admin/bookings/${BOOKING_ID}/session-fee`, body: {} }])
    expect(section('Payments')).toHaveTextContent('30,000 RWF')
    expect(section('Messages sent')).toHaveTextContent('Session fee request')
  })

  it.each([
    ['nothing_to_pay', 'There is nothing left to pay on this booking.'],
    ['in_progress', 'The client is paying right now. Wait for that to finish.'],
    ['not_allowed', 'That is not possible for this booking any more. The booking below is up to date.'],
  ])('shows the %s refusal in its own words', async (code, words) => {
    stubApi({ booking: UNDER_WAY, onPost: () => json({ error: code, booking: UNDER_WAY }, 409) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Request 30,000 RWF session fee' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(words)
    expect(screen.getByRole('alert')).not.toHaveTextContent('That did not work.')
  })

  it('shows the not_allowed refusal for an add-on the API will not take, and stays usable', async () => {
    stubApi({ booking: UNDER_WAY, onPost: () => json({ error: 'not_allowed', booking: UNDER_WAY }, 409) })
    await renderLoaded()
    await openDialog('Add an add-on')
    await screen.findByLabelText('Add-on')

    await user().selectOptions(screen.getByLabelText('Add-on'), OWN_ADDON_ID)
    await user().click(screen.getByRole('button', { name: 'Add to the booking' }))

    // A refusal keeps the dialog open, with the words inside it.
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That is not possible for this booking any more.')
    expect(within(dialog).getByRole('button', { name: 'Add to the booking' })).toBeInTheDocument()
    await user().keyboard('{Escape}')
    expect(section('Money')).toHaveTextContent('Total50,000 RWF')
  })
})


// --- What the quantity field sends ---------------------------------------------------------

/**
 * The field is `type="number" min={1} max={99}` inside a real form, so the
 * browser's own constraint validation refuses a zero or a hundred before any
 * submit handler runs -- nothing is sent, and the API's 422 is a second line of
 * defence rather than the first. An emptied field is valid HTML, and
 * `AddonForm`'s `Number(quantity) || 1` reads it as one.
 */
describe('"completed" means paid (2026-09-27)', () => {
  it('shows Mark completed disabled while money is owed, and says how much', async () => {
    const { sent } = stubApi({ booking: UNDER_WAY })
    await renderLoaded()

    const complete = screen.getByRole('button', { name: 'Mark completed' })
    expect(complete).toHaveAttribute('aria-disabled', 'true')
    expect(complete).toHaveAccessibleDescription(
      'Mark completed opens once nothing is owed. 30,000 RWF is still to pay. Paid in full, the booking completes by itself.',
    )
    await user().click(complete)
    expect(writes(sent)).toEqual([])
    // No-show is not held back by money.
    expect(screen.getByRole('button', { name: 'Mark no-show' })).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('shows neither the disabled button nor its hint once nothing is owed', async () => {
    stubApi({ booking: STARTED })
    await renderLoaded()

    expect(screen.getAllByRole('button', { name: 'Mark completed' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Mark completed' })).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByText(/opens once nothing is owed/)).toBeNull()
  })

  it('shows the balance_due refusal in its own words, and the booking it carried', async () => {
    stubApi({ booking: STARTED, onPost: () => json({ error: 'balance_due', booking: UNDER_WAY }, 409) })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Mark completed' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The client still owes money on this booking. It completes by itself once it is paid in full.',
    )
    expect(screen.getByRole('button', { name: 'Mark completed' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('points to Request session fee once an add-on is added, until the fee is asked for', async () => {
    const REQUESTED: AdminBooking = { ...WITH_POST_SHOOT, actions: { ...WITH_POST_SHOOT.actions, canRequestSessionFee: false } }
    stubApi({
      booking: UNDER_WAY,
      onPost: (call, state) => {
        state.value = call.url.endsWith('/session-fee') ? REQUESTED : WITH_POST_SHOOT
        return json({ booking: state.value })
      },
    })
    await renderLoaded()
    expect(screen.queryByRole('button', { name: 'Go to Request session fee' })).toBeNull()

    await openDialog('Add an add-on')
    await screen.findByLabelText('Add-on')
    await user().selectOptions(screen.getByLabelText('Add-on'), OWN_ADDON_ID)
    await user().click(screen.getByRole('button', { name: 'Add to the booking' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(section('Money')).getByRole('status')).toHaveTextContent(
      'Added. The client now owes 45,000 RWF. Once every add-on is in, ask for it with the session fee.',
    )
    await user().click(screen.getByRole('button', { name: 'Go to Request session fee' }))
    const request = screen.getByRole('button', { name: 'Request 45,000 RWF session fee' })
    expect(request).toHaveFocus()

    await user().click(request)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Go to Request session fee' })).toBeNull())
  })
})

describe('recording a cash payment (item 7, 2026-09-27)', () => {
  /** The request the client was emailed, voided by the cash. */
  const REPLACED: AdminPayment = {
    ...BOOKING_FEE,
    id: 'pay-request',
    kind: 'session_fee',
    ourRef: 'c0ffee00-0000-4000-8000-000000000001',
    providerRef: null,
    method: null,
    amountRwf: 30_000,
    status: 'failed',
    failureReason: 'superseded_by_cash',
    settledAt: null,
  }
  const CASH: AdminPayment = {
    ...BOOKING_FEE,
    id: 'pay-cash',
    kind: 'session_fee',
    provider: 'cash',
    ourRef: 'ca5h0000-0000-4000-8000-000000000002',
    providerRef: null,
    method: null,
    amountRwf: 30_000,
    settledAt: '2027-01-06T10:00:00.000Z',
    note: 'Paid at the studio.',
  }
  const PAID_IN_CASH: AdminBooking = {
    ...UNDER_WAY,
    status: 'completed',
    stage: 'completed',
    money: { ...UNDER_WAY.money, totals: { ...UNDER_WAY.money.totals, collectedRwf: 50_000, outstandingRwf: 0 } },
    payments: [...UNDER_WAY.payments, REPLACED, CASH],
    actions: { ...UNDER_WAY.actions, canComplete: false, canMarkNoShow: false, canEditAddons: false, canRequestSessionFee: false, canEditDelivery: true },
  }

  it('offers it only while money is owed', async () => {
    stubApi({ booking: STARTED })
    await renderLoaded()

    expect(screen.queryByRole('button', { name: 'Record cash payment' })).toBeNull()
  })

  it('opens a dialog prefilled with what is owed, posts it, and lists the payment as cash', async () => {
    const { sent } = stubApi({
      booking: UNDER_WAY,
      onPost: (_call, state) => {
        state.value = PAID_IN_CASH
        return json({ booking: PAID_IN_CASH })
      },
    })
    await renderLoaded()

    const dialog = await openDialog('Record cash payment')
    expect(within(dialog).getByRole('heading', { name: 'Record a cash payment' })).toBeInTheDocument()
    const amount = within(dialog).getByLabelText('Amount received (RWF)')
    expect(amount).toHaveValue(30_000)
    expect(amount).toHaveAccessibleDescription('Whole francs, from 1 up to 30,000 RWF, which is what is still owed.')
    await user().type(within(dialog).getByLabelText('Note (optional)'), '  Paid at the studio.  ')
    await user().click(within(dialog).getByRole('button', { name: 'Record the payment' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes(sent)).toEqual([
      { method: 'POST', url: `/api/admin/bookings/${BOOKING_ID}/payments/cash`, body: { amountRwf: 30_000, note: 'Paid at the studio.' } },
    ])
    const payments = section('Payments')
    expect(payments).toHaveTextContent('Cash · 30,000 RWF')
    expect(payments).toHaveTextContent('cash · our ref ca5h0000-0000-4000-8000-000000000002')
    expect(payments).toHaveTextContent('Paid at the studio.')
    // The voided request reads as replaced, not as a failure owed attention.
    expect(payments).toHaveTextContent('Replaced by cash')
    expect(payments).not.toHaveTextContent('Failed')
  })

  it('sends part of the balance when he was paid part of it', async () => {
    const { sent } = stubApi({ booking: UNDER_WAY, onPost: (_call, state) => json({ booking: state.value }) })
    await renderLoaded()

    const dialog = await openDialog('Record cash payment')
    const amount = within(dialog).getByLabelText('Amount received (RWF)')
    await user().clear(amount)
    await user().type(amount, '10000')
    await user().click(within(dialog).getByRole('button', { name: 'Record the payment' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]?.body).toEqual({ amountRwf: 10_000, note: null })
  })

  it.each([
    ['more than is owed', '30001'],
    ['nothing', '0'],
    ['a fraction', '10.5'],
    ['an empty field', ''],
  ])('refuses %s in the form, and sends nothing', async (_case, typed) => {
    const { sent } = stubApi({ booking: UNDER_WAY })
    await renderLoaded()

    const dialog = await openDialog('Record cash payment')
    const amount = within(dialog).getByLabelText('Amount received (RWF)')
    await user().clear(amount)
    if (typed !== '') await user().type(amount, typed)
    await user().click(within(dialog).getByRole('button', { name: 'Record the payment' }))

    expect(amount).toHaveAttribute('aria-invalid', 'true')
    expect(within(dialog).getByRole('button', { name: 'Record the payment' })).toHaveAttribute('aria-disabled', 'true')
    expect(writes(sent)).toEqual([])
  })

  it.each([
    ['over_outstanding', 'That is more than the client owes. Enter the amount you were paid, up to what is still owed.'],
    ['in_progress', 'The client is paying right now. Wait for that to finish.'],
  ])('shows the %s refusal inside the dialog, which stays open', async (code, words) => {
    stubApi({ booking: UNDER_WAY, onPost: () => json({ error: code, booking: UNDER_WAY }, 409) })
    await renderLoaded()

    const dialog = await openDialog('Record cash payment')
    await user().click(within(dialog).getByRole('button', { name: 'Record the payment' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(words)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('the quantity the add-on form sends', () => {
  it.each([
    ['a zero', '0'],
    ['a hundred', '100'],
    ['a negative', '-3'],
  ])('sends nothing at all for %s: the field refuses it first', async (_case, value) => {
    const { sent } = stubApi({ booking: UNDER_WAY })
    await renderLoaded()
    await openDialog('Add an add-on')
    await screen.findByLabelText('Add-on')

    await user().selectOptions(screen.getByLabelText('Add-on'), OWN_ADDON_ID)
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value } })
    await user().click(screen.getByRole('button', { name: 'Add to the booking' }))

    expect(writes(sent)).toEqual([])
    expect(screen.getByLabelText('Quantity')).toBeInvalid()
  })

  it('reads an emptied field as one', async () => {
    const { sent } = stubApi({ booking: UNDER_WAY })
    await renderLoaded()
    await openDialog('Add an add-on')
    await screen.findByLabelText('Add-on')

    await user().selectOptions(screen.getByLabelText('Add-on'), OWN_ADDON_ID)
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '' } })
    await user().click(screen.getByRole('button', { name: 'Add to the booking' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]?.body).toEqual({ addonId: OWN_ADDON_ID, quantity: 1 })
  })

  it('sends the highest quantity the API takes', async () => {
    const { sent } = stubApi({ booking: UNDER_WAY })
    await renderLoaded()
    await openDialog('Add an add-on')
    await screen.findByLabelText('Add-on')

    await user().selectOptions(screen.getByLabelText('Add-on'), OWN_ADDON_ID)
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '99' } })
    await user().click(screen.getByRole('button', { name: 'Add to the booking' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]?.body).toEqual({ addonId: OWN_ADDON_ID, quantity: 99 })
  })
})

// --- The photos (plan.md Task 21) ------------------------------------------------------------

/**
 * The delivery section (spec §3.5 steps 5-6, §6.20, A-7, A-8).
 *
 * It is not on the page at all until there is something to show: an open editor
 * or a link already saved. With the editor open it is a form -- the link, the
 * day it stops working, and a line for the client -- prefilled from the booking
 * and sending only the fields he filled in, because a blank date means "date it
 * for me" (spec A-8) and a blank note means none. With the editor shut but a
 * link on file it is two lines of text and nothing to press.
 *
 * Saving and sending are separate buttons because they are separate acts: he
 * can paste a link, check it opens, and write to the client afterwards. "Send
 * the photos" appears only once the API says there is a link to send, and reads
 * "Send again" after the first one, which is how §6.20's lost email is answered.
 * Its own refusal -- there is no link yet -- has its own words.
 */

const DELIVERY_LINK = 'https://photos.example-host.com/s/abc123'
const DELIVERY_NOTE = 'The raw files are in the second folder.'

/** A completed shoot with the delivery editor open and nothing saved yet. */
const DELIVERABLE: AdminBooking = {
  ...COMPLETED,
  actions: { ...COMPLETED.actions, canEditDelivery: true, canSendDelivery: false },
}

/** The same, with a link saved but never sent. */
const WITH_LINK: AdminBooking = {
  ...DELIVERABLE,
  delivery: { url: DELIVERY_LINK, expiresOn: '2027-03-15', sentAt: null, note: DELIVERY_NOTE },
  actions: { ...DELIVERABLE.actions, canSendDelivery: true },
}

/** And once the email has gone. */
const DELIVERY_SENT: AdminBooking = {
  ...WITH_LINK,
  delivery: { ...WITH_LINK.delivery, sentAt: '2027-01-07T09:15:00.000Z' },
}

/** A link on a booking whose editor the API has closed: text, and nothing to press. */
const READ_ONLY_DELIVERY: AdminBooking = {
  ...BOOKING,
  delivery: { url: DELIVERY_LINK, expiresOn: '2027-03-15', sentAt: '2027-01-07T09:15:00.000Z', note: DELIVERY_NOTE },
  actions: { ...BOOKING.actions, canEditDelivery: false, canSendDelivery: false },
}

function deliverySection(): HTMLElement {
  return section('The photos')
}

function linkField(): HTMLElement {
  return screen.getByLabelText('Link to the photos')
}

/** The link form opens in a dialog: "Add the photo link" first, "Change the link" once one is saved. */
async function openLinkDialog(): Promise<HTMLElement> {
  const opener =
    screen.queryByRole('button', { name: 'Add the photo link' }) ?? screen.getByRole('button', { name: 'Change the link' })
  await user().click(opener)
  return screen.getByRole('dialog')
}

describe('the delivery section', () => {
  it('is not on the page at all with neither an editor nor a link', async () => {
    stubApi()
    await renderLoaded()

    expect(screen.queryByRole('heading', { level: 2, name: 'The photos' })).toBeNull()
    expect(screen.queryByLabelText('Link to the photos')).toBeNull()
  })

  it('is read-only when there is a link but the editor is shut', async () => {
    stubApi({ booking: READ_ONLY_DELIVERY })
    await renderLoaded()

    const photos = deliverySection()
    expect(photos).toHaveTextContent(DELIVERY_LINK)
    expect(photos).toHaveTextContent('Monday, 15 March 2027')
    expect(screen.queryByLabelText('Link to the photos')).toBeNull()
    expect(within(photos).queryByRole('button')).toBeNull()
  })

  it('is a form once the API says the delivery may be edited', async () => {
    stubApi({ booking: DELIVERABLE })
    await renderLoaded()

    // The section offers the opener; the form itself opens in a dialog (2026-09-27).
    expect(within(deliverySection()).getByRole('button', { name: 'Add the photo link' })).toBeInTheDocument()
    expect(deliverySection()).toHaveTextContent('Saving only stores the link. The client hears nothing until you send it.')
    const dialog = await openLinkDialog()
    expect(dialog).toHaveAccessibleName('The photos')
    expect(within(dialog).getByLabelText('Link to the photos')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Link expires')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('A line for the client (optional)')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save the link' })).toBeInTheDocument()
    expect(dialog).toHaveTextContent('Left blank, the client gets 90 days from today.')
  })

  it('starts empty on a booking with nothing saved', async () => {
    stubApi({ booking: DELIVERABLE })
    await renderLoaded()
    await openLinkDialog()

    expect(linkField()).toHaveValue('')
    expect(screen.getByLabelText('Link expires')).toHaveValue('')
    expect(screen.getByLabelText('A line for the client (optional)')).toHaveValue('')
  })

  it('prefills every field from the booking', async () => {
    stubApi({ booking: WITH_LINK })
    await renderLoaded()
    await openLinkDialog()

    expect(linkField()).toHaveValue(DELIVERY_LINK)
    expect(screen.getByLabelText('Link expires')).toHaveValue('2027-03-15')
    expect(screen.getByLabelText('A line for the client (optional)')).toHaveValue(DELIVERY_NOTE)
  })

  it('says nothing has been sent until something has', async () => {
    stubApi({ booking: WITH_LINK })
    await renderLoaded()

    expect(deliverySection()).toHaveTextContent('Nothing has been sent to the client yet.')
    expect(deliverySection()).not.toHaveTextContent('Last sent')
  })

  it('renders the moment it was last sent, in Kigali time', async () => {
    stubApi({ booking: DELIVERY_SENT })
    await renderLoaded()

    expect(deliverySection()).toHaveTextContent('Last sent')
    // 09:15Z is 11:15 in Kigali (spec §6.5).
    expect(deliverySection()).toHaveTextContent('7 Jan 2027, 11:15')
    expect(deliverySection()).not.toHaveTextContent('Nothing has been sent')
  })
})

describe('saving the link', () => {
  it('sends the link, the date he chose and the note he wrote', async () => {
    const { sent } = stubApi({ booking: DELIVERABLE })
    await renderLoaded()
    await openLinkDialog()

    await user().type(linkField(), DELIVERY_LINK)
    fireEvent.change(screen.getByLabelText('Link expires'), { target: { value: '2027-03-15' } })
    await user().type(screen.getByLabelText('A line for the client (optional)'), DELIVERY_NOTE)
    await user().click(screen.getByRole('button', { name: 'Save the link' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]).toEqual({
      method: 'PUT',
      url: `/api/admin/bookings/${BOOKING_ID}/delivery`,
      body: { url: DELIVERY_LINK, expiresOn: '2027-03-15', note: DELIVERY_NOTE },
    })
  })

  it('leaves the date out when the field is blank, so the API dates it (spec A-8)', async () => {
    const { sent } = stubApi({ booking: DELIVERABLE })
    await renderLoaded()
    await openLinkDialog()

    await user().type(linkField(), DELIVERY_LINK)
    await user().click(screen.getByRole('button', { name: 'Save the link' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]?.body).toEqual({ url: DELIVERY_LINK, note: null })
    expect(Object.keys(writes(sent)[0]?.body as object)).not.toContain('expiresOn')
  })

  it('sends a null note when the box is empty or only spaces', async () => {
    const { sent } = stubApi({ booking: DELIVERABLE })
    await renderLoaded()
    await openLinkDialog()

    await user().type(linkField(), DELIVERY_LINK)
    fireEvent.change(screen.getByLabelText('A line for the client (optional)'), { target: { value: '   ' } })
    await user().click(screen.getByRole('button', { name: 'Save the link' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]?.body).toMatchObject({ url: DELIVERY_LINK, note: null })
  })

  it('sends the link and the note without the whitespace around them', async () => {
    const { sent } = stubApi({ booking: DELIVERABLE })
    await renderLoaded()
    await openLinkDialog()

    fireEvent.change(linkField(), { target: { value: `  ${DELIVERY_LINK}  ` } })
    fireEvent.change(screen.getByLabelText('A line for the client (optional)'), { target: { value: `  ${DELIVERY_NOTE}  ` } })
    await user().click(screen.getByRole('button', { name: 'Save the link' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]?.body).toEqual({ url: DELIVERY_LINK, note: DELIVERY_NOTE })
  })

  it('sends nothing at all when there is no link to save', async () => {
    const { sent } = stubApi({ booking: DELIVERABLE })
    await renderLoaded()
    await openLinkDialog()

    await user().click(screen.getByRole('button', { name: 'Save the link' }))
    fireEvent.change(linkField(), { target: { value: '   ' } })
    await user().click(screen.getByRole('button', { name: 'Save the link' }))

    expect(writes(sent)).toEqual([])
  })

  it('re-renders from the booking the save answered with', async () => {
    stubApi({
      booking: DELIVERABLE,
      onPost: (_call, state) => {
        state.value = WITH_LINK
        return json({ booking: WITH_LINK })
      },
    })
    await renderLoaded()
    await openLinkDialog()

    await user().type(linkField(), DELIVERY_LINK)
    await user().click(screen.getByRole('button', { name: 'Save the link' }))

    expect(await screen.findByRole('button', { name: 'Send the photos' })).toBeInTheDocument()
  })
})

/** "Send" opens the confirm step; its "Send now" is what sends (2026-09-25). */
async function sendThroughConfirm(label: 'Send the photos' | 'Send again' = 'Send the photos') {
  await user().click(screen.getByRole('button', { name: label }))
  await user().click(screen.getByRole('button', { name: 'Send now' }))
}

describe('sending the photos', () => {
  it('offers no send button until the API says there is a link to send', async () => {
    stubApi({ booking: DELIVERABLE })
    await renderLoaded()

    expect(screen.queryByRole('button', { name: 'Send the photos' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull()
  })

  it('offers "Send the photos" once there is one, and sends an empty body', async () => {
    const { sent } = stubApi({ booking: WITH_LINK })
    await renderLoaded()

    await sendThroughConfirm()

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]).toEqual({ method: 'POST', url: `/api/admin/bookings/${BOOKING_ID}/delivery/send`, body: {} })
  })

  it('reads "Send again" once it has been sent (spec §6.20)', async () => {
    stubApi({ booking: DELIVERY_SENT })
    await renderLoaded()

    expect(screen.getByRole('button', { name: 'Send again' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send the photos' })).toBeNull()
  })

  it('becomes "Send again" the moment the first send answers', async () => {
    stubApi({
      booking: WITH_LINK,
      onPost: (_call, state) => {
        state.value = DELIVERY_SENT
        return json({ booking: DELIVERY_SENT })
      },
    })
    await renderLoaded()

    await sendThroughConfirm()

    expect(await screen.findByRole('button', { name: 'Send again' })).toBeInTheDocument()
    expect(deliverySection()).toHaveTextContent('7 Jan 2027, 11:15')
  })

  it('shows the no_link refusal in its own words', async () => {
    stubApi({ booking: WITH_LINK, onPost: () => json({ error: 'no_link', booking: DELIVERABLE }, 409) })
    await renderLoaded()

    await sendThroughConfirm()

    expect(await screen.findByRole('alert')).toHaveTextContent('Save a link to the photos first.')
    expect(screen.getByRole('alert')).not.toHaveTextContent('That did not work.')
  })

  it('shows the not_allowed refusal for a booking that moved on, and catches up with it', async () => {
    stubApi({ booking: WITH_LINK, onPost: () => json({ error: 'not_allowed', booking: CANCELLED }, 409) })
    await renderLoaded()

    await sendThroughConfirm()

    expect(await screen.findByRole('alert')).toHaveTextContent('That is not possible for this booking any more.')
    expect(document.body).toHaveTextContent('Cancelled by you')
    // The delivery section is gone with it: no editor, and no link to show.
    expect(screen.queryByRole('heading', { level: 2, name: 'The photos' })).toBeNull()
  })

  it('asks who to send it to first, prefilled with the booking’s email, and sends nothing yet (2026-09-25)', async () => {
    const { sent } = stubApi({ booking: WITH_LINK })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Send the photos' }))

    expect(within(deliverySection()).getByText('Send the photo link to:')).toBeInTheDocument()
    expect(screen.getByLabelText('Email address')).toHaveValue('aline@example.com')
    expect(screen.queryByRole('button', { name: 'Send the photos' })).toBeNull()
    expect(writes(sent)).toHaveLength(0)
  })

  it('goes back without sending', async () => {
    const { sent } = stubApi({ booking: WITH_LINK })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Send the photos' }))
    await user().click(screen.getByRole('button', { name: 'Back' }))

    expect(screen.queryByLabelText('Email address')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send the photos' })).toBeInTheDocument()
    expect(writes(sent)).toHaveLength(0)
  })

  it('sends a changed address as this email’s recipient, trimmed', async () => {
    const { sent } = stubApi({ booking: WITH_LINK })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Send the photos' }))
    const field = screen.getByLabelText('Email address')
    await user().clear(field)
    await user().type(field, '  aline.new@example.com ')
    await user().click(screen.getByRole('button', { name: 'Send now' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]?.body).toEqual({ recipient: 'aline.new@example.com' })
  })

  it('refuses an address that is not one, sending nothing', async () => {
    const { sent } = stubApi({ booking: WITH_LINK })
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Send the photos' }))
    const field = screen.getByLabelText('Email address')
    await user().clear(field)
    await user().type(field, 'not an email')
    await user().click(screen.getByRole('button', { name: 'Send now' }))

    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(writes(sent)).toHaveLength(0)
  })

  it('names the recipient in the history only when it was not the booking’s own address', async () => {
    const sentElsewhere: AdminBooking = {
      ...DELIVERY_SENT,
      messages: [
        ...BOOKING.messages,
        { ...BOOKING.messages[0], id: 'm9', template: 'photo_delivery', recipient: 'aline.new@example.com' } as AdminBooking['messages'][number],
      ],
    }
    stubApi({ booking: sentElsewhere })
    await renderLoaded()

    const history = section('Messages sent')
    expect(history).toHaveTextContent('to aline.new@example.com')
    expect(history.textContent ?? '').not.toContain('to aline@example.com')
  })

  it('reports no download count: the section is the link, the date, the note and when it went', async () => {
    stubApi({ booking: DELIVERY_SENT })
    await renderLoaded()

    expect(deliverySection().textContent ?? '').not.toMatch(/download|opened|viewed/i)
  })
})

describe('before the booking is marked completed', () => {
  // "The shoot has begun" is the API's `canComplete`, measured on its clock.
  it('says where photo delivery will be once the shoot has begun (2026-09-25)', async () => {
    stubApi({ booking: STARTED })
    await renderLoaded()

    expect(deliverySection()).toHaveTextContent(
      'Photo delivery opens once this booking is completed: by itself when it is paid in full, or when you mark it completed.',
    )
    expect(screen.queryByLabelText('Link to the photos')).toBeNull()
  })

  it('says nothing before the shoot', async () => {
    stubApi({ booking: BOOKING })
    await renderLoaded()

    expect(screen.queryByRole('heading', { level: 2, name: 'The photos' })).toBeNull()
  })

  it('says nothing for a cancelled booking', async () => {
    stubApi({ booking: CANCELLED })
    await renderLoaded()

    expect(screen.queryByRole('heading', { level: 2, name: 'The photos' })).toBeNull()
  })
})

describe('notes to the client (2026-09-25)', () => {
  const NOTE = { id: 'n1', body: 'Bring a jacket.\nIt gets cold.', emailed: true, createdAt: '2026-10-02T08:00:00.000Z' }
  const WITH_NOTE: AdminBooking = { ...BOOKING, notes: [NOTE] }

  function notes() {
    return section('Notes to the client')
  }

  it('lists the notes with when they were written and whether they were emailed', async () => {
    stubApi({ booking: { ...BOOKING, notes: [NOTE, { ...NOTE, id: 'n2', body: 'Quiet one.', emailed: false }] } })
    await renderLoaded()

    expect(notes()).toHaveTextContent('Bring a jacket.')
    expect(notes()).toHaveTextContent('Emailed')
    expect(notes()).toHaveTextContent('On the page only')
  })

  it('adds a note, emailed by default, and clears the form', async () => {
    const { sent } = stubApi({ onPost: (_call, current) => ((current.value = WITH_NOTE), json({ booking: WITH_NOTE })) })
    await renderLoaded()

    expect(within(notes()).getByRole('checkbox', { name: 'Also email it to the client' })).toBeChecked()
    await user().type(within(notes()).getByLabelText('New note'), '  Bring a jacket.  ')
    expect(notes()).toHaveTextContent('19 of 1000')
    await user().click(within(notes()).getByRole('button', { name: 'Add the note' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]).toEqual({ method: 'POST', url: `/api/admin/bookings/${BOOKING_ID}/notes`, body: { body: 'Bring a jacket.', email: true } })
    await waitFor(() => expect(within(notes()).getByLabelText('New note')).toHaveValue(''))
  })

  it('keeps it to the page when unticked', async () => {
    const { sent } = stubApi()
    await renderLoaded()

    await user().click(within(notes()).getByRole('checkbox', { name: 'Also email it to the client' }))
    await user().type(within(notes()).getByLabelText('New note'), 'Quiet one.')
    await user().click(within(notes()).getByRole('button', { name: 'Add the note' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]?.body).toEqual({ body: 'Quiet one.', email: false })
  })

  it('keeps what was typed when the note could not be saved', async () => {
    stubApi({ onPost: () => json({ error: 'failed' }, 500) })
    await renderLoaded()

    await user().type(within(notes()).getByLabelText('New note'), 'Do not lose me.')
    await user().click(within(notes()).getByRole('button', { name: 'Add the note' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(within(notes()).getByLabelText('New note')).toHaveValue('Do not lose me.')
  })

  it('sends nothing for an empty note', async () => {
    const { sent } = stubApi()
    await renderLoaded()

    await user().click(within(notes()).getByRole('button', { name: 'Add the note' }))

    expect(writes(sent)).toHaveLength(0)
  })

  it('deletes a note only after confirming, and keeps it on Keep it', async () => {
    const { sent } = stubApi({ booking: WITH_NOTE, onPost: (_call, current) => ((current.value = BOOKING), json({ booking: BOOKING })) })
    await renderLoaded()

    await user().click(within(notes()).getByRole('button', { name: 'Delete' }))
    expect(notes()).toHaveTextContent('An email already sent stays sent.')
    await user().click(within(notes()).getByRole('button', { name: 'Keep it' }))
    expect(writes(sent)).toHaveLength(0)

    await user().click(within(notes()).getByRole('button', { name: 'Delete' }))
    await user().click(within(notes()).getByRole('button', { name: 'Delete the note' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(1))
    expect(writes(sent)[0]).toMatchObject({ method: 'DELETE', url: `/api/admin/bookings/${BOOKING_ID}/notes/n1` })
    await waitFor(() => expect(notes()).toHaveTextContent('No notes yet.'))
  })

  it('is not offered before a client has a page to read it on', async () => {
    stubApi({ booking: { ...BOOKING, lifecycle: { ...BOOKING.lifecycle, confirmedAt: null } } })
    await renderLoaded()

    expect(screen.queryByRole('heading', { level: 2, name: 'Notes to the client' })).not.toBeInTheDocument()
  })
})

/**
 * Tested as the code behaves, and flagged rather than "fixed". `DeliveryForm`
 * seeds its three fields with `useState` and never re-seeds them, so the
 * booking the API answers with does not reach the inputs. After a save that
 * took the API's default date (spec A-8), the date field is still blank -- and
 * a second save therefore sends no date again, so the API re-dates the link
 * from *that* day rather than leaving the date the client was already told.
 */
describe('what the form does with the booking it gets back', () => {
  // Changed 2026-09-27 (item 1): the link form opens in a dialog, and each
  // opening starts from what is stored, so closing it unsaved discards the edit.
  // A date the API chose is therefore shown on the next opening, and saving
  // again keeps that same date rather than re-dating the link.
  it('shows the date the API chose on the next opening, and a second save keeps it', async () => {
    const dated: AdminBooking = { ...WITH_LINK, delivery: { ...WITH_LINK.delivery, expiresOn: '2027-04-06', note: null } }
    const { sent } = stubApi({
      booking: DELIVERABLE,
      onPost: (_call, state) => {
        state.value = dated
        return json({ booking: dated })
      },
    })
    await renderLoaded()
    await openLinkDialog()

    await user().type(linkField(), DELIVERY_LINK)
    await user().click(screen.getByRole('button', { name: 'Save the link' }))
    await screen.findByRole('button', { name: 'Send the photos' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(writes(sent)[0]?.body).not.toHaveProperty('expiresOn')

    await openLinkDialog()
    expect(screen.getByLabelText('Link expires')).toHaveValue('2027-04-06')
    await user().click(screen.getByRole('button', { name: 'Save the link' }))

    await waitFor(() => expect(writes(sent)).toHaveLength(2))
    expect(writes(sent)[1]?.body).toMatchObject({ url: DELIVERY_LINK, expiresOn: '2027-04-06' })
  })
})
