import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { forgetAccountMe } from '@/auth/account'
import { readSession, saveSession } from '@/auth/session'
import { routes } from '@/routes'
import { HELD_ROW, REFERENCE, ROW, SESSION, USER, bookingsPage } from '@/test/account-fixtures'
import { type Sent, json, stubApi } from '@/test/fetch'

/**
 * `/account`, the dashboard (marketplace-spec R8.1), through the real routes:
 * the greeting and the account nav, the bookings across photographers with
 * their photographer, service, Kigali time, status and money, the tabs and
 * page in the URL, "Finish payment" for a live hold, the empty, loading and
 * failure states, signing out, and the session guard.
 */

function renderAt(path = '/account') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function api(answer: (sent: Sent) => Response | undefined = () => undefined) {
  return stubApi((sent) => {
    if (sent.url === '/api/account/me') return json({ user: USER })
    return answer(sent)
  })
}

const bookings = (sent: Sent) => sent.url.startsWith('/api/account/bookings')

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  forgetAccountMe()
})

describe('the dashboard', () => {
  it('greets the client, and lists upcoming bookings across photographers with the account token', async () => {
    saveSession('account', SESSION)
    const stub = api((sent) => (bookings(sent) ? json(bookingsPage([ROW, HELD_ROW])) : undefined))
    renderAt()

    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('heading', { level: 1, name: 'Hello, Aline Uwase' })).toBeInTheDocument()
    const items = within(await main.findByRole('list', { name: 'Bookings' })).getAllByRole('listitem')
    expect(items).toHaveLength(2)

    const first = within(items[0]!)
    expect(first.getByRole('link', { name: 'Kigali Lens' })).toHaveAttribute('href', '/p/kigali-lens')
    expect(first.getByRole('link', { name: 'Portraits, Standard' })).toHaveAttribute('href', `/account/bookings/${REFERENCE}`)
    expect(first.getByText('Wednesday, 7 October 2026, 09:30 to 11:00, Kigali time')).toBeInTheDocument()
    expect(first.getByText(REFERENCE)).toBeInTheDocument()
    expect(first.getByText('Confirmed')).toBeInTheDocument()
    expect(first.getByText('50,000 RWF')).toBeInTheDocument()
    expect(first.getByText('20,000 RWF')).toBeInTheDocument()
    expect(first.getByText('30,000 RWF')).toBeInTheDocument()
    expect(first.queryByRole('link', { name: /Finish payment/ })).toBeNull()

    const second = within(items[1]!)
    expect(second.getByRole('link', { name: 'Light House Studio' })).toHaveAttribute('href', '/p/light-house')
    expect(second.getByText('Waiting for payment')).toBeInTheDocument()
    expect(second.getByRole('link', { name: /Finish payment/ })).toHaveAttribute('href', HELD_ROW.checkoutPath)
    expect(second.getByText('Held until 27 Oct 2026, 12:30. Pay the booking fee to confirm it.')).toBeInTheDocument()

    expect(main.getByText('2 bookings')).toBeInTheDocument()
    const listCall = stub.sent.find(bookings)
    expect(listCall?.url).toBe('/api/account/bookings?scope=upcoming')
    expect(listCall?.headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
  })

  it('shows the account nav with Bookings current, and Upcoming current', async () => {
    saveSession('account', SESSION)
    api((sent) => (bookings(sent) ? json(bookingsPage([ROW])) : undefined))
    renderAt()

    const nav = screen.getByRole('navigation', { name: 'Your account' })
    expect(within(nav).getByRole('link', { name: 'Bookings' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Payments' })).not.toHaveAttribute('aria-current')
    expect(within(nav).getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/account/profile')
    expect(within(nav).getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    // The nav sits beside the page's own main, never inside it.
    expect(screen.getByRole('main').contains(nav)).toBe(false)
    expect(screen.getAllByRole('main')).toHaveLength(1)

    const tabs = within(screen.getByRole('navigation', { name: 'Which bookings' }))
    expect(tabs.getByRole('link', { name: 'Upcoming' })).toHaveAttribute('aria-current', 'page')
    expect(tabs.getByRole('link', { name: 'Past' })).toHaveAttribute('href', '/account?scope=past')
  })

  it('switching to Past puts the scope in the URL and asks for it', async () => {
    saveSession('account', SESSION)
    const stub = api((sent) =>
      bookings(sent) ? json(bookingsPage(sent.url.includes('past') ? [{ ...ROW, stage: 'completed', status: 'completed' }] : [ROW])) : undefined,
    )
    const router = renderAt()
    const main = within(screen.getByRole('main'))
    await main.findByText('Confirmed')

    await userEvent.setup({ delay: null }).click(main.getByRole('link', { name: 'Past' }))

    expect(await main.findByText('Completed')).toBeInTheDocument()
    expect(router.state.location.search).toBe('?scope=past')
    expect(main.getByRole('link', { name: 'Past' })).toHaveAttribute('aria-current', 'page')
    expect(stub.sent.filter(bookings).map((call) => call.url)).toEqual([
      '/api/account/bookings?scope=upcoming',
      '/api/account/bookings?scope=past',
    ])
  })

  it('opens on the scope and page in the URL, and pages with links', async () => {
    saveSession('account', SESSION)
    const stub = api((sent) => (bookings(sent) ? json(bookingsPage([ROW], { scope: 'past', page: 2, pageCount: 3, total: 41 })) : undefined))
    renderAt('/account?scope=past&page=2')

    const main = within(screen.getByRole('main'))
    const pager = within(await main.findByRole('navigation', { name: 'Pages' }))
    expect(pager.getByText('Page 2 of 3')).toBeInTheDocument()
    expect(pager.getByRole('link', { name: 'Previous page' })).toHaveAttribute('href', '/account?scope=past')
    expect(pager.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', '/account?scope=past&page=3')
    expect(main.getByText('41 bookings')).toBeInTheDocument()
    expect(stub.sent.find(bookings)?.url).toBe('/api/account/bookings?scope=past&page=2')
  })

  it('the last page has no Next, the first no Previous, and a single page no pager', async () => {
    saveSession('account', SESSION)
    let pageCount = 2
    let page = 2
    api((sent) => (bookings(sent) ? json(bookingsPage([ROW], { page, pageCount })) : undefined))
    renderAt('/account?page=2')
    const main = within(screen.getByRole('main'))
    const pager = within(await main.findByRole('navigation', { name: 'Pages' }))
    expect(pager.queryByRole('link', { name: 'Next page' })).toBeNull()
    expect(pager.getByRole('link', { name: 'Previous page' })).toHaveAttribute('href', '/account')

    pageCount = 1
    page = 1
    await userEvent.setup({ delay: null }).click(pager.getByRole('link', { name: 'Previous page' }))
    await waitFor(() => expect(main.queryByRole('navigation', { name: 'Pages' })).toBeNull())
    expect(within(main.getByRole('list', { name: 'Bookings' })).getAllByRole('listitem')).toHaveLength(1)
  })

  it('never sends the API a scope or page it would refuse', async () => {
    saveSession('account', SESSION)
    const stub = api((sent) => (bookings(sent) ? json(bookingsPage([ROW])) : undefined))
    renderAt('/account?scope=everything&page=-4')

    await within(screen.getByRole('main')).findByText('Confirmed')
    expect(stub.sent.find(bookings)?.url).toBe('/api/account/bookings?scope=upcoming')
  })

  it('an empty upcoming list says so and leads to the directory', async () => {
    saveSession('account', SESSION)
    api((sent) => (bookings(sent) ? json(bookingsPage([])) : undefined))
    renderAt()

    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('heading', { level: 2, name: 'No upcoming bookings' })).toBeInTheDocument()
    expect(main.getByRole('link', { name: 'Find a photographer' })).toHaveAttribute('href', '/photographers')
    expect(main.queryByText(/^\d+ bookings?$/)).toBeNull()
  })

  it('an empty past list has its own words', async () => {
    saveSession('account', SESSION)
    api((sent) => (bookings(sent) ? json(bookingsPage([], { scope: 'past' })) : undefined))
    renderAt('/account?scope=past')

    expect(await within(screen.getByRole('main')).findByRole('heading', { level: 2, name: 'No past bookings yet' })).toBeInTheDocument()
  })

  it('says it is loading until the list arrives', () => {
    saveSession('account', SESSION)
    api((sent) => (bookings(sent) ? (new Promise<Response>(() => {}) as unknown as Response) : undefined))
    renderAt()

    expect(within(screen.getByRole('main')).getByRole('status')).toHaveTextContent('Loading your bookings…')
  })

  it('a failed load says so, and Try again asks again', async () => {
    saveSession('account', SESSION)
    let fail = true
    api((sent) => (bookings(sent) ? (fail ? json({ error: 'internal_error' }, 500) : json(bookingsPage([ROW]))) : undefined))
    renderAt()

    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('alert')).toHaveTextContent('Could not load your bookings. Check your connection and try again.')
    fail = false
    await userEvent.setup({ delay: null }).click(main.getByRole('button', { name: 'Try again' }))
    expect(await main.findByText('Confirmed')).toBeInTheDocument()
  })

  it('a checkout path that is not the app’s own checkout is not linked', async () => {
    saveSession('account', SESSION)
    api((sent) => (bookings(sent) ? json(bookingsPage([{ ...HELD_ROW, checkoutPath: 'https://evil.example/checkout/a/b' }])) : undefined))
    renderAt()

    const main = within(screen.getByRole('main'))
    await main.findByText('Waiting for payment')
    expect(main.queryByRole('link', { name: /Finish payment/ })).toBeNull()
  })

  it('renders names and services as plain text', async () => {
    saveSession('account', SESSION)
    api((sent) =>
      bookings(sent)
        ? json(bookingsPage([{ ...ROW, serviceName: '<img src=x onerror=alert(1)>', photographer: { handle: 'x', displayName: '<b>Bold</b>' } }]))
        : undefined,
    )
    renderAt()

    const main = within(screen.getByRole('main'))
    expect(await main.findByText('<b>Bold</b>')).toBeInTheDocument()
    expect(main.getByText('<img src=x onerror=alert(1)>, Standard')).toBeInTheDocument()
    expect(document.querySelector('main img, main b')).toBeNull()
  })

  it('greets without a name when the account has none', async () => {
    saveSession('account', SESSION)
    stubApi((sent) =>
      sent.url === '/api/account/me' ? json({ user: { ...USER, fullName: null } }) : bookings(sent) ? json(bookingsPage([])) : undefined,
    )
    renderAt()
    await waitFor(() => expect(within(screen.getByRole('main')).getByRole('heading', { level: 1 })).toHaveTextContent(/^Hello$/))
  })

  it('Sign out forgets only the account’s token and goes home', async () => {
    saveSession('account', SESSION)
    saveSession('studio', SESSION)
    api((sent) => (bookings(sent) ? json(bookingsPage([])) : sent.url === '/api/photographers' ? json({ photographers: [] }) : undefined))
    const router = renderAt()
    await within(screen.getByRole('main')).findByRole('heading', { level: 1, name: 'Hello, Aline Uwase' })

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(readSession('account')).toBeNull())
    expect(router.state.location.pathname).toBe('/')
    expect(router.state.location.search).toBe('')
    expect(readSession('studio')).not.toBeNull()
    expect(await within(screen.getByRole('banner')).findByRole('link', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('sends a visitor with no account session to the login, asking the dashboard nothing', () => {
    const stub = stubApi(() => json({ google: false }))
    const router = renderAt('/account?scope=past')

    expect(router.state.location.pathname).toBe('/account/login')
    expect(stub.sent.some((call) => call.url.startsWith('/api/account/') && !call.url.startsWith('/api/account/auth/'))).toBe(false)
  })

  it('sends him to sign in when the API refuses the token', async () => {
    saveSession('account', SESSION)
    stubApi((sent) => (sent.url.startsWith('/api/account/') ? json({ error: 'invalid_token' }, 401) : json({ google: false })))
    const router = renderAt()

    await waitFor(() => expect(router.state.location.pathname).toBe('/account/login'))
    expect(readSession('account')).toBeNull()
  })

  it('does not open for a studio or platform session', () => {
    saveSession('studio', SESSION)
    saveSession('platform', SESSION)
    stubApi(() => json({ google: false }))
    expect(renderAt().state.location.pathname).toBe('/account/login')
  })
})
