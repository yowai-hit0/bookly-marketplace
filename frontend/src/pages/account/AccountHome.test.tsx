import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { forgetAccountMe } from '@/auth/account'
import { readSession, saveSession } from '@/auth/session'
import { routes } from '@/routes'
import { json, stubApi } from '@/test/fetch'

/**
 * `/account`, minimal until Phase 8: the greeting with the client's name, the
 * address they sign in with, and sign out, behind the account session.
 */

const SESSION = { token: 'account.jwt', expiresAt: '2099-01-01T00:00:00.000Z' }
const ME = { user: { id: 'c1', email: 'aline@example.com', lastLoginAt: null, fullName: 'Aline Uwase' } }

function renderAt(path = '/account') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  forgetAccountMe()
})

describe('the account page', () => {
  it('greets the client by name and shows their address, from /api/account/me with the account token', async () => {
    saveSession('account', SESSION)
    const api = stubApi(({ url }) => (url === '/api/account/me' ? json(ME) : undefined))
    renderAt()

    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('heading', { level: 1, name: 'Hello, Aline Uwase' })).toBeInTheDocument()
    expect(main.getByText('aline@example.com')).toBeInTheDocument()
    expect(api.sent.every((call) => call.headers.get('Authorization') === `Bearer ${SESSION.token}`)).toBe(true)
    // The header and the page share one answer.
    expect(api.sent.filter((call) => call.url === '/api/account/me')).toHaveLength(1)
  })

  it('greets without a name when the account has none', async () => {
    saveSession('account', SESSION)
    stubApi(({ url }) => (url === '/api/account/me' ? json({ user: { ...ME.user, fullName: null } }) : undefined))
    renderAt()

    const main = within(screen.getByRole('main'))
    expect(await main.findByText('aline@example.com')).toBeInTheDocument()
    expect(main.getByRole('heading', { level: 1 })).toHaveTextContent(/^Hello$/)
  })

  it('says it is loading until the account arrives', () => {
    saveSession('account', SESSION)
    stubApi(() => new Promise<Response>(() => {}))
    renderAt()

    expect(within(screen.getByRole('main')).getByRole('status')).toHaveTextContent('Loading your account…')
  })

  it('shows a failure with Try again, which asks again', async () => {
    saveSession('account', SESSION)
    let fail = true
    stubApi(({ url }) => (url === '/api/account/me' ? (fail ? json({ error: 'internal_error' }, 500) : json(ME)) : undefined))
    renderAt()

    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('alert')).toHaveTextContent('Could not load your account. Check your connection and try again.')
    fail = false
    await userEvent.setup({ delay: null }).click(main.getByRole('button', { name: 'Try again' }))

    expect(await main.findByRole('heading', { level: 1, name: 'Hello, Aline Uwase' })).toBeInTheDocument()
  })

  it('signs out by forgetting the account token, and goes home', async () => {
    saveSession('account', SESSION)
    saveSession('studio', SESSION)
    stubApi(({ url }) => (url === '/api/account/me' ? json(ME) : url === '/api/photographers' ? json({ photographers: [] }) : undefined))
    const router = renderAt()
    const main = within(screen.getByRole('main'))
    await main.findByRole('heading', { level: 1, name: 'Hello, Aline Uwase' })

    await userEvent.setup({ delay: null }).click(main.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(readSession('account')).toBeNull())
    // Home, as asked, not the login the guard would have sent him to.
    expect(router.state.location.pathname).toBe('/')
    expect(router.state.location.search).toBe('')
    // Only the account's: the studio session is another sign-in.
    expect(readSession('studio')).not.toBeNull()
    expect(await within(screen.getByRole('banner')).findByRole('link', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('sends a visitor with no account session to the account login, asking the API nothing', () => {
    const api = stubApi(() => json({ google: false }))
    const router = renderAt()

    expect(router.state.location.pathname).toBe('/account/login')
    expect(api.sent.some((call) => call.url === '/api/account/me')).toBe(false)
  })

  it('sends him to sign in when the API refuses the token', async () => {
    saveSession('account', SESSION)
    stubApi(({ url }) => (url === '/api/account/me' ? json({ error: 'invalid_token' }, 401) : json({ google: false })))
    const router = renderAt()

    await waitFor(() => expect(router.state.location.pathname).toBe('/account/login'))
    expect(readSession('account')).toBeNull()
  })

  it('does not open for a studio or platform session', () => {
    saveSession('studio', SESSION)
    saveSession('platform', SESSION)
    stubApi(() => json({ google: false }))
    const router = renderAt()

    expect(router.state.location.pathname).toBe('/account/login')
  })
})
