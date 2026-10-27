import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { forgetAccountMe } from '@/auth/account'
import { type Area, readSession } from '@/auth/session'
import { routes } from '@/routes'
import { json, stubApi } from '@/test/fetch'
import { studioMeBody } from '@/test/studio-me'

/**
 * `/{area}/verify/:token` (marketplace spec R2.1c): opening the link changes
 * nothing; the page posts the token with the account's password. Success signs
 * in and lands in the area; every refusal is one answer, so the page says it
 * once and offers "Forgot password" and "Send a new link".
 */

const TOKEN = 'v3rify-t0ken'
const LOGIN = { user: { id: 'u1', email: 'someone@example.com', lastLoginAt: null }, token: 'issued.jwt', tokenType: 'Bearer', expiresAt: '2099-01-01T00:00:00.000Z' }
const INVALID = 'That did not work. The link may have expired or been used already, or the password is not the one chosen at sign-up.'

/** What each area's landing page asks for once signed in. */
function landingAnswers(url: string): Response | undefined {
  if (url === '/api/studio/me') return json(studioMeBody('pending'))
  if (url.startsWith('/api/studio/calendar')) return json({ bookings: [], blocks: [] })
  if (url.startsWith('/api/platform/photographers')) return json({ photographers: [] })
  if (url === '/api/account/me') return json({ user: { id: 'u1', email: 'someone@example.com', lastLoginAt: null, fullName: 'Aline Uwase' } })
  return undefined
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

async function confirm(password = 'correct horse battery staple') {
  await user().type(screen.getByLabelText('Password'), password)
  await user().click(screen.getByRole('button', { name: 'Confirm and sign in' }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  forgetAccountMe()
})

describe.each<[Area, string, string]>([
  ['studio', '/studio/calendar', 'Calendar'],
  ['platform', '/platform/photographers', 'Photographers'],
  ['account', '/account', 'Hello, Aline Uwase'],
])('the %s verify page', (area, landing, landingHeading) => {
  it('asks for the password and posts nothing until it is sent', () => {
    const api = stubApi(({ url }) => landingAnswers(url))
    renderAt(`/${area}/verify/${TOKEN}`)

    expect(screen.getByRole('heading', { level: 1, name: 'Confirm your email' })).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(api.sent.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  it('posts the token and password, keeps the session under the area’s key, and lands in the area', async () => {
    const api = stubApi(({ url }) => (url === `/api/${area}/auth/verify` ? json(LOGIN) : landingAnswers(url)))
    const router = renderAt(`/${area}/verify/${TOKEN}`)

    await confirm()

    expect(await screen.findByRole('heading', { level: 1, name: landingHeading })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(landing)
    expect(api.sent[0]).toMatchObject({ method: 'POST', url: `/api/${area}/auth/verify`, body: { token: TOKEN, password: 'correct horse battery staple' } })
    expect(readSession(area)).toEqual({ token: 'issued.jwt', expiresAt: LOGIN.expiresAt })
    for (const other of (['studio', 'platform', 'account'] as const).filter((each) => each !== area)) expect(readSession(other)).toBeNull()
  })

  it.each<[string, () => Response]>([
    ['invalid_verification', () => json({ error: 'invalid_verification' }, 400)],
    ['invalid_request', () => json({ error: 'invalid_request' }, 400)],
  ])('on %s says one thing and offers Forgot password and Send a new link', async (_label, respond) => {
    stubApi(({ url }) => (url === `/api/${area}/auth/verify` ? respond() : landingAnswers(url)))
    const router = renderAt(`/${area}/verify/${TOKEN}`)

    await confirm()

    const main = screen.getByRole('main')
    expect(await within(main).findByRole('alert')).toHaveTextContent(INVALID)
    expect(router.state.location.pathname).toBe(`/${area}/verify/${TOKEN}`)
    expect(readSession(area)).toBeNull()
    expect(within(main).getByRole('link', { name: 'Forgot your password? Reset it' })).toHaveAttribute('href', `/${area}/reset-password`)
    expect(within(main).getByRole('button', { name: 'Send a new link' })).toBeInTheDocument()
  })

  it('sends a new link to the address given, saying the same thing whatever it is', async () => {
    const api = stubApi(({ url }) =>
      url === `/api/${area}/auth/verify`
        ? json({ error: 'invalid_verification' }, 400)
        : url === `/api/${area}/auth/verify/resend`
          ? json({ ok: true }, 202)
          : landingAnswers(url),
    )
    renderAt(`/${area}/verify/${TOKEN}`)
    await confirm()
    await within(screen.getByRole('main')).findByRole('alert')

    await user().click(screen.getByRole('button', { name: 'Send a new link' }))
    await user().type(screen.getByLabelText('Email'), ' someone@example.com ')
    await user().click(screen.getByRole('button', { name: 'Send a new link' }))

    expect(await screen.findByText("If an account needs it, we've sent an email with a new link.")).toBeInTheDocument()
    expect(api.sent.at(-1)).toMatchObject({ method: 'POST', url: `/api/${area}/auth/verify/resend`, body: { email: 'someone@example.com' } })
  })
})

describe('the verify page’s other answers', () => {
  it.each<[string, () => Response | Promise<Response>, string]>([
    ['a 429', () => json({ error: 'rate_limited' }, 429), 'Too many attempts from here. Wait a few minutes and try again.'],
    ['a 500', () => json({ error: 'internal_error' }, 500), 'Could not confirm the address. Check your connection and try again.'],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch')), 'Could not confirm the address. Check your connection and try again.'],
  ])('on %s says so, without the dead-end options', async (_label, respond) => {
    stubApi(respond)
    renderAt(`/studio/verify/${TOKEN}`)

    await confirm()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send a new link' })).not.toBeInTheDocument()
  })

  it.each<[string, () => Response, string]>([
    ['a 429', () => json({ error: 'rate_limited' }, 429), 'Too many attempts from here. Wait a few minutes and try again.'],
    ['a 500', () => json({ error: 'internal_error' }, 500), 'Could not send the link. Check your connection and try again.'],
  ])('words a resend refused with %s', async (_label, respond, message) => {
    stubApi(({ url }) => (url.endsWith('/resend') ? respond() : json({ error: 'invalid_verification' }, 400)))
    renderAt(`/platform/verify/${TOKEN}`)
    await confirm()
    await screen.findByRole('alert')

    await user().click(screen.getByRole('button', { name: 'Send a new link' }))
    await user().type(screen.getByLabelText('Email'), 'someone@example.com')
    await user().click(screen.getByRole('button', { name: 'Send a new link' }))

    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('wears the console panel for the studio and the client shell for the account', () => {
    stubApi(() => undefined)
    const { unmount } = render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [`/studio/verify/${TOKEN}`] })} />)
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    expect(screen.getByText('Studio')).toBeInTheDocument()
    unmount()

    renderAt(`/account/verify/${TOKEN}`)
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
  })
})
