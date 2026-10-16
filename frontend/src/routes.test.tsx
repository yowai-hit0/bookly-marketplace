import { render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { routes } from '@/routes'

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
    expect(await screen.findByRole('heading', { level: 1, name: /Book a photographer/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Bookly' })).toHaveAttribute('href', '/')
  })

  it('wraps the client routes in the shell, including the not-found page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ services: [] }))))

    for (const path of ['/', '/services', '/nothing-here']) {
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
    renderAt('/admin/login')

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    // The client top bar it wore from 2026-09-25 is gone (admin console decision 6).
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Book now' })).not.toBeInTheDocument()
    const shell = routes.find((route) => route.path === undefined)
    expect((shell?.children ?? []).map((child) => child.path)).not.toContain('/admin/login')
  })

  it('keeps the reset page bare: no client top bar, no footer', async () => {
    renderAt('/admin/reset-password')

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Book now' })).not.toBeInTheDocument()
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

  it('serves the public service list from /services (plan.md Task 11)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ services: [] }))))
    renderAt('/services')
    expect(await screen.findByRole('heading', { level: 1, name: 'Services' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/services', expect.anything())
  })

  it('serves a service page from /services/:slug (plan.md Task 11)', async () => {
    const service = { id: 's1', slug: 'portraits', nameEn: 'Portraits', descriptionEn: null, coverImageUrl: null, packages: [], addons: [], bookingFeeRate: 0.4 }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ service }))))
    renderAt('/services/portraits')
    expect(await screen.findByRole('heading', { level: 1, name: 'Portraits' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/services/portraits', expect.anything())
  })

  it('has nothing below a service page — /services/portraits/extra is a 404', () => {
    renderAt('/services/portraits/extra')
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })

  it('declares the two public service paths', () => {
    expect(declaredPaths()).toContain('/services')
    expect(declaredPaths()).toContain('/services/:slug')
  })

  it('declares no route whose first segment is a locale', () => {
    const firstSegments = declaredPaths()
      .map((path) => path.split('/').filter(Boolean)[0])
      .filter((segment): segment is string => segment !== undefined)
    expect(firstSegments).not.toContain('en')
    expect(firstSegments).not.toContain('fr')
  })
})
