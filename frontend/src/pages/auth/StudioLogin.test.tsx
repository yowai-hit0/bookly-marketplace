import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { readSession } from '@/admin/session'
import { routes } from '@/routes'
import { isStudioMe, studioMe } from '@/test/studio-me'

/**
 * `/studio/login` (plan.md Task 9, spec A-11; `/admin/login` until Phase 2):
 * email and password against `POST /api/studio/auth/login`, the token kept in
 * sessionStorage under the studio's key, then the calendar, or where the
 * studio's guard sent him from. The API refuses a wrong password, an unknown
 * email, a locked account and an unverified address identically, so the page
 * shows one message for all of them.
 */

const NOW = new Date('2026-10-07T08:00:00.000Z')
const LOGIN_URL = '/api/studio/auth/login'
const INVALID = 'That email and password did not work.'
const FAILED = 'Could not sign in. Check your connection and try again.'
const RATE_LIMITED = 'Too many attempts from here. Wait a few minutes and try again.'

type FetchArgs = [input: string | URL | Request, init?: RequestInit]
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

function stubFetch(handler: Handler) {
  const mock = vi.fn(async (input: FetchArgs[0], init: FetchArgs[1] = {}) => handler(String(input), init))
  vi.stubGlobal('fetch', mock)
  return mock
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const LOGIN_OK = {
  user: { id: 'a1', email: 'photographer@bookly.example', lastLoginAt: null },
  token: 'issued.jwt.token',
  tokenType: 'Bearer',
  expiresAt: '2026-10-07T16:00:00.000Z',
}

/** Login answers `respond`; the layout's banner request answers approved; the calendar, once reached, answers empty. */
function stubLogin(respond: () => Response | Promise<Response>) {
  return stubFetch((url) => (url === LOGIN_URL ? respond() : isStudioMe(url) ? studioMe() : json({ bookings: [], blocks: [] })))
}

/** The requests the pages made, the layout's banner request left out. */
function pageCalls(mock: ReturnType<typeof stubFetch>) {
  return mock.mock.calls.filter(([input]) => !isStudioMe(input))
}

function renderLogin(path = '/studio/login') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

async function submit(email = 'photographer@bookly.example', password = 'correct horse battery staple') {
  const user = userEvent.setup({ delay: null })
  await user.type(screen.getByLabelText('Email'), email)
  await user.type(screen.getByLabelText('Password'), password)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

describe('the studio login', () => {
  it('renders the sign-in form', () => {
    stubLogin(() => json(LOGIN_OK))
    renderLogin()

    expect(screen.getByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // The client top bar was dropped on 2026-09-26 (admin-console.md decision 6):
  // sign in and reset password are one place, a console panel whose Bookly mark
  // is the way back to the client site. These replace the two tests that
  // guarded the header and the skip link that only skipped it.
  it('wears no client top bar or footer, only its own main', () => {
    stubLogin(() => json(LOGIN_OK))
    const { container } = render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/studio/login'] })} />)

    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Book now' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Admin login' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Skip to content' })).not.toBeInTheDocument()
    expect(container.querySelectorAll('main')).toHaveLength(1)
    // No client footer: its links are for clients.
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
  })

  it('opens on the Bookly mark, a link home, above its one heading', async () => {
    stubLogin(() => json(LOGIN_OK))
    renderLogin()

    const home = within(screen.getByRole('main')).getByRole('link', { name: 'Bookly' })
    expect(home).toHaveAttribute('href', '/')
    expect(document.querySelector('a[href], button, input')).toBe(home)
    await userEvent.setup({ delay: null }).tab()
    expect(home).toHaveFocus()

    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]).toHaveAccessibleName('Admin sign in')
  })

  it('is reached from the client top bar', async () => {
    stubLogin(() => json(LOGIN_OK))
    const router = createMemoryRouter(routes, { initialEntries: ['/'] })
    render(<RouterProvider router={router} />)

    const user = userEvent.setup({ delay: null })
    await user.click(within(screen.getByRole('banner')).getByRole('link', { name: 'Admin login' }))

    expect(router.state.location.pathname).toBe('/studio/login')
    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument()
  })

  // The reset page is reachable only from here. The page itself is tested in
  // AdminResetPassword.test.tsx; without this, nothing proved the way in exists
  // (the gap list's row 2, closed 2026-09-21 and checked here since).
  it('offers the way to the reset page, carrying nothing with it', async () => {
    stubLogin(() => json(LOGIN_OK))
    renderLogin()

    const forgot = screen.getByRole('link', { name: 'Forgot your password?' })
    expect(forgot).toHaveAttribute('href', '/studio/reset-password')
    // No email, no token, no query: the reset page asks for the address itself.
    expect(forgot.getAttribute('href')).not.toMatch(/[?#]/)
  })

  it('posts the email and password as JSON to the login endpoint', async () => {
    const mock = stubLogin(() => json(LOGIN_OK))
    renderLogin()

    await submit('photographer@bookly.example', 'p@ss "word"')

    await waitFor(() => expect(mock).toHaveBeenCalled())
    const [url, init] = mock.mock.calls[0] ?? []
    expect(url).toBe(LOGIN_URL)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({ email: 'photographer@bookly.example', password: 'p@ss "word"' })
  })

  it('on success keeps only the token and expiry in sessionStorage, then opens the calendar with that token', async () => {
    const mock = stubLogin(() => json(LOGIN_OK))
    const router = renderLogin()

    await submit()

    expect(await screen.findByRole('heading', { name: 'October 2026' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/studio/calendar')
    expect(readSession()).toEqual({ token: 'issued.jwt.token', expiresAt: '2026-10-07T16:00:00.000Z' })
    expect(JSON.parse(sessionStorage.getItem('bookly.studio.session') ?? 'null')).toEqual({
      token: 'issued.jwt.token',
      expiresAt: '2026-10-07T16:00:00.000Z',
    })
    expect(localStorage.length).toBe(0)

    await waitFor(() => expect(pageCalls(mock)).toHaveLength(2))
    const [calendarUrl, calendarInit] = pageCalls(mock)[1] ?? []
    expect(String(calendarUrl)).toMatch(/^\/api\/studio\/calendar\?/)
    expect(new Headers(calendarInit?.headers).get('Authorization')).toBe('Bearer issued.jwt.token')
  })

  it('replaces the login page in history, so Back does not return to it', async () => {
    stubLogin(() => json(LOGIN_OK))
    const router = renderLogin()

    await submit()

    await screen.findByRole('heading', { name: 'October 2026' })
    expect(router.state.historyAction).toBe('REPLACE')
  })

  it.each<[string, number]>([
    ['a 401 (wrong password, unknown email or locked account)', 401],
    ['a 400 (a malformed request)', 400],
  ])('on %s shows one message, stores nothing and stays put', async (_label, status) => {
    stubLogin(() => json({ error: status === 401 ? 'invalid_credentials' : 'invalid_request' }, status))
    const router = renderLogin()

    await submit()

    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID)
    expect(router.state.location.pathname).toBe('/studio/login')
    expect(sessionStorage.length).toBe(0)
  })

  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('on %s says it could not sign in, storing nothing', async (_label, respond) => {
    stubLogin(respond)
    const router = renderLogin()

    await submit()

    expect(await screen.findByRole('alert')).toHaveTextContent(FAILED)
    expect(router.state.location.pathname).toBe('/studio/login')
    expect(sessionStorage.length).toBe(0)
  })

  it('on a 429 says to wait, storing nothing', async () => {
    stubLogin(() => json({ error: 'rate_limited' }, 429))
    const router = renderLogin()

    await submit()

    expect(await screen.findByRole('alert')).toHaveTextContent(RATE_LIMITED)
    expect(router.state.location.pathname).toBe('/studio/login')
    expect(sessionStorage.length).toBe(0)
  })

  it('lands where the studio guard sent him from, query included', async () => {
    stubLogin(() => json(LOGIN_OK))
    const router = renderLogin('/studio/login?next=%2Fstudio%2Fbookings%3Fstage%3Dconfirmed')

    await submit()

    await waitFor(() => expect(router.state.location.pathname).toBe('/studio/bookings'))
    expect(router.state.location.search).toBe('?stage=confirmed')
  })

  it.each<[string, string]>([
    ['another site', 'https://evil.example/studio'],
    ['a protocol-relative address', '//evil.example/studio'],
    ['a backslash trick', '/\\evil.example'],
    ['another area', '/platform/photographers'],
    ['the client site', '/my-booking'],
    ['a javascript: URL', 'javascript:alert(1)'],
  ])('ignores a return path to %s and opens the calendar', async (_label, next) => {
    stubLogin(() => json(LOGIN_OK))
    const router = renderLogin(`/studio/login?next=${encodeURIComponent(next)}`)

    await submit()

    expect(await screen.findByRole('heading', { name: 'October 2026' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/studio/calendar')
  })

  it('offers the studio signup, and no Google sign-in', () => {
    const mock = stubLogin(() => json(LOGIN_OK))
    renderLogin()

    expect(screen.getByRole('link', { name: 'New photographer? Create your studio' })).toHaveAttribute('href', '/studio/signup')
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument()
    // The providers endpoint is the account's; the studio never asks it.
    expect(mock).not.toHaveBeenCalled()
  })

  it('disables the button while signing in', async () => {
    let answer: (res: Response) => void = () => {}
    stubLogin(() => new Promise<Response>((resolve) => (answer = resolve)))
    renderLogin()

    await submit()

    const button = await screen.findByRole('button', { name: 'Signing in…' })
    expect(button).toBeDisabled()

    answer(json({ error: 'invalid_credentials' }, 401))

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  it('signs in on a second attempt after a refusal', async () => {
    const responses = [json({ error: 'invalid_credentials' }, 401), json(LOGIN_OK)]
    stubLogin(() => responses.shift() ?? json({}, 500))
    const router = renderLogin()

    await submit('photographer@bookly.example', 'wrong')
    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID)

    const user = userEvent.setup({ delay: null })
    await user.clear(screen.getByLabelText('Password'))
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await screen.findByRole('heading', { name: 'October 2026' })
    expect(router.state.location.pathname).toBe('/studio/calendar')
    expect(readSession()?.token).toBe('issued.jwt.token')
  })
})
