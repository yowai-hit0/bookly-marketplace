import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { readSession, saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import { type StudioStatus, studioMeBody } from '@/test/studio-me'
import { AdminLayout } from './AdminLayout'

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

  it('lists the six pages in order, Earnings among them (Phase 4), each keeping the name the e2e suite navigates by', () => {
    renderShell()

    const nav = screen.getByRole('navigation', { name: 'Admin' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([
      'Calendar',
      'Bookings',
      'Catalogue',
      'Availability',
      'Earnings',
      'Settings',
    ])
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/studio/calendar',
      '/studio/bookings',
      '/studio/catalogue',
      '/studio/availability',
      '/studio/earnings',
      '/studio/settings',
    ])
  })

  it.each([
    ['/studio/earnings', 'Earnings'],
    ['/studio/payouts/p1', 'Earnings'],
    ['/studio/payout-method', 'Earnings'],
    ['/studio/bookings/b1', 'Bookings'],
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

    await waitFor(() => expect(api.sent).toHaveLength(1))
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
