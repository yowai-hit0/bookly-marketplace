import { render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { forgetAccountMe } from '@/auth/account'
import { GOOGLE_FLOW_KEY } from '@/auth/client'
import { readSession } from '@/auth/session'
import { routes } from '@/routes'
import { json, stubApi } from '@/test/fetch'

/**
 * `/account/google/callback` (marketplace spec R2.4): the state Google returns
 * is compared with the one this tab stored before anything is posted, and the
 * stored state works once. Every refusal is worded; `account_conflict` never
 * says what kind of account holds the address.
 */

const LOGIN = { user: { id: 'u1', email: 'aline@example.com', lastLoginAt: null }, token: 'google.jwt', tokenType: 'Bearer', expiresAt: '2099-01-01T00:00:00.000Z' }
const ME = { user: { id: 'u1', email: 'aline@example.com', lastLoginAt: null, fullName: 'Aline Uwase' } }
const START_AGAIN = 'This sign-in has expired or did not start in this browser tab. Start again from the sign-in page.'

function storeFlow(state = 'st4te', next: string | null = null) {
  sessionStorage.setItem(GOOGLE_FLOW_KEY, JSON.stringify({ state, next }))
}

function callbackApi(respond: () => Response | Promise<Response> = () => json(LOGIN)) {
  return stubApi(({ url }) => (url === '/api/account/auth/google/callback' ? respond() : url === '/api/account/me' ? json(ME) : undefined))
}

function renderAt(path: string, strict = false) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const app = <RouterProvider router={router} />
  render(strict ? <StrictMode>{app}</StrictMode> : app)
  return router
}

function posts(api: ReturnType<typeof callbackApi>) {
  return api.sent.filter((call) => call.method === 'POST')
}

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  forgetAccountMe()
})

describe('the Google callback', () => {
  it('posts the code with the matching state, signs the client in and lands on /account', async () => {
    storeFlow()
    const api = callbackApi()
    const router = renderAt('/account/google/callback?code=c0de&state=st4te')

    expect(await screen.findByRole('heading', { level: 1, name: 'Hello, Aline Uwase' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/account')
    expect(router.state.historyAction).toBe('REPLACE')
    expect(posts(api)).toEqual([expect.objectContaining({ url: '/api/account/auth/google/callback', body: { code: 'c0de', state: 'st4te' } })])
    expect(readSession('account')).toEqual({ token: 'google.jwt', expiresAt: LOGIN.expiresAt })
    expect(sessionStorage.getItem(GOOGLE_FLOW_KEY)).toBeNull()
  })

  it('returns to where the client set out from, when that is inside the account', async () => {
    storeFlow('st4te', '/account')
    callbackApi()
    const router = renderAt('/account/google/callback?code=c0de&state=st4te')

    await waitFor(() => expect(router.state.location.pathname).toBe('/account'))
  })

  it('ignores a stored return path that leaves the account', async () => {
    storeFlow('st4te', 'https://evil.example/')
    callbackApi()
    const router = renderAt('/account/google/callback?code=c0de&state=st4te')

    await waitFor(() => expect(router.state.location.pathname).toBe('/account'))
  })

  it('posts once under StrictMode, whose effects run twice in development', async () => {
    storeFlow()
    const api = callbackApi()
    renderAt('/account/google/callback?code=c0de&state=st4te', true)

    await screen.findByRole('heading', { level: 1, name: 'Hello, Aline Uwase' })
    expect(posts(api)).toHaveLength(1)
  })

  it.each<[string, () => void, string]>([
    ['a state that differs from the stored one', () => storeFlow('another'), '/account/google/callback?code=c0de&state=st4te'],
    ['no stored state (another tab, or a replayed link)', () => {}, '/account/google/callback?code=c0de&state=st4te'],
    ['no state returned', () => storeFlow(), '/account/google/callback?code=c0de'],
    ['no code returned', () => storeFlow(), '/account/google/callback?state=st4te'],
  ])('with %s, posts nothing and says to start again', async (_label, arrange, path) => {
    arrange()
    const api = callbackApi()
    renderAt(path)

    expect(await within(screen.getByRole('main')).findByRole('alert')).toHaveTextContent(START_AGAIN)
    expect(posts(api)).toHaveLength(0)
    expect(readSession('account')).toBeNull()
    expect(sessionStorage.getItem(GOOGLE_FLOW_KEY)).toBeNull()
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/account/login')
  })

  it('uses a stored state once: the same link a second time is refused before posting', async () => {
    storeFlow()
    const api = callbackApi()
    const { unmount } = render(
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/account/google/callback?code=c0de&state=st4te'] })} />,
    )
    await screen.findByRole('heading', { level: 1, name: 'Hello, Aline Uwase' })
    unmount()
    sessionStorage.removeItem('bookly.account.session')

    renderAt('/account/google/callback?code=c0de&state=st4te')

    expect(await within(screen.getByRole('main')).findByRole('alert')).toHaveTextContent(START_AGAIN)
    expect(posts(api)).toHaveLength(1)
  })

  it.each<[string, string]>([
    ['access_denied', 'Google sign-in was cancelled.'],
    ['server_error', 'Google sign-in did not work. Try again, or sign in with your email and password.'],
  ])('words Google’s own error %s, posting nothing', async (error, message) => {
    storeFlow()
    const api = callbackApi()
    renderAt(`/account/google/callback?error=${error}&state=st4te`)

    expect(await within(screen.getByRole('main')).findByRole('alert')).toHaveTextContent(message)
    expect(posts(api)).toHaveLength(0)
    expect(sessionStorage.getItem(GOOGLE_FLOW_KEY)).toBeNull()
  })

  it.each<[string, () => Response | Promise<Response>, string]>([
    ['400 invalid_state', () => json({ error: 'invalid_state' }, 400), START_AGAIN],
    ['400 google_sign_in_failed', () => json({ error: 'google_sign_in_failed' }, 400), 'Google sign-in did not work. Try again, or sign in with your email and password.'],
    ['400 google_email_unverified', () => json({ error: 'google_email_unverified' }, 400), 'The email address on your Google account is not verified. Verify it with Google first, or sign up with your email.'],
    ['409 account_conflict', () => json({ error: 'account_conflict' }, 409), 'This email address cannot be used with Google sign-in here. Sign in with your email and password instead.'],
    ['404 not_found', () => json({ error: 'not_found' }, 404), 'Google sign-in is not available right now. Sign in with your email and password.'],
    ['429', () => json({ error: 'rate_limited' }, 429), 'Too many attempts from here. Wait a few minutes and try again.'],
    ['500', () => json({ error: 'internal_error' }, 500), 'Could not finish signing in. Check your connection and try again.'],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch')), 'Could not finish signing in. Check your connection and try again.'],
  ])('words a %s from the API, signing nobody in', async (_label, respond, message) => {
    storeFlow()
    callbackApi(respond)
    const router = renderAt('/account/google/callback?code=c0de&state=st4te')

    expect(await within(screen.getByRole('main')).findByRole('alert')).toHaveTextContent(message)
    expect(router.state.location.pathname).toBe('/account/google/callback')
    expect(readSession('account')).toBeNull()
  })

  it('never names the other kind of account behind a conflict', async () => {
    storeFlow()
    callbackApi(() => json({ error: 'account_conflict' }, 409))
    renderAt('/account/google/callback?code=c0de&state=st4te')

    const alert = await within(screen.getByRole('main')).findByRole('alert')
    expect(alert.textContent ?? '').not.toMatch(/photographer|studio|admin|platform/i)
  })

  it('says it is finishing while the API answers', () => {
    storeFlow()
    callbackApi(() => new Promise<Response>(() => {}))
    renderAt('/account/google/callback?code=c0de&state=st4te')

    expect(within(screen.getByRole('main')).getByRole('status')).toHaveTextContent('Finishing sign-in…')
  })
})
