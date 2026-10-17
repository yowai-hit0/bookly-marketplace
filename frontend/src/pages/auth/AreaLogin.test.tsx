import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { forgetAccountMe } from '@/auth/account'
import { GOOGLE_FLOW_KEY, externalNavigation } from '@/auth/client'
import { readSession } from '@/auth/session'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'

/**
 * `/account/login` and `/platform/login` (marketplace spec R2.6): the studio's
 * login (`StudioLogin.test.tsx`) for the other two areas. The account login
 * wears the client shell and offers Google only when the API says it is
 * configured; the platform login is a console panel.
 */

const LOGIN = { user: { id: 'u1', email: 'someone@example.com', lastLoginAt: null }, token: 'issued.jwt', tokenType: 'Bearer', expiresAt: '2099-01-01T00:00:00.000Z' }
const ME = { user: { id: 'u1', email: 'someone@example.com', lastLoginAt: null, fullName: 'Aline Uwase' } }
const GOOGLE = 'Continue with Google'

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

async function signIn(email = 'someone@example.com', password = 'correct horse battery staple') {
  const main = within(screen.getByRole('main'))
  await user().type(main.getByLabelText('Email'), email)
  await user().type(main.getByLabelText('Password'), password)
  await user().click(main.getByRole('button', { name: 'Sign in' }))
}

/** The account API: providers as given, login as given, `/me` and Google start as given. */
function accountApi(options: { google?: boolean; login?: () => Response; start?: () => Response } = {}) {
  return stubApi((call: Sent) => {
    if (call.url === '/api/account/auth/providers') return json({ google: options.google ?? false })
    if (call.url === '/api/account/auth/login') return (options.login ?? (() => json(LOGIN)))()
    if (call.url === '/api/account/me') return json(ME)
    if (call.url === '/api/account/auth/google/start') {
      return (options.start ?? (() => json({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', state: 'st4te' })))()
    }
    return undefined
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
  localStorage.clear()
  forgetAccountMe()
})

describe('the account login', () => {
  it('wears the client shell and is reached from its Sign in link', async () => {
    accountApi()
    const router = renderAt('/')

    await user().click(within(screen.getByRole('banner')).getByRole('link', { name: 'Sign in' }))

    expect(router.state.location.pathname).toBe('/account/login')
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Forgot your password?' })).toHaveAttribute('href', '/account/reset-password')
    expect(screen.getByRole('link', { name: 'New here? Create an account' })).toHaveAttribute('href', '/account/signup')
  })

  it('signs in with the account’s endpoint, keeps only the account session, and lands on /account', async () => {
    const api = accountApi()
    const router = renderAt('/account/login')

    await signIn()

    expect(await screen.findByRole('heading', { level: 1, name: 'Hello, Aline Uwase' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/account')
    expect(api.sent.find((call) => call.url === '/api/account/auth/login')?.body).toEqual({
      email: 'someone@example.com',
      password: 'correct horse battery staple',
    })
    expect(readSession('account')).toEqual({ token: 'issued.jwt', expiresAt: LOGIN.expiresAt })
    expect(readSession('studio')).toBeNull()
    // The header follows: the client's name, not "Sign in".
    expect(await within(screen.getByRole('banner')).findByRole('link', { name: 'Aline Uwase' })).toBeInTheDocument()
  })

  it('arrives from the /account guard and returns there', async () => {
    accountApi()
    const router = renderAt('/account')

    await waitFor(() => expect(router.state.location.pathname).toBe('/account/login'))
    await signIn()

    await waitFor(() => expect(router.state.location.pathname).toBe('/account'))
  })

  it.each<[string, number, string]>([
    ['refused credentials', 401, 'That email and password did not work.'],
    ['too many attempts', 429, 'Too many attempts from here. Wait a few minutes and try again.'],
    ['a fault', 500, 'Could not sign in. Check your connection and try again.'],
  ])('words %s', async (_label, status, message) => {
    accountApi({ login: () => json({ error: 'x' }, status) })
    renderAt('/account/login')

    await signIn()

    expect(await within(screen.getByRole('main')).findByRole('alert')).toHaveTextContent(message)
    expect(readSession('account')).toBeNull()
  })

  it('offers no Google button when the API says Google is off', async () => {
    const api = accountApi({ google: false })
    renderAt('/account/login')

    await waitFor(() => expect(api.sent.some((call) => call.url === '/api/account/auth/providers')).toBe(true))
    expect(screen.queryByRole('button', { name: GOOGLE })).not.toBeInTheDocument()
  })

  it('offers no Google button when the providers endpoint fails', async () => {
    stubApi(({ url }) => (url === '/api/account/auth/providers' ? json({ error: 'internal_error' }, 500) : undefined))
    renderAt('/account/login')

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByRole('button', { name: GOOGLE })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('shows Continue with Google when the API says so, and starts the flow from it', async () => {
    const api = accountApi({ google: true })
    const assign = vi.spyOn(externalNavigation, 'assign').mockImplementation(() => {})
    renderAt('/account/login?next=%2Faccount')

    await user().click(await screen.findByRole('button', { name: GOOGLE }))

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'))
    expect(api.sent.find((call) => call.url === '/api/account/auth/google/start')?.method).toBe('POST')
    expect(JSON.parse(sessionStorage.getItem(GOOGLE_FLOW_KEY) ?? 'null')).toEqual({ state: 'st4te', next: '/account' })
  })

  it('never stores an unsafe return path for Google', async () => {
    accountApi({ google: true })
    vi.spyOn(externalNavigation, 'assign').mockImplementation(() => {})
    renderAt(`/account/login?next=${encodeURIComponent('https://evil.example')}`)

    await user().click(await screen.findByRole('button', { name: GOOGLE }))

    await waitFor(() => expect(sessionStorage.getItem(GOOGLE_FLOW_KEY)).not.toBeNull())
    expect(JSON.parse(sessionStorage.getItem(GOOGLE_FLOW_KEY) ?? 'null')).toEqual({ state: 'st4te', next: null })
  })

  it.each<[string, () => Response, string]>([
    ['a 404 (Google switched off since)', () => json({ error: 'not_found' }, 404), 'Google sign-in is not available right now. Sign in with your email and password.'],
    ['a 429', () => json({ error: 'rate_limited' }, 429), 'Too many attempts from here. Wait a few minutes and try again.'],
    ['a 500', () => json({ error: 'internal_error' }, 500), 'Could not open Google sign-in. Check your connection and try again.'],
  ])('words a start refused with %s, leaving nothing stored', async (_label, start, message) => {
    accountApi({ google: true, start })
    const assign = vi.spyOn(externalNavigation, 'assign').mockImplementation(() => {})
    renderAt('/account/login')

    await user().click(await screen.findByRole('button', { name: GOOGLE }))

    expect(await within(screen.getByRole('main')).findByRole('alert')).toHaveTextContent(message)
    expect(assign).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(GOOGLE_FLOW_KEY)).toBeNull()
  })
})

describe('the platform login', () => {
  it('is a console panel with its own title and eyebrow, and no signup or Google', () => {
    const api = stubApi(() => undefined)
    renderAt('/platform/login')

    expect(screen.getByRole('heading', { level: 1, name: 'Platform sign in' })).toBeInTheDocument()
    expect(screen.getByText('Platform')).toBeInTheDocument()
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Forgot your password?' })).toHaveAttribute('href', '/platform/reset-password')
    expect(screen.queryByRole('link', { name: /Create/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: GOOGLE })).not.toBeInTheDocument()
    expect(api.sent).toHaveLength(0)
  })

  it('signs in with the platform’s endpoint and lands on the photographers', async () => {
    const api = stubApi(({ url }) =>
      url === '/api/platform/auth/login' ? json(LOGIN) : url.startsWith('/api/platform/photographers') ? json({ photographers: [] }) : undefined,
    )
    const router = renderAt('/platform/login')

    await signIn()

    expect(await screen.findByRole('heading', { level: 1, name: 'Photographers' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/platform/photographers')
    expect(readSession('platform')?.token).toBe('issued.jwt')
    expect(api.sent.at(-1)?.headers.get('Authorization')).toBe('Bearer issued.jwt')
  })

  it('returns to the filtered list it was sent from', async () => {
    stubApi(({ url }) =>
      url === '/api/platform/auth/login' ? json(LOGIN) : url.startsWith('/api/platform/photographers') ? json({ photographers: [] }) : undefined,
    )
    const router = renderAt('/platform/photographers?status=pending')
    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/login'))

    await signIn()

    await waitFor(() => expect(router.state.location.pathname).toBe('/platform/photographers'))
    expect(router.state.location.search).toBe('?status=pending')
  })
})
