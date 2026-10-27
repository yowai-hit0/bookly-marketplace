import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { forgetAccountMe } from '@/auth/account'
import { readSession } from '@/auth/session'
import { routes } from '@/routes'
import { USER, signedIn } from '@/test/account-fixtures'
import { json, stubApi } from '@/test/fetch'

/**
 * `/account/email-confirm/:token` (R8.3, decisions 2 and 3): opening the link
 * changes nothing; the password and the token are posted together, with no
 * session; success signs the tab in and lands on the profile saying so; each
 * refusal is worded and signs no one in.
 */

const TOKEN = 'Qm9va2x5LWVtYWlsLWNoYW5nZS10b2tlbi0xMjM0NTY3'
const PATH = `/account/email-confirm/${TOKEN}`

function renderAt(path = PATH) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  forgetAccountMe()
})

async function confirmWith(password: string) {
  const main = within(screen.getByRole('main'))
  const user = userEvent.setup({ delay: null })
  if (password !== '') await user.type(main.getByLabelText('Password'), password)
  await user.click(main.getByRole('button', { name: 'Confirm and sign in' }))
  return main
}

describe('confirming a new sign-in email', () => {
  it('opening the link sends nothing', () => {
    const api = stubApi(() => undefined)
    renderAt()
    expect(screen.getByRole('heading', { level: 1, name: 'Confirm your new email' })).toBeInTheDocument()
    expect(api.sent.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('posts the token and password with no session, signs in, and lands on the profile saying so', async () => {
    const api = stubApi((sent) => {
      if (sent.url === '/api/account/email/confirm') return json(signedIn('confirmed.jwt', { email: 'new@example.com' }))
      if (sent.url === '/api/account/me') return json({ user: { ...USER, email: 'new@example.com' } })
      if (sent.url === '/api/account/profile') return json({ profile: { fullName: 'Aline Uwase', phone: null } })
      return undefined
    })
    const router = renderAt()
    await confirmWith('my password')

    await waitFor(() => expect(router.state.location.pathname).toBe('/account/profile'))
    expect(await screen.findByText('Your email is changed. You now sign in with new@example.com.')).toBeInTheDocument()
    expect(readSession('account')?.token).toBe('confirmed.jwt')
    const post = api.sent.find((call) => call.url === '/api/account/email/confirm')
    expect(post?.body).toEqual({ token: TOKEN, password: 'my password' })
    expect(post?.headers.get('Authorization')).toBeNull()
  })

  it('an empty password is asked for, sending nothing', async () => {
    const api = stubApi(() => undefined)
    renderAt()
    const main = await confirmWith('')
    expect(main.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true')
    expect(main.getByText('Enter your password.')).toBeInTheDocument()
    expect(api.sent).toEqual([])
  })

  it.each([
    [400, 'invalid_confirmation', 'That did not work. The link may have expired'],
    [409, 'email_taken', 'Another account now uses that address, so the change was withdrawn.'],
    [429, 'rate_limited', 'Too many attempts from here.'],
    [500, 'internal_error', 'Could not confirm the change.'],
  ])('a %s (%s) is said and signs no one in', async (status, error, words) => {
    stubApi(() => json({ error }, status))
    const router = renderAt()
    const main = await confirmWith('my password')

    expect(await main.findByRole('alert')).toHaveTextContent(words)
    expect(readSession('account')).toBeNull()
    expect(router.state.location.pathname).toBe(PATH)
  })
})
