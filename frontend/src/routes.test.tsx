import { render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { routes } from '@/routes'
import { profile } from '@/test/marketplace-fixtures'

/**
 * Every declared path, one level of children included: the client routes hang
 * off a pathless layout route since 2026-09-21, so `routes.map(r => r.path)`
 * no longer sees them.
 */
function declaredPaths(): string[] {
  return routes
    .flatMap((route) => [route.path, ...(route.children ?? []).map((child) => child.path)])
    .filter((path): path is string => path !== undefined)
}

const PROFILE = profile({ services: [] })

function renderAt(path: string) {
  return render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />)
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('routing', () => {
  it('serves the landing page from a plain path', async () => {
    renderAt('/')
    // The wordmark is the shell's link; the page's own h1 is the hero.
    expect(await screen.findByRole('heading', { level: 1, name: 'Find and book photographers across Rwanda' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Bookly' })).toHaveAttribute('href', '/')
  })

  it('wraps the client routes in the shell, including the not-found page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ photographers: [] }))))

    for (const path of ['/', '/photographers', '/nothing-here']) {
      const { unmount } = renderAt(path)
      // By the nav's name, not `banner`: pages render their own inner
      // `<header>`, which Testing Library's role engine also reports as a
      // banner even though it is scoped out of the landmark by `main`.
      expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument()
      expect(screen.getByRole('contentinfo')).toBeInTheDocument()
      unmount()
    }
  })

  it('gives the emailed pages the shell too: they are the ones with no other way out', () => {
    const shell = routes.find((route) => route.path === undefined)
    const wrapped = (shell?.children ?? []).map((child) => child.path)

    expect(wrapped).toEqual(
      expect.arrayContaining([
        '/checkout/:reference/:token',
        '/checkout/:reference/:token/payments/:ourRef',
        '/booking/:token',
        '/booking/:token/payments/:ourRef',
      ]),
    )
  })

  it('leaves admin outside the client shell: the login is bare, like reset password (2026-09-26)', async () => {
    renderAt('/studio/login')

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    // The client top bar it wore from 2026-09-25 is gone (admin console decision 6).
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Book now' })).not.toBeInTheDocument()
    const shell = routes.find((route) => route.path === undefined)
    expect((shell?.children ?? []).map((child) => child.path)).not.toContain('/studio/login')
  })

  it('keeps the reset page bare: no client top bar, no footer', async () => {
    renderAt('/studio/reset-password')

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Book now' })).not.toBeInTheDocument()
  })

  it('declares every Phase 2 area page (marketplace spec, URL map)', () => {
    const shell = routes.find((route) => route.path === undefined)
    const inShell = (shell?.children ?? []).map((child) => child.path)
    const studio = routes.find((route) => route.path === '/studio')
    const platform = routes.find((route) => route.path === '/platform')

    // The account wears the client shell: it is the client's site.
    expect(inShell).toEqual(
      expect.arrayContaining(['/account', '/account/login', '/account/signup', '/account/verify/:token', '/account/reset-password', '/account/google/callback']),
    )
    // The studio's and the platform's sign-in pages are bare, outside their guarded layouts.
    expect(declaredPaths()).toEqual(
      expect.arrayContaining([
        '/studio/login',
        '/studio/signup',
        '/studio/verify/:token',
        '/studio/reset-password',
        '/platform/login',
        '/platform/verify/:token',
        '/platform/reset-password',
      ]),
    )
    expect((studio?.children ?? []).map((child) => child.path)).toEqual(
      expect.arrayContaining(['calendar', 'catalogue', 'bookings', 'bookings/:id', 'availability', 'settings']),
    )
    expect((platform?.children ?? []).map((child) => child.path)).toContain('photographers')
    expect(inShell).not.toContain('/studio/login')
    expect(inShell).not.toContain('/platform/login')
  })

  it('declares the Phase 4 pages: earnings, a payout and the payout method in the studio; payouts and refunds on the platform', () => {
    const studio = routes.find((route) => route.path === '/studio')
    const platform = routes.find((route) => route.path === '/platform')

    expect((studio?.children ?? []).map((child) => child.path)).toEqual(expect.arrayContaining(['earnings', 'payouts/:id', 'payout-method']))
    expect((platform?.children ?? []).map((child) => child.path)).toEqual(expect.arrayContaining(['payouts', 'payouts/:id', 'refunds']))
    // Inside their guarded layouts, never in the client shell.
    const shell = routes.find((route) => route.path === undefined)
    const inShell = (shell?.children ?? []).map((child) => child.path)
    for (const path of ['/studio/earnings', '/studio/payout-method', '/platform/payouts', '/platform/refunds']) expect(inShell).not.toContain(path)
  })

  it('declares the Phase 5 pages: the subscription in the studio; every subscription and the settings on the platform', () => {
    const studio = routes.find((route) => route.path === '/studio')
    const platform = routes.find((route) => route.path === '/platform')

    expect((studio?.children ?? []).map((child) => child.path)).toContain('subscription')
    expect((platform?.children ?? []).map((child) => child.path)).toEqual(expect.arrayContaining(['subscriptions', 'settings']))
    const shell = routes.find((route) => route.path === undefined)
    const inShell = (shell?.children ?? []).map((child) => child.path)
    for (const path of ['/studio/subscription', '/platform/subscriptions', '/platform/settings']) expect(inShell).not.toContain(path)
  })

  it.each([
    ['/studio/subscription', '/studio/login'],
    ['/platform/subscriptions', '/platform/login'],
    ['/platform/settings', '/platform/login'],
    ['/studio/earnings', '/studio/login'],
    ['/studio/payouts/p1', '/studio/login'],
    ['/studio/payout-method', '/studio/login'],
    ['/platform/payouts', '/platform/login'],
    ['/platform/payouts/p1', '/platform/login'],
    ['/platform/refunds', '/platform/login'],
  ])('sends a signed-out visitor from %s to %s, asking the API nothing', async (path, login) => {
    const router = createMemoryRouter(routes, { initialEntries: [path] })
    render(<RouterProvider router={router} />)

    await waitFor(() => expect(router.state.location.pathname).toBe(login))
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(path)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['studio', '/studio/earnings', 'Earnings', { totals: { pendingRwf: 0, payableRwf: 0, inDraftRwf: 0, paidRwf: 0 }, items: [], payouts: [] }],
    ['studio', '/studio/payout-method', 'Payout method', { payoutMethod: null }],
    ['platform', '/platform/payouts', 'Payouts', { due: [] }],
    ['platform', '/platform/refunds', 'Refunds', { refunds: [] }],
    ['studio', '/studio/subscription', 'Subscription', { subscription: null, prices: { monthly: 10_000, yearly: 100_000 }, methods: [], graceDays: 7 }],
    ['platform', '/platform/subscriptions', 'Subscriptions', { subscriptions: [] }],
    [
      'platform',
      '/platform/settings',
      'Settings',
      {
        settings: {
          holdMinutes: 15,
          trialDays: 30,
          subscriptionMonthlyPriceRwf: 10_000,
          subscriptionYearlyPriceRwf: 100_000,
          subscriptionGraceDays: 7,
          subscriptionReminderDays: [7, 3, 1],
        },
      },
    ],
  ] as const)('serves %s %s under its own heading', async (area, path, heading, body) => {
    sessionStorage.setItem(`bookly.${area}.session`, JSON.stringify({ token: 't', expiresAt: '2099-01-01T00:00:00.000Z' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))))
    renderAt(path)

    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    sessionStorage.clear()
  })

  it('keeps the platform login bare: no client top bar, no footer', async () => {
    renderAt('/platform/login')

    expect(await screen.findByRole('heading', { level: 1, name: 'Platform sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
  })

  it('has no locale-prefixed route — /en is a 404, not the home page', () => {
    renderAt('/en')
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })

  it('has no locale-prefixed route — /en/ is a 404 too', () => {
    renderAt('/en/')
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })

  it('falls through to the not-found page for an unknown path', () => {
    renderAt('/nothing-here')
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })

  it('serves the photographers list from /photographers (brief decision 9)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ photographers: [] }))))
    renderAt('/photographers')
    expect(await screen.findByRole('heading', { level: 1, name: 'Photographers' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/photographers', expect.anything())
  })

  it('serves a photographer’s profile from /p/:handle, from the profile alone (Phase 6, R6.2)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ photographer: PROFILE }))),
    )
    renderAt('/p/kigali-lens')
    expect(await screen.findByRole('heading', { level: 1, name: 'Kigali Lens' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/photographers/kigali-lens', expect.anything())
    expect(fetch).not.toHaveBeenCalledWith('/api/photographers/kigali-lens/services', expect.anything())
  })

  it('serves the directory with its filters from the query string (R6.3)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ photographers: [], page: 1, pageSize: 24, hasMore: false, total: 0 }))))
    renderAt('/photographers?category=wedding&district=gasabo')
    expect(await screen.findByRole('heading', { level: 1, name: 'Photographers' })).toBeInTheDocument()
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/photographers?category=wedding&district=gasabo', expect.anything()))
  })

  it('serves a service page from /p/:handle/:slug', async () => {
    const service = { id: 's1', slug: 'portraits', nameEn: 'Portraits', descriptionEn: null, coverImageUrl: null, packages: [], addons: [], bookingFeeRate: 0.4 }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        input.includes('/services/')
          ? new Response(JSON.stringify({ service }))
          : new Response(JSON.stringify({ photographer: PROFILE })),
      ),
    )
    renderAt('/p/kigali-lens/portraits')
    expect(await screen.findByRole('heading', { level: 1, name: 'Portraits' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/photographers/kigali-lens/services/portraits', expect.anything())
  })

  it('has nothing below a service page — /p/kigali-lens/portraits/extra is a 404', () => {
    renderAt('/p/kigali-lens/portraits/extra')
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })

  it('redirects the old service list, /services, to /photographers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ photographers: [] }))))
    const router = createMemoryRouter(routes, { initialEntries: ['/services'] })
    render(<RouterProvider router={router} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Photographers' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/photographers')
  })

  it('has no service page without its photographer — /services/:slug is a 404 and asks the API nothing', () => {
    renderAt('/services/portraits')
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('declares the public catalogue paths, and no service path outside a photographer', () => {
    expect(declaredPaths()).toEqual(expect.arrayContaining(['/photographers', '/p/:handle', '/p/:handle/:slug', '/services']))
    expect(declaredPaths()).not.toContain('/services/:slug')
  })

  it('declares no route whose first segment is a locale', () => {
    const firstSegments = declaredPaths()
      .map((path) => path.split('/').filter(Boolean)[0])
      .filter((segment): segment is string => segment !== undefined)
    expect(firstSegments).not.toContain('en')
    expect(firstSegments).not.toContain('fr')
  })
})

/**
 * `/admin/*` was the studio until Phase 2. Old links -- bookmarks, and emailed
 * reset links with their token in the fragment -- must still land, on the same
 * page under `/studio`.
 */
describe('the old /admin addresses', () => {
  function redirectFrom(path: string) {
    const router = createMemoryRouter(routes, { initialEntries: [path] })
    render(<RouterProvider router={router} />)
    return router
  }

  it.each<[string, string, string, string]>([
    ['/admin', '/studio/login', '', ''],
    ['/admin/login', '/studio/login', '', ''],
    ['/admin/reset-password', '/studio/reset-password', '', ''],
    ['/admin/reset-password#token=r3set', '/studio/reset-password', '', '#token=r3set'],
  ])('sends %s to %s, keeping the query and fragment', async (from, pathname, search, hash) => {
    const router = redirectFrom(from)

    await waitFor(() => expect(router.state.location.pathname).toBe(pathname))
    expect(router.state.location.search).toBe(search)
    expect(router.state.location.hash).toBe(hash)
    expect(router.state.historyAction).toBe('REPLACE')
  })

  it('sends a signed-in photographer’s old page to the same page under /studio', async () => {
    sessionStorage.setItem('bookly.studio.session', JSON.stringify({ token: 't', expiresAt: '2099-01-01T00:00:00.000Z' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ bookings: [], total: 0, page: 1, pageSize: 25, pageCount: 0 }))))
    const router = redirectFrom('/admin/bookings?stage=confirmed')

    await waitFor(() => expect(router.state.location.pathname).toBe('/studio/bookings'))
    expect(router.state.location.search).toBe('?stage=confirmed')
    sessionStorage.clear()
  })

  it('opens the reset page with the emailed token still in the fragment', async () => {
    redirectFrom('/admin/reset-password#token=r3set')

    expect(await screen.findByRole('heading', { level: 1, name: 'Choose a new password' })).toBeInTheDocument()
  })

  it('carries a signed-out visitor’s old page through to the studio login’s return path', async () => {
    const router = redirectFrom('/admin/calendar?view=week')

    await waitFor(() => expect(router.state.location.pathname).toBe('/studio/login'))
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe('/studio/calendar?view=week')
  })

  it('does not treat a look-alike path as the old admin', () => {
    renderAt('/administrator')

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })
})
