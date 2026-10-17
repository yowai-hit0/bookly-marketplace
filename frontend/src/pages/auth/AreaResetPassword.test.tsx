import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { routes } from '@/routes'
import { json, stubApi } from '@/test/fetch'

/**
 * `/platform/reset-password` and `/account/reset-password`: the studio's reset
 * page (`StudioResetPassword.test.tsx`) for the other two areas, each against
 * its own endpoints, because a reset token works only in the area that
 * issued it. The request always says the same thing.
 */

const SENT = 'If that address can sign in here, a reset link is on its way.'

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe.each(['platform', 'account'] as const)('the %s reset page', (area) => {
  it('asks the area’s own endpoint for a link and says the same thing whatever the address', async () => {
    const api = stubApi(({ url }) => (url === `/api/${area}/auth/password-reset/request` ? json({ ok: true }, 202) : undefined))
    renderAt(`/${area}/reset-password`)
    const main = within(screen.getByRole('main'))

    await user().type(main.getByLabelText('Email'), 'someone@example.com')
    await user().click(main.getByRole('button', { name: 'Send the link' }))

    expect(await main.findByRole('status')).toHaveTextContent(SENT)
    expect(api.sent.find((call) => call.method === 'POST')).toMatchObject({
      url: `/api/${area}/auth/password-reset/request`,
      body: { email: 'someone@example.com' },
    })
    expect(main.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', `/${area}/login`)
  })

  it('says to wait on a 429', async () => {
    stubApi(({ method }) => (method === 'POST' ? json({ error: 'rate_limited' }, 429) : undefined))
    renderAt(`/${area}/reset-password`)
    const main = within(screen.getByRole('main'))

    await user().type(main.getByLabelText('Email'), 'someone@example.com')
    await user().click(main.getByRole('button', { name: 'Send the link' }))

    expect(await main.findByRole('alert')).toHaveTextContent('Too many attempts from here. Wait a few minutes and try again.')
  })

  it('consumes the fragment’s token at the area’s endpoint, then leads to the area’s sign in', async () => {
    const api = stubApi(({ url }) => (url === `/api/${area}/auth/password-reset/confirm` ? new Response(null, { status: 204 }) : undefined))
    renderAt(`/${area}/reset-password#token=r3set`)
    const main = within(screen.getByRole('main'))

    await user().type(main.getByLabelText('New password'), 'a brand new passphrase')
    await user().type(main.getByLabelText('Repeat the new password'), 'a brand new passphrase')
    await user().click(main.getByRole('button', { name: 'Save the password' }))

    expect(await main.findByRole('heading', { level: 1, name: 'Password changed' })).toBeInTheDocument()
    expect(api.sent.find((call) => call.method === 'POST')).toMatchObject({ body: { token: 'r3set', newPassword: 'a brand new passphrase' } })
    expect(main.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', `/${area}/login`)
  })

  it('calls a refused token a dead end', async () => {
    stubApi(({ method }) => (method === 'POST' ? json({ error: 'invalid_or_expired_token' }, 400) : undefined))
    renderAt(`/${area}/reset-password#token=sp3nt`)
    const main = within(screen.getByRole('main'))

    await user().type(main.getByLabelText('New password'), 'a brand new passphrase')
    await user().type(main.getByLabelText('Repeat the new password'), 'a brand new passphrase')
    await user().click(main.getByRole('button', { name: 'Save the password' }))

    expect(await main.findByRole('alert')).toHaveTextContent('That link has expired or has already been used. Ask for a new one.')
  })
})

it('wears the client shell for the account and the console panel for the platform', () => {
  stubApi(() => undefined)
  const { unmount } = render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/account/reset-password'] })} />)
  expect(screen.getByRole('contentinfo')).toBeInTheDocument()
  unmount()

  renderAt('/platform/reset-password')
  expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
  expect(screen.getByText('Platform')).toBeInTheDocument()
})
