import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { readSession, saveSession } from '@/auth/session'
import { formatDateTime } from '@/lib/format'
import { json, stubApi } from '@/test/fetch'
import { STUDIO_SUBSCRIPTION_URL, type StudioStatus, studioMeBody, studioSubscriptionBody } from '@/test/studio-me'
import { AdminLayout } from './AdminLayout'
import { useSubscriptionRefresh } from './subscription-refresh'

/**
 * The admin shell (`design-system/bookly/pages/admin-shell.md`), restyled in
 * Phase 3 section 5 from a top bar to a sidebar that reflows.
 *
 * Two of these are load-bearing beyond this file: the wordmark must not be a
 * level-1 heading, because `e2e/admin-bookings.spec.ts` looks up an unqualified
 * `heading level 1` and a second one makes it ambiguous; and the nav links keep
 * their accessible names, which `e2e/admin-catalogue.spec.ts` navigates by.
 */

const SESSION_KEY = 'bookly.studio.session'
const SESSION = JSON.stringify({ token: 'test.token.signature', expiresAt: '2099-01-01T00:00:00.000Z' })

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

/** Stands in for the subscription page once a payment settles: asks the layout to read the subscription again. */
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

function LoginProbe() {
  const { search } = useLocation()
  return (
    <main>
      <h1>Admin sign in</h1>
      <p>{search}</p>
    </main>
  )
}

/** `/api/studio/me` answers `status`; nothing else is asked. */
function stubMe(status: StudioStatus = 'approved') {
  return stubApi(({ url }) => (url === '/api/studio/me' ? json(studioMeBody(status)) : undefined))
}

beforeEach(() => {
  sessionStorage.setItem(SESSION_KEY, SESSION)
  stubMe()
})

afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('the admin shell', () => {
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

  it('lists the seven pages in order, Earnings (Phase 4) and Subscription (Phase 5) among them, each keeping the name the e2e suite navigates by', () => {
    renderShell()

    const nav = screen.getByRole('navigation', { name: 'Admin' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([
      'Calendar',
      'Bookings',
      'Catalogue',
      'Availability',
      'Earnings',
      'Subscription',
      'Settings',
    ])
    expect(links).toHaveLength(7)
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/studio/calendar',
      '/studio/bookings',
      '/studio/catalogue',
      '/studio/availability',
      '/studio/earnings',
      '/studio/subscription',
      '/studio/settings',
    ])
  })

  it.each([
    ['/studio/earnings', 'Earnings'],
    ['/studio/payouts/p1', 'Earnings'],
    ['/studio/payout-method', 'Earnings'],
    ['/studio/bookings/b1', 'Bookings'],
    ['/studio/subscription', 'Subscription'],
  ])('on %s marks %s current, and only that link', (path, current) => {
    renderShell(path)

    const links = within(screen.getByRole('navigation', { name: 'Admin' })).getAllByRole('link')
    const marked = links.filter((link) => link.getAttribute('aria-current') === 'page')
    expect(marked.map((link) => link.textContent)).toEqual([current])
    expect(marked[0]?.className).toContain('font-medium')
  })

  it('marks no link current on a path no section owns', () => {
    renderShell('/studio/nowhere')

    const links = within(screen.getByRole('navigation', { name: 'Admin' })).getAllByRole('link')
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

    expect(screen.getByRole('heading', { level: 1, name: 'Admin sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Admin' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Skip to content' })).not.toBeInTheDocument()
  })

  it('carries where he was going to the sign in, and asks the API nothing', () => {
    sessionStorage.clear()
    const api = stubMe()
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

describe('the studio status banner (Phase 2)', () => {
  it('asks /api/studio/me with the studio token', async () => {
    const api = stubMe('pending')
    renderShell()

    await screen.findByText(/Your profile is waiting for approval/)
    expect(api.sent).toEqual([expect.objectContaining({ method: 'GET', url: '/api/studio/me' })])
    expect(api.sent[0]?.headers.get('Authorization')).toBe('Bearer test.token.signature')
  })

  it('says a pending profile cannot be found or booked yet', async () => {
    stubMe('pending')
    renderShell()

    expect(await screen.findByText("Your profile is waiting for approval: clients can't find or book you yet.")).toBeInTheDocument()
    // Above the page, inside the content the skip link leads to.
    const banner = document.querySelector('[data-studio-status="pending"]')
    expect(banner?.closest('#admin-content')).not.toBeNull()
  })

  it('says a suspended studio is hidden, and that its bookings carry on', async () => {
    stubMe('suspended')
    renderShell()

    expect(
      await screen.findByText("Your studio is suspended: clients can't find or book you. Bookings you already have carry on."),
    ).toBeInTheDocument()
  })

  it('shows nothing once approved', async () => {
    const api = stubMe('approved')
    renderShell()

    // Approved, the layout reads the subscription too (Phase 5); unanswered here, it adds no banner.
    await waitFor(() => expect(api.sent).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.querySelector('[data-studio-status]')).toBeNull()
  })

  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a body without a photographer', () => json({ user: {} })],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows nothing on %s, and keeps the shell', async (_label, respond) => {
    const api = stubApi(() => respond())
    renderShell()

    await waitFor(() => expect(api.sent).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.querySelector('[data-studio-status]')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Admin' })).toBeInTheDocument()
  })

  it('on a 401 drops the studio session and leaves for the sign in', async () => {
    stubApi(() => json({ error: 'invalid_token' }, 401))
    const router = renderShell()

    await waitFor(() => expect(router.state.location.pathname).toBe('/studio/login'))
    expect(readSession('studio')).toBeNull()
  })
})

describe('the subscription banner (Phase 5, R5.5)', () => {
  const DAY = 24 * 60 * 60 * 1000

  /** An instant `days` from now, as the API would send it. */
  function inDays(days: number): string {
    return new Date(Date.now() + days * DAY).toISOString()
  }

  type Subscription = ReturnType<typeof studioSubscriptionBody>['subscription']
  type Answer = Partial<Subscription> | null | (() => Response | Promise<Response>)

  /** `/me` answers `status`; the subscription answers each of `answers` in turn (the last one repeats). */
  function stubLayout(status: StudioStatus, ...answers: Answer[]) {
    let call = 0
    return stubApi(({ url }) => {
      if (url === '/api/studio/me') return json(studioMeBody(status))
      if (url !== STUDIO_SUBSCRIPTION_URL) return undefined
      const answer = answers[Math.min(call, answers.length - 1)]
      call += 1
      if (typeof answer === 'function') return answer()
      const body = studioSubscriptionBody()
      return json({ ...body, subscription: answer === null || answer === undefined ? null : { ...body.subscription, ...answer } })
    })
  }

  function banner() {
    return document.querySelector('[data-subscription-banner]')
  }

  /** Lets every answer settle, so a test can say there is no banner. */
  async function settled(api: ReturnType<typeof stubApi>, calls: number) {
    await waitFor(() => expect(api.sent).toHaveLength(calls))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('asks for the subscription with the studio token, once /me says approved', async () => {
    const api = stubLayout('approved', { status: 'past_due', currentPeriodEndsAt: inDays(-1), graceEndsAt: inDays(6) })
    renderShell()

    await waitFor(() => expect(banner()).not.toBeNull())
    expect(api.sent.map((call) => call.url)).toEqual(['/api/studio/me', STUDIO_SUBSCRIPTION_URL])
    expect(api.sent[1]?.headers.get('Authorization')).toBe('Bearer test.token.signature')
  })

  it.each<StudioStatus>(['pending', 'suspended'])('never asks for it while %s: he cannot pay, so no banner asks him to', async (status) => {
    const api = stubLayout(status, { status: 'expired' })
    renderShell()

    await screen.findByText(status === 'pending' ? /waiting for approval/ : /is suspended/)
    await settled(api, 1)
    expect(api.sent.map((call) => call.url)).toEqual(['/api/studio/me'])
    expect(banner()).toBeNull()
  })

  it('says a past-due subscription ended, that clients cannot book, and when the profile is hidden, linking to the subscription', async () => {
    const ended = inDays(-2)
    const hidden = inDays(5)
    stubLayout('approved', { status: 'past_due', currentPeriodEndsAt: ended, graceEndsAt: hidden })
    renderShell()

    await waitFor(() => expect(banner()).toHaveAttribute('data-subscription-banner', 'past_due'))
    expect(banner()).toHaveTextContent(
      `Your subscription ended ${formatDateTime(ended)}. Clients can't book you, and your profile is hidden after ${formatDateTime(hidden)}.`,
    )
    const link = within(banner() as HTMLElement).getByRole('link', { name: 'Go to subscription' })
    expect(link).toHaveAttribute('href', '/studio/subscription')
    // Above the page, inside the content the skip link leads to.
    expect(banner()?.closest('#admin-content')).not.toBeNull()
  })

  it('says an expired subscription hides the profile until he pays', async () => {
    stubLayout('approved', { status: 'expired', currentPeriodEndsAt: inDays(-10), graceEndsAt: inDays(-3) })
    renderShell()

    await waitFor(() => expect(banner()).toHaveAttribute('data-subscription-banner', 'expired'))
    expect(banner()).toHaveTextContent('Your subscription has expired and your profile is hidden. Pay to come back.')
    expect(within(banner() as HTMLElement).getByRole('link', { name: 'Go to subscription' })).toHaveAttribute('href', '/studio/subscription')
  })

  it.each([
    ['trialing', 3, 'trial_ending', 'Your free trial ends'],
    ['trialing', 0.5, 'trial_ending', 'Your free trial ends'],
    ['trialing', 7, 'trial_ending', 'Your free trial ends'],
    ['active', 6, 'period_ending', 'Your subscription ends'],
    ['active', 1, 'period_ending', 'Your subscription ends'],
  ] as const)('warns a %s subscription ending in %s days', async (status, days, kind, words) => {
    const end = inDays(days)
    stubLayout('approved', { status, currentPeriodEndsAt: end })
    renderShell()

    await waitFor(() => expect(banner()).toHaveAttribute('data-subscription-banner', kind))
    expect(banner()).toHaveTextContent(`${words} ${formatDateTime(end)}. Pay to keep taking bookings.`)
    expect(within(banner() as HTMLElement).getByRole('link', { name: 'Go to subscription' })).toHaveAttribute('href', '/studio/subscription')
  })

  it.each([
    ['trialing', 8],
    ['active', 7.5],
    ['active', 30],
    ['trialing', 200],
  ] as const)('says nothing for a %s subscription ending in %s days', async (status, days) => {
    const api = stubLayout('approved', { status, currentPeriodEndsAt: inDays(days) })
    renderShell()

    await settled(api, 2)
    expect(banner()).toBeNull()
  })

  it('says nothing for a photographer never approved into a subscription (null)', async () => {
    const api = stubLayout('approved', null)
    renderShell()

    await settled(api, 2)
    expect(banner()).toBeNull()
  })

  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a body without prices', () => json({ subscription: null })],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('says nothing on %s, and keeps the shell', async (_label, respond) => {
    const api = stubLayout('approved', respond)
    renderShell()

    await settled(api, 2)
    expect(banner()).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Admin' })).toBeInTheDocument()
  })

  it('is not repeated on the subscription page, which says it all itself', async () => {
    const api = stubLayout('approved', { status: 'expired', currentPeriodEndsAt: inDays(-10), graceEndsAt: inDays(-3) })
    renderShell('/studio/subscription')

    await settled(api, 2)
    expect(banner()).toBeNull()
  })

  it('reads the subscription again when a page reports a payment settled, and drops the banner', async () => {
    const api = stubLayout(
      'approved',
      { status: 'past_due', currentPeriodEndsAt: inDays(-1), graceEndsAt: inDays(6) },
      { status: 'active', currentPeriodEndsAt: inDays(30), graceEndsAt: inDays(37) },
    )
    renderShell('/studio/paid')

    await waitFor(() => expect(banner()).toHaveAttribute('data-subscription-banner', 'past_due'))

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Payment settled' }))

    await waitFor(() => expect(banner()).toBeNull())
    expect(api.sent.map((call) => call.url)).toEqual(['/api/studio/me', STUDIO_SUBSCRIPTION_URL, STUDIO_SUBSCRIPTION_URL])
  })

  it('on a 401 from the subscription drops the studio session and leaves for the sign in', async () => {
    stubLayout('approved', () => json({ error: 'invalid_token' }, 401))
    const router = renderShell()

    await waitFor(() => expect(router.state.location.pathname).toBe('/studio/login'))
    expect(readSession('studio')).toBeNull()
  })
})
