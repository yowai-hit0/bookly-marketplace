import { render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { forgetAccountMe } from '@/auth/account'
import { clearSession, saveSession } from '@/auth/session'
import { STORED_BOOKING_KEY, rememberBookingToken } from '@/lib/stored-booking'
import { ClientShell } from './ClientShell'

/**
 * The header and footer are structural: three e2e specs read `main`, `dl dt`
 * and page-wide button and radio counts, and all of them break if the shell
 * adds a second landmark or a control. These assertions are the guard.
 */

function renderShell(path = '/') {
  const router = createMemoryRouter(
    [
      {
        element: <ClientShell />,
        children: [
          { path: '/', element: <main><h1>A page</h1></main> },
          { path: '/photographers', element: <main><h1>Photographers</h1></main> },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  return render(<RouterProvider router={router} />)
}

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  forgetAccountMe()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
})

describe('the client shell', () => {
  it('puts the header and footer beside the page’s own main, never around it', () => {
    const { container } = renderShell()

    expect(container.querySelectorAll('main')).toHaveLength(1)
    const banner = screen.getByRole('banner')
    const main = screen.getByRole('main')
    const footer = screen.getByRole('contentinfo')
    expect(banner.contains(main)).toBe(false)
    expect(footer.contains(main)).toBe(false)
    expect(main.closest('#main-content')).not.toBeNull()
  })

  it('opens with a skip link that targets the outlet container', () => {
    renderShell()

    const skip = screen.getByRole('link', { name: 'Skip to content' })
    expect(skip).toHaveAttribute('href', '#main-content')
    // First focusable in the document, or it skips nothing.
    const focusable = document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
    expect(focusable[0]).toBe(skip)

    const target = document.querySelector('#main-content')
    expect(target).toHaveAttribute('tabindex', '-1')
  })

  it('carries the photographers list, how booking works, My booking, sign in and the admin login, and nothing else', () => {
    renderShell()

    const banner = screen.getByRole('banner')
    expect(within(banner).getByRole('link', { name: 'Bookly' })).toHaveAttribute('href', '/')
    expect(within(banner).getByRole('link', { name: 'Find a photographer' })).toHaveAttribute('href', '/photographers')
    // Added 2026-09-25: the photographer's way into admin from the site.
    expect(within(banner).getByRole('link', { name: 'Studio' })).toHaveAttribute('href', '/studio/login')
    // Added 2026-09-25, now that a public resend exists (item 4).
    expect(within(banner).getByRole('link', { name: 'My booking' })).toBeInTheDocument()
    // Added 2026-09-27 (client front redesign): the two page links of the board.
    // The catalogue is per photographer since brief decision 9, so the first leads to them.
    expect(within(banner).getByRole('link', { name: 'Photographers' })).toHaveAttribute('href', '/photographers')
    expect(within(banner).getByRole('link', { name: 'How booking works' })).toHaveAttribute('href', '/#how')
    // Added in Phase 2: the client's account.
    expect(within(banner).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/account/login')
    expect(within(banner).getAllByRole('link')).toHaveLength(7)
  })

  it('keeps "Find a photographer" last in the bar, the primary action after the quieter links', () => {
    renderShell()

    const links = within(screen.getByRole('banner')).getAllByRole('link').map((link) => link.textContent)
    expect(links).toEqual(['Bookly', 'Photographers', 'How booking works', 'My booking', 'Sign in', 'Studio', 'Find a photographer'])
  })

  it('moves the admin login to the footer below sm, where the bar has no room for it (2026-09-25)', () => {
    renderShell()

    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Studio' })).toHaveClass('hidden', 'sm:inline-flex')
    const footerLink = within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Studio' })
    expect(footerLink).toHaveAttribute('href', '/studio/login')
    expect(footerLink.closest('li')).toHaveClass('sm:hidden')
  })

  it('adds no form control, and no button but the theme’s: the e2e suite counts these page-wide', () => {
    const { container } = renderShell()

    // The theme control (2026-09-27) is one button, never radios: checkout.spec.ts
    // counts radios page-wide. The specs count buttons inside `main` only.
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Theme: System'])
    expect(within(screen.getByRole('contentinfo')).queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    // checkout.spec.ts counts `input:disabled, [aria-disabled="true"]`; that
    // assertion is scoped to `main`, so the chrome's side of it is proved here.
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0)
    expect(container.querySelectorAll('[aria-disabled="true"]')).toHaveLength(0)
  })

  it('puts no definition list in the footer: booking.spec.ts reads `dl dt` page-wide', () => {
    const { container } = renderShell()

    expect(within(screen.getByRole('contentinfo')).queryAllByRole('definition')).toHaveLength(0)
    expect(container.querySelectorAll('footer dl')).toHaveLength(0)
  })

  it('never names a link "All services": three e2e specs match that name page-wide', () => {
    renderShell()

    expect(screen.queryByRole('link', { name: /all services/i })).not.toBeInTheDocument()
    const footer = screen.getByRole('contentinfo')
    expect(within(footer).getByRole('link', { name: 'Browse photographers' })).toHaveAttribute('href', '/photographers')
    expect(within(footer).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/')
  })

  it('carries marketplace branding in the footer, and no studio’s contact details (Phase 6, R6.4)', () => {
    renderShell()

    const footer = within(screen.getByRole('contentinfo'))
    expect(footer.getByText('Bookly: find and book photographers across Rwanda.')).toBeInTheDocument()
    expect(footer.queryByRole('list', { name: 'Contact' })).not.toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).not.toHaveTextContent(/demo studio name|\+250 700 000 000|hello@example\.com|Phone|WhatsApp|Email/i)
    expect(screen.getByRole('contentinfo').querySelector('a[href^="tel:"], a[href^="mailto:"], a[href*="wa.me"]')).toBeNull()
  })

  it('invites photographers to list their studio from the footer', () => {
    renderShell()

    expect(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'List your studio' })).toHaveAttribute('href', '/studio/signup')
  })

  it('keeps the words the payment and price specs assert are absent', () => {
    renderShell()

    for (const chrome of [screen.getByRole('banner'), screen.getByRole('contentinfo')]) {
      expect(chrome.textContent ?? '').not.toMatch(/processing|airtel|card/i)
    }
  })

  it('sends My booking to the page that emails a new link when this device holds none', () => {
    renderShell()

    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'My booking' })).toHaveAttribute('href', '/my-booking')
  })

  it('sends My booking to the booking this device last opened', () => {
    localStorage.setItem(STORED_BOOKING_KEY, 'aB3_x-9QzT7vL4pR8sK1nB6yH3cF5dG0wJe')
    renderShell()

    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'My booking' })).toHaveAttribute(
      'href',
      '/booking/aB3_x-9QzT7vL4pR8sK1nB6yH3cF5dG0wJe',
    )
  })

  it('follows a link remembered after it rendered', () => {
    renderShell()

    act(() => rememberBookingToken('later-token-0123456789abcdef'))

    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'My booking' })).toHaveAttribute('href', '/booking/later-token-0123456789abcdef')
  })

  it('still renders when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    renderShell()

    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'My booking' })).toHaveAttribute('href', '/my-booking')
  })

  it('wraps every client page, not just the landing page', () => {
    renderShell('/photographers')

    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Photographers' })).toBeInTheDocument()
  })
})

describe('the account link (Phase 2)', () => {
  const SESSION = { token: 'account.jwt.token', expiresAt: '2099-01-01T00:00:00.000Z' }
  const ME = { user: { id: 'c1', email: 'aline@example.com', lastLoginAt: null, fullName: 'Aline Uwase' } }

  function stubMe(respond: () => Response | Promise<Response>) {
    const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => respond())
    vi.stubGlobal('fetch', mock)
    return mock
  }

  it('says Sign in with no account session, and asks the API nothing', () => {
    const mock = stubMe(() => new Response(JSON.stringify(ME)))
    renderShell()

    const header = within(screen.getByRole('banner')).getByRole('link', { name: 'Sign in' })
    expect(header).toHaveAttribute('href', '/account/login')
    // Below `sm` the bar has no room for it: the footer carries it there.
    expect(header).toHaveClass('hidden', 'sm:inline-flex')
    const footer = within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Sign in' })
    expect(footer).toHaveAttribute('href', '/account/login')
    expect(footer.closest('li')).toHaveClass('sm:hidden')
    expect(mock).not.toHaveBeenCalled()
  })

  it('shows the client’s name once signed in, from one request with the account token', async () => {
    saveSession('account', SESSION)
    const mock = stubMe(() => new Response(JSON.stringify(ME), { status: 200 }))
    renderShell()

    const link = await within(screen.getByRole('banner')).findByRole('link', { name: 'Aline Uwase' })
    expect(link).toHaveAttribute('href', '/account')
    expect(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Aline Uwase' })).toHaveAttribute('href', '/account')
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument()
    // The header and the footer share one answer.
    expect(mock).toHaveBeenCalledTimes(1)
    const [url, init] = mock.mock.calls[0] ?? []
    expect(String(url)).toBe('/api/account/me')
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${SESSION.token}`)
  })

  it('falls back to the address when the account has no name', async () => {
    saveSession('account', SESSION)
    stubMe(() => new Response(JSON.stringify({ user: { ...ME.user, fullName: null } })))
    renderShell()

    expect(await within(screen.getByRole('banner')).findByRole('link', { name: 'aline@example.com' })).toHaveAttribute('href', '/account')
  })

  it('says Your account while the name loads', () => {
    saveSession('account', SESSION)
    stubMe(() => new Promise<Response>(() => {}))
    renderShell()

    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Your account' })).toHaveAttribute('href', '/account')
  })

  it('goes back to Sign in when the API refuses the token, and forgets it', async () => {
    saveSession('account', SESSION)
    stubMe(() => new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 }))
    renderShell()

    expect(await within(screen.getByRole('banner')).findByRole('link', { name: 'Sign in' })).toBeInTheDocument()
    expect(sessionStorage.getItem('bookly.account.session')).toBeNull()
  })

  it('follows sign-out in this tab', async () => {
    saveSession('account', SESSION)
    stubMe(() => new Response(JSON.stringify(ME)))
    renderShell()
    await within(screen.getByRole('banner')).findByRole('link', { name: 'Aline Uwase' })

    act(() => clearSession('account'))

    await waitFor(() => expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Sign in' })).toBeInTheDocument())
  })

  it('ignores a studio or platform session: only the account’s counts', () => {
    saveSession('studio', SESSION)
    saveSession('platform', SESSION)
    const mock = stubMe(() => new Response(JSON.stringify(ME)))
    renderShell()

    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Sign in' })).toBeInTheDocument()
    expect(mock).not.toHaveBeenCalled()
  })
})

describe('the client theme in the shell', () => {
  it('sets data-theme on <html> while mounted, cycles with its button, and removes it on the way out', async () => {
    const { unmount } = renderShell()
    expect(document.documentElement.dataset.theme).toBe('light')

    const button = screen.getByRole('button', { name: 'Theme: System' })
    act(() => button.click())
    expect(screen.getByRole('button', { name: 'Theme: Light' })).toBeInTheDocument()
    act(() => screen.getByRole('button', { name: 'Theme: Light' }).click())
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('bookly.theme')).toBe('dark')

    unmount()
    expect(document.documentElement).not.toHaveAttribute('data-theme')
  })
})
