import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { readSession, saveSession } from '@/auth/session'
import { PlatformLayout } from './PlatformLayout'

/**
 * The platform console's shell (Phase 2 brief decision 7; Phase 4 adds
 * Payouts and Refunds): the studio console's layout with the platform's own
 * sections, rendered here around stand-in pages.
 */

const SESSION = { token: 'platform.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }

function page(name: string) {
  return (
    <main>
      <h1>{name}</h1>
    </main>
  )
}

function renderShell(path = '/platform/photographers') {
  const router = createMemoryRouter(
    [
      {
        path: '/platform',
        element: <PlatformLayout />,
        children: [
          { path: 'photographers', element: page('Photographers') },
          { path: 'payouts', element: page('Payouts') },
          { path: 'payouts/:id', element: page('One payout') },
          { path: 'refunds', element: page('Refunds') },
        ],
      },
      { path: '/platform/login', element: page('Platform sign in') },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

function navLinks() {
  return within(screen.getByRole('navigation', { name: 'Platform' })).getAllByRole('link')
}

beforeEach(() => {
  saveSession('platform', SESSION)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  delete document.documentElement.dataset.adminTheme
})

describe('the platform shell', () => {
  it('lists Photographers, Payouts and Refunds, in that order', () => {
    renderShell()

    expect(navLinks().map((link) => link.textContent)).toEqual(['Photographers', 'Payouts', 'Refunds'])
    expect(navLinks().map((link) => link.getAttribute('href'))).toEqual(['/platform/photographers', '/platform/payouts', '/platform/refunds'])
  })

  it.each([
    ['/platform/photographers', 'Photographers'],
    ['/platform/payouts', 'Payouts'],
    ['/platform/payouts/po1', 'Payouts'],
    ['/platform/refunds', 'Refunds'],
  ])('on %s marks %s current with a weight change, and nothing else', (path, current) => {
    renderShell(path)

    const marked = navLinks().filter((link) => link.getAttribute('aria-current') === 'page')
    expect(marked.map((link) => link.textContent)).toEqual([current])
    expect(marked[0]?.className).toContain('font-medium')
  })

  it('opens with a skip link to the content, and leaves the one h1 to the page', () => {
    renderShell('/platform/payouts')

    const skip = screen.getByRole('link', { name: 'Skip to content' })
    expect(skip).toHaveAttribute('href', '#platform-content')
    expect(document.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])')[0]).toBe(skip)
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Payouts'])
    expect(screen.getByRole('heading', { level: 1 }).closest('#platform-content')).not.toBeNull()
  })

  it('keeps every nav icon decorative, so each link is named by its word', () => {
    renderShell()

    for (const link of navLinks()) for (const svg of link.querySelectorAll('svg')) expect(svg).toHaveAttribute('aria-hidden', 'true')
  })

  it('signs out of the platform alone', async () => {
    saveSession('studio', SESSION)
    const router = renderShell()

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(readSession('platform')).toBeNull())
    expect(router.state.location.pathname).toBe('/platform/login')
    expect(readSession('studio')).not.toBeNull()
  })
})
