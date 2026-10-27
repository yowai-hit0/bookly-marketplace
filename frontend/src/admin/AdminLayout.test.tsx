import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { readSession, saveSession } from '@/auth/session'
import { formatDateTime } from '@/lib/format'
import { json, stubApi } from '@/test/fetch'
import { STUDIO_SUBSCRIPTION_URL, type StudioStatus, studioMeBody } from '@/test/studio-me'
import { AdminLayout } from './AdminLayout'
import { useStudioRefresh } from './studio-refresh'
import { useSubscriptionRefresh } from './subscription-refresh'

/**
 * The studio shell (`design-system/bookly/pages/admin-shell.md`), restyled in
 * Phase 3 section 5 from a top bar to a sidebar that reflows; named "Studio"
 * and given its Phase 7 nav and one banner from `/api/studio/me`.
 *
 * Two of these are load-bearing beyond this file: the wordmark must not be a
 * level-1 heading, because `e2e/admin-bookings.spec.ts` looks up an unqualified
 * `heading level 1` and a second one makes it ambiguous; and the nav links keep
 * their accessible names, which `e2e/admin-catalogue.spec.ts` navigates by.
 */

const SESSION_KEY = 'bookly.studio.session'
const SESSION = JSON.stringify({ token: 'test.token.signature', expiresAt: '2099-01-01T00:00:00.000Z' })
const ME = '/api/studio/me'

function renderShell(path = '/studio/availability') {
  const router = createMemoryRouter(
    [
      {
        path: '/studio',
        element: <AdminLayout />,
        children: [
          { path: 'availability', element: <main><h1>Availability</h1></main> },
          { path: 'bookings', element: <main><h1>Bookings</h1></main> },
          { path: 'bookings/:id', element: <main><h1>One booking</h1></main> },
          { path: 'earnings', element: <main><h1>Earnings</h1></main> },
          { path: 'payouts/:id', element: <main><h1>One payout</h1></main> },
          { path: 'payout-method', element: <main><h1>Payout method</h1></main> },
          { path: 'subscription', element: <main><h1>Subscription</h1></main> },
          { path: 'setup', element: <SubmitProbe /> },
          { path: 'profile', element: <main><h1>Profile</h1></main> },
          { path: 'portfolio', element: <main><h1>Portfolio</h1></main> },
          { path: 'paid', element: <RefreshProbe /> },
          { path: 'nowhere', element: <main><h1>Nowhere</h1></main> },
        ],
      },
      { path: '/studio/login', element: <LoginProbe /> },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

/** Stands in for the subscription page once a payment settles: asks the layout to read again. */
function RefreshProbe() {
  const refresh = useSubscriptionRefresh()
  return (
    <main>
      <h1>Paid</h1>
      <button type="button" onClick={refresh}>
        Payment settled
      </button>
    </main>
  )
}

/** Stands in for the setup page once the studio is submitted. */
function SubmitProbe() {
  const refresh = useStudioRefresh()
  return (
    <main>
      <h1>Setup</h1>
      <button type="button" onClick={refresh}>
        Submitted
      </button>
    </main>
  )
}

function LoginProbe() {
  const { search } = useLocation()
  return (
    <main>
      <h1>Studio sign in</h1>
      <p>{search}</p>
    </main>
  )
}

type Me = ReturnType<typeof studioMeBody>

/** `/api/studio/me` answers each of `answers` in turn (the last one repeats); nothing else is asked. */
function stubMe(...answers: (Me | (() => Response | Promise<Response>))[]) {
  let call = 0
  return stubApi(({ url }) => {
    if (url !== ME) return undefined
    const answer = answers[Math.min(call, answers.length - 1)] ?? studioMeBody()
    call += 1
    return typeof answer === 'function' ? answer() : json(answer)
  })
}

function nav() {
  return screen.getByRole('navigation', { name: 'Studio' })
}

function banner() {
  return document.querySelector('[data-studio-banner]')
}

/** Lets every answer settle, so a test can say there is no banner. */
async function settled(api: ReturnType<typeof stubApi>, calls: number) {
  await waitFor(() => expect(api.sent).toHaveLength(calls))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const DAY = 24 * 60 * 60 * 1000

/** An instant `days` from now, as the API would send it. */
function inDays(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString()
}

beforeEach(() => {
  sessionStorage.setItem(SESSION_KEY, SESSION)
  stubMe(studioMeBody())
})

afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('the studio shell', () => {
  it('leaves the only level-1 heading to the page inside it', () => {
    renderShell()

    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]).toHaveTextContent('Availability')
    // The wordmark is present, and is not a heading.
    expect(screen.getByText('Bookly').tagName).toBe('SPAN')
  })

  it('opens with a skip link that targets the outlet container', () => {
    renderShell()

    const skip = screen.getByRole('link', { name: 'Skip to content' })
    expect(skip).toHaveAttribute('href', '#admin-content')

    const focusable = document.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])')
    expect(focusable[0]).toBe(skip)
    expect(document.querySelector('#admin-content')).toHaveAttribute('tabindex', '-1')
  })

  it('is named "Studio", not "Admin"', () => {
    renderShell()

    expect(nav()).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Admin' })).not.toBeInTheDocument()
  })

  it('lists the nine pages in order for an approved studio, Profile and Portfolio (Phase 7) among them, and no Setup', async () => {
    const api = stubMe(studioMeBody('approved'))
    renderShell()
    await settled(api, 1)

    const links = within(nav()).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([
      'Calendar',
      'Bookings',
      'Catalogue',
      'Availability',
      'Profile',
      'Portfolio',
      'Earnings',
      'Subscription',
      'Settings',
    ])
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/studio/calendar',
      '/studio/bookings',
      '/studio/catalogue',
      '/studio/availability',
      '/studio/profile',
      '/studio/portfolio',
      '/studio/earnings',
      '/studio/subscription',
      '/studio/settings',
    ])
  })

  it('puts Setup first while the studio is pending, submitted or not', async () => {
    stubMe(studioMeBody('pending', { submittedAt: '2026-10-20T08:00:00.000Z' }))
    renderShell()

    await waitFor(() => expect(within(nav()).getAllByRole('link')[0]).toHaveTextContent('Setup'))
    expect(within(nav()).getByRole('link', { name: 'Setup' })).toHaveAttribute('href', '/studio/setup')
    expect(within(nav()).getAllByRole('link')).toHaveLength(10)
  })

  it.each<StudioStatus>(['approved', 'suspended'])('shows no Setup link once %s', async (status) => {
    const api = stubMe(studioMeBody(status))
    renderShell()
    await settled(api, 1)

    expect(within(nav()).queryByRole('link', { name: 'Setup' })).not.toBeInTheDocument()
  })

  it('shows no Setup link before /me answers or when it fails, so nothing appears and then vanishes', async () => {
    const api = stubMe(() => json({ error: 'internal_error' }, 500))
    renderShell()
    expect(within(nav()).queryByRole('link', { name: 'Setup' })).not.toBeInTheDocument()

    await settled(api, 1)
    expect(within(nav()).queryByRole('link', { name: 'Setup' })).not.toBeInTheDocument()
  })

  it.each([
    ['/studio/earnings', 'Earnings'],
    ['/studio/payouts/p1', 'Earnings'],
    ['/studio/payout-method', 'Earnings'],
    ['/studio/bookings/b1', 'Bookings'],
    ['/studio/subscription', 'Subscription'],
    ['/studio/profile', 'Profile'],
    ['/studio/portfolio', 'Portfolio'],
  ])('on %s marks %s current, and only that link', (path, current) => {
    renderShell(path)

    const links = within(nav()).getAllByRole('link')
    const marked = links.filter((link) => link.getAttribute('aria-current') === 'page')
    expect(marked.map((link) => link.textContent)).toEqual([current])
    expect(marked[0]?.className).toContain('font-medium')
  })

  it('marks Setup current on the setup page while pending', async () => {
    stubMe(studioMeBody('pending'))
    renderShell('/studio/setup')

    expect(await within(nav()).findByRole('link', { name: 'Setup' })).toHaveAttribute('aria-current', 'page')
  })

  it('marks no link current on a path no section owns', () => {
    renderShell('/studio/nowhere')

    const links = within(nav()).getAllByRole('link')
    expect(links.filter((link) => link.hasAttribute('aria-current'))).toEqual([])
  })

  it('marks the current page with aria-current and a weight change, not colour alone', () => {
    renderShell()

    const current = screen.getByRole('link', { name: 'Availability' })
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(current.className).toContain('font-medium')

    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current')
  })

  it('keeps sign-out named even where its text is visually hidden', () => {
    renderShell()

    // Below `sm` only the icon shows; the accessible name must survive that.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    // Red, as a way out (2026-09-25): the destructive text colour, not a solid fill.
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveClass('text-destructive')
    expect(screen.getByRole('button', { name: 'Sign out' })).not.toHaveClass('bg-destructive')
  })

  it('sends a visitor with no session to sign in, and renders no shell there', () => {
    sessionStorage.clear()
    renderShell()

    expect(screen.getByRole('heading', { level: 1, name: 'Studio sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Studio' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Skip to content' })).not.toBeInTheDocument()
  })

  it('carries where he was going to the sign in, and asks the API nothing', () => {
    sessionStorage.clear()
    const api = stubMe(studioMeBody())
    const router = renderShell('/studio/bookings?stage=confirmed')

    expect(router.state.location.pathname).toBe('/studio/login')
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe('/studio/bookings?stage=confirmed')
    expect(api.sent).toHaveLength(0)
  })

  it('does not open for a platform or account session', () => {
    sessionStorage.clear()
    saveSession('platform', JSON.parse(SESSION))
    saveSession('account', JSON.parse(SESSION))
    const router = renderShell()

    expect(router.state.location.pathname).toBe('/studio/login')
  })

  it('signs out of the studio alone, to its sign in with no return path', async () => {
    saveSession('account', JSON.parse(SESSION))
    const router = renderShell()

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(readSession('studio')).toBeNull())
    expect(router.state.location.pathname).toBe('/studio/login')
    expect(router.state.location.search).toBe('')
    expect(readSession('account')).not.toBeNull()
  })
})

describe('the studio banner (Phase 7, R7.4)', () => {
  it('asks /api/studio/me once with the studio token, and nothing else: the subscription comes with it', async () => {
    const api = stubMe(studioMeBody('approved', { subscription: { status: 'past_due', currentPeriodEndsAt: inDays(-1), graceEndsAt: inDays(6) } }))
    renderShell()

    await waitFor(() => expect(banner()).not.toBeNull())
    await settled(api, 1)
    expect(api.sent).toEqual([expect.objectContaining({ method: 'GET', url: ME })])
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer test.token.signature')
    expect(api.sent.map((call) => call.url)).not.toContain(STUDIO_SUBSCRIPTION_URL)
  })

  it('tells a pending studio that has not submitted to finish its setup, linking to it', async () => {
    stubMe(studioMeBody('pending', { submittedAt: null }))
    renderShell()

    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', 'setup'))
    expect(banner()).toHaveTextContent("Finish setting up your studio and submit it for review. Clients can't find or book you until it is approved.")
    expect(within(banner() as HTMLElement).getByRole('link', { name: 'Go to setup' })).toHaveAttribute('href', '/studio/setup')
    // Above the page, inside the content the skip link leads to.
    expect(banner()?.closest('#admin-content')).not.toBeNull()
  })

  it('tells a submitted studio it is waiting for review, with nothing to click', async () => {
    stubMe(studioMeBody('pending', { submittedAt: '2026-10-20T08:00:00.000Z' }))
    renderShell()

    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', 'awaiting_review'))
    expect(banner()).toHaveTextContent('Your studio is waiting for review: the Bookly team will email you once it is approved.')
    expect(within(banner() as HTMLElement).queryByRole('link')).not.toBeInTheDocument()
  })

  it('says a suspended studio is hidden, with the reason as plain text', async () => {
    stubMe(studioMeBody('suspended', { suspensionReason: '<b>Photos</b> that are not your own.' }))
    renderShell()

    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', 'suspended'))
    expect(banner()).toHaveTextContent("Your studio is suspended: clients can't find or book you. Bookings you already have carry on.")
    expect(banner()).toHaveTextContent('Reason: <b>Photos</b> that are not your own.')
    expect(banner()?.querySelector('b')).toBeNull()
  })

  it.each([null, '', '   '])('says a suspended studio is hidden without a reason line when the reason is %j', async (reason) => {
    stubMe(studioMeBody('suspended', { suspensionReason: reason }))
    renderShell()

    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', 'suspended'))
    expect(banner()).not.toHaveTextContent('Reason:')
  })

  it('puts suspended before a lapsed subscription: one banner at a time', async () => {
    stubMe(studioMeBody('suspended', { subscription: { status: 'past_due', currentPeriodEndsAt: inDays(-1), graceEndsAt: inDays(6) } }))
    renderShell()

    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', 'suspended'))
    expect(document.querySelectorAll('[data-studio-banner]')).toHaveLength(1)
  })

  it('puts pending before a subscription the API somehow sent', async () => {
    stubMe(studioMeBody('pending', { subscription: { status: 'trialing', endingSoon: true } }))
    renderShell()

    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', 'setup'))
    expect(document.querySelectorAll('[data-studio-banner]')).toHaveLength(1)
  })

  it('says a past-due subscription ended, that clients cannot book, and when the profile is hidden, linking to the subscription', async () => {
    const ended = inDays(-2)
    const hidden = inDays(5)
    stubMe(studioMeBody('approved', { subscription: { status: 'past_due', currentPeriodEndsAt: ended, graceEndsAt: hidden, takingBookings: false } }))
    renderShell()

    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', 'past_due'))
    expect(banner()).toHaveTextContent(
      `Your subscription ended ${formatDateTime(ended)}. Clients can't book you, and your profile is hidden after ${formatDateTime(hidden)}.`,
    )
    expect(within(banner() as HTMLElement).getByRole('link', { name: 'Go to subscription' })).toHaveAttribute('href', '/studio/subscription')
  })

  it('says an expired subscription hides the profile until he pays', async () => {
    stubMe(studioMeBody('approved', { subscription: { status: 'expired', currentPeriodEndsAt: inDays(-10), graceEndsAt: inDays(-3) } }))
    renderShell()

    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', 'expired'))
    expect(banner()).toHaveTextContent('Your subscription has expired and your profile is hidden. Pay to come back.')
  })

  it.each([
    ['trialing', 'trial_ending', 'Your free trial ends'],
    ['active', 'period_ending', 'Your subscription ends'],
  ] as const)('warns a %s subscription the API says ends soon, with the date', async (status, kind, words) => {
    const end = inDays(3)
    stubMe(studioMeBody('approved', { subscription: { status, currentPeriodEndsAt: end, endingSoon: true } }))
    renderShell()

    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', kind))
    expect(banner()).toHaveTextContent(`${words} ${formatDateTime(end)}. Pay to keep taking bookings.`)
    expect(within(banner() as HTMLElement).getByRole('link', { name: 'Go to subscription' })).toHaveAttribute('href', '/studio/subscription')
  })

  it.each(['trialing', 'active'] as const)('says nothing for a %s subscription the API says is not ending soon, whatever its date', async (status) => {
    // Two days away, but the platform's reminder window decides, not the browser.
    const api = stubMe(studioMeBody('approved', { subscription: { status, currentPeriodEndsAt: inDays(2), endingSoon: false } }))
    renderShell()

    await settled(api, 1)
    expect(banner()).toBeNull()
  })

  it('says nothing for an approved studio with no subscription', async () => {
    const api = stubMe(studioMeBody('approved', { subscription: null }))
    renderShell()

    await settled(api, 1)
    expect(banner()).toBeNull()
  })

  it('keeps the moderation banner when the subscription part is unreadable', async () => {
    const body = { ...studioMeBody('suspended'), subscription: { status: 'mystery' } }
    stubMe(() => json(body))
    renderShell()

    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', 'suspended'))
  })

  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a body without a photographer', () => json({ user: {} })],
    ['an unknown status', () => json({ photographer: { status: 'mystery' } })],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows nothing on %s, and keeps the shell', async (_label, respond) => {
    const api = stubMe(respond)
    renderShell()

    await settled(api, 1)
    expect(banner()).toBeNull()
    expect(nav()).toBeInTheDocument()
  })

  it('drops the subscription banners on the subscription page, which says it all itself', async () => {
    const api = stubMe(studioMeBody('approved', { subscription: { status: 'expired' } }))
    renderShell('/studio/subscription')

    await settled(api, 1)
    expect(banner()).toBeNull()
  })

  it('drops the pending banners on the setup page, and keeps a suspended one there', async () => {
    const api = stubMe(studioMeBody('pending'))
    renderShell('/studio/setup')
    await settled(api, 1)
    expect(banner()).toBeNull()
  })

  it('keeps the suspended banner on the setup page', async () => {
    stubMe(studioMeBody('suspended'))
    renderShell('/studio/setup')

    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', 'suspended'))
  })

  it('reads /me again when a page reports a payment settled, and drops the banner', async () => {
    const api = stubMe(
      studioMeBody('approved', { subscription: { status: 'past_due', currentPeriodEndsAt: inDays(-1), graceEndsAt: inDays(6) } }),
      studioMeBody('approved', { subscription: { status: 'active', currentPeriodEndsAt: inDays(30), graceEndsAt: inDays(37) } }),
    )
    renderShell('/studio/paid')

    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', 'past_due'))
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Payment settled' }))

    await waitFor(() => expect(banner()).toBeNull())
    expect(api.sent.map((call) => call.url)).toEqual([ME, ME])
  })

  it('reads /me again when the studio is submitted, so the banner turns to waiting for review', async () => {
    const api = stubMe(studioMeBody('pending'), studioMeBody('pending', { submittedAt: '2026-10-25T08:00:00.000Z' }))
    const router = renderShell('/studio/setup')
    await settled(api, 1)

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Submitted' }))
    await settled(api, 2)
    await router.navigate('/studio/profile')

    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', 'awaiting_review'))
  })

  it('keeps the last banner when a re-read fails', async () => {
    const api = stubMe(studioMeBody('pending'), () => json({ error: 'internal_error' }, 500))
    renderShell('/studio/paid')
    await waitFor(() => expect(banner()).toHaveAttribute('data-studio-banner', 'setup'))

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Payment settled' }))
    await settled(api, 2)
    expect(banner()).toHaveAttribute('data-studio-banner', 'setup')
  })

  it('on a 401 drops the studio session and leaves for the sign in', async () => {
    stubMe(() => json({ error: 'invalid_token' }, 401))
    const router = renderShell()

    await waitFor(() => expect(router.state.location.pathname).toBe('/studio/login'))
    expect(readSession('studio')).toBeNull()
  })
})
