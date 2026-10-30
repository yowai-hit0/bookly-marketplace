import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { saveSession } from '@/auth/session'
import type { PlatformPhotographer, PlatformPhotographerDetail } from '@/platform/photographers'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'

/**
 * `/platform/photographers/:id` (Phase 9, R9.1, R9.4): one photographer in
 * full from one read -- timeline, profile, setup, subscription, the payout
 * method MASKED (decision 4) with its 72-hour warning, booking counts,
 * earnings (a negative payable shown as such), recent activity -- and the
 * list's own moderation, after which the page reads the photographer again.
 * Also the list's link here, and Back to the list's view.
 */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }
const ID = '0b7d6f4e-1c2a-4e3b-9a8f-5d6c7b8a9e0f'

function photographerRow(overrides: Partial<PlatformPhotographer> = {}): PlatformPhotographer {
  return {
    id: ID,
    handle: 'kigali-lens',
    displayName: 'Kigali Lens',
    email: 'lens@kigali.example',
    status: 'approved',
    createdAt: '2026-10-01T08:00:00.000Z',
    approvedAt: '2026-10-03T08:00:00.000Z',
    approvedByUserId: 'u1',
    suspendedAt: null,
    suspensionReason: null,
    submittedAt: '2026-10-02T08:00:00.000Z',
    handleChangedAt: null,
    ...overrides,
  }
}

function detail(overrides: Partial<PlatformPhotographerDetail> = {}, row: Partial<PlatformPhotographer> = {}): PlatformPhotographerDetail {
  return {
    photographer: { ...photographerRow(row), approvedBy: { id: 'u1', email: 'admin@bookly.example' } },
    profile: {
      bio: 'Portraits and <script>alert(1)</script> weddings.',
      contactPhone: '+250788123456',
      whatsappPhone: null,
      contactEmail: 'hello@kigali-lens.example',
      coverImageUrl: 'https://images.example/cover.jpg',
      districts: [
        { code: 'gasabo', name: 'Gasabo' },
        { code: 'kicukiro', name: 'Kicukiro' },
      ],
      categories: [
        { slug: 'portrait', name: 'Portrait', isActive: true },
        { slug: 'drone', name: 'Drone', isActive: false },
      ],
    },
    setup: {
      items: [
        { key: 'profile', done: true },
        { key: 'categories', done: true },
        { key: 'districts', done: true },
        { key: 'payoutMethod', done: true },
        { key: 'services', done: false },
        { key: 'workingHours', done: true },
      ],
      missing: ['services'],
      canSubmit: false,
    },
    subscription: {
      id: 's1',
      status: 'trialing',
      currentPeriodEndsAt: '2026-11-02T08:00:00.000Z',
      graceEndsAt: '2026-11-09T08:00:00.000Z',
      createdAt: '2026-10-03T08:00:00.000Z',
      takingBookings: true,
      periods: [{ id: 'per1', kind: 'trial', planInterval: null, priceRwf: 0, startsAt: '2026-10-03T08:00:00.000Z', endsAt: '2026-11-02T08:00:00.000Z', paidAt: null }],
    },
    payoutMethod: { id: 'm1', kind: 'momo', provider: 'mtn', accountName: 'Jean Mugabo', last4: '3456', createdAt: '2026-10-26T08:00:00.000Z' },
    methodChangedRecently: true,
    counts: {
      bookings: { pending_payment: 1, confirmed: 4, completed: 7, no_show: 0, expired: 2, cancelled_by_client: 1, cancelled_by_photographer: 0, cancelled_by_platform: 0 },
      services: { total: 3, active: 2 },
    },
    earnings: { payableRwf: 120_000, inDraftRwf: 45_000, paidOutRwf: 300_000 },
    activity: [
      {
        id: 'a1',
        action: 'photographer_approved',
        actor: { id: 'u1', email: 'admin@bookly.example' },
        target: { type: 'photographer', id: ID },
        photographer: { id: ID, handle: 'kigali-lens', displayName: 'Kigali Lens' },
        details: { status: 'approved', trialStarted: true, trialEndsAt: '2026-11-02T08:00:00.000Z' },
        createdAt: '2026-10-03T08:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

type Api = ReturnType<typeof stubApi>

/** The API over one photographer: `reads` answers each GET of the detail in turn (the last one repeats). */
function api(reads: (() => Response)[], onPost?: (call: Sent) => Response): Api {
  let read = 0
  return stubApi((call) => {
    const url = new URL(call.url, 'http://test')
    if (call.method === 'GET' && url.pathname === `/api/platform/photographers/${ID}`) {
      const answer = reads[Math.min(read, reads.length - 1)]
      read += 1
      return answer?.()
    }
    if (call.method === 'GET' && url.pathname === '/api/platform/photographers') return json({ photographers: [photographerRow({ status: 'pending' })] })
    if (call.method === 'POST' && onPost !== undefined) return onPost(call)
    return undefined
  })
}

function renderAt(path = `/platform/photographers/${ID}`, state?: unknown) {
  const router = createMemoryRouter(routes, { initialEntries: [state === undefined ? path : { pathname: path, state }] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

async function loaded() {
  return screen.findByRole('heading', { level: 1, name: 'Kigali Lens' })
}

function section(name: string) {
  return within(screen.getByRole('region', { name }))
}

beforeEach(() => saveSession('platform', SESSION))
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  delete document.documentElement.dataset.adminTheme
})

describe('the photographer detail page', () => {
  it('shows a loading region first, then the photographer from one read', async () => {
    const calls = api([() => json(detail())])
    renderAt()
    expect(screen.getByText('Loading the photographer…')).toBeInTheDocument()
    await loaded()
    expect(calls.sent.filter((call) => call.method === 'GET').map((call) => call.url)).toEqual([`/api/platform/photographers/${ID}`])
    expect(calls.sent[0]?.headers.get('Authorization')).toBe('Bearer platform.jwt')
    expect(screen.getByText('/p/kigali-lens')).toBeInTheDocument()
    expect(screen.getByText('lens@kigali.example')).toBeInTheDocument()
    expect(document.querySelector('[data-photographer-status="approved"]')).not.toBeNull()
    expect(screen.getByRole('link', { name: /View public profile/ })).toHaveAttribute('href', '/p/kigali-lens')
  })

  it('tells the timeline in order: signed up, submitted, approved by whom', async () => {
    api([() => json(detail())])
    renderAt()
    await loaded()
    const items = section('Timeline').getAllByRole('listitem')
    expect(items.map((item) => item.getAttribute('data-event'))).toEqual(['signedUp', 'submitted', 'approved'])
    expect(items[2]).toHaveTextContent('Approved by admin@bookly.example')
    expect(items[2]).toHaveTextContent('3 Oct 2026, 10:00')
  })

  it('adds a handle change and a suspension with its reason, as plain text, and says when the approver is unknown', async () => {
    const d = detail({}, { status: 'suspended', suspendedAt: '2026-10-20T08:00:00.000Z', suspensionReason: '<b>Fake</b> portfolio.', handleChangedAt: '2026-10-02T12:00:00.000Z' })
    d.photographer.approvedBy = null
    api([() => json(d)])
    renderAt()
    await loaded()
    const timeline = section('Timeline')
    expect(timeline.getAllByRole('listitem').map((item) => item.getAttribute('data-event'))).toEqual(['signedUp', 'submitted', 'handleChanged', 'approved', 'suspended'])
    expect(timeline.getByText('Handle changed to /p/kigali-lens')).toBeInTheDocument()
    expect(timeline.getByText('Approved by a platform admin')).toBeInTheDocument()
    expect(timeline.getByText('Reason: <b>Fake</b> portfolio.')).toBeInTheDocument()
    expect(document.querySelector('b')).toBeNull()
    // Only an approved studio has a public page to open.
    expect(screen.queryByRole('link', { name: /View public profile/ })).toBeNull()
  })

  it('says a pending studio has not submitted, with Approve held back and the reason beside it', async () => {
    const d = detail({ subscription: null }, { status: 'pending', submittedAt: null, approvedAt: null, approvedByUserId: null })
    d.photographer.approvedBy = null
    api([() => json(d)])
    renderAt()
    await loaded()
    expect(section('Timeline').getByText('Not submitted for review yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve Kigali Lens' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Approve Kigali Lens' })).toHaveAccessibleDescription('Not submitted for review yet')
    expect(section('Subscription').getByText('No subscription yet: it starts when the studio is approved.')).toBeInTheDocument()
  })

  it('shows the profile as plain text, a hidden category marked, and the districts', async () => {
    api([() => json(detail())])
    renderAt()
    await loaded()
    const profile = section('Profile')
    expect(profile.getByText('Portraits and <script>alert(1)</script> weddings.')).toBeInTheDocument()
    expect(document.querySelector('main script')).toBeNull()
    expect(profile.getByText('+250788123456')).toBeInTheDocument()
    expect(profile.getByText('Not given')).toBeInTheDocument()
    expect(profile.getByText('Gasabo, Kicukiro')).toBeInTheDocument()
    expect(document.querySelector('[data-category="drone"]')).toHaveAttribute('data-inactive')
    expect(document.querySelector('[data-category="drone"]')).toHaveTextContent('Drone(hidden)')
    expect(document.querySelector('[data-category="portrait"]')).not.toHaveAttribute('data-inactive')
    const cover = profile.getByRole('img', { name: 'Cover photo of Kigali Lens' })
    expect(cover).toHaveAttribute('src', 'https://images.example/cover.jpg')
    expect(cover).toHaveAttribute('referrerpolicy', 'no-referrer')
  })

  it('never puts a non-https cover on the page, and says what is missing', async () => {
    api([
      () =>
        json(
          detail({
            profile: { bio: null, contactPhone: null, whatsappPhone: null, contactEmail: null, coverImageUrl: 'javascript:alert(1)', districts: [], categories: [] },
          }),
        ),
    ])
    renderAt()
    await loaded()
    const profile = section('Profile')
    expect(profile.queryByRole('img')).toBeNull()
    expect(profile.getByText('This image could not be loaded.')).toBeInTheDocument()
    expect(profile.getByText('No bio yet')).toBeInTheDocument()
    expect(profile.getByText('No districts yet')).toBeInTheDocument()
    expect(profile.getByText('No categories yet')).toBeInTheDocument()
  })

  it('shows the setup checklist in its order, with the words for each state', async () => {
    api([() => json(detail())])
    renderAt()
    await loaded()
    const setup = section('Setup checklist')
    expect(setup.getByRole('heading', { level: 3, name: '5 of 6 done' })).toBeInTheDocument()
    const rows = setup.getAllByRole('listitem')
    expect(rows.map((row) => row.getAttribute('data-setup-item'))).toEqual(['profile', 'categories', 'districts', 'payoutMethod', 'services', 'workingHours'])
    expect(rows[4]).toHaveTextContent('ServicesTo do')
    expect(rows[0]).toHaveTextContent('Your profileDone')
  })

  it('shows the subscription and its periods', async () => {
    api([() => json(detail())])
    renderAt()
    await loaded()
    const subscription = section('Subscription')
    expect(subscription.getByText('Free trial', { selector: '[data-subscription-status] *, [data-subscription-status]' })).toBeInTheDocument()
    expect(subscription.getByText('2 Nov 2026, 10:00')).toBeInTheDocument()
    expect(subscription.getByText('Yes')).toBeInTheDocument()
    expect(subscription.getByRole('table', { name: 'Periods' })).toBeInTheDocument()
    expect(subscription.getByText('Free')).toBeInTheDocument()
  })

  it('shows the payout method masked, never a full number, with the 72-hour warning', async () => {
    api([() => json(detail())])
    renderAt()
    await loaded()
    const payout = section('Payout method')
    expect(payout.getByText('MTN MoMo')).toBeInTheDocument()
    expect(payout.getByText('ending in 3456')).toBeInTheDocument()
    expect(payout.getByText('•••• 3456')).toHaveAttribute('aria-hidden', 'true')
    expect(payout.getByText('Name on the account: Jean Mugabo')).toBeInTheDocument()
    // No run of digits longer than the last four: the full number is never on this page.
    expect(screen.getByRole('region', { name: 'Payout method' }).textContent?.replace(/\d{1,2} \w{3} \d{4}, \d{2}:\d{2}/g, '')).not.toMatch(/\d{5,}/)
    expect(document.querySelector('[data-warning="changed-recently"]')).toHaveTextContent('changed in the last 72 hours')
  })

  it('shows a bank by its name, no warning when unchanged, and says when there is no method', async () => {
    api([() => json(detail({ methodChangedRecently: false, payoutMethod: { id: 'm2', kind: 'bank', provider: 'Bank of Kigali', accountName: 'K L Ltd', last4: '9012', createdAt: '2026-09-01T08:00:00.000Z' } }))])
    const { unmount } = render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [`/platform/photographers/${ID}`] })} />)
    await loaded()
    expect(section('Payout method').getByText('Bank of Kigali')).toBeInTheDocument()
    expect(document.querySelector('[data-warning="changed-recently"]')).toBeNull()
    unmount()

    api([() => json(detail({ payoutMethod: null, methodChangedRecently: false }))])
    renderAt()
    await loaded()
    expect(section('Payout method').getByText('No payout method yet.')).toBeInTheDocument()
  })

  it('counts every booking status, zeros included, and the services', async () => {
    api([() => json(detail())])
    renderAt()
    await loaded()
    const counts = section('Bookings and services')
    expect(document.querySelectorAll('[data-booking-count]')).toHaveLength(8)
    expect(document.querySelector('[data-booking-count="completed"]')).toHaveTextContent('Completed7')
    expect(document.querySelector('[data-booking-count="cancelled_by_platform"]')).toHaveTextContent('Cancelled by Bookly0')
    expect(counts.getByText('3 services, 2 active')).toBeInTheDocument()
  })

  it('shows the earnings, and a negative payable clearly', async () => {
    api([() => json(detail())])
    const { unmount } = render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [`/platform/photographers/${ID}`] })} />)
    await loaded()
    const earnings = section('Earnings')
    expect(earnings.getByText('120,000 RWF')).toBeInTheDocument()
    expect(earnings.getByText('45,000 RWF')).toBeInTheDocument()
    expect(earnings.getByText('300,000 RWF')).toBeInTheDocument()
    expect(document.querySelector('[data-negative-payable]')).toBeNull()
    unmount()

    api([() => json(detail({ earnings: { payableRwf: -15_000, inDraftRwf: 0, paidOutRwf: 0 } }))])
    renderAt()
    await loaded()
    expect(section('Earnings').getByText('-15,000 RWF')).toHaveClass('text-destructive')
    expect(document.querySelector('[data-negative-payable]')).toHaveTextContent('Reversals outweigh new earnings')
  })

  it('lists recent activity, and links to all of it filtered to this photographer', async () => {
    api([() => json(detail())])
    const router = renderAt()
    await loaded()
    const activity = section('Recent activity')
    expect(activity.getByText('Approved Kigali Lens; the free trial ends 2 Nov 2026, 10:00')).toBeInTheDocument()
    // The entry is about this page's photographer: no link to itself.
    expect(activity.queryByRole('link', { name: 'Kigali Lens' })).toBeNull()
    await user().click(activity.getByRole('link', { name: 'See all activity for this photographer' }))
    expect(router.state.location.pathname).toBe('/platform/activity')
    expect(router.state.location.search).toBe(`?photographerId=${ID}`)
    expect(router.state.location.state).toEqual({ photographerId: ID, photographerName: 'Kigali Lens' })
  })

  it('says when nothing is recorded yet', async () => {
    api([() => json(detail({ activity: [] }))])
    renderAt()
    await loaded()
    expect(section('Recent activity').getByText('Nothing recorded for this photographer yet.')).toBeInTheDocument()
  })
})

describe('the states around it', () => {
  it.each([
    [404, 'not_found'],
    [400, 'invalid_request'],
  ])('a %i says the photographer does not exist', async (status, error) => {
    api([() => json({ error }, status)])
    renderAt()
    expect(await screen.findByRole('heading', { level: 1, name: "This photographer doesn't exist" })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to photographers' })).toHaveAttribute('href', '/platform/photographers')
  })

  it('a failure offers a retry, which reads again', async () => {
    const calls = api([() => json({ error: 'internal' }, 500), () => json(detail())])
    renderAt()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this photographer.')
    await user().click(screen.getByRole('button', { name: 'Try again' }))
    await loaded()
    expect(calls.sent.filter((call) => call.method === 'GET')).toHaveLength(2)
  })

  it('a dropped connection is a failure too, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
    renderAt()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this photographer.')
  })

  it('a 401 leaves the platform for its sign in', async () => {
    api([() => json({ error: 'unauthenticated' }, 401)])
    const router = renderAt()
    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))
  })
})

describe('moderating from the detail page', () => {
  it('suspends with a reason, then reads the photographer again and shows the change', async () => {
    const suspended = detail({}, { status: 'suspended', suspendedAt: '2026-10-27T08:00:00.000Z', suspensionReason: 'Fake portfolio.' })
    const calls = api([() => json(detail()), () => json(suspended)], (call) =>
      json({ photographer: { ...photographerRow(), status: 'suspended', suspendedAt: '2026-10-27T08:00:00.000Z', suspensionReason: (call.body as { reason: string }).reason } }),
    )
    renderAt()
    await loaded()
    const u = user()
    await u.click(screen.getByRole('button', { name: 'Suspend Kigali Lens' }))
    const dialog = screen.getByRole('dialog', { name: 'Suspend Kigali Lens?' })
    // A reason is required, and checked before anything is sent.
    await u.click(within(dialog).getByRole('button', { name: 'Suspend' }))
    expect(within(dialog).getByText('Give a reason, up to 500 characters.')).toBeInTheDocument()
    expect(calls.sent.filter((call) => call.method === 'POST')).toEqual([])

    await u.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Fake portfolio.')
    await u.click(within(dialog).getByRole('button', { name: 'Suspend' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Kigali Lens is suspended.')
    expect(calls.sent.filter((call) => call.method === 'POST').map((call) => [call.url, call.body])).toEqual([
      [`/api/platform/photographers/${ID}/suspend`, { reason: 'Fake portfolio.' }],
    ])
    await waitFor(() => expect(calls.sent.filter((call) => call.method === 'GET' && call.url.endsWith(ID))).toHaveLength(2))
    await waitFor(() => expect(section('Timeline').getByText('Reason: Fake portfolio.')).toBeInTheDocument())
    expect(document.querySelector('[data-photographer-status="suspended"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Reactivate Kigali Lens' })).toBeInTheDocument()
  })

  it('approves a submitted pending studio', async () => {
    const pending = detail({ subscription: null }, { status: 'pending', approvedAt: null, approvedByUserId: null })
    pending.photographer.approvedBy = null
    const calls = api([() => json(pending), () => json(detail())], () => json({ photographer: photographerRow() }))
    renderAt()
    await loaded()
    const u = user()
    await u.click(screen.getByRole('button', { name: 'Approve Kigali Lens' }))
    await u.click(within(screen.getByRole('dialog', { name: 'Approve Kigali Lens?' })).getByRole('button', { name: 'Approve' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Kigali Lens is approved.')
    expect(calls.sent.some((call) => call.method === 'POST' && call.url.endsWith('/approve'))).toBe(true)
    await waitFor(() => expect(section('Subscription').getByRole('table', { name: 'Periods' })).toBeInTheDocument())
  })

  it('a 409 not_submitted says so and refreshes', async () => {
    const pending = detail({ subscription: null }, { status: 'pending', approvedAt: null, approvedByUserId: null })
    pending.photographer.approvedBy = null
    const calls = api([() => json(pending)], () => json({ error: 'not_submitted', photographer: { ...photographerRow({ status: 'pending', approvedAt: null }), submittedAt: null } }, 409))
    renderAt()
    await loaded()
    const u = user()
    await u.click(screen.getByRole('button', { name: 'Approve Kigali Lens' }))
    await u.click(within(screen.getByRole('dialog', { name: 'Approve Kigali Lens?' })).getByRole('button', { name: 'Approve' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Kigali Lens hasn't submitted their studio for review yet, so it can't be approved.")
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(calls.sent.filter((call) => call.method === 'GET' && call.url.endsWith(ID))).toHaveLength(2))
  })

  it('a change another admin made first says so', async () => {
    api([() => json(detail())], () => json({ error: 'invalid_transition', photographer: photographerRow({ status: 'suspended', suspensionReason: 'Other admin.' }) }, 409))
    renderAt()
    await loaded()
    const u = user()
    await u.click(screen.getByRole('button', { name: 'Suspend Kigali Lens' }))
    const dialog = screen.getByRole('dialog', { name: 'Suspend Kigali Lens?' })
    await u.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Spam.')
    await u.click(within(dialog).getByRole('button', { name: 'Suspend' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That change no longer applies: Kigali Lens is now suspended.')
  })

  it('a photographer gone meanwhile turns the page into not-found', async () => {
    api([() => json(detail())], () => json({ error: 'not_found' }, 404))
    renderAt()
    await loaded()
    const u = user()
    await u.click(screen.getByRole('button', { name: 'Suspend Kigali Lens' }))
    const dialog = screen.getByRole('dialog', { name: 'Suspend Kigali Lens?' })
    await u.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Spam.')
    await u.click(within(dialog).getByRole('button', { name: 'Suspend' }))
    expect(await screen.findByRole('heading', { level: 1, name: "This photographer doesn't exist" })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('That photographer no longer exists.')
  })

  it('a failed save stays in the dialog', async () => {
    api([() => json(detail())], () => json({ error: 'internal' }, 500))
    renderAt()
    await loaded()
    const u = user()
    await u.click(screen.getByRole('button', { name: 'Suspend Kigali Lens' }))
    const dialog = screen.getByRole('dialog', { name: 'Suspend Kigali Lens?' })
    await u.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Spam.')
    await u.click(within(dialog).getByRole('button', { name: 'Suspend' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not save the change.')
  })
})

describe('getting here from the list, and back', () => {
  it('each row names the photographer as a link here, and Back returns to the same review view', async () => {
    api([() => json(detail())])
    const router = renderAt('/platform/photographers?review=awaiting')
    const link = await screen.findByRole('link', { name: 'Kigali Lens' })
    expect(link).toHaveAttribute('href', `/platform/photographers/${ID}`)
    const u = user()
    await u.click(link)
    await loaded()
    expect(screen.getByRole('link', { name: 'Back to photographers' })).toHaveAttribute('href', '/platform/photographers?review=awaiting')
    await u.click(screen.getByRole('link', { name: 'Back to photographers' }))
    expect(router.state.location.search).toBe('?review=awaiting')
  })

  it('keeps a status filter, and never carries anything else', async () => {
    api([() => json(detail())])
    renderAt(`/platform/photographers/${ID}`, { listSearch: 'status=suspended' })
    await loaded()
    expect(screen.getByRole('link', { name: 'Back to photographers' })).toHaveAttribute('href', '/platform/photographers?status=suspended')
  })

  it.each([
    [{ listSearch: 'review=nope&next=https://evil.example' }],
    [{ listSearch: 42 }],
    ['junk'],
  ])('falls back to the plain list for state %j', async (state) => {
    api([() => json(detail())])
    renderAt(`/platform/photographers/${ID}`, state)
    await loaded()
    expect(screen.getByRole('link', { name: 'Back to photographers' })).toHaveAttribute('href', '/platform/photographers')
  })
})
