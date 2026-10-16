import { render, screen, within } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '@/i18n'
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

const SESSION_KEY = 'bookly.admin.session'
const SESSION = JSON.stringify({ token: 'test.token.signature', expiresAt: '2099-01-01T00:00:00.000Z' })

function renderShell(path = '/admin/availability') {
  const router = createMemoryRouter(
    [
      {
        path: '/admin',
        element: <AdminLayout />,
        children: [
          { path: 'availability', element: <main><h1>Availability</h1></main> },
          { path: 'bookings', element: <main><h1>Bookings</h1></main> },
        ],
      },
      { path: '/admin/login', element: <main><h1>Admin sign in</h1></main> },
    ],
    { initialEntries: [path] },
  )
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  sessionStorage.setItem(SESSION_KEY, SESSION)
})

afterEach(() => {
  sessionStorage.clear()
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

  it('lists the five pages in order, each keeping the name the e2e suite navigates by', () => {
    renderShell()

    const nav = screen.getByRole('navigation', { name: 'Admin' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([
      'Calendar',
      'Bookings',
      'Catalogue',
      'Availability',
      'Settings',
    ])
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/admin/calendar',
      '/admin/bookings',
      '/admin/catalogue',
      '/admin/availability',
      '/admin/settings',
    ])
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
})
