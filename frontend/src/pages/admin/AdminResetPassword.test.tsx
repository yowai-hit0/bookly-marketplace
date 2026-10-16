import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { routes } from '@/routes'

/**
 * `/admin/reset-password` (plan.md Task 7, spec §6.23, A-11), rendered through
 * the real routes with `fetch` stubbed.
 *
 * What is proven: one route does both halves of a reset, told apart by the
 * token the emailed link carries in its **fragment**; the token reaches the API
 * only in a POST body and never in a URL; the request step says the same thing
 * whether or not the address can sign in, so the page cannot leak who has an
 * account; and a spent link is told apart from a network failure.
 */

const NOW = new Date('2026-10-07T08:00:00.000Z')
const RESET_TOKEN = 'reset.token.from.the.email'
const REQUEST_URL = '/api/admin/auth/password-reset/request'
const CONFIRM_URL = '/api/admin/auth/password-reset/confirm'

const GOOD_PASSWORD = 'correct horse battery staple'

type Sent = { method: string; url: string; body: unknown }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubApi(respond: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = []
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Sent = {
      method: init.method ?? 'GET',
      url: String(input),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    }
    sent.push(call)
    return respond(call)
  })
  vi.stubGlobal('fetch', mock)
  return sent
}

/** `hash` is how the emailed link carries the token: never a query string. */
function renderPage(hash = '') {
  const router = createMemoryRouter(routes, { initialEntries: [`/admin/reset-password${hash}`] })
  render(<RouterProvider router={router} />)
  return router
}

const user = () => userEvent.setup({ delay: null })

/**
 * Every shape wears the same way home as sign in (2026-09-26, decision 6: the
 * login dropped the client header, so the panel's Bookly mark is the way back
 * to the client site): a link to `/`, first in tab order.
 */
function expectBooklyLinkHome() {
  const home = within(screen.getByRole('main')).getByRole('link', { name: 'Bookly' })
  expect(home).toHaveAttribute('href', '/')
  expect(document.querySelector('a[href], button, input')).toBe(home)
}

async function choosePassword(password: string, repeated = password) {
  await user().type(screen.getByLabelText('New password'), password)
  await user().type(screen.getByLabelText('Repeat the new password'), repeated)
  await user().click(screen.getByRole('button', { name: 'Save the password' }))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('AdminResetPassword, asking for a link', () => {
  it('asks for the email when the link carried no token', () => {
    stubApi(() => json({ ok: true }, 202))
    renderPage()

    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email')
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
    expectBooklyLinkHome()
  })

  it('posts the address and then says a link is on its way', async () => {
    const sent = stubApi(() => json({ ok: true }, 202))
    renderPage()

    await user().type(screen.getByLabelText('Email'), 'photographer@bookly.example')
    await user().click(screen.getByRole('button', { name: 'Send the link' }))

    expect(await screen.findByRole('status')).toHaveTextContent(/a reset link is on its way/i)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: REQUEST_URL,
      body: { email: 'photographer@bookly.example' },
    })
    // The form is gone, so a second send cannot be used to probe addresses.
    expect(screen.queryByRole('button', { name: 'Send the link' })).not.toBeInTheDocument()
    expectBooklyLinkHome()
  })

  it('says exactly the same thing for an address that cannot sign in', async () => {
    // The API answers 202 either way; the page has nothing else to go on.
    stubApi(() => json({ ok: true }, 202))
    renderPage()

    await user().type(screen.getByLabelText('Email'), 'stranger@example.com')
    await user().click(screen.getByRole('button', { name: 'Send the link' }))

    expect(await screen.findByRole('status')).toHaveTextContent(/a reset link is on its way/i)
  })

  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('on %s says the link could not be sent, because none is coming', async (_label, respond) => {
    stubApi(respond)
    renderPage()

    await user().type(screen.getByLabelText('Email'), 'photographer@bookly.example')
    await user().click(screen.getByRole('button', { name: 'Send the link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not send the link. Check your connection and try again.')
  })

  it('offers a way back to sign in', async () => {
    stubApi(() => json({ ok: true }, 202))
    const router = renderPage()

    await user().click(screen.getByRole('link', { name: 'Back to sign in' }))

    expect(router.state.location.pathname).toBe('/admin/login')
  })
})

describe('AdminResetPassword, choosing the new password', () => {
  it('asks for the new password when the link carried a token', () => {
    stubApi(() => new Response(null, { status: 204 }))
    renderPage(`#token=${RESET_TOKEN}`)

    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument()
    expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Repeat the new password')).toHaveAttribute('type', 'password')
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expectBooklyLinkHome()
  })

  it('sends the token in the body and in no URL at all', async () => {
    const sent = stubApi(() => new Response(null, { status: 204 }))
    renderPage(`#token=${RESET_TOKEN}`)

    await choosePassword(GOOD_PASSWORD)

    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: CONFIRM_URL,
      body: { token: RESET_TOKEN, newPassword: GOOD_PASSWORD },
    })
    for (const call of sent) expect(call.url).not.toContain(RESET_TOKEN)
  })

  it('confirms the change and points at sign in', async () => {
    stubApi(() => new Response(null, { status: 204 }))
    const router = renderPage(`#token=${RESET_TOKEN}`)

    await choosePassword(GOOD_PASSWORD)

    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
    expectBooklyLinkHome()

    await user().click(screen.getByRole('link', { name: 'Back to sign in' }))
    expect(router.state.location.pathname).toBe('/admin/login')
  })

  it('refuses a password under twelve characters without sending it anywhere', async () => {
    const sent = stubApi(() => new Response(null, { status: 204 }))
    renderPage(`#token=${RESET_TOKEN}`)

    await choosePassword('short')

    expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument()
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true')
    expect(sent).toHaveLength(0)
  })

  it('refuses two passwords that differ, without sending either', async () => {
    const sent = stubApi(() => new Response(null, { status: 204 }))
    renderPage(`#token=${RESET_TOKEN}`)

    await choosePassword(GOOD_PASSWORD, 'correct horse battery stapler')

    expect(await screen.findByText('Those two passwords are not the same.')).toBeInTheDocument()
    expect(screen.getByLabelText('Repeat the new password')).toHaveAttribute('aria-invalid', 'true')
    expect(sent).toHaveLength(0)
  })

  it('tells him a spent or expired link apart from a failure, and to ask for a new one', async () => {
    stubApi(() => json({ error: 'invalid_or_expired_token' }, 400))
    renderPage(`#token=${RESET_TOKEN}`)

    await choosePassword(GOOD_PASSWORD)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That link has expired or has already been used. Ask for a new one.',
    )
  })

  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('on %s says the password could not be saved', async (_label, respond) => {
    stubApi(respond)
    renderPage(`#token=${RESET_TOKEN}`)

    await choosePassword(GOOD_PASSWORD)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not save the password. Check your connection and try again.',
    )
  })

  it('treats an empty token in the fragment as no token', () => {
    stubApi(() => new Response(null, { status: 204 }))
    renderPage('#token=')

    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument()
  })
})

describe('the sign-in page', () => {
  it('links to the reset page, carrying nothing with it', async () => {
    stubApi(() => json({}))
    const router = createMemoryRouter(routes, { initialEntries: ['/admin/login'] })
    render(<RouterProvider router={router} />)

    const link = screen.getByRole('link', { name: 'Forgot your password?' })
    expect(link).toHaveAttribute('href', '/admin/reset-password')

    await user().click(link)
    expect(router.state.location.pathname).toBe('/admin/reset-password')
    expect(router.state.location.search).toBe('')
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument()
  })
})
