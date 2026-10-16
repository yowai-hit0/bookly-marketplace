import { act, render, screen, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '@/i18n'
import { AdminLayout } from './AdminLayout'
import { useBreadcrumbTail } from './breadcrumb-tail'

/**
 * The admin breadcrumb (design-system/bookly/admin-console.md section 6.2),
 * rendered inside the real layout: Admin > the section > on a booking, the
 * reference the booking page reports once it has loaded.
 */

const SESSION_KEY = 'bookly.admin.session'
const SESSION = JSON.stringify({ token: 'test.token.signature', expiresAt: '2099-01-01T00:00:00.000Z' })

/** Stands in for the booking page: reports loading, then the reference or nothing. */
let finishLoad: (label: string | null) => void = () => {}
function FakeBookingPage() {
  const [state, setState] = useState<{ loading: boolean; label: string | null }>({ loading: true, label: null })
  useEffect(() => {
    finishLoad = (label) => setState({ loading: false, label })
  }, [])
  useBreadcrumbTail(state.loading, state.label)
  return (
    <main>
      <h1>{state.label ?? 'Loading'}</h1>
    </main>
  )
}

function renderAt(path: string) {
  const page = (name: string) => (
    <main>
      <h1>{name}</h1>
    </main>
  )
  const router = createMemoryRouter(
    [
      {
        path: '/admin',
        element: <AdminLayout />,
        children: [
          { path: 'calendar', element: page('Calendar') },
          { path: 'bookings', element: page('Bookings') },
          { path: 'bookings/:id', element: <FakeBookingPage /> },
          { path: 'catalogue', element: page('Catalogue') },
          { path: 'availability', element: page('Availability') },
          { path: 'settings', element: page('Settings') },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

function crumbs() {
  const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
  return within(nav).getAllByRole('listitem')
}

beforeEach(() => {
  sessionStorage.setItem(SESSION_KEY, SESSION)
})

afterEach(() => {
  sessionStorage.clear()
})

describe('the admin breadcrumb', () => {
  it.each([
    ['/admin/calendar', 'Calendar'],
    ['/admin/bookings', 'Bookings'],
    ['/admin/catalogue', 'Catalogue'],
    ['/admin/availability', 'Availability'],
    ['/admin/settings', 'Settings'],
  ])('on %s reads Admin > %s, with the section as the current page', (path, section) => {
    renderAt(path)

    const items = crumbs()
    expect(items.map((item) => item.textContent)).toEqual(['Admin', section])

    const admin = within(items[0] as HTMLElement).getByRole('link', { name: 'Admin' })
    expect(admin).toHaveAttribute('href', '/admin')

    // The page itself is plain text, not a link to where you already are.
    expect(items[1]?.querySelector('[aria-current="page"]')).toHaveTextContent(section)
    expect(within(items[1] as HTMLElement).queryByRole('link')).not.toBeInTheDocument()
  })

  it('adds the booking reference once the booking page has it, and links back to the list', () => {
    renderAt('/admin/bookings/b1')

    // While the booking loads: a placeholder, hidden from assistive tech, and
    // Bookings stays the current page.
    let items = crumbs()
    expect(items).toHaveLength(3)
    expect(items[2]?.querySelector('[data-slot="breadcrumb-skeleton"]')).toHaveAttribute('aria-hidden', 'true')
    expect(items[1]?.querySelector('[aria-current="page"]')).toHaveTextContent('Bookings')

    act(() => finishLoad('BKY-2610-00042'))

    items = crumbs()
    expect(items.map((item) => item.textContent)).toEqual(['Admin', 'Bookings', 'BKY-2610-00042'])
    expect(within(items[1] as HTMLElement).getByRole('link', { name: 'Bookings' })).toHaveAttribute('href', '/admin/bookings')
    expect(items[2]?.querySelector('[aria-current="page"]')).toHaveTextContent('BKY-2610-00042')
    expect(items[1]?.querySelector('[aria-current]')).toBeNull()
  })

  it('drops the reference crumb when the booking fails to load', () => {
    renderAt('/admin/bookings/missing')

    act(() => finishLoad(null))

    expect(crumbs().map((item) => item.textContent)).toEqual(['Admin', 'Bookings'])
  })

  it('forgets the reference when leaving the booking', async () => {
    const router = renderAt('/admin/bookings/b1')
    act(() => finishLoad('BKY-2610-00042'))

    await act(() => router.navigate('/admin/bookings'))

    expect(crumbs().map((item) => item.textContent)).toEqual(['Admin', 'Bookings'])
  })

  it('hides separators from assistive tech, and is not a second "Admin" navigation', () => {
    renderAt('/admin/bookings')

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    for (const svg of nav.querySelectorAll('svg')) expect(svg).toHaveAttribute('aria-hidden', 'true')
    // The e2e suite finds the sidebar by the name "Admin"; the breadcrumb must not match it.
    expect(screen.getAllByRole('navigation', { name: 'Admin' })).toHaveLength(1)
  })
})
